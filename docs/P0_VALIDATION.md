# P0 validation record

Local validation on 3-4 November 2026. No commits, pushes or public deployments were performed. Remote GitHub Actions have not run; the workflow is prepared for a later owner-authorized push.

| Check | Result |
| --- | --- |
| Clean npm ci with package-lock.json | Passed |
| Typecheck of workspaces, tests and deployment source | Passed |
| All six TypeScript workspace builds | Passed |
| Built SDK import through package exports | Passed |
| Fast TypeScript tests | 10 passed |
| Empty Vitest discovery | Correctly exits with code 1 |
| Public Testnet test without opt-in | Correctly exits with code 1 |
| Explicit read-only Testnet preflight | 1 passed; network protocol compatible with 29 |
| Pinned Docker Compose local node | Started; health, network and protocol-29 test passed |
| Native Rust Soroban host test | 1 passed; other crates still have no business tests |
| Locked Stellar CLI WASM build | Four artifacts built; demo-service exports probe; three business contracts have no entry points |
| Final Rust check / format / clippy / non-empty runner | Passed with pinned Rust 1.98.0; clippy denies warnings |
| git diff --check | Passed |

Rust checks, host tests and WASM builds passed with Rust 1.98.0, including the version-named pinned toolchain. Node and Stellar CLI were downloaded to a temporary tool directory for local verification; follow DEVELOPMENT.md to install them persistently. Docker was started for the local-network test and the temporary Compose container is cleaned up afterward.

These are infrastructure checks only. Real signed agent authorization, custody/policies, provider verification and business acceptance A01-A30 are future phases. No P0 probe result implies those features exist.
