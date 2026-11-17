import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';

async function testFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await testFiles(path)));
    else if (/\.(test|spec)\.tsx?$/.test(entry.name)) files.push(path);
  }
  return files;
}

const forbidden = new Set(['only', 'skip', 'todo', 'skipIf', 'runIf', 'fails', 'fail', 'fixme']);
const violations = [];
for (const path of [
  ...(await testFiles('packages')),
  ...(await testFiles('apps')),
  ...(await testFiles('e2e')),
]) {
  const source = ts.createSourceFile(
    path,
    await readFile(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  function visit(node) {
    if (ts.isPropertyAccessExpression(node) && forbidden.has(node.name.text)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      violations.push(`${path}:${line + 1}: forbidden test modifier .${node.name.text}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
if (violations.length > 0) {
  console.error(violations.join('\n'));
  process.exitCode = 1;
} else {
  const directory = await mkdtemp(join(tmpdir(), 'nextstop-vitest-'));
  try {
    const reportPath = join(directory, 'report.json');
    const result = spawnSync(
      'pnpm',
      [
        'exec',
        'vitest',
        'run',
        '--reporter=default',
        '--reporter=json',
        `--outputFile.json=${reportPath}`,
      ],
      { stdio: 'inherit' },
    );
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
    } else {
      const report = JSON.parse(await readFile(reportPath, 'utf8'));
      if (
        report.success !== true ||
        !Number.isInteger(report.numTotalTests) ||
        report.numTotalTests < 1 ||
        report.numPendingTests !== 0 ||
        report.numTodoTests !== 0 ||
        report.numFailedTests !== 0 ||
        report.numFailedTestSuites !== 0
      ) {
        throw new Error('Test gate rejected missing, empty, skipped, or failed test results');
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
