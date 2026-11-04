# Adversarial

Authorization, replay, limits and rollback acceptance cases are listed in docs/REQUIREMENTS.md. Their original placeholders use `.planned.ts` until executable behavior exists. Real `.test.ts` cases in this directory run under `npm run test:integration` against the isolated local network. They must not depend solely on mocked authorization.
