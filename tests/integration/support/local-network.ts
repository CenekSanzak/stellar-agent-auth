import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  Address, BASE_FEE, Networks, Operation, TransactionBuilder, hash, rpc, xdr,
  type Keypair, type Transaction,
} from '@stellar/stellar-sdk';
import { expect } from 'vitest';
import { loadConfig } from '../../../packages/sdk/src/config.js';

export type Simulation = ReturnType<typeof successfulSimulation>;
export type Confirmed = rpc.Api.GetSuccessfulTransactionResponse;
export type LocalNetwork = Awaited<ReturnType<typeof localNetwork>>;

export function successfulSimulation(response: rpc.Api.SimulateTransactionResponse) {
  if (!rpc.Api.isSimulationSuccess(response) || !response.result) {
    throw new Error('error' in response ? response.error : 'Missing simulation result');
  }
  return { ...response, result: response.result };
}

/** Host auth failures by cause: the leading host error and the diagnostic that names the failing address. */
const AUTH_FAILURES = {
  missing: ['InvalidAction', 'Unauthorized function call for address'],
  forged: ['InvalidAction', 'failed account authentication with error'],
  replayed: ['ExistingValue', 'nonce already exists for address'],
} as const;

/** A host credential failure of `kind` for `address`, as opposed to an expiry, contract, budget or other error. */
export function assertAuthFailure(
  simulation: rpc.Api.SimulateTransactionResponse, kind: keyof typeof AUTH_FAILURES, address: string, label: string,
) {
  const [code, diagnostic] = AUTH_FAILURES[kind];
  const error = 'error' in simulation ? simulation.error : 'success';
  expect(error, label).toMatch(new RegExp(`^HostError: Error\\(Auth, ${code}\\)`));
  expect(error, label).toContain(`"${diagnostic}", ${address}`);
}

export function returnValue(result: Confirmed) {
  if (!result.returnValue) throw new Error('Missing confirmed return value');
  return result.returnValue;
}

export const contractEvents = (result: Confirmed) => result.events.contractEventsXdr.flat();

/** WASM built by `npm run build:contracts`, or downloaded from the CI foundation job. */
export const readWasm = (name: string) =>
  readFileSync(new URL(`../../../target/wasm32v1-none/release/stellar_agent_auth_${name}.wasm`, import.meta.url));

/** The loopback protocol-29 Quickstart, with helpers for runtime-funded roles and confirmed transactions. */
export async function localNetwork() {
  const config = loadConfig(process.env);
  expect(config.network).toBe('local');
  expect(['localhost', '127.0.0.1', '[::1]']).toContain(new URL(config.rpcUrl).hostname);
  const server = new rpc.Server(config.rpcUrl, { allowHttp: true, timeout: 15_000 });
  const network = await server.getNetwork();
  expect(network.passphrase).toBe(Networks.STANDALONE);
  expect(Number(network.protocolVersion)).toBe(29);
  const { passphrase } = config;

  /** Friendbot-funds keypairs generated at test runtime; no key material is stored. */
  async function fund(...roles: Keypair[]) {
    for (const role of roles) await server.requestAirdrop(role.publicKey());
  }

  async function build(source: Keypair, operation: xdr.Operation): Promise<Transaction> {
    const account = await server.getAccount(source.publicKey());
    return new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: passphrase })
      .addOperation(operation)
      .setTimeout(120)
      .build();
  }

  const simulate = (tx: Transaction, mode: rpc.Api.SimulationAuthMode) =>
    server.simulateTransaction(tx, undefined, mode, false);

  /** Assemble with the simulated footprint and fee, sign the envelope with `source` only, and confirm. */
  async function submit(tx: Transaction, simulation: Simulation, source: Keypair) {
    const prepared = rpc.assembleTransaction(tx, simulation).build();
    prepared.sign(source);
    const sent = await server.sendTransaction(prepared);
    if (sent.status !== 'PENDING') {
      throw new Error(`Submission ${sent.status}: ${'errorResult' in sent ? sent.errorResult?.toXdr('base64') : sent.hash}`);
    }
    const confirmed = await server.pollTransaction(sent.hash, { attempts: 30, sleepStrategy: () => 1_000 });
    if (confirmed.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      const details = 'diagnosticEventsXdr' in confirmed
        ? confirmed.diagnosticEventsXdr?.map((event) => event.toXdr('base64')).join(', ')
        : '';
      throw new Error(`Transaction ${sent.hash}: ${confirmed.status} ${details ?? ''}`);
    }
    return { prepared, confirmed };
  }

  /** A call authorized by its transaction source alone. */
  async function invoke(source: Keypair, operation: xdr.Operation) {
    const tx = await build(source, operation);
    const simulation = successfulSimulation(await simulate(tx, 'record'));
    return { ...await submit(tx, simulation, source), simulation };
  }

  /**
   * Install `wasm` unless its code is already on the ledger. Suites run in parallel and install the same contracts;
   * when another suite's identical upload lands between simulation and inclusion, the racing upload can exceed its
   * simulated budget and fail. That failure is harmless exactly when the code is then present.
   */
  async function upload(source: Keypair, wasm: Uint8Array) {
    const key = xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: hash(wasm) }));
    const installed = async () => (await server.getLedgerEntries(key)).entries.length > 0;
    if (await installed()) return;
    try {
      await invoke(source, Operation.uploadContractWasm({ wasm }));
    } catch (error) {
      if (!(await installed())) throw error;
    }
  }

  /** Install `wasm` if needed and create one instance with `source` as deployer; returns the contract address. */
  async function deploy(source: Keypair, wasm: Uint8Array, constructorArgs: xdr.ScVal[] = []) {
    await upload(source, wasm);
    const { confirmed } = await invoke(source, Operation.createCustomContract({
      address: Address.fromString(source.publicKey()), wasmHash: hash(wasm), salt: randomBytes(32), constructorArgs,
    }));
    return Address.fromScVal(returnValue(confirmed)).toString();
  }

  const latestLedger = async () => (await server.getLatestLedger()).sequence;

  return { server, passphrase, fund, build, simulate, submit, invoke, upload, deploy, latestLedger };
}
