# Verifier

Off-chain checks and publication of provider-authenticated results.

P3 implements the limited verifier as an explicit command-line job; there is no HTTP endpoint. Rules and coverage: [ADR 0004](../../docs/decisions/0004-verification-registry.md) and [verification coverage](../../docs/VERIFICATION_COVERAGE.md).

```sh
npm run build
export STELLAR_NETWORK=local AGENT_REGISTRY_ID=C... VERIFICATION_REGISTRY_ID=C... VERIFIER_PUBLIC_ADDRESS=G...
node services/verifier/dist/index.js assess --agent 1            # dry run: stores the report, signs nothing
VERIFIER_SECRET_KEY_FILE=~/.config/verifier.key \
  node services/verifier/dist/index.js assess --agent 1 --publish
node services/verifier/dist/index.js show --agent 1 --revision 1
VERIFIER_SECRET_KEY_FILE=~/.config/verifier.key \
  node services/verifier/dist/index.js revoke --agent 1 --revision 1 --sequence 1
```

- `net.ts` fetches agent-supplied URLs over HTTPS only, pinned to vetted public addresses, with fixed size, time and redirect limits and TLS verification always on.
- `metadata.ts` hashes the registered URI's bytes before parsing and accepts only the strict v1 schema.
- `checks.ts` runs the metadata, endpoint, signer-account and signer-history checks and reports code, media, token and threat-feed as unsupported.
- `attestations.ts` writes the canonical report to `$VERIFIER_STATE_DIR/reports/<sha256>.json` before publishing, then publishes as the provider. An interrupted publication is settled from `$VERIFIER_STATE_DIR/pending` before any new transaction; exit code 75 means the outcome is still pending, so rerun later.

The key file must be readable by its owner only (`chmod 600`). Results are valid for 24 hours by default (`--validity <seconds>`).
