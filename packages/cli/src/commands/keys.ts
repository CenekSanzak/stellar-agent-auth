import { createNamedKey, keyDirectory } from '@stellar-agent-auth/sdk/node';
import type { Command } from '../index.js';
import { UsageError, required } from '../runtime.js';

/**
 * Local key management for development networks. Keys are written owner-only into the key directory and are only
 * ever referenced by name or path; secrets are never printed or accepted on the command line.
 */
export const keysCommands: Record<string, Command> = {
  create: {
    summary: 'Generate a named key: --name <name> [--fund] (Friendbot, local and testnet only)',
    options: { name: 'string', fund: 'boolean' },
    async run(runtime, values, flags) {
      const name = required(values['name'], 'name');
      let address: string;
      try {
        address = await createNamedKey(name, runtime.env);
      } catch (error) {
        if ((error as { code?: unknown }).code === 'EEXIST') throw new UsageError(`Key ${name} already exists`);
        throw error;
      }
      if (flags['fund']) await runtime.server.requestAirdrop(address);
      return { name, address, directory: keyDirectory(runtime.env), funded: Boolean(flags['fund']) };
    },
  },
  address: {
    summary: 'Print the public address of a key reference: --key <reference>',
    options: { key: 'string' },
    async run(runtime, values) {
      return { address: (await runtime.key(values['key'], 'key')).address };
    },
  },
  fund: {
    summary: 'Fund a key with Friendbot (local and testnet only): --key <reference>',
    options: { key: 'string' },
    async run(runtime, values) {
      const { address } = await runtime.key(values['key'], 'key');
      await runtime.server.requestAirdrop(address);
      return { address, funded: true };
    },
  },
};
