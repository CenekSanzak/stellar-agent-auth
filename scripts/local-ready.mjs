import { setTimeout } from 'node:timers/promises';

async function rpc(method) {
  const response = await fetch('http://localhost:8000/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method }),
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  return (await response.json()).result;
}

// Friendbot starts after RPC. Without an address it answers 400 once it is serving
// (502 from the proxy while booting), so this probe funds nothing.
async function friendbotReady() {
  const response = await fetch('http://localhost:8000/friendbot', { signal: AbortSignal.timeout(2000) });
  return response.status === 400;
}

for (let attempt = 0; attempt < 90; attempt++) {
  try {
    const [network, health, friendbot] = await Promise.all([rpc('getNetwork'), rpc('getHealth'), friendbotReady()]);
    if (network?.passphrase === 'Standalone Network ; February 2017'
      && network.protocolVersion === 29 && health?.status === 'healthy' && friendbot) {
      console.log('Local protocol-29 RPC and Friendbot ready. Run npm run test:integration.');
      process.exit(0);
    }
  } catch { /* Container may still be booting. */ }
  if (attempt % 10 === 0) console.log('Waiting for healthy local protocol-29 RPC and Friendbot...');
  await setTimeout(2000);
}
console.error('Local RPC or Friendbot did not become ready; inspect docker compose logs.');
process.exit(1);
