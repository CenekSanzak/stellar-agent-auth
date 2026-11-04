# Integration

Run `npm run dev`, then `npm run test:integration` from the root. P0 includes an actual local RPC readiness/protocol check in tests/local. Signed registration and wallet flows arrive in P1-P5.

The `.planned.ts` files preserve the original scenario notes and are intentionally not discovered as executable tests. Replace them with real `.test.ts` suites as the behavior lands. Empty executable suites fail.
