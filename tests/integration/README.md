# Integration

From the root, run `npm run build:contracts`, `npm run dev` and `npm run test:integration`. The local suites check RPC readiness and run the Phase 1 sponsored transfer and authorization mutation tests. Signed registry and policy enforcement flows arrive in P2–P4.

The `.planned.ts` files preserve the original scenario notes and are intentionally not discovered as executable tests. Replace them with real `.test.ts` suites as the behavior lands. Empty executable suites fail.
