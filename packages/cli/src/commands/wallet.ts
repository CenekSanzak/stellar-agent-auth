import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Address, hash, scValToNative, xdr } from '@stellar/stellar-sdk';
import {
  fromContractUnits, fundInvocation, ownerInvocation, readActivePolicies, readAuditHead, readPaused, readWalletBalance,
  readWalletOwner, readWalletRegistries, uploadInvocation, walletDeployment, type WalletOwnerMethod, type WalletArgs,
} from '@stellar-agent-auth/sdk';
import type { Command } from '../index.js';
import { UsageError, address, contractAddress, settled, type Runtime } from '../runtime.js';

/** Wallet custody: deploy, inspect, fund, withdraw, pause and resume. */

const DEFAULT_WASM = 'target/wasm32v1-none/release/stellar_agent_auth_smart_wallet.wasm';
const walletOption = { wallet: 'string' } as const;

export const walletId = (runtime: Runtime, value: string | undefined) => runtime.contract(value, 'WALLET_ID', 'wallet');

/** Run an owner-only wallet call; the owner pays unless a sponsor or `--source` is configured. */
export async function ownerCall<M extends WalletOwnerMethod>(
  runtime: Runtime, wallet: string, method: M, args: WalletArgs[M], ownerKey: string | undefined,
  extra?: (value: xdr.ScVal) => Record<string, unknown>,
) {
  const owner = await runtime.key(ownerKey, 'owner');
  const context = await runtime.context();
  return settled(await runtime.run(ownerInvocation(context, wallet, method, args, owner), owner,
    `owner:${wallet}`), extra);
}

async function installed(runtime: Runtime, wasmHash: Uint8Array) {
  const key = xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: wasmHash }));
  return (await runtime.server.getLedgerEntries(key)).entries.length > 0;
}

export const walletCommands: Record<string, Command> = {
  create: {
    summary: 'Deploy a wallet owned by --owner <key> [--wasm <path>]; the owner pays and authorizes',
    options: { owner: 'string', wasm: 'string', 'agent-registry': 'string', 'verification-registry': 'string' },
    async run(runtime, values) {
      const owner = await runtime.key(values['owner'], 'owner');
      const agentRegistry = runtime.contract(values['agent-registry'], 'AGENT_REGISTRY_ID', 'agent-registry');
      const verificationRegistry = runtime.contract(values['verification-registry'], 'VERIFICATION_REGISTRY_ID',
        'verification-registry');
      const wasm = await readFile(resolve(values['wasm'] ?? DEFAULT_WASM)).catch(() => {
        throw new UsageError(`Smart wallet WASM not found; run npm run build:contracts or pass --wasm`);
      });
      const wasmHash = hash(wasm);
      const uploaded = !(await installed(runtime, wasmHash));
      if (uploaded && !runtime.options.dryRun) {
        settled(await runtime.run(uploadInvocation(wasm), owner, `source:${owner.address}`, 'direct',
          runtime.deployLimits));
      }
      const salt = randomBytes(32);
      const deployment = walletDeployment(owner.address, wasmHash, agentRegistry, verificationRegistry, salt);
      const result = settled(await runtime.run(deployment, owner, `source:${owner.address}`, 'direct',
        runtime.deployLimits),
        (value) => ({ wallet: Address.fromScVal(value).toString() }));
      return { ...result, owner: owner.address, wasm_sha256: Buffer.from(wasmHash).toString('hex'),
        code_uploaded: uploaded };
    },
  },
  show: {
    summary: 'Show wallet configuration, pause state, active policies and audit head [--asset <C...>]',
    options: { ...walletOption, asset: 'string' },
    async run(runtime, values) {
      const wallet = walletId(runtime, values['wallet']);
      const read = runtime.read(wallet);
      const asset = values['asset'] === undefined ? undefined : contractAddress(values['asset'], 'asset');
      return {
        wallet, owner: await readWalletOwner(read), ...await readWalletRegistries(read),
        paused: await readPaused(read), active_policies: await readActivePolicies(read),
        audit_head: await readAuditHead(read),
        ...(asset ? { asset, balance: await runtime.format(asset, await readWalletBalance(read, asset)) } : {}),
      };
    },
  },
  balance: {
    summary: 'Show the wallet balance of --asset <C...>',
    options: { ...walletOption, asset: 'string' },
    async run(runtime, values) {
      const wallet = walletId(runtime, values['wallet']);
      const asset = contractAddress(values['asset'], 'asset');
      const units = await readWalletBalance(runtime.read(wallet), asset);
      return { wallet, asset, balance: await runtime.format(asset, units), units };
    },
  },
  fund: {
    summary: 'Fund the wallet: --from <key> --asset <C...> --amount <decimal>; grants no authority',
    options: { ...walletOption, from: 'string', asset: 'string', amount: 'string' },
    async run(runtime, values) {
      const wallet = walletId(runtime, values['wallet']);
      const funder = await runtime.key(values['from'], 'from');
      const asset = contractAddress(values['asset'], 'asset');
      const amount = await runtime.units(asset, values['amount'], 'amount');
      const context = await runtime.context();
      return settled(await runtime.run(fundInvocation(context, wallet, { from: funder.address, asset, amount }, funder),
        funder, `fund:${wallet}:${funder.address}`), await balanceOf(runtime, asset));
    },
  },
  withdraw: {
    summary: 'Withdraw as owner: --owner <key> --asset <C...> --to <address> --amount <decimal>',
    options: { ...walletOption, owner: 'string', asset: 'string', to: 'string', amount: 'string' },
    async run(runtime, values) {
      const wallet = walletId(runtime, values['wallet']);
      const asset = contractAddress(values['asset'], 'asset');
      const args = { asset, recipient: address(values['to'], 'to'),
        amount: await runtime.units(asset, values['amount'], 'amount') };
      return ownerCall(runtime, wallet, 'withdraw', args, values['owner'], await balanceOf(runtime, asset));
    },
  },
  pause: {
    summary: 'Pause agent execution: --owner <key>',
    options: { ...walletOption, owner: 'string' },
    async run(runtime, values) {
      return ownerCall(runtime, walletId(runtime, values['wallet']), 'pause', {}, values['owner']);
    },
  },
  resume: {
    summary: 'Resume agent execution: --owner <key>',
    options: { ...walletOption, owner: 'string' },
    async run(runtime, values) {
      return ownerCall(runtime, walletId(runtime, values['wallet']), 'resume', {}, values['owner']);
    },
  },
};

/** Formats the `i128` balance a call returns as a decimal amount of `asset`. */
async function balanceOf(runtime: Runtime, asset: string) {
  const decimals = await runtime.decimals(asset);
  return (value: xdr.ScVal) => (value.type === 'scvI128'
    ? { balance: fromContractUnits(scValToNative(value) as bigint, decimals) } : {});
}
