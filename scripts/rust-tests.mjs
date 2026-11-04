import { spawnSync } from 'node:child_process';
const listed = spawnSync('cargo', ['test', '--workspace', '--locked', '--', '--list'], { encoding: 'utf8' });
if (listed.status !== 0 || !/^.+: test$/m.test(listed.stdout ?? '')) {
  console.error(listed.stderr ?? listed.error?.message, 'Expected at least one Rust test.');
  process.exit(1);
}
const result = spawnSync('cargo', ['test', '--workspace', '--locked'], { stdio: 'inherit' });
process.exit(result.status ?? 1);
