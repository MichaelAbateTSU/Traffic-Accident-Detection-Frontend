import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { accessSync, constants } from 'node:fs';
import { pathToFileURL } from 'node:url';

const title = 'frontend receipt/privacy contract against pinned backend HTTP, auth and SQLite (fake queue, no inference)';
export function verifyRequiredBoundaryTap(output) {
  const lines = output.split(/\r?\n/);
  assert.ok(lines.some(line => /^ok \d+ - /.test(line) && line.includes(title) && !line.includes('# SKIP')),
    'Required exact-backend contract did not execute successfully');
  assert.ok(lines.some(line => /^# tests 1$/.test(line)));
  assert.ok(lines.some(line => /^# pass 1$/.test(line)));
  assert.ok(lines.some(line => /^# fail 0$/.test(line)));
  assert.ok(lines.some(line => /^# skipped 0$/.test(line)), 'Required backend contract was skipped');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.env.TAD_BACKEND_CONTRACT_ROOT;
  const python = process.env.TAD_BOUNDARY_PYTHON;
  const frontend = process.argv[2];
  for (const path of [root, python, frontend]) assert.ok(path && isAbsolute(path), 'Absolute fixture paths are required');
  accessSync(python, constants.X_OK);
  accessSync(join(root, 'app/api/detect.py'));
  const pin = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  assert.equal(pin.status, 0);
  assert.equal(pin.stdout.trim(), '5a1bfc38e207913c66eb6120e986147a66410424');
  const result = spawnSync(process.execPath, [
    '--experimental-vm-modules', '--test', '--test-reporter=tap', 'tests/keyed-backend-boundary.test.js',
  ], { cwd: frontend, env: process.env, encoding: 'utf8', timeout: 60000 });
  // Do not echo fixture failure output: assertions may contain ephemeral tokens.
  assert.equal(result.error, undefined, 'Required backend contract process failed');
  assert.equal(result.status, 0, 'Required backend contract failed');
  verifyRequiredBoundaryTap(result.stdout);
  console.log('Required exact-backend HTTP/privacy contract: 1 passed, 0 skipped (fake queue, no inference).');
}
