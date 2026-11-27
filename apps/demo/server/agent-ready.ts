/**
 * The instructions an AI agent reads to set itself up, as Markdown. The owner pastes one sentence with this
 * document's address into their agent; the agent does the rest. It is written to the agent, in the imperative, and
 * it is generated so that the commands in it already name this server and the owner's account.
 */
export function agentReady(options: {
  origin: string; owner?: string | undefined; network: string; verifies: boolean;
  /** The tool's name on npm, once it is published there. Without it the tool is fetched from this server as one file. */
  npmPackage?: string | undefined;
}): string {
  const { origin, network } = options;
  const owner = options.owner ?? '<the G... address of the account that owns the wallet>';
  const file = '~/.stellar-agent-wallet/stellar-agent-wallet.mjs';
  // How the tool is run: from npm when it is published there, from the downloaded file otherwise.
  const run = options.npmPackage ? `npx -y ${options.npmPackage}` : `node ${file}`;
  return `# Become the agent of a Stellar smart wallet

These are instructions for you, an AI coding agent. The person who gave you this address owns a smart wallet on
${network} and wants you to be able to pay for things from it, inside an allowance they control. Do the setup; do
not explain it back to them first.

What you end up with:

- a key of your own, on this machine. It is your identity. You never see the owner's key, and they never see yours.
- an identity in an on-chain agent registry, and a verification of it.
- four tools: \`allowance\`, \`sellers\`, \`price\` and \`buy\`.

You cannot spend anything until the owner approves an allowance for you, in their own wallet. After that the wallet
contract enforces it: how much per purchase, per day and in total, which sellers, and until when. Everything here is
test money on a test network.
${options.owner ? '' : `
> This address was opened without an owner. Ask the person for the account address shown on ${origin}/ after they
> connect, and use it wherever \`--owner\` appears below.
`}
## 1. Check Node.js

\`\`\`sh
node --version
\`\`\`

It must print v20 or newer. If it does not, tell the person to install Node.js and stop here.

## 2. Get the tool
${options.npmPackage ? `
There is nothing to install: \`npx\` fetches \`${options.npmPackage}\` from npm the first time it is used.
` : `
One file, with nothing else to install:

\`\`\`sh
mkdir -p ~/.stellar-agent-wallet
curl -fsSL ${origin}/agent/stellar-agent-wallet.mjs -o ${file}
\`\`\`
`}
## 3. Create and register yourself

Pick a short name the owner will recognise, such as "Claude Code on <this machine's name>".

\`\`\`sh
${run} init --market ${origin} --owner ${owner} --name "<your name>"
\`\`\`

This creates your keys under \`~/.stellar-agent-wallet/keys\`, funds them with test XLM, registers you in the agent
registry, asks for your verification, and tells the owner's page about you. It takes about half a minute and is safe
to run again. It prints a link for the owner; keep it for step 5.
${options.verifies ? '' : '\nThis server cannot verify agents at the moment. You will be registered, and the wallet will not pay for you until you are verified.\n'}
## 4. Add the tools to yourself

Use the line for the host you are running in:

\`\`\`sh
claude mcp add agent-wallet -- ${run} mcp      # Claude Code
codex mcp add agent-wallet -- ${run} mcp       # Codex
\`\`\`

For any other MCP host, the command to start is \`${run} mcp\`. Where a host wants the command and its arguments
apart, write out the home directory in any path; hosts do not expand \`~\`.

New tools usually appear only after the host reloads its tools or a new session starts. If you cannot call
\`allowance\` after adding them, say so in step 5.

## 5. Tell the person what is left

Say, in a few lines:

1. that you are registered, and under which name and agent number;
2. the link \`init\` printed. They open it, connect the same wallet, and approve an allowance for you;
3. if your tools are not loaded yet, that they should start a new session with you afterwards.

Then stop and wait. Do not ask them for any key, and do not try to approve anything yourself: you cannot.

## 6. Once you have an allowance

- Call \`allowance\` first. It tells you what you may spend and where.
- \`sellers\` lists what is on offer here. \`price\` asks what something costs and whether the wallet would pay it,
  without spending. \`buy\` buys.
- A refusal from the wallet or from a seller is a normal answer. Report it with its reason. Do not retry it and do not
  look for a way around it; only the owner can change the allowance.
- Buy only what you were asked to get.
- Never print, copy or send the files under \`~/.stellar-agent-wallet/keys\`.

## If something goes wrong

- \`init\` says Friendbot did not fund an account: the test network's faucet is busy. Wait a minute and run it again.
- \`init\` says this directory already holds an agent for another address: add \`--home <another directory>\` to both
  \`init\` and the \`mcp\` command, to keep the two apart.
- \`allowance\` says there is no wallet yet: the owner has not created theirs. They do that at ${origin}/.
- A purchase is blocked with \`ResultExpired\`: your verification ran out. Starting the tools again renews it.

Source and documentation: https://github.com/CenekSanzak/stellar-agent-auth
`;
}
