# Operations

Who holds which key, how to check a deployment, what needs looking after, and what the design does and does not protect against. For getting started see [the setup guide](SETUP.md); for the hosted server itself see [hosting](HOSTING.md).

## Keys and what each can do

Every role is a separate key. No role's key lets it do another role's job, and no service holds an owner's key.

| Role | Where its key is | What it can do | What it cannot do |
| --- | --- | --- | --- |
| **Owner** | The owner's own wallet app, or their browser as a guest | Create their wallet, put money in and take it out, approve, replace and revoke allowances, pause and resume | Anything in another owner's wallet |
| **Agent** | With the agent: on the owner's machine for their own agent, on the server for the sample agent | Sign payments under the one allowance approved for it | Pay more than the allowance, pay anyone else, change the allowance, withdraw |
| **Agent's controller** | Beside the agent's key | Change what the agent says about itself, rotate its key, disable it | Spend. Changing the identity makes every allowance for the old one stop working |
| **Verifier (provider)** | The hosted server | Publish and revoke check results | Approve itself, spend, change an allowance. A result it publishes only matters to wallets whose owners named it |
| **Registry admin** | The machine that made the deployment | Approve a verifier, disable a verifier | Publish results, touch any wallet, upgrade or replace a contract |
| **Facilitator / relayer** | The hosted server | Pay the network fee for a payment the agent signed, and submit it | Authorize anything. A payment it changes no longer matches the agent's signature and fails |
| **Faucet (funder)** | The hosted server | Give test money to wallets | Take any back |
| **Asset issuer** | The machine that made the deployment | Issue more of the test asset | Anything in a wallet |

The contracts have no upgrade entry point, no admin transfer and no owner transfer. What is deployed is what runs; a change means a new deployment, and a new owner means a new wallet.

**If a key leaks**, the damage is what the table's third column says and no more:

- An agent's key: payments inside its allowance until the owner revokes it or pauses the wallet, which take effect at once. Nothing outside the allowance.
- The verifier's key: false passing results. Wallets that require checks from this verifier would then trust an agent they should not; the allowance's limits still hold. The admin disables the verifier, which is permanent, and owners approve allowances naming another.
- The facilitator's or the faucet's key: their balances of test XLM and test money.
- An owner's key: that owner's wallet. This is the one key the project never handles.

On Testnet none of it has value, and the remedy for any leak in the deployment's own keys is a new deployment.

## Checking a deployment

```sh
npm run build:contracts && npm run build
node deployments/testnet/deploy.ts
```

This reads the deployment's record, `deployments/testnet/demo.json`, and asks the network whether each thing in it is there and is what the record says: both registries and the code they run, the installed wallet code, what the verification registry is bound to, the verifier's approval, the sample agent, its metadata and its current check result, and the asset. It compares the code on the network with what this source builds. It then finds, in the network's own history, the transactions that made the deployment. It needs no key and changes nothing.

If everything matches it writes [`deployments/testnet/manifest.json`](../deployments/testnet/manifest.json); if anything does not, it says what, exits with 1 and writes nothing. Run it after a new deployment and after a Testnet reset, before pointing anyone at the addresses.

The hosted server answers `ok` or `degraded` at `/healthz`, and `/indexer/v1/health` shows how far its history has been read.

## What needs looking after

| What | When | What to do |
| --- | --- | --- |
| An agent's check result runs out | 30 days after it was issued | The hosted server renews the results of agents it verified when fewer than seven days are left. Elsewhere, run the verifier again: `stellar-agent-auth verify run --agent <id> --publish --provider <key name>` |
| An account that pays fees runs low on test XLM | After many thousands of transactions | Fund it again from Friendbot |
| The faucet runs out of test money | After about 100,000 faucet payments | Pay more from the issuer to the faucet's account |
| Contract storage is left untouched | An entry nobody touches for 30 days is archived | Nothing is lost: see below |
| The history database | Continuously | Back it up: see below |
| Testnet is reset | A few times a year, announced by the Stellar Development Foundation | Deploy again: see below |

### Contract storage

Soroban archives a ledger entry that nobody has touched for its time to live. Each contract extends what it touches: every call extends the contract and its code, and every read or write in a submitted transaction extends that entry to 30 days once fewer than 29 remain.

An archived entry is not gone. Since protocol 23 a transaction that touches one restores it first, with exactly what it held. So an archived revocation is still a revocation, a spent budget is still spent, and nothing that expired comes back. This is tested against the contract with archival emulated; it has not been observed on a public network, where it would take a month of leaving a wallet alone.

