import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { validateProductionBuild } from '../src/config.js';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const blueprint = readFileSync(new URL('../render.yaml', import.meta.url), 'utf8');

test('Render build pins root history routing and requires explicit missing-backend opt-in', () => {
  const command = packageJson.scripts['build:render'];
  const assignments = Object.fromEntries(command.split(' ').filter((part) => part.includes('=')).map((part) => part.split('=')));
  assert.deepEqual(assignments, {
    VITE_BASE_PATH: '/',
    VITE_ROUTER_MODE: 'history',
  });
  assert.match(command, /vite build$/);
  assert.throws(() => validateProductionBuild(assignments), /public HTTPS/);
  assert.throws(() => validateProductionBuild({ ...assignments, VITE_API_BASE_URL: 'http://localhost:8000' }), /public HTTPS/);
  assert.doesNotThrow(() => validateProductionBuild({ ...assignments, VITE_API_BASE_URL: 'https://backend.example/api/v1' }));
  assert.doesNotThrow(() => validateProductionBuild({ ...assignments, VITE_ALLOW_UNCONFIGURED_BACKEND: 'true' }));
  assert.throws(() => validateProductionBuild({
    ...assignments, VITE_ALLOW_UNCONFIGURED_BACKEND: 'true', VITE_API_BASE_URL: 'http://backend.example',
  }), /public HTTPS/);
});

test('Render blueprint tests and builds a static site with operator-supplied public configuration', () => {
  assert.match(blueprint, /runtime: static/);
  assert.match(blueprint, /branch: main/);
  assert.match(blueprint, /buildCommand: npm ci && npm test && npm run build:render/);
  assert.match(blueprint, /staticPublishPath: \.\/dist/);
  assert.match(blueprint, /key: VITE_API_BASE_URL\s+sync: false/);
  assert.match(blueprint, /key: VITE_ALLOW_UNCONFIGURED_BACKEND\s+value: "true"/);
  assert.doesNotMatch(blueprint, /plan:|token|password|secret/i);
  assert.match(blueprint, /type: rewrite\s+source: \/\*\s+destination: \/index\.html/);
});

test('Pages retains repository-path routing and its explicit unavailable-backend publishing mode', () => {
  const workflow = readFileSync(new URL('../.github/workflows/deploy-pages.yml', import.meta.url), 'utf8');
  assert.match(workflow, /VITE_BASE_PATH: \/\$\{\{ github\.event\.repository\.name \}\}\//);
  assert.match(workflow, /VITE_ROUTER_MODE: hash/);
  assert.match(workflow, /VITE_ALLOW_UNCONFIGURED_BACKEND: 'true'/);
});
