# Adversarial

Authorization, replay, limits and rollback acceptance cases are listed in docs/REQUIREMENTS.md. The `.test.ts` suites here run under `npm run test:integration` against the isolated local network with real account signatures. They must not depend solely on mocked authorization.

- `authorization.test.ts`: the signed-entry mutation matrix, other keys, networks and wallets, replay and duplicate actions, authorization expiry and request deadlines, the agent or sponsor acting as owner, and funding signature binding (A08, A11–A13).
- `limits.test.ts`: per-transfer and daily caps, non-positive amounts, unapproved assets, blocked recipients, empty allowlists, policy windows and two requests racing for one sequence (A13–A17).

Both build on `../integration/support/wallet-world.ts`. Results are in [P4 validation](../../docs/P4_VALIDATION.md).
