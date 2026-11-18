import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { findForbiddenTestModifiers } from './test-policy.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function check(source: string) {
  const directory = await mkdtemp(join(tmpdir(), 'nextstop-test-policy-'));
  directories.push(directory);
  const path = join(directory, 'fixture.test.ts');
  await writeFile(path, source);
  return findForbiddenTestModifiers([path]);
}

it.each([
  "import { it } from 'vitest'; it.skip('case', () => {});",
  "import { test as scenario } from 'vitest'; scenario.only.each([1])('case', () => {});",
  "import * as v from 'vitest'; v.describe['skipIf'](true)('suite', () => {});",
  "import { test } from 'vitest'; test.each([1]).fails('case', () => {});",
  "import { suite } from 'vitest'; suite.todo('suite');",
])('rejects modifiers on Vitest declarations: %s', async (source) => {
  expect(await check(source)).toHaveLength(1);
});

it('allows assert.fail and ordinary objects with modifier-like properties', async () => {
  expect(
    await check(`
    import assert from 'node:assert/strict';
    import { it, expect } from 'vitest';
    const object = { skip() {}, only() {}, fail() {} };
    it('case', () => { object.skip(); object.only(); object.fail(); assert.fail(); });
    expect(object.skip).toBeDefined();
  `),
  ).toEqual([]);
});

it('respects a local object that shadows an imported test name', async () => {
  expect(
    await check(`
    import { it as scenario } from 'vitest';
    scenario('case', () => {
      const scenario = { skip() {} };
      scenario.skip();
    });
  `),
  ).toEqual([]);
});
