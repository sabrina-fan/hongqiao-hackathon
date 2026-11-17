import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

function gitFiles(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Cannot determine files to format from Git');
  return result.stdout.split('\0').filter(Boolean);
}

const all = process.argv.includes('--all');
const candidates = all
  ? gitFiles(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
  : [
      ...gitFiles(['diff', '--name-only', '--diff-filter=ACMR', '-z', 'HEAD']),
      ...gitFiles(['ls-files', '--others', '--exclude-standard', '-z']),
    ];
const roots = /^(apps|packages|scripts|evals|e2e|\.github)\//;
const config =
  /^(package\.json|pnpm-workspace\.yaml|tsconfig[^/]*\.json|\.ox[^/]*\.json|vitest\.config\.ts)$/;
const extensions = /\.(ts|tsx|mjs|json|css|html|yaml|yml)$/;
const files = [...new Set(candidates)].filter(
  (file) => (roots.test(file) || config.test(file)) && extensions.test(file) && existsSync(file),
);
if (files.length > 0) {
  const args = [
    'exec',
    'oxfmt',
    ...(process.argv.includes('--check') ? ['--check'] : []),
    ...files,
  ];
  const result = spawnSync('pnpm', args, { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
}
