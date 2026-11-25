import { readFile, writeFile } from 'node:fs/promises';
import { Address, scValToNative, xdr } from '@stellar/stellar-sdk';
import {
  accountPaymentAction, accountPaymentInvocation, actionHash, decodeAction, evaluateRequest, executeInvocation,
  readPaused, readPaymentCheck, readPolicy, readPolicyState, signForSponsor, stateAsOf, transferRequest,
  type AccountPayment, type ActionRequest, type Hash32,
} from '@stellar-agent-auth/sdk';
import type { Command } from '../index.js';
import { UsageError, address, contractAddress, hex32, integer, required, settled, type Runtime } from '../runtime.js';
import { walletId } from './wallet.js';

/**
 * Agent payments. `transfer`, `sign` and `submit` push a payment through the wallet's `execute`: the agent key signs
 * one authorization entry bound to the exact request, and the sponsor (or a `--source` fee payer) submits it. Every
 * request in a policy uses the next sequence, so an unsettled earlier submission for the same policy blocks a new
 * one: a request is never rebuilt while its predecessor might commit.
 *
 * `pay` uses the wallet's account path instead, for a payment that is pulled: a plain asset transfer that anyone
 * holding the signed entry can make, or a service's own call with the transfer inside it.
 */

const scopeOf = (wallet: string, policy: Hash32) => `execute:${wallet}:${Buffer.from(policy).toString('hex')}`;

const transferOptions = {
  wallet: 'string', 'agent-key': 'string', policy: 'string', to: 'string', asset: 'string', amount: 'string',
  sequence: 'string', 'deadline-seconds': 'string',
} as const;

/** Build and precheck a transfer request against the live policy, state and pause flag. */
async function buildRequest(runtime: Runtime, values: Record<string, string | undefined>) {
  const wallet = walletId(runtime, values['wallet']);
  const policyHash = hex32(values['policy'], 'policy');
  const agent = await runtime.key(values['agent-key'], 'agent-key');
  const scope = scopeOf(wallet, policyHash);
  const context = await runtime.context();
  // A repeated command must first see what became of the earlier one, before it reads the next sequence.
  if (!runtime.options.dryRun) await runtime.settleEarlier(scope);

  const read = runtime.read(wallet);
  const [policy, state, paused, latest] = await Promise.all([
    readPolicy(read, policyHash), readPolicyState(read, policyHash), readPaused(read),
    runtime.server.getLatestLedger(),
  ]);
  if (policy.signer !== agent.address) throw new UsageError('--agent-key is not the signer this policy names');
  const now = BigInt(latest.closeTime);
  const asset = contractAddress(values['asset'], 'asset');
  const deadlineSeconds = values['deadline-seconds'] === undefined ? 300n
    : integer(values['deadline-seconds'], 'deadline-seconds');
  if (deadlineSeconds < 30n || deadlineSeconds > 86_400n) throw new UsageError('--deadline-seconds must be 30-86400');
  const request = transferRequest({
    wallet, policyHash,
    sequence: values['sequence'] === undefined ? stateAsOf(state, now).next_sequence
      : integer(values['sequence'], 'sequence'),
    deadline: now + deadlineSeconds, asset, recipient: address(values['to'], 'to'),
    amount: await runtime.units(asset, values['amount'], 'amount'),
  });
  // The wallet's own checks in order, so a doomed request is explained before anything is signed.
  evaluateRequest(policy, state, request, { wallet, policyHash, paused, now });
  return { request, agent, scope, context };
}

function describe(runtime: Runtime, request: ActionRequest) {
  const transfer = request.action.kind === 'Transfer' ? request.action.transfer : request.action.payment;
  return {
    wallet: request.wallet, policy_hash: request.policy_hash, sequence: request.sequence, deadline: request.deadline,
    asset: transfer.asset, recipient: transfer.recipient, units: transfer.amount,
    action_hash: actionHash(runtime.config.passphrase, request),
  };
}

/** The request carried by a signed `execute` operation, refusing anything else. */
function signedRequest(operation: xdr.Operation): { request: ActionRequest; expiration: number } {
  const { body } = operation;
  const fn = body.type === 'invokeHostFunction' ? body.invokeHostFunctionOp.hostFunction : undefined;
  if (fn?.type !== 'hostFunctionTypeInvokeContract' || fn.invokeContract.functionName.toString() !== 'execute'
    || fn.invokeContract.args.length !== 1) {
    throw new UsageError('File does not hold a signed wallet execute operation');
  }
  const request = decodeAction(fn.invokeContract.args[0]!);
  if (Address.fromScAddress(fn.invokeContract.contractAddress).toString() !== request.wallet) {
    throw new UsageError('Signed operation targets a different wallet than its request');
  }
  const [entry] = body.type === 'invokeHostFunction' ? body.invokeHostFunctionOp.auth : [];
  const credentials = entry?.credentials;
  const expiration = credentials?.type === 'sorobanCredentialsAddress' ? credentials.address.signatureExpirationLedger
    : credentials?.type === 'sorobanCredentialsAddressV2' ? credentials.addressV2.signatureExpirationLedger : 0;
  return { request, expiration };
}

