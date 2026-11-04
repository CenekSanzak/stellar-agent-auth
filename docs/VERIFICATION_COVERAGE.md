# Verification coverage and scoring

This document states what the project's verifier checks, how it scores results, and which [ERC-8126](https://eips.ethereum.org/EIPS/eip-8126) features this release does not provide. The contract rules are in [ADR 0004](decisions/0004-verification-registry.md).

## What a passing result means

A passing result means that, at its issue time, the registered metadata matched its hash and the v1 schema, the declared endpoints answered over verified TLS, and the registered signer account existed and could authorize with its own key. It does not mean the agent is safe, that its code or decisions are sound, or that it will behave the same in future. Unsupported checks are reported as `Unsupported`. They are never counted as passes.

## Check coverage

| `CheckKind` | ERC-8126 area | This verifier | Outcomes and scores |
| --- | --- | --- | --- |
| `Metadata` | Agent registration file | Fetches only the registered URI and compares SHA-256 of the original bytes with the registered hash before parsing. Parses only a match, against the strict v1 schema. | `Passed` 0 on a match with a valid document. `Failed` 100 on a hash mismatch, an invalid document, or a URI that cannot be fetched safely (TLS, private address, redirect, size). `Inconclusive` on a timeout, network, DNS or HTTP-status failure. |
| `Endpoint` | Web endpoint verification | One `HEAD` request per declared endpoint, under the same fetch protections. | `Passed` 0 if every endpoint answers below HTTP 500 over verified TLS 1.2 or 1.3. `Failed` 100 otherwise. `NotApplicable` with no endpoints, and `Inconclusive` without verified metadata. |
| `SignerAccount` | Wallet verification | Reads the signer's account entry through RPC. | `Passed` 0 if the account exists and its master key weight is nonzero and at least the medium threshold, which Soroban account authorization requires. `Failed` 100 otherwise. |
| `SignerHistory` | Wallet history | Estimates account age from the sequence number: a new account starts at `creation_ledger << 32`, and bumping only makes it look younger. | `Passed` 0 when at least 17,280 ledgers (about one day) old. `Inconclusive` when younger or missing. Never `Failed`. |
| `ThreatFeed` | Wallet threat intelligence | Not implemented. | `Unsupported`. The verifier never sets serious wallet-risk flags. |
| `Token` | Token verification | Not implemented. | `Unsupported` |
| `Media` | Media verification | Not implemented. | `Unsupported` |
| `Code` | Code verification | Not implemented. | `Unsupported` |

Every live result reports all eight kinds. A policy that requires an unsupported, inconclusive or not-applicable check therefore always denies.

## Scoring

- Each implemented check scores 0 when it passes and 100 when it fails. `Inconclusive`, `NotApplicable` and `Unsupported` checks have no score.
- The result's `risk_score` is the integer ceiling of the mean of the scored checks: one failure among three scored checks gives 34. With no scored check, `risk_score` is absent, never zero.
- The registry recomputes the aggregate and rejects a mismatch, and rejects a score on an unassessed check. A policy's `max_risk_score` is inclusive. An absent aggregate fails every threshold.
- The serious wallet-risk flags (known compromise, confirmed malicious activity, threat-feed match) deny regardless of the aggregate. This release has no adapter that can set them; only fixture providers publish flagged results, in tests.

## Fixture results

`tests/fixtures/verification.ts` builds deterministic passing, failed-endpoint, high-risk and seriously flagged results. They are published only by providers approved for `Fixture` mode. The registry rejects fixture results from live providers and live results from fixture providers. Fixture evidence hashes commit to a `SIMULATED fixture` label, not to a report. Fixture results are not assessments of any agent, and the demo policy must not treat a fixture provider as an independent assessment.

## Metadata schema v1

```json
{
  "schema": "stellar-agent-auth/agent-metadata/v1",
  "name": "1 to 128 characters",
  "description": "optional, at most 1,024 characters",
  "endpoints": [{ "name": "1 to 64 characters", "url": "https://host/path" }]
}
```

The document must be UTF-8 without a byte-order mark. Unknown fields are rejected. At most four endpoints are allowed, each with a unique HTTPS URL on the default port, at most 2,048 bytes long and without credentials or a private IP literal. Metadata is limited to 64 KiB, endpoint responses to 16 KiB, every request to 10 seconds, and each request to three redirects.

## ERC-8126 features not provided

- Privacy proofs and verifiable computation over the report. The evidence hash links a result to a stored report; it proves nothing about how the report was produced.
- Token, media, code and threat-intelligence checks, as listed above.
- ERC-8004 identity resolution. Identities come from this project's Stellar agent registry.
- Provider reputation, aggregation across providers, and on-chain report storage.