To keep a dormant wallet's entries live without waiting for restoration, submit any wallet call. A read through the SDK is simulated and extends nothing.

### The history database

The indexer keeps each wallet's events in one SQLite file, so that history outlives the few days the network's RPC keeps events. On the hosted server it is on the volume mounted at `/data`.

- **Back it up** by stopping the process, or with SQLite's online backup, and copying the file. A plain copy of a running database also needs its `-wal` file.
- **Restore it** by putting the file back and starting the indexer. It continues from where the file left off and stores nothing twice.
- **If it was down longer than the RPC keeps events**, the ledgers in between cannot be read again. The indexer records the gap and says so; it never reports a history with a hole in it as verified. A wallet whose every entry is stored still verifies, whatever was skipped.
- **Losing the file loses no money and no rule.** History is rebuilt from the network as far back as the RPC reaches. What a wallet allows is in the wallet contract, not in this file.

Details are in the [indexer's README](../services/indexer/README.md#keeping-the-history).

### After a Testnet reset, or to deploy again

1. Run the setup again; it makes new keys and new contracts ([setup guide](SETUP.md#5-deploy-your-own)). Never reuse a record from another deployment.
2. Check it: `node deployments/testnet/deploy.ts`.
3. Commit the new `demo.json` and `manifest.json`.
4. Give the hosted server its four new keys and redeploy it; its volume can be emptied, since a new deployment is a new history ([hosting](HOSTING.md)).
5. Run the acceptance scenario and commit its record: `node deployments/testnet/evidence.ts`.

Wallets and agents from before the reset are gone with the network. Owners create new ones.

## What the design protects against, and what it does not

There has been no security audit, and none is planned in this work. What follows is the reasoning the contracts were built on and tested against, not a review by anyone else.

**What is being protected.** The money in an owner's wallet, and the owner's ability to stop an agent.

**Who is assumed hostile.** The agent, once its key is in the wrong hands or it is doing what its owner did not intend. Whoever relays a payment. A seller. Anyone on the network. A verifier nobody named.

**What holds, and where it is enforced.** All of it is enforced by the wallet contract on the ledger, not by the SDK, the agent's tool or the server:

| An attempt to | Is stopped by | Tested in |
| --- | --- | --- |
| Pay more than the allowance, per payment, per day or in total | The wallet's limits, per asset | `tests/adversarial/limits.test.ts`, contract tests |
| Pay someone, or in an asset, the owner did not approve | The allowance's lists; an empty list allows nobody | Contract tests |
| Pay after revocation, expiry or a pause | The wallet reads its current state on every payment | `tests/integration/wallet-flow.test.ts`, the acceptance run |
| Use a payment signed earlier, twice, or changed in transit | Each payment names its own sequence and deadline, and the agent's signature covers every field | `tests/adversarial/authorization.test.ts` |
| Pay with a key that is not the allowance's agent | The wallet checks the signature against the allowance's signer | The same file |
| Keep paying after the agent's check result expired, failed or was revoked, or its identity changed | The wallet asks both registries on every payment | `tests/integration/verification-flow.test.ts`, contract tests |
| Have a relayer gain anything from carrying a payment | The relayer authorizes nothing | `tests/adversarial/sponsor.test.ts` |
| Leave a payment half done | A failed transfer leaves balances, budgets and history unchanged | Contract tests |
| Rewrite or hide history | Every action extends a chain of hashes the wallet stores; anyone can rebuild it and compare | `tests/unit/indexer.test.ts`, `tests/integration/indexer.test.ts` |

**What it does not protect against.**

- **An agent that spends badly inside its allowance.** The wallet limits how much and to whom, not whether a purchase was wise. An allowance is the most an owner can lose to that agent.
- **A verifier that is wrong.** A passing result means the verifier's checks passed, and the verifier here performs three of them. It says nothing about what the agent's code does. An owner chooses which verifier to believe.
- **A seller that takes payment and delivers nothing.** There is no refund path.
- **The owner's own key.** Whoever holds it owns the wallet.
- **The hosted server being unavailable or dishonest about what it shows.** It cannot move an owner's money, and the page checks the wallet's history against the wallet itself. But the sample agent's key and the verifier's key live on it, and it is one small machine.
- **Flaws nobody has found.** The contracts have their author's tests and no outside review.

**Other limits.** Amounts and recipients are public, as everything on the ledger is. The wallet pays by plain transfer and by one kind of service call; it does not call arbitrary contracts. A web API that settles with the published x402 software, unchanged, refuses the wallet as a payer ([x402 validation](X402_VALIDATION.md)).
