/**
 * x402 payments from a policy-limited smart wallet on Stellar.
 *
 * - `client`: the paying side, for an agent whose payer is the wallet.
 * - `facilitator`: facilitators that accept the wallet as payer, on Testnet and on a local network.
 * - `gate`: a payee's own check on the paying agent.
 * - `resource`: a paid resource over `node:http`, served by x402's resource server.
 */
export * from './networks.js';
export * from './client.js';
export * from './facilitator.js';
export * from './gate.js';
export * from './resource.js';
