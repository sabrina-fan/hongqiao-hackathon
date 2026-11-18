import { spawnSync } from 'node:child_process';
import { glob, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findForbiddenTestModifiers, testExclude, testInclude } from './test-policy.ts';

const files = await Array.fromAsync(glob(testInclude, { exclude: testExclude }));
const violations = findForbiddenTestModifiers(files);
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
      const executed = new Set(report.testResults.map((result) => resolve(result.name)));
      const missing = files.filter((path) => !executed.has(resolve(path)));
      if (missing.length > 0) {
        throw new Error(`Test files were scanned but not executed: ${missing.join(', ')}`);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