/** The wallet returns the hash of the action it executed; anything else is not this request's result. */
const actionResult = (runtime: Runtime, request: ActionRequest) => (value: xdr.ScVal) => {
  const executed = Buffer.from(scValToNative(value) as Uint8Array).toString('hex');
  const expected = Buffer.from(actionHash(runtime.config.passphrase, request)).toString('hex');
  if (executed !== expected) throw new Error(`The wallet reported action ${executed}, not the requested ${expected}`);
  return { executed_action_hash: executed };
};

export const executeCommands: Record<string, Command> = {
  transfer: {
    summary: 'Pay as the agent: --agent-key <key> --policy <hash> --to <address> --asset <C...> --amount <decimal>',
    options: transferOptions,
    async run(runtime, values) {
      const { request, agent, scope, context } = await buildRequest(runtime, values);
      const result = settled(await runtime.run(executeInvocation(context, request, agent), undefined, scope),
        actionResult(runtime, request));
      return { ...result, request: describe(runtime, request) };
    },
  },
  pay: {
    summary: 'Pay on the account path: --agent-key <key> --policy <hash> --to <address> --asset <C...> '
      + '--amount <decimal> [--service <C...> --service-id <hex>]',
    options: {
      wallet: 'string', 'agent-key': 'string', policy: 'string', to: 'string', asset: 'string', amount: 'string',
      service: 'string', 'service-id': 'string',
    },
    async run(runtime, values) {
      if ((values['service'] === undefined) !== (values['service-id'] === undefined)) {
        throw new UsageError('--service and --service-id go together');
      }
      const wallet = walletId(runtime, values['wallet']);
      const policyHash = hex32(values['policy'], 'policy');
      const agent = await runtime.key(values['agent-key'], 'agent-key');
      const asset = contractAddress(values['asset'], 'asset');
      const payment: AccountPayment = {
        wallet, policyHash, asset, recipient: address(values['to'], 'to'),
        amount: await runtime.units(asset, values['amount'], 'amount'),
        ...(values['service'] === undefined ? {} : {
          service: {
            contract: contractAddress(values['service'], 'service'),
            service_id: hex32(values['service-id'], 'service-id'),
          },
        }),
      };
      const read = runtime.read(wallet);
      if ((await readPolicy(read, policyHash)).signer !== agent.address) {
        throw new UsageError('--agent-key is not the signer this policy names');
      }
      // Ask the wallet first. A refusal on the account path itself reaches us only as an authorization failure,
      // and a public RPC does not say why; this names the rule.
      const after = await readPaymentCheck(read, { policy_hash: policyHash, action: accountPaymentAction(payment) });
      const context = await runtime.context();
      const scope = `account:${wallet}:${Buffer.from(policyHash).toString('hex')}`;
      const result = settled(await runtime.run(accountPaymentInvocation(context, payment, agent), undefined, scope),
        (value) => (payment.service ? { receipt: scValToNative(value) as unknown } : {}));
      return {
        ...result,
        payment: {
          wallet, policy_hash: policyHash, asset, recipient: payment.recipient, units: payment.amount,
          ...(payment.service ? { service: payment.service.contract, service_id: payment.service.service_id } : {}),
        },
        spent_today: after.daily_spend,
      };
    },
  },
  sign: {
    summary: 'Sign a transfer without submitting it: same options as transfer, plus --out <file>',
    options: { ...transferOptions, out: 'string' },
    dryRun: false,
    async run(runtime, values) {
      const out = required(values['out'], 'out');
      const { request, agent, context } = await buildRequest(runtime, values);
      const sponsor = runtime.sponsor();
      const simulatedSource = sponsor ? (await sponsor).address
        : runtime.options.source ? (await runtime.key(runtime.options.source, 'source')).address : undefined;
      if (!simulatedSource) throw new UsageError('Set --sponsor-url or SUBMITTER_URL, or pass --source');
      const operation = await signForSponsor(context, simulatedSource, executeInvocation(context, request, agent),
        runtime.limits);
      const { expiration } = signedRequest(operation);
      await writeFile(out, `${JSON.stringify({ operation: operation.toXdr('base64') }, null, 2)}\n`, { mode: 0o600 });
      return { status: 'signed', file: out, auth_expiration_ledger: expiration, request: describe(runtime, request) };
    },
  },
  submit: {
    summary: 'Submit a transfer signed earlier with "execute sign": --file <file>',
    options: { file: 'string' },
    async run(runtime, values) {
      const path = required(values['file'], 'file');
      let operation: xdr.Operation;
      try {
        const { operation: encoded } = JSON.parse(await readFile(path, 'utf8')) as { operation?: unknown };
        if (typeof encoded !== 'string') throw new Error('missing operation');
        operation = xdr.Operation.fromXdr(encoded, 'base64');
      } catch (error) {
        throw new UsageError(`Cannot read signed operation ${path}: ${error instanceof Error ? error.message : error}`);
      }
      const { request, expiration } = signedRequest(operation);
      const result = settled(await runtime.runSigned(operation, scopeOf(request.wallet, request.policy_hash)),
        actionResult(runtime, request));
      return { ...result, auth_expiration_ledger: expiration, request: describe(runtime, request) };
    },
  },
};
