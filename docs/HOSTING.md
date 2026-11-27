# Hosting the demo

The demo is one container: it serves the page, plays Scout and the sellers, and runs the indexer. It needs a public HTTPS address, a small persistent disk, outbound access to the Stellar RPC, and three secrets. This page uses Fly.io; any host that runs a container behind a TLS proxy works the same way.

Design and risks are in [ADR 0013](decisions/0013-hosted-demo.md).

## What it costs

Fly.io has no free plan for new organisations. A `shared-cpu-1x` machine with 512 MB that stays up, a 1 GB volume and a shared IPv4 address come to roughly three to four US dollars a month at the prices published in November 2026; check [the pricing page](https://fly.io/docs/about/pricing/) before relying on that. A card is required. The container used about 120 MB at rest in testing, so the 256 MB size would probably also do.

## What is needed first

- A Testnet deployment and its record in `deployments/testnet/demo.json`. The repository has one; [the demo README](../apps/demo/README.md) says how to make another.
- The three keys the server signs with: `agent.key`, `funder.key` and `facilitator.key`, in the `keys` directory the setup wrote under `.local/testnet-demo/`. They are Testnet keys. The other keys in that directory stay where they are.
- [`flyctl`](https://fly.io/docs/flyctl/install/) and a Fly account.

## Deploy

Choose a name. It becomes the address, `https://<name>.fly.dev`, so set both `app` and `DEMO_PUBLIC_URL` in [`fly.toml`](../fly.toml) to match. The server refuses requests for any other host name.

```sh
fly auth login
fly apps create <name>
fly volumes create scout_data --size 1 --region fra --app <name>
```

Give it the three secrets. Run this yourself, in your own shell; it reads the key files and sends them to Fly, and prints nothing.

```sh
KEYS=$(ls -d .local/testnet-demo/*/keys | tail -1)
fly secrets set --app <name> \
  SCOUT_AGENT_SECRET="$(cat "$KEYS/agent.key")" \
  SCOUT_FUNDER_SECRET="$(cat "$KEYS/funder.key")" \
  SCOUT_FACILITATOR_SECRET="$(cat "$KEYS/facilitator.key")"
```

Then deploy and look at it:

```sh
fly deploy
fly status
curl https://<name>.fly.dev/healthz
```

Keep it at one machine (`fly scale count 1`). The rate limits, the table of running tasks and the indexer's database all live in one process.

## Try the image before deploying

```sh
docker build -t scout-demo .
KEYS=$(ls -d .local/testnet-demo/*/keys | tail -1)
docker run --rm -p 127.0.0.1:8792:8080 \
  -e DEMO_PUBLIC_URL=http://localhost:8792 \
  -e DEMO_AGENT_KEY=env:SCOUT_AGENT_SECRET -e DEMO_FUNDER_KEY=env:SCOUT_FUNDER_SECRET \
  -e DEMO_FACILITATOR_KEY=env:SCOUT_FACILITATOR_SECRET \
  -e SCOUT_AGENT_SECRET="$(cat "$KEYS/agent.key")" -e SCOUT_FUNDER_SECRET="$(cat "$KEYS/funder.key")" \
  -e SCOUT_FACILITATOR_SECRET="$(cat "$KEYS/facilitator.key")" scout-demo
```

Open `http://localhost:8792/`. Do not run it at the same time as a deployed copy with the same keys: two facilitators on one account get in each other's way.

## Keeping it running

| What | When | How |
| --- | --- | --- |
| Scout's verification expires | 30 days after it was issued; the page shows the date | `DEMO_DIRECTORY=.local/testnet-demo npm run demo:assess`, from the machine that holds the provider's key. Nothing is redeployed |
| The faucet runs out of tUSD | After about 100,000 faucet payments | Pay more from the issuer to the funder; the issuer's key is in the setup's key directory |
| The facilitator or the funder runs out of test XLM | Each payment costs a fraction of an XLM; Friendbot gave each 10,000 | Fund the account again from Friendbot |
| Testnet is reset | Announced by the Stellar Development Foundation, a few times a year | Run the setup again, commit the new record, set the new secrets and redeploy. The volume can be emptied; a new deployment is a new stream |
| A key may have leaked | | Run the setup again and replace everything. Nothing in the old deployment has value |

`GET /healthz` answers `ok`, or `degraded` when the indexer's last pass failed. `GET /indexer/v1/health` shows how far the indexer has read.

## Other hosts

The server needs these set, and nothing Fly-specific:

| Setting | Value |
| --- | --- |
| `DEMO_HOST` | `0.0.0.0` (set in the image) |
| `DEMO_PORT` | `8080` (set in the image) |
| `DEMO_PUBLIC_URL` | The origin visitors use |
| `DEMO_STATE_DIRECTORY` | A directory on a persistent disk (`/data` in the image) |
| `DEMO_AGENT_KEY`, `DEMO_FUNDER_KEY`, `DEMO_FACILITATOR_KEY` | `env:<NAME>` references to the three secrets |

Behind a proxy, the client's address is taken from `Fly-Client-IP`, or failing that from the first entry of `X-Forwarded-For`. Use a proxy that sets one of them itself and does not pass on what a client sent, or every rate limit can be sidestepped. The proxy must terminate TLS; the server speaks plain HTTP.
