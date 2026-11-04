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

for (let attempt = 0; attempt < 90; attempt++) {
  try {
    const [network, health] = await Promise.all([rpc('getNetwork'), rpc('getHealth')]);
    if (network?.passphrase === 'Standalone Network ; February 2017'
      && network.protocolVersion === 29 && health?.status === 'healthy') {
      console.log('Local protocol-29 RPC ready. Run npm run test:integration.');
      process.exit(0);
    }
  } catch { /* Container may still be booting. */ }
  if (attempt % 10 === 0) console.log('Waiting for healthy local protocol-29 RPC...');
  await setTimeout(2000);
}
console.error('Local RPC did not become ready; inspect docker compose logs.');
process.exit(1);
