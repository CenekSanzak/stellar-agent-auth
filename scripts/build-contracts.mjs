import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
const version = spawnSync('stellar', ['--version'], { encoding: 'utf8' });
if (version.status !== 0 || !/stellar 30\.0\.1(?:\s|$)/.test(version.stdout)) {
  console.error('Install stellar-cli 30.0.1; see docs/DEVELOPMENT.md.'); process.exit(1);
}
const result = spawnSync('stellar', ['contract', 'build', '--locked'], { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
for (const name of ['agent_registry', 'verification_registry', 'smart_wallet', 'demo_service', 'probe']) {
  const path = `target/wasm32v1-none/release/stellar_agent_auth_${name}.wasm`;
  if (statSync(path).size === 0) throw new Error(`Empty WASM: ${path}`);
}
