# Submitter

A private fee sponsor over HTTP. A client signs every authorization entry for its call and sends only the signed operation. The submitter wraps it in a transaction with itself as source, enforces it in simulation, checks the fee ceiling, signs the envelope, submits it and tracks it. The logic is the SDK's `Sponsor`; this process is a thin adapter. Validation is in [P5 validation](../../docs/P5_VALIDATION.md).

It is not a public relay. It serves the contracts and methods it is configured for, and it needs a bearer token to listen beyond loopback.

```sh
npm run build
export STELLAR_NETWORK=local
export SUBMITTER_SPONSOR_KEY=sponsor            # a key reference, never a secret
export SUBMITTER_CONTRACTS=C...                 # comma-separated wallet addresses
node services/submitter/dist/index.js
```

## What the sponsor can and cannot do

- It pays the fee, up to `SUBMITTER_MAX_FEE_STROOPS` per transaction.
- It cannot change the action. Each entry is bound by its signer to the exact call and arguments.
- It authorizes nothing. Source-account credentials and entries for its own address are refused before simulation.
- It can delay or drop a request, like any relayer. A client must not take its word for an outcome: the SDK's `sponsoredInvoke` checks the returned transaction against the operation it signed and reads the result from the network.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `SUBMITTER_SPONSOR_KEY` | required | Key reference for the paying account |
| `SUBMITTER_CONTRACTS` | required | Contracts whose calls are sponsored |
| `SUBMITTER_METHODS` | `execute,fund` | Function names that are sponsored |
| `SUBMITTER_MAX_FEE_STROOPS` | `5000000` | Highest total fee per transaction |
| `SUBMITTER_TIMEOUT_SECONDS` | `60` | Transaction validity |
| `SUBMITTER_RATE_LIMIT` | `30` | Requests per minute per client address |
| `SUBMITTER_HOST`, `SUBMITTER_PORT` | `127.0.0.1`, `8787` | Listen address |
| `SUBMITTER_TOKEN_FILE` | none | Owner-only file with a bearer token of at least 32 characters; required beyond loopback |
| `SUBMITTER_STATE_DIR` | `.local/submitter` | Transaction journal |

Network settings come from the same variables as the SDK (`STELLAR_NETWORK`, `STELLAR_RPC_URL`).

## HTTP

| Route | Result |
| --- | --- |
| `GET /v1/health` | Sponsor address, network, contracts, methods and fee ceiling |
| `POST /v1/transactions` with `{ "operation": "<base64 XDR>" }` | Sponsors one signed operation |
| `GET /v1/transactions/<hash>` | Settles a hash this sponsor submitted |

A settled result is 200 whatever its status, and a pending or unknown one is 202. Every 4xx means nothing was submitted for the request: 400 and 413 for the body, 401 for the token, 403 for a refused call, 409 while an earlier transaction is still settling, 422 for a simulation rejection, 429 for the rate limit. A 5xx can follow a submission, so a client must treat it as an unknown outcome.

## Sponsoring account payments

A payment on the wallet's account path is not a call on the wallet. It is `transfer` on the asset contract, or `pay_for_service` on a service contract, carrying the wallet's own entry. To sponsor them, list those contracts in `SUBMITTER_CONTRACTS` and those methods in `SUBMITTER_METHODS`. The submitter does not need to know the wallet. Note that listing an asset's `transfer` sponsors that transfer for any payer whose entry simulates, not only for one wallet.

## Limits to know

- Submissions are serialized inside one process. Do not run two submitters on one key.
- The server speaks plain HTTP. Put it behind TLS before using a token across a network.
- There is a per-transaction fee ceiling but no total budget.
- A client whose connection drops has no hash to query; see the CLI's notes on exit code 75.
