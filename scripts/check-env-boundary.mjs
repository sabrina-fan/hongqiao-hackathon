import { spawnSync } from 'node:child_process';

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}

const tracked = git(['ls-files', '-z']);
if (tracked.status !== 0) throw new Error('Cannot inspect tracked files');
const forbidden = tracked.stdout
  .split('\0')
  .filter((path) => /(^|\/)\.env($|\.)/.test(path) && path !== '.env.example');
if (forbidden.length > 0) {
  throw new Error(`Real environment files must not be tracked: ${forbidden.join(', ')}`);
}
for (const path of ['.env', '.env.jev.local']) {
  if (git(['check-ignore', '--no-index', '--quiet', path]).status !== 0) {
    throw new Error(`${path} must remain ignored by Git`);
  }
}
console.log('Environment boundary passed: real env files are ignored and untracked.');
