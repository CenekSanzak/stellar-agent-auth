# ERC-8126 and ERC-8196 compatibility

**Specs:** [ERC-8126](https://eips.ethereum.org/EIPS/eip-8126) (AI Agent Verification) and
[ERC-8196](https://eips.ethereum.org/EIPS/eip-8196) (AI Agent Authenticated Wallet).

**Whose view this is.** This document was written by the
[Stellar Agent Services](https://github.com/AlgoriaLabs/stellar-agent-services) project. It describes what that
project needs from Stellar implementations of ERC-8126 and ERC-8196, and this repository is one such implementation.
"Stellar Agent Services", "the provider verifier" and "the payment client" mean that project; "this repository"
means stellar-agent-auth. Everything marked **Proposed** is that project's proposal, not a decision made here.
[Where this repository stands](#where-this-repository-stands) records what is and is not implemented.

## Goal

Implement Stellar versions of these standards with interfaces both projects can share, so that future integrations
fit together.

## How the layers fit

| Layer | Question it answers | Score | Built by |
| --- | --- | --- | --- |
| Stellar 8004 (ERC-8004) | Who is this agent? | – | `stellar-8004` (exists) |
| ERC-8126 | Is this agent safe? | risk 0–100, **lower is better** | this repository |
| Provider Standard verifier | Does this service follow the standard, take payment correctly and recover jobs? | conformance 0–100, **higher is better** | Stellar Agent Services |
| ERC-8196 | Is this action allowed right now? | – | this repository (on-chain); the payment client enforces off-chain first |
| x402 | How is the service paid? | – | public `@x402/*` packages |

- **Complementary, not overlapping.** The provider verifier's checks (C1–C6) test conformance, while ERC-8126 tests
  security risk. They overlap in two places:
  - ERC-8126 Web Application Verification touches C1 and C6 (HTTPS, reachability).
  - ERC-8126 Wallet Verification touches C4 (the `payTo` wallet).
- **No compliance claim.** Stellar Agent Services never presents its receipts as ERC-8126 results. This repository
  does not claim full ERC-8126 or ERC-8196 compliance either; see
  [verification coverage](VERIFICATION_COVERAGE.md).

## Ethereum to Stellar mapping

Both projects need this table. Where they pick different answers, their code stops fitting together.

| ERC concept | Stellar equivalent |
| --- | --- |
| `uint256 agentId` | Stellar 8004 `agent_id: u32` |
| `address` | strkey: `G…` account or `C…` contract |
| Chain id / EIP-155 | CAIP-2 `stellar:testnet` / `stellar:pubnet` plus the network passphrase |
| EIP-712 typed data | Soroban authorization entries for on-chain actions; SEP-53 signed messages off-chain |
| EIP-3009 gasless USDC | x402 `exact` scheme on Stellar: a signed auth entry and a fee-sponsoring facilitator |
| ERC-4337 smart account | Soroban custom account contract (`__check_auth`) |
| `keccak256` | `sha256` (native in Soroban; `BytesN<32>` in the registries) |
| Value limits in `wei` | Per-asset `i128` amounts (USDC uses 7 decimals) |
| `agentWallet` | Stellar 8004 `get_agent_wallet(agent_id)` |
| `eth_getCode` (ETV, SCV) | Soroban contract instance and Wasm hash; SAC or SEP-41 for tokens |

ETV and SCV are Ethereum/Solidity-specific. Their Stellar versions (Soroban Wasm) are for this repository to
define.

## Touchpoints

### T1. Agent identity and the registration file

- **Same starting point.** Both projects start from `agent_id`, then the registration JSON. ERC-8126 does not
  allow verifying from loose parameters.
- **Proposed: `payTo` equals the on-chain `agent_wallet`.**
  - ERC-8004 defines `agentWallet` as "the address where the agent receives payments".
  - With this rule, ERC-8126 Wallet Verification assesses exactly the address that users pay.
  - The provider verifier enforces it in C2.
- **Registration file fields.** The provider's registration file lists the Stellar Agent Services manifest under
  `services`. It keeps the standard ERC-8004 fields (`image`, `services[].endpoint`), so an ERC-8126 resolver finds
  the HTTPS endpoint without knowing that manifest format.

### T2. Validation Registry records

The two scores run in opposite directions:
- **ERC-8004 `response`:** 0 means failed and 100 means passed, so higher is better.
- **ERC-8126 risk score:** 0 is the lowest risk, so lower is better.

Stellar's `get_summary` with an empty tag averages *all* records for an agent. One raw risk score would therefore
corrupt every average.

**Proposed:**
- `response` is always higher-is-better. ERC-8126 posts `100 − overallRiskScore`. The raw risk score and the proof
  ids go in the response document.
- Each standard uses its own tag. The provider verifier's is `provider-standard-v1`; ERC-8126 uses e.g. `erc8126` or one tag per type
  (`erc8126-wav` and so on).
- Response documents share an envelope:
  - `standard`, `agentId`, `network`, `validator`, `checkedAt`
  - `score`, `scoreDirection`
  - `results[]`
  - evidence links
- Hashing is shared:
  - `response_hash = sha256(RFC 8785 JCS(document))`
  - `request_hash = sha256(JCS(request document))`
  - Both projects use the same canonicalization, so a third party can recompute either hash.

### T3. Reading a risk score

ERC-8196 gates actions on `getLatestRiskScore(agentId)`. The payment client and Stellar Agent Search will want the
same value.

**Proposed:** this repository does one of two things:
- exposes `get_latest_risk_score(agent_id) -> Option<u32>` on a Soroban contract, or
- documents exactly how to derive it from the Validation Registry (validator address plus tag).

Stellar Agent Services reads it through one small interface (a "risk source"), so either choice works and neither
project depends on the other's code.

### T4. Payment policy

This is input to the payment client design, which is still open.

ERC-8196's policy is close to the payment client's "spending controls": a per-transaction cap, a daily cap, a validity window,
allow and block lists, and a verification gate. Applied to x402 on Stellar, it has four gaps that need a shared
answer:

1. **Limits are in native value (`wei`).** x402 pays USDC through the token contract's `transfer`, so the native
   value is 0. Limits must be per asset.
2. **`allowedContracts` would only ever contain the USDC contract.** The real payee is an argument of `transfer`.
   The policy needs payee allow and block lists.
3. **The ERC-8126 gate checks the *acting* agent**, which is the policy's `agentId`. In the x402 flow the risk that
   matters most is the *payee* (the provider). The policy needs a payee-side gate, e.g. a maximum provider risk or a
   required `provider-standard-v1` record.
4. **The name `minVerificationScore` is misleading.** It is actually a *maximum* risk score.

**Proposed for the policy:** whichever design is chosen, the payment client's policy uses ERC-8196 field names plus
named Stellar extensions. The same policy can then be registered on an ERC-8196 smart account later.

**Proposed for the journal:** ERC-8196 requires a hash-chained audit trail (`previousHash`). The payment client
journal uses the same entry chain.

### T5. Paying x402 services from an ERC-8196 smart account

`@x402/stellar` 2.28.0 looks compatible:
- The facilitator checks the payer's auth entries by simulation.
- It accepts any address credential, not only `G…` accounts (`validateAuthEntries`).
- The client signer has the SEP-43 shape (`address`, `signAuthEntry`).

So, in principle, a Soroban smart account whose `__check_auth` enforces an ERC-8196 policy can pay x402 services
with no provider-side change.

The facilitator imposes these constraints:
- the auth tree has no sub-invocations
- signature expiry stays within its ledger bound
- the facilitator is not in the auth entries

The policy check runs inside `__check_auth`, which is outside the auth tree, so these should hold.

**Not verified yet.** This needs a testnet spike, run jointly by both projects.

## What Stellar Agent Services does and doesn't do

**Does** (cheap, and keeps the door open):
- C2 checks that `payTo` equals `agent_wallet` (T1).
- Validation records are higher-is-better, use their own tag, and are hashed with JCS (T2).
- A risk-source interface with no dependency on this repository (T3).
- Payment client policy and journal formats aligned with ERC-8196, once that design is chosen (T4).

**Doesn't do:**
- ERC-8126 checks, zero-knowledge proofs (PDV) or QCV
- an ERC-8196 contract
- make any of its SOW deliverables wait on this repository's timeline

## Open questions for this repository

1. The score direction and tag names in the Validation Registry (T2).
2. An on-chain risk-score contract, or a score derived from the registry (T3)?
3. The Stellar profiles for ETV and SCV.
4. The policy extensions: per-asset limits, payee lists, a payee gate (T4).
5. Which smart-account base it will build on, and when a testnet x402 spike is possible (T5).

## Where this repository stands

As of 2026-11-25. Apart from T5, none of the proposals above has been accepted or rejected here, and none of the
open questions is answered. This section only records what the code does today.

| Touchpoint | In this repository today | Fits the proposal? |
| --- | --- | --- |
| Mapping: agent identity | Its own agent registry allocates `u64` agent IDs. It does not resolve identities from Stellar 8004. | No |
| T1: registration file | Metadata schema v1 has `name`, `description` and `endpoints`. It has no `payTo` or agent wallet field. | No |
| T2: validation records | Results live in this repository's verification registry, with risk 0–100 where lower is better. Nothing is posted to a Validation Registry. The evidence hash is the SHA-256 of the verifier's own canonical JSON report, which has not been compared with RFC 8785. | No |
| T3: reading a risk score | `latest`, `current` and `check` are keyed by agent ID, identity revision and provider. There is no `get_latest_risk_score(agent_id)`. | No |
| T4: per-asset limits | Per-transfer and per-UTC-day caps for each asset contract, and an optional total for the policy's life | Yes |
| T4: payee lists | Recipient allow and block lists; an empty allowlist permits nothing | Yes |
| T4: risk threshold name | `max_risk_score`, an inclusive maximum | Yes |
| T4: payee-side gate | The wallet checks only the acting agent's verification, never the recipient's | No |
| T4: audit trail | Every owner action and execution extends a hash chain whose head is stored on-chain | Yes |
| T5: paying x402 services | The wallet is also a custom account. Its `__check_auth` authorizes one plain `transfer` of a policy asset under a policy, signed by the agent key, on the same budget as `execute` ([ADR 0007](decisions/0007-account-payment-path.md)). Tested on a local network and on Testnet with a relayer that knows nothing of the wallet; not tested with a real x402 client. | Partly |

The rules behind these rows are in [the wallet decision](decisions/0005-smart-wallet.md),
[the verification registry decision](decisions/0004-verification-registry.md) and
[verification coverage](VERIFICATION_COVERAGE.md). On 2026-11-25 a spike showed that a custom account can enforce such a policy as the payer of a plain transfer, on
a local network and on Testnet, and the project decided to add that path to the wallet
([ADR 0006](decisions/0006-custom-account-spike.md)). The wallet has it since then and has paid that way on Testnet
([P9 validation](P9_VALIDATION.md)); what is still missing for T5 is a run against a real x402 client. The request is tracked in
[issue #2](https://github.com/CenekSanzak/stellar-agent-auth/issues/2).
