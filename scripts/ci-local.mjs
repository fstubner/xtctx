#!/usr/bin/env node
// Shared local/hosted checks. No publish, deploy, git push or service operations.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const argv = process.argv.slice(2);
const lane = argv.length === 0 ? 'all' : argv.length === 2 && argv[0] === '--lane' ? argv[1] : '';
const lanes = {
  portable: ['test', 'test:integration', 'test:drift', 'test:smoke', 'build', 'smoke:cli', 'demo:public'],
  checks: ['lint', 'typecheck', 'test:cloud', 'test:security', 'security:checklist',
    'check:workflows', 'check:review-coverage', 'audit:production', 'audit:site', 'test:eval', 'site:check'],
  semantic: [],
};
if (!['all', ...Object.keys(lanes)].includes(lane)) {
  console.error('Usage: npm run ci:local -- [--lane portable|checks|semantic|all]');
  process.exit(2);
}
const npm = process.env.npm_execpath;
if (!npm) {
  console.error('Run through npm run ci:local so the same npm runtime is used on every OS.');
  process.exit(2);
}
function run(command, args, cwd = root) {
  console.log(`\n+ ${JSON.stringify([command, ...args])}`);
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: false });
  if (result.error) {
    console.error(`Required command failed to start: ${result.error.message}`);
    process.exit(127);
  }
  if (result.status !== 0) {
    console.error('Local CI failed; no push or publication was performed.');
    process.exit(result.status ?? 1);
  }
}
for (const selected of lane === 'all' ? Object.keys(lanes) : [lane]) {
  for (const script of lanes[selected]) run(process.execPath, [npm, 'run', script]);
  if (selected === 'checks') run(process.execPath, [npm, 'pack', '--dry-run']);
  if (selected === 'semantic') {
    run(process.execPath, [npm, '--prefix', 'cloud', 'run', 'test:semantic']);
    if (process.env.TEST_DATABASE_URL?.trim()) {
      run(process.execPath, [npm, '--prefix', 'cloud', 'run', 'test:integration']);
    }
  }
}
console.log(`\nLocal CI passed (${lane}). Hosted OS-matrix checks remain required.`);
