/**
 * Check the kept Testnet deployment against the network and write what was found to `manifest.json`.
 *
 *   npm run build:contracts && npm run build
 *   node deployments/testnet/deploy.ts
 *
 * The deployment itself is made once, by the demo's setup (`npm run demo:setup`, see the README beside this file),
 * which records its public addresses in `demo.json` and keeps its keys in the git-ignored `.local/testnet-demo/`.
 * This script makes nothing and needs no key. It reads `demo.json` and asks the network whether each thing in it
 * is there and is what the record says: the contracts and their code, what they are bound to, the provider, the
 * agent and its verification, and the asset. It then looks up, in the network's own history, the transactions that
 * made them. It exits with 1 if anything does not match, and writes nothing then.
 *
 * It also says whether the contracts as built on this machine are byte for byte the ones on the network. That is
 * reported, not required: the deployment was built on macOS arm64, where the pinned toolchain reproduces it, and
 * a Linux x86_64 build of the same source has the same size, interface and build metadata but other bytes in two
 * of the three contracts.
 *
 * Run it again after a Testnet reset or a new deployment, before anything points people at the addresses.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { Address, Asset, hash, rpc, xdr } from '@stellar/stellar-sdk';
import {
  contractCodeHash, decodeIdentity, networkIdOf, readAgent, readAssetDecimals, readBoundAgentRegistry,
  readCurrentResult, readProvider, readVerificationAdmin,
} from '@stellar-agent-auth/sdk';
import { isMainModule } from '@stellar-agent-auth/sdk/node';
import { TESTNET } from './addresses.ts';

const HORIZON = 'https://horizon-testnet.stellar.org';
const EXPLORER = 'https://stellar.expert/explorer/testnet';
const WASM = new URL('../../target/wasm32v1-none/release/', import.meta.url);
const ROOT = new URL('../../', import.meta.url);

interface Made { transaction: string; ledger: number; at: string; link: string }
interface HorizonOperation {
  type: string; created_at: string; transaction_hash: string; transaction_successful: boolean; source_account: string;
  function?: string; parameters?: { value: string; type: string }[] | null; asset_code?: string; to?: string;
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const text = async (path: string) => readFile(new URL(path, ROOT), 'utf8');

/** The SHA-256 of a contract as it is built here, or `null` when it has not been built. */
async function built(name: string): Promise<string | null> {
  return readFile(new URL(`stellar_agent_auth_${name}.wasm`, WASM)).then((wasm) => hex(hash(wasm)), () => null);
}

/** Every operation an account has made, oldest first; a deployment's accounts make a few dozen at most. */
async function operationsOf(account: string): Promise<HorizonOperation[]> {
  const response = await fetch(`${HORIZON}/accounts/${account}/operations?order=asc&limit=200`);
  if (!response.ok) return [];
  return ((await response.json()) as { _embedded: { records: HorizonOperation[] } })._embedded.records
    .filter((operation) => operation.transaction_successful);
}

