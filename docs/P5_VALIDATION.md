# P5 validation

P5 is the SDK transaction pipeline, the fee sponsor and its `submitter` process, the `stellar-agent-auth` CLI and `examples/payment-flow.ts`. Its code was committed on 2026-11-05 (`eec515b`). CI passed on that commit the same day, including the local-network job, but no validation record was written. This record covers a local run on 2026-11-20 and the review that preceded it.

## What was run

On 2026-11-20, on macOS arm64 with Node 24.22.2, Rust 1.98.0, Stellar CLI 30.0.1 and the pinned protocol 29 Quickstart:

| Tree | `npm run check` | Local network (`npm run test:integration`) |
| --- | --- | --- |
| `eec515b` in CI (GitHub Actions run 42035022307, 2026-11-05, ubuntu-24.04) | Passed | Passed: 9 files, including the payment flow |
| `eec515b` as committed | Passed, with its steps run one at a time: 412 unit tests in 13 files, 73 Rust tests, five WASM builds, 3 spec tests | Passed: 50 tests in 9 files |
| With the changes below | Passed: 420 unit tests in 13 files, 73 Rust tests, five WASM builds, 3 spec tests | Passed: 50 tests in 9 files |

The 50 local tests are the 43 from P1–P4, six in `tests/adversarial/sponsor.test.ts` and the CLI payment flow in `tests/integration/payment-flow.test.ts`. Each tree was run once locally; flakiness over repeated runs was not measured. The contracts are unchanged since P4, and their WASM sizes match the [P4 record](P4_VALIDATION.md).

To reproduce: `npm run check`, `npm run dev`, `npm run test:integration`, `npm run local:down`.

## P5 gate

> A fresh-checkout CLI example completes the whole transfer flow with real local-network signatures and separate roles. The sponsor cannot mutate the action or gain authority. Unknown transaction status never appears as success or causes an automatic duplicate payment.

| Gate item | Evidence | Status |
| --- | --- | --- |
| CLI example completes the flow with separate roles | `payment-flow.test.ts` runs the built CLI and submitter as separate processes: registration, a real verification by a `Live` provider, funding, policy approval, a sponsored 3-unit payment, revocation, and refusal of a request signed before the revocation. Every role is a different account and the transcript holds no secret. | Met locally |
| Sponsor cannot mutate the action or gain authority | `tests/adversarial/sponsor.test.ts` on the local network; `tests/unit/sponsor.test.ts` for admission. Source-account credentials and entries for the sponsor's own address are refused before simulation. | Met locally |
| Unknown status never appears as success | `tests/unit/pipeline.test.ts` for the direct pipeline. For the sponsored path this did not hold as committed; see finding 4. | Met after the changes below |
| Unknown status never causes an automatic duplicate payment | Did not hold as committed; see finding 1. One path is still open; see "Still open". | Partly met |

The payment flow test fetches the agent metadata from `raw.githubusercontent.com`, so this gate depends on a public host. That contradicts requirement F07 and is listed under "Still open".

## Findings from the review, and what changed

The committed P5 code passed its tests, so these are defects the tests did not cover. Four were confirmed by reading the code path and are fixed here, each with a unit test.

1. **Repeating a command after an uncertain outcome paid twice.** When a status query failed, the CLI exited 75 and told the user to "rerun the same command later". The rerun settled the earlier transaction silently, read the next policy sequence and signed a second payment. There was no command to query a hash.
   - `Runtime.settleEarlier` now stops a command when an earlier submission in its scope settled during this run. It reports that outcome with exit code 76 and signs nothing. A deliberate rerun then proceeds.
   - `tx status --hash <hex>` settles a journaled transaction without submitting anything.
   - The messages for exit 75 name `tx status` and no longer suggest a rerun.
2. **A paying source's authorization was not inspected.** When the signer was also the transaction source, simulation recorded source-account credentials, and these were passed through unchecked. The envelope signature then authorized the whole recorded tree. A hostile contract in the call path, such as an asset named in `wallet withdraw`, could add a nested transfer out of the owner's account. Sponsored calls were not affected.
   - Every domain invocation now carries a tree check per account (`Invocation.checks`), and `authorizeEntries` applies the source's check to a source-account entry. A source without a check may authorize nothing, which also covers a third-party `--source` fee payer.
   - Deployments use `contractDeployment`, whose check admits the creation and the contract's own constructor only. The local payment flow exercises it with the real recorded tree for both registries and the wallet.
