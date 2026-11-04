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
