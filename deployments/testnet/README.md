# Testnet

What is on Testnet, and the records of it. Every file here holds public addresses and transaction hashes only; keys stay in the git-ignored `.local/`.

| File | What it is |
| --- | --- |
| [`demo.json`](demo.json) | The kept deployment's addresses, as its setup wrote them |
| [`addresses.ts`](addresses.ts) | The same record with its type, for scripts |
| [`deploy.ts`](deploy.ts) | Checks the record against the network and looks up the transactions that made the deployment. Needs no key and changes nothing |
| [`manifest.json`](manifest.json) | What `deploy.ts` found on 2026-11-28: 11 checks, the code hashes, every role's address, seven transactions, the tool versions, and whether a build on that machine matched |
| [`evidence.ts`](evidence.ts) | The acceptance scenario: one payment inside an allowance and four refused, each refusal on the ledger |
| [`evidence.json`](evidence.json) | Its run on 2026-11-28, with every address and transaction |
| [`scout-metadata.json`](scout-metadata.json) | The sample agent's metadata, registered at this file's address at a fixed commit |
| `checkpoint.ts`, `p3-checkpoint.json`, `agent-metadata.json`, `reports/` | An earlier development checkpoint; see the end of this page |

```sh
npm run build:contracts && npm run build
node deployments/testnet/deploy.ts       # check the deployment, rewrite manifest.json
node deployments/testnet/evidence.ts     # run the acceptance scenario, rewrite evidence.json
```

What the records show is on [the evidence page](../../docs/EVIDENCE.md); when to run the scripts is in [operations](../../docs/OPERATIONS.md).

## The acceptance scenario

`evidence.ts` creates a new owner, a new agent and a new wallet each time, on the kept deployment. It uses only what is public: Friendbot, the deployment the hosted service describes at `/v1/config`, and that service's agent setup, verifier and faucet. So anyone can run it, and `--market` points it at another server.

A payment the wallet refuses is normally never sent: the agent asks the wallet first. Here each refusal is also submitted, so that there is a failed transaction to look at. A refused payment cannot be simulated, so the network will not say which ledger entries it needs; it is sent with the entries a payment the wallet would make needs, which are the same ones. The wallet's reason is then read from the failed transaction itself.

`tests/integration/evidence.test.ts` runs the same scenario against the same server on a local network.

## The kept deployment

[`demo.json`](demo.json) records the deployment the hosted demo runs against: both registries, a `Live` provider, the agent Scout with a real limited assessment, the test asset tUSD, the installed wallet code, and the accounts the demo's sellers are paid at. It holds public addresses only. There is no wallet in it; every owner creates their own from the wallet code and the salt it names.

Scout's metadata is [`scout-metadata.json`](scout-metadata.json), registered at the address of this file at a fixed commit, so that the bytes the verifier fetches cannot change under the registered hash.

It was made with the demo's setup, which also wrote the keys to the git-ignored `.local/testnet-demo/`:

```sh
npm run build:contracts && npm run build
STELLAR_NETWORK=testnet DEMO_DIRECTORY=.local/testnet-demo npm run demo:setup -- \
  --metadata-uri https://raw.githubusercontent.com/CenekSanzak/stellar-agent-auth/<commit>/deployments/testnet/scout-metadata.json \
  --public-record deployments/testnet/demo.json
```

See [the demo](../../apps/demo/README.md) and [hosting](../../docs/HOSTING.md).

## The earlier checkpoint

Before the wallet existed, a development checkpoint deployed both registries to Testnet, registered one agent and ran one real assessment. It is recorded in [`p3-checkpoint.json`](p3-checkpoint.json), with its assessment report in [`reports/`](reports/) and the agent's metadata in [`agent-metadata.json`](agent-metadata.json). Its contracts are not the kept deployment's. `checkpoint.ts` made it; its keys are in the git-ignored `.local/testnet/`.

```sh
npm run build:contracts && npm run build
node deployments/testnet/checkpoint.ts deploy
node deployments/testnet/checkpoint.ts register --metadata-uri https://<public host>/agent.json
node deployments/testnet/checkpoint.ts assess
```

The metadata document must follow the v1 schema in [verification coverage](../../docs/VERIFICATION_COVERAGE.md) and be served unchanged between `register` and `assess`.