3. **`verify revoke --dry-run` revoked.** Revocation is terminal. `keys create`, `keys fund` and `execute sign` ignored the flag too. A command whose effect cannot be simulated now declares `dryRun: false`, and `--dry-run` is refused for it before anything runs.
4. **The sponsored client trusted the sponsor's report.** It took the transaction hash, envelope and time bound from the sponsor's answer. A sponsor could report another transaction's success as this one, or report a rejection while keeping a valid envelope.
   - `verifiedSponsorRecord` requires the envelope to be a plain transaction from the sponsor carrying exactly the signed operation, with the reported hash. The time bound is read from the envelope.
   - The outcome is then read from the network. A reported `rejected`, `expired` or `success` that the network does not yet show is `SubmissionUnsettled` (exit 75).
   - `execute transfer` and `execute submit` compare the action hash the wallet returns with the request's.
   - The HTTP client treats only a 4xx as a refusal. A 5xx or a lost connection is `SponsorOutcomeUnknown` (exit 75), with the ledger until which the signed operation stays valid. The submitter answers 409, not 503, when it is busy settling.

Three smaller fixes:

- `policy approve` and `policy replace` fail if the hash the wallet stored differs from the one computed locally, instead of printing the local one.
- A key reference is never echoed in an error, and anything shaped like a secret seed is refused, including a mistyped or quoted one.
- The verifier no longer writes a resolved private address into a report, where it would map the verifier's network.

## Still open

Found in the same review and not fixed yet. None was shown to let a sponsor or a third party move funds.

- **Lost sponsor response.** The client learns the transaction hash only from the sponsor's answer. If the answer is lost, nothing is journaled and the CLI exits 75 with the expiry ledger. A user who signs a new request before that ledger can pay twice. Closing this needs a lookup on the submitter by operation hash.
- **Non-hermetic gate test.** `payment-flow.test.ts` needs a public host; serve the metadata from a local HTTPS fixture.
- **`SUBMITTER_URL` captures every mutating command.** Owner commands are then sent to a sponsor that refuses them. The example works around it; the CLI needs an explicit direct mode.
- **Journal.** The default location is relative to the working directory, records carry no network name, writes are not fsynced, and there is no command to acknowledge a permanently `unknown` record.
- **Sequence numbers.** The sponsor serializes submissions within one process only. Two processes on one key collide with `txBAD_SEQ`; neither pays twice.
- **Verifier publication** uses its own transaction path, without the SDK's fee ceiling or journal.
- **Sponsor budget.** There is a per-transaction fee ceiling and a per-address rate limit, but no total budget.
- **Packaging.** The SDK installs outside the workspace (`npm run check:sdk-package`); the CLI and submitter do not.
- **Evidence gaps.** No test submits two simulation-valid requests for one sequence where only the sequence check can stop the second; A17's local test would pass on the daily cap alone. On-chain failure codes are decoded only from hand-built events. The verifier's real HTTPS transport runs only on the payment flow's success path.

## Acceptance cases

| ID | Evidence | Status |
| --- | --- | --- |
| A24: sponsor tampering | Admission refuses rewritten, re-pointed and sponsor-signed entries (`tests/unit/sponsor.test.ts`, `tests/adversarial/sponsor.test.ts`). The client rejects a report it cannot tie to its own operation. | Shown |
| A24: sequence collision | In-process serialization is tested with a fake RPC. Two processes on one key are not tested. | Partial |
| A24: uncertain submission and retry | Direct pipeline: send failures, retention gaps and unreadable status are tested with a fake RPC, and a rerun after settlement stops (finding 1). Sponsored: a lost response is reported but not recoverable (see "Still open"). | Partial |
| A28: SDK import from outside the workspace | `scripts/check-sdk-package.mjs` | Shown |
| A28: CLI example | `payment-flow.test.ts` on the local network | Shown locally |
| A28: browser smoke | None; the demo is P7. | Missing |
