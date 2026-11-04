import { spawnSync } from 'node:child_process';
if (process.env.RUN_TESTNET_TESTS !== '1') {
  console.error('Set RUN_TESTNET_TESTS=1 to explicitly enable the read-only public Testnet suite.');
  process.exit(1);
}
const result = spawnSync('npx', ['--no-install', 'vitest', 'run', '--project', 'testnet'], { stdio: 'inherit' });
process.exit(result.status ?? 1);