export async function checkDeployment(log: (line: string) => void = console.log) {
  const record = TESTNET;
  const server = new rpc.Server(record.rpc_url, { timeout: 30_000 });
  const network = await server.getNetwork();
  const read = { server, source: record.roles.facilitator, networkPassphrase: record.passphrase };
  const checks: { what: string; ok: boolean; found?: string }[] = [];
  const check = (what: string, ok: boolean, found?: string) => {
    checks.push({ what, ok, ...(ok || found === undefined ? {} : { found }) });
    log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok || found === undefined ? '' : ` (found ${found})`}`);
  };

  check('the RPC server is on the recorded network', network.passphrase === record.passphrase, network.passphrase);

  // The contracts, and the code they run.
  const code = {
    agent_registry: await contractCodeHash(server, record.agent_registry).catch(() => undefined),
    verification_registry: await contractCodeHash(server, record.verification_registry).catch(() => undefined),
  };
  const local = {
    agent_registry: await built('agent_registry'), verification_registry: await built('verification_registry'),
    smart_wallet: await built('smart_wallet'),
  };
  check('the agent registry exists', code.agent_registry !== undefined);
  check('the verification registry exists', code.verification_registry !== undefined);
  const walletCode = xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: Buffer.from(record.wallet_wasm_hash, 'hex') }));
  check('the wallet code is installed', (await server.getLedgerEntries(walletCode)).entries.length === 1);
  const deployedCode = { ...code, smart_wallet: record.wallet_wasm_hash };
  const builtHere = Object.fromEntries((['agent_registry', 'verification_registry', 'smart_wallet'] as const).map((name) => {
    const sha256 = local[name];
    if (sha256) log(`${sha256 === deployedCode[name] ? 'same' : 'diff'} ${name.replace('_', ' ')} as built on this machine${sha256 === deployedCode[name] ? '' : ` (${sha256})`}`);
    return [name, sha256 ? { sha256, same_as_deployed: sha256 === deployedCode[name] } : null];
  }));

  // What they are bound to.
  const verification = { ...read, contractId: record.verification_registry };
  const admin = await readVerificationAdmin(verification);
  const bound = await readBoundAgentRegistry(verification);
  check('the verification registry is bound to the agent registry', bound === record.agent_registry, bound);
  const provider = await readProvider(verification, record.provider.address);
  check(`the provider is approved, as ${record.provider.mode}`, provider.mode === record.provider.mode && provider.approved,
    `${provider.mode}${provider.approved ? '' : ', not approved'}`);

  // The agent and its verification.
  const agentId = BigInt(record.agent.agent_id);
  const identity = await readAgent({ ...read, contractId: record.agent_registry }, agentId);
  check('the agent is registered with the recorded signer, controller and metadata',
    identity.signer === record.agent.signer && identity.controller === record.agent.controller
    && identity.metadata_uri === record.agent.metadata_uri && !identity.disabled);
  const document = await fetch(record.agent.metadata_uri).then(async (response) => new Uint8Array(await response.arrayBuffer()));
  check('the agent\'s metadata is served and has the registered hash', hex(hash(Buffer.from(document))) === hex(identity.metadata_hash));
  const result = await readCurrentResult(verification, { agent_id: agentId, revision: identity.revision, provider: record.provider.address })
    .catch(() => undefined);
  const now = BigInt((await server.getLatestLedger()).closeTime);
  check('the agent has a current verification from the provider', result !== undefined && !result.revoked && result.expires_at > now);

  // The asset.
  const asset = new Asset(record.asset.code, record.asset.issuer);
  check('the asset contract is the Stellar Asset Contract of the recorded asset', asset.contractId(record.passphrase) === record.asset.contract);
  const decimals = await readAssetDecimals(read, record.asset.contract).catch(() => undefined);
  check(`the asset has ${record.asset.decimals} decimals`, decimals === record.asset.decimals, String(decimals));

  if (checks.some(({ ok }) => !ok)) throw new Error('The deployment does not match its record; nothing was written');

  // The transactions that made it, from the network's history.
  const made = async (operation: HorizonOperation | undefined): Promise<Made | undefined> => {
    if (!operation) return undefined;
    const tx = await (await fetch(`${HORIZON}/transactions/${operation.transaction_hash}`)).json() as { ledger: number };
    return { transaction: operation.transaction_hash, ledger: tx.ledger, at: operation.created_at, link: `${EXPLORER}/tx/${operation.transaction_hash}` };
  };
  const calls = (operations: HorizonOperation[], name: string) => operations.filter((operation) => {
    const symbol = operation.type === 'invoke_host_function' && operation.parameters?.[1]
      ? xdr.ScVal.fromXdr(operation.parameters[1].value, 'base64') : undefined;
    return symbol?.type === 'scvSymbol' && symbol.sym.toString() === name;
  });
  /** The contract a creation made, read from the transaction's own result while the RPC still keeps it. */
  const created = async (operations: HorizonOperation[], contract: string) => {
    for (const operation of operations.filter(({ function: fn }) => fn?.includes('CreateContract'))) {
      const tx = await server.getTransaction(operation.transaction_hash);
      if (tx.status === rpc.Api.GetTransactionStatus.SUCCESS && tx.returnValue?.type === 'scvAddress'
        && Address.fromScVal(tx.returnValue).toString() === contract) return made(operation);
    }
    return undefined;
  };
  const byAdmin = await operationsOf(admin);
  const everyone = [...byAdmin, ...await operationsOf(record.asset.issuer), ...await operationsOf(record.roles.funder)];
  const registered = (await operationsOf(record.agent.controller)).filter((operation) => calls([operation], 'register').length > 0);
  let registration: Made | undefined;
  for (const operation of registered) {
    const tx = await server.getTransaction(operation.transaction_hash);
    if (tx.status === rpc.Api.GetTransactionStatus.SUCCESS && tx.returnValue
      && decodeIdentity(tx.returnValue).agent_id === agentId) registration = await made(operation);
  }
  const transactions = {
    agent_registry_created: await created(everyone, record.agent_registry),
    verification_registry_created: await created(everyone, record.verification_registry),
    provider_approved: await made(calls(byAdmin, 'approve_provider')[0]),
    asset_contract_created: await created(everyone, record.asset.contract),
    asset_issued: await made((await operationsOf(record.asset.issuer)).find(({ type, asset_code: issued }) => type === 'payment' && issued === record.asset.code)),
    agent_registered: registration,
    agent_first_verified: await made(calls(await operationsOf(record.provider.address), 'publish')[0]),
  };
  for (const [name, found] of Object.entries(transactions)) log(`${found ? 'tx  ' : 'none'} ${name}${found ? ` ${found.transaction}` : ' (not found in the network\'s history)'}`);

  const cargo = await text('Cargo.toml');
  const lock = JSON.parse(await text('package-lock.json')) as { packages: Record<string, { version?: string }> };
  const version = (name: string) => lock.packages[`node_modules/${name}`]?.version ?? null;
  const manifest = {
    checked_at: new Date().toISOString(),
    network: record.network,
    passphrase: record.passphrase,
    network_id: networkIdOf(record.passphrase),
    protocol: Number(network.protocolVersion),
    rpc_url: record.rpc_url,
    made_at: record.created_at,
    contracts: {
      agent_registry: { id: record.agent_registry, wasm_sha256: code.agent_registry, link: `${EXPLORER}/contract/${record.agent_registry}` },
      verification_registry: {
        id: record.verification_registry, wasm_sha256: code.verification_registry, admin, agent_registry: bound,
        link: `${EXPLORER}/contract/${record.verification_registry}`,
      },
      smart_wallet: {
        wasm_sha256: record.wallet_wasm_hash, salt: record.wallet_salt,
        note: 'There is no one wallet. Each owner deploys their own from this code, at an address fixed by their account and this salt.',
      },
    },
    asset: {
      ...record.asset, link: `${EXPLORER}/asset/${record.asset.code}-${record.asset.issuer}`,
      note: 'A test asset issued for this deployment. It has no value and is not a stablecoin.',
    },
    provider: { ...record.provider, approved: provider.approved },
    agent: {
      ...record.agent, revision: identity.revision.toString(), metadata_sha256: hex(identity.metadata_hash),
      verification: result ? {
        sequence: result.sequence.toString(), risk_score: result.risk_score,
        issued_at: new Date(Number(result.issued_at) * 1_000).toISOString(),
        expires_at: new Date(Number(result.expires_at) * 1_000).toISOString(),
        checks: result.checks.map(({ kind, outcome }) => ({ kind, outcome })),
      } : null,
    },
    roles: { admin, issuer: record.asset.issuer, ...record.roles, provider: record.provider.address, vendors: record.vendors },
    transactions,
    built_here: {
      host: `${process.platform} ${process.arch}`,
      ...builtHere,
      note: 'Whether this machine\'s build of the source is byte for byte what is deployed. The deployment was built on macOS arm64. A Linux x86_64 build of the same source has the same size, interface and build metadata, and other bytes in two of the three contracts.',
    },
    toolchain: {
      node: process.version, '@stellar/stellar-sdk': version('@stellar/stellar-sdk'), '@x402/stellar': version('@x402/stellar'),
      'soroban-sdk': cargo.match(/soroban-sdk\s*=\s*(?:\{[^}]*version\s*=\s*)?"([^"]+)"/)?.[1] ?? null,
      rust: (await text('rust-toolchain.toml')).match(/channel\s*=\s*"([^"]+)"/)?.[1] ?? null,
    },
    checks: checks.map(({ what }) => what),
  };
  await writeFile(new URL('./manifest.json', import.meta.url), `${JSON.stringify(manifest, null, 2)}\n`);
  log(`${checks.length} checks passed. Written to deployments/testnet/manifest.json`);
  return manifest;
}

if (isMainModule(import.meta.url)) {
  checkDeployment().catch((error: unknown) => {
    console.error(`deploy: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
