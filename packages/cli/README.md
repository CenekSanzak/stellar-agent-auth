# CLI

`stellar-agent-auth` runs the SDK workflows from a terminal: agent registration, verification, wallet and policy management, agent payments and audit history. It works against the local network and Testnet. Validation is in [P5 validation](../../docs/P5_VALIDATION.md).

From the repository root, after `npm ci --ignore-scripts`, `npm run build` and `npm run build:contracts`:

```sh
node packages/cli/dist/index.js help
```

`examples/payment-flow.ts` runs the whole flow against a local network and is the best worked example.

## Commands

| Group | Commands |
| --- | --- |
| `agent` | `register`, `show`, `update`, `rotate` |
| `verify` | `run` (add `--publish` to publish as a provider), `show`, `revoke` |
| `wallet` | `create`, `show`, `balance`, `fund`, `withdraw`, `pause`, `resume` |
| `policy` | `approve`, `show`, `revoke`, `replace` |
| `execute` | `transfer`, `sign`, `submit` through the wallet's `execute`; `pay` on its account path |
| `history` | Reads the wallet's audit events and verifies them against the stored audit head |
| `tx` | `status`: settle a journaled transaction by hash |
| `keys` | `create`, `address`, `fund` (Friendbot; local and Testnet only) |

Every command accepts `--help`. `--json` prints one JSON object; amounts are decimal strings and hashes are hex.

## Keys

Keys are passed as references, never as secrets:

- `file:<path>`: a file holding the secret, readable by its owner only;
- `env:<NAME>`: an environment variable holding the secret;
- `<name>`: `<key directory>/<name>.key`, where the directory is `STELLAR_AGENT_AUTH_KEY_DIR` or `.local/keys`.

A secret, or anything shaped like one, is refused and never printed.

## Who pays the fee

- With `--sponsor-url` or `SUBMITTER_URL`, the acting key signs its authorization and the [submitter](../../services/submitter/README.md) pays. The sponsor sponsors `execute` and `fund` by default, so set the variable only for those commands; owner commands sent to it are refused.
- With `--source <key>`, that account pays and signs the envelope. It authorizes nothing else.
- Otherwise the acting key pays for its own call. The CLI checks the exact call the envelope signature will authorize and refuses anything more.

## Two ways to pay

- `execute transfer` pushes a payment: the agent signs a request and the wallet moves the funds. Requests are ordered by a policy sequence and carry a deadline. `execute sign` and `execute submit` split it in two.
- `execute pay` is for a payment that is pulled. The wallet authorizes it as an account, under the same policy and the same budget.
  - Plain: `--to`, `--asset`, `--amount`. The result is an `asset.transfer` that anyone holding the signed entry can submit.
  - To a service: add `--service <C...> --service-id <hex>`. The wallet authorizes the service's own `pay_for_service` call with the transfer inside it, so the payment and what the service gives for it happen together or not at all. The policy must permit that service.

Before signing, `execute pay` asks the wallet whether the payment would pass. A refusal there exits 3 with the wallet's own reason. On this path the agent signs as a key: the signer account's own signers and thresholds are not applied.

A policy file permits a service with an optional `"service": { "contract": "C...", "service_id": "<64 hex>" }`. Add `"plain_transfers": false` to permit the service only.

Each asset in a policy file has `per_transfer` and `per_day`, and may have `total`: the most the agent may ever spend of it under the policy. Without it the exposure is bounded only day by day, and `policy show` says so.

To sponsor these payments, the submitter must list the asset contract with the `transfer` method, or the service contract with `pay_for_service`.

## Exit codes

| Code | Meaning | What to do |
| --- | --- | --- |
| 0 | The command succeeded. | |
| 1 | Another error, including an audit history mismatch. | Read the message. |
| 2 | Usage error. | Fix the arguments. |
| 3 | Refused before submission. Nothing was sent. | Fix the cause and run again. |
| 4 | Submitted and definitively not applied: failed on the ledger, rejected or expired. | Safe to run again. |
| 75 | Submitted, or possibly submitted, with an outcome not yet known. | Do not repeat the command. Run `tx status --hash <hash>` until it settles. |
| 76 | An earlier submission in the same scope settled during this run and is reported instead. Nothing new was signed. | Run again only if the action is still wanted. |

Repeating a payment command signs a new request for the next sequence. Exit 76 exists so that a repeat after an uncertain outcome reports what happened to the first attempt instead of paying a second time.

One case has no hash to query: if the sponsor does not answer, the CLI exits 75 and names the ledger until which the signed operation stays valid. Wait for that ledger, then read the policy state (`policy show`) or `history` before signing anything new.

## Dry run

`--dry-run` simulates with enforced authorization and sends nothing. Commands whose effect cannot be simulated refuse the flag: `verify revoke`, `verify run --publish`, `execute sign`, `keys create` and `keys fund`.

## State

The transaction journal lives in `--state-dir`, `STELLAR_AGENT_AUTH_STATE_DIR` or `.local/cli` under the working directory. It holds public envelopes and their status, never keys. Run commands for one deployment from one directory, or set the variable: a different directory means a different journal, which cannot see an earlier unsettled transaction.
