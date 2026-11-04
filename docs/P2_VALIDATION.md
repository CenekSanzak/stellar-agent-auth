# P2 validation

On 2026-11-04, `npm run check` passed with 85 TypeScript unit tests in three files, 17 Rust tests and five WASM builds. The typecheck, Rust format check and clippy with warnings denied also passed. On a freshly started protocol 29 Quickstart, the local suite passed 12 tests in three files: 10 agent registry tests plus the P1 authorization and network tests.

An independent rerun after the workflow repeated `npm run check` with the same counts. Its first local run failed before any registry call: Friendbot answered HTTP 502 because `local:ready` waited only for RPC, and Friendbot starts several seconds later. `scripts/local-ready.mjs` now also waits until Friendbot answers an address-less request with 400, which funds nothing. Two consecutive runs on fresh networks then passed all 12 local tests. The CI local-network job uses the same script.

To reproduce, run `npm run check` and start the network with `npm run dev`. Then run `npm run test:integration -- --disableConsoleIntercept` to print the resource measurements, and remove the network with `npm run local:down`. The controller, signer, new signer, sponsor and attacker keys are generated at runtime and funded by the local Friendbot. No key material is committed, and nothing was deployed to a public network.

P2 is in commits 297ff05 and a6c379a. The subject of a6c379a names P3, but the commit contains only P2 work. The validated tree was a6c379a plus uncommitted review fixes to eight code and test files and the readiness script; `git diff a6c379a -- . ':!*.md' | shasum -a 256` printed `3ea8241f9b309c7952cc0721fb2f2cb43357ad52c9f136208949bbaceca9026b`. The registry WASM is 8,633 bytes with SHA-256 `5502b1e0f0bbbcdc1b74312b91d3e0aed96b166a32e2b2bbdd4681184ce6cf8a`. It exports the eight entry points in [the registry decision](decisions/0003-agent-registry.md).

## Host and SDK tests

The 14 registry host tests cover sequential IDs, invalid roles, metadata bounds, ID and revision overflow, the `NotFound`, `IdentityChanged` and `Duplicate` transitions, disable and reactivate, recovery while disabled, and TTL extension by every entry point. Enforcing mocks with contract-address controllers show that the call fails without the controller, and that an attacker or the agent signer cannot change an identity. Host mocks cannot authorize standard accounts, so these tests check signer and new-signer authorization by comparing `env.auths()` with the exact expected invocations. The shared-types metadata test and the SDK's metadata table cover the same boundaries. The 70 tests in `tests/unit/agents.test.ts` also cover strict identity decoding, the error names parsed from `errors.rs` and the authorization validator, which never calls the signer for a mismatched entry.

Mutation runs on scratch copies were all caught. Eight contract mutants included requiring the signer before the account check, dropping or unbinding the controller's authorization, and reordering or weakening the checks in `rotate_signer`. Five SDK mutants changed the method-name check, the account check, the metadata character bounds and the zero-hash check.

## Signed registry flow

The sponsor is the transaction source and signs only envelopes. Each role signs its own recording-mode authorization entry through `signRegistryAuthorization`. Every confirmed mutation is decoded strictly and matches both `get` and its `identity_v1` event.

- The first submitted call extends the new instance to exactly 30 days and the WASM code to at least 29 days. A new identity entry is live for 30 days.
- Agent 1 registers with controller and signer authorization and reads back through `get`, `current` and `agent_count` at revision 1. A metadata update moves it to revision 2, rotation with the new signer's authorization to 3, `disable` to 4 and `reactivate` to 5. Agent 2 registers with a 2,048-byte URI.
- After each change, `current` for the previous revision returns `IdentityChanged`. While the agent is disabled, `current` returns `Revoked`. After reactivation, revisions 1–4 all return `IdentityChanged`.
- An update signed at revision 3, which had simulated successfully, fails with `IdentityChanged` after `disable`. A freshly signed update for revision 3 still fails after reactivation.

## Rejections

Each authorization failure matches its expected host cause and failing address, so an expiry, budget or contract error cannot pass for one. The local RPC rejects:

- reuse of the confirmed registration's entries, through the existing nonce;
- registration without the signer's entry, with the signer's entry signed by the controller's key, or without the controller;
- an update whose controller entry is signed by the attacker, agent signer or sponsor key, an attacker's own credential and the sponsor's source-account credential;
- `disable` signed by the attacker, and rotation to the attacker's key with every entry signed by the attacker;
- rotation without the new signer's entry, or with that entry signed by the controller's key.

For a forged controller signature the host diagnostic quotes an internal contract code, and the SDK does not report it as a registry error. The SDK precheck and the contract both return `InvalidInput` for the controller or a contract as signer, and on chain the controller's signature alone reaches that error. A 2,049-byte URI (`LimitExceeded`), an `http://` URI and a zero hash (`InvalidInput`) fail before signing. With valid signatures over the raw arguments, they also fail inside the contract for `register` and `update_metadata`. With the controller's signature, rotation to the controller returns `IdentityChanged` at stale revision 2 and `InvalidInput` at revision 3. Repeating the current metadata, signer or disabled state returns `Duplicate`.

## Resource measurements

The values are simulated resource declarations and committed event XDR lengths, checked against the protocol 29 limits read from the local network. These limits match the [P1 record](P1_VALIDATION.md). The fees come from local simulation and exclude the base inclusion fee.

| Resource | Register, 43-byte URI | Register, 2,048-byte URI | Transaction limit |
| --- | ---: | ---: | ---: |
| Identity value, XDR bytes | 352 | 2,356 | — |
| Signed envelope, XDR bytes | 1,752 | 7,764 | 132,096 |
| Committed event XDR bytes | 436 | 2,440 | 16,384 |
| CPU instructions | 2,452,859 | 3,104,828 | 400,000,000 |
| Disk read bytes | 288 | 288 | 200,000 |
| Write bytes | 752 | 2,756 | 132,096 |
| Write entries | 4 | 4 | 200 |
| Footprint entries | 7 | 7 | 400 |
| Largest changed entry, XDR bytes | 448 | 2,452 | 65,536 |
| Minimum resource fee, stroops | 261,217 | 1,224,848 | — |

The first submitted call on the new deployment, `agent_count`, extended the instance and code. It used 475,390 instructions, a 348-byte envelope and two footprint entries, with no writes or events. Its minimum resource fee was 26,059,211 stroops. An earlier development run on a reused network, where the code entry had already been extended, measured 46,003 stroops for that call. Most of the fee is therefore rent for newly uploaded code, paid by whoever submits first. The costs of update, rotation, disable and reactivate were not measured, and neither were Testnet fees.

## Limits

- A02 is only partly shown. The registry rejects requests signed for an earlier revision, and `current` rejects old and disabled revisions. No verification result or policy exists yet, so P3 and P4 must show that old results and already signed old-policy requests fail.
- No Testnet deployment exists. The first Testnet registration, with recorded IDs and transaction links, belongs to P3's checkpoint.
- Rejections are full-check simulations against the live ledger, as in P1, not failed submitted transactions.
- Real account signatures appear only in the local flow. The host tests rely on mocks and `env.auths()`.
- A contract-address new signer without its own entry fails with a host authorization error rather than `InvalidInput`, because `rotate_signer` requires the new signer before validating it.
- TTL extension is tested, but archival and restoration are not.
