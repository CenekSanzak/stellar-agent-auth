# Testnet

The P3 development checkpoint is deployed on Testnet (protocol 30) and recorded in [`p3-checkpoint.json`](p3-checkpoint.json), with its assessment report in [`reports/`](reports/) and the agent's metadata in [`agent-metadata.json`](agent-metadata.json). The final deployment belongs to P8.

`checkpoint.ts` runs the P3 development checkpoint: it deploys both registries, approves the live provider, registers an agent whose metadata is publicly hosted, runs a real limited assessment and records the public result in `p3-checkpoint.json`. Generated keys stay in the git-ignored `.local/testnet/`. This is not the final P8 deployment.

```sh
npm run build:contracts && npm run build
node deployments/testnet/checkpoint.ts deploy
node deployments/testnet/checkpoint.ts register --metadata-uri https://<public host>/agent.json
node deployments/testnet/checkpoint.ts assess
```

The metadata document must follow the v1 schema in [verification coverage](../../docs/VERIFICATION_COVERAGE.md) and be served unchanged between `register` and `assess`.

## The demo's deployment

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
