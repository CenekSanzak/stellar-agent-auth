# ADR 0001: P0 foundation and v1 direction

Status: accepted for P0 infrastructure; domain decisions below remain proposed until P1's signing/ABI spike.

## Tooling and topology

Use npm workspaces, exact direct dependency versions and committed lockfiles when the owner chooses to commit. Use Node 24 LTS, Rust 1.98, Soroban SDK 29.0.1 and CLI 30.0.1. Testnet reports protocol 29; local Quickstart is digest-pinned and explicitly runs protocol 29. CLI version is a build tool version, not the contract's protocol version. No automated dependency upgrade may change the protocol baseline without rerunning local compatibility tests.

Keep the two registries and one wallet per owner. Keep shared types a normal library; the four eventual contracts are cdylib/rlib crates. P0 adds only a non-economic demo-service probe so CI can verify Soroban host dispatch. It confers no permissions or custody behavior.

Use Vitest projects to separate deterministic, local-network and explicit public Testnet checks. Zero discovered tests fail. Placeholder scenarios are not tests. CI builds WASM with the official CLI, not a raw cargo WASM build.

## Proposed v1 contract decisions (P1 must validate)

- Native address authorization over complete invocation arguments; standard account signers first. Owner, controller, agent, provider and sponsor are distinct roles. A sponsor pays fees without signing agent actions.
- Atomic owner-authorized construction and immutable registry references; no contract upgrade entry point in v1.
- Canonical versioned XDR and domain-separated SHA-256 for policy/action/audit hashes. Amounts use checked i128 and bigint; JSON transports decimal strings.
- Controller/signer proof for identity creation and signer rotation. Identity changes increment a revision and invalidate old authority.
- Approved providers publish monotonic assessments; execution reads the latest result for the policy's provider and identity revision. A newer failure supersedes a pass; serious wallet flags block regardless of aggregate risk.
- Required checks must pass. Unsupported coverage, fixture results and real limited checks are explicitly distinguished. No full ERC-8126 or ERC-8196 compliance claim.
- Owner-defined per-policy/per-asset budgets, UTC day boundaries, exact action sequence, exclusive expiry and irreversible revocation. Empty allowlists deny and blocks override allows.
- A downstream failure rolls back balances, counters, sequences and audit head. Security records persist across archival/restoration; missing records never recreate active defaults.
- Bounded policies/checks, persistent per-record state, TTL maintenance, versioned hash-linked audit events and a durable indexer with explicit retention-gap reporting.
- First deliver the transfer flow; arbitrary execution, privacy proofs, entropy protocols and credential delegation remain deferred. The restricted service adapter remains P9, required for full README milestone 3.

Detailed field definitions, preliminary caps and gates remain in IMPLEMENTATION_PLAN.md section 3. Freeze them only after P1 proves signing, cross-language vectors and resource costs.

## Operational follow-up

R9: local Git remote configuration was observed to embed a token. The owner should rotate it and use a credential manager. P0 does not change local credentials or copy their values. Never print credential-bearing remote URLs in diagnostics.
