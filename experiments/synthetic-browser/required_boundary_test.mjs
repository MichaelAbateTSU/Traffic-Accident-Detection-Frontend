import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyRequiredBoundaryTap } from './required_boundary.mjs';
import { spawnSync } from 'node:child_process';

const passed = `ok 1 - frontend receipt/privacy contract against pinned backend HTTP, auth and SQLite (fake queue, no inference)
# tests 1
# pass 1
# fail 0
# skipped 0`;
test('required boundary accepts only executed exact-title single passing test', () => {
  verifyRequiredBoundaryTap(passed);
  for (const output of [
    passed.replace('# skipped 0', '# skipped 1'),
    passed.replace('# pass 1', '# pass 0'),
    passed.replace('ok 1 -', 'not ok 1 -'),
    passed.replace('(fake queue, no inference)', '(fake queue, no inference) # SKIP'),
    passed.replace('frontend receipt/privacy contract', 'unrelated test'),
  ]) assert.throws(() => verifyRequiredBoundaryTap(output), assert.AssertionError);
});

test('required runner fails when documented backend/Python paths are missing', () => {
  const result = spawnSync(process.execPath, [
    new URL('./required_boundary.mjs', import.meta.url).pathname, '/tmp',
  ], { env: { ...process.env, TAD_BACKEND_CONTRACT_ROOT: '', TAD_BOUNDARY_PYTHON: '' },
    encoding: 'utf8', timeout: 5000 });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout.includes('1 passed'), false);
});
