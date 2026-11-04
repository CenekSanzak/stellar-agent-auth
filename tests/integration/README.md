# Integration

From the root, run `npm run build:contracts`, `npm run dev` and `npm run test:integration`. The local suites check RPC readiness, run the Phase 1 sponsored transfer and authorization mutation tests, and run the P2 agent registry flow in `agent-flow.test.ts` with real controller, signer, new-signer and sponsor signatures ([results](../../docs/P2_VALIDATION.md)). Verification and policy enforcement flows arrive in P3–P4. Shared local-network helpers live in `support/`.

The `.planned.ts` files preserve the original scenario notes and are intentionally not discovered as executable tests. Replace them with real `.test.ts` suites as the behavior lands. Empty executable suites fail.
