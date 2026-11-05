import { hash } from '@stellar/stellar-sdk';
import {
  decodeIdentity, readAgent, registryInvocation, registryOperation, type AgentIdentity, type RegistryArgs,
  type RegistryAuthMethod, type Signer,
} from '@stellar-agent-auth/sdk';
import { safeFetch } from '@stellar-agent-auth/verifier';
import type { Command } from '../index.js';
import { UsageError, hex32, integer, required, settled, type Runtime } from '../runtime.js';

/** Agent registry: register, show, update metadata and rotate the signer. */

const identity = (value: Parameters<typeof decodeIdentity>[0]) => ({ identity: decodeIdentity(value) });

/** The SHA-256 of the exact bytes served at `uri`, fetched with the verifier's SSRF-safe client. */
async function metadataHash(uri: string, supplied: string | undefined): Promise<Uint8Array> {
  if (supplied !== undefined) return hex32(supplied, 'metadata-sha256');
  const response = await safeFetch(uri);
  if (response.status !== 200) throw new UsageError(`Metadata URI answered HTTP ${response.status}`);
  return Uint8Array.from(hash(Buffer.from(response.body)));
}

async function mutate<M extends RegistryAuthMethod>(
  runtime: Runtime, registry: string, method: M, args: RegistryArgs[M], signers: Signer[], payer: Signer,
) {
  const context = await runtime.context();
  const invocation = registryInvocation(context, registry, method, args, signers,
    registryOperation(registry, method, args));
  return settled(await runtime.run(invocation, payer, `source:${payer.address}`), identity);
}

const live = async (runtime: Runtime, registry: string, agentId: bigint): Promise<AgentIdentity> =>
  readAgent(runtime.read(registry), agentId);

export const agentCommands: Record<string, Command> = {
  register: {
    summary: 'Register an agent: --controller <key> --signer <key> --metadata-uri <https URL> [--metadata-sha256 <hex>]',
    options: { controller: 'string', signer: 'string', 'metadata-uri': 'string', 'metadata-sha256': 'string',
      'agent-registry': 'string' },
    async run(runtime, values) {
      const registry = runtime.contract(values['agent-registry'], 'AGENT_REGISTRY_ID', 'agent-registry');
      const controller = await runtime.key(values['controller'], 'controller');
      const signer = await runtime.key(values['signer'], 'signer');
      const uri = required(values['metadata-uri'], 'metadata-uri');
      const args = {
        controller: controller.address, signer: signer.address, metadata_uri: uri,
        metadata_hash: await metadataHash(uri, values['metadata-sha256']),
      };
      return mutate(runtime, registry, 'register', args, [controller, signer], controller);
    },
  },
  show: {
    summary: 'Show an agent identity: --agent <id>',
    options: { agent: 'string', 'agent-registry': 'string' },
    async run(runtime, values) {
      const registry = runtime.contract(values['agent-registry'], 'AGENT_REGISTRY_ID', 'agent-registry');
      return { identity: await live(runtime, registry, integer(values['agent'], 'agent')) };
    },
  },
  update: {
    summary: 'Update metadata: --agent <id> --controller <key> --metadata-uri <URL> [--metadata-sha256 <hex>]',
    options: { agent: 'string', controller: 'string', 'metadata-uri': 'string', 'metadata-sha256': 'string',
      'agent-registry': 'string' },
    async run(runtime, values) {
      const registry = runtime.contract(values['agent-registry'], 'AGENT_REGISTRY_ID', 'agent-registry');
      const controller = await runtime.key(values['controller'], 'controller');
      const current = await live(runtime, registry, integer(values['agent'], 'agent'));
      const uri = required(values['metadata-uri'], 'metadata-uri');
      return mutate(runtime, registry, 'update_metadata', {
        agent_id: current.agent_id, expected_revision: current.revision, metadata_uri: uri,
        metadata_hash: await metadataHash(uri, values['metadata-sha256']),
      }, [controller], controller);
    },
  },
  rotate: {
    summary: 'Rotate the agent signer: --agent <id> --controller <key> --new-signer <key>',
    options: { agent: 'string', controller: 'string', 'new-signer': 'string', 'agent-registry': 'string' },
    async run(runtime, values) {
      const registry = runtime.contract(values['agent-registry'], 'AGENT_REGISTRY_ID', 'agent-registry');
      const controller = await runtime.key(values['controller'], 'controller');
      const signer = await runtime.key(values['new-signer'], 'new-signer');
      const current = await live(runtime, registry, integer(values['agent'], 'agent'));
      return mutate(runtime, registry, 'rotate_signer', {
        agent_id: current.agent_id, expected_revision: current.revision, new_signer: signer.address,
      }, [controller, signer], controller);
    },
  },
};
