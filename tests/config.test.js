import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveApiConfiguration, validateProductionBuild } from '../src/config.js';

test('development uses the existing Vite API proxy', () => {
  assert.deepEqual(resolveApiConfiguration(), { baseUrl: '/api', error: null });
  assert.equal(resolveApiConfiguration({ VITE_API_URL: 'http://localhost:8000/' }).baseUrl, 'http://localhost:8000');
});

test('production rejects missing, relative, insecure, local and credential-bearing API URLs', () => {
  for (const base of [
    undefined, '', '/api', '//backend.example', 'http://backend.example',
    'https://localhost', 'https://foo.localhost', 'https://127.0.0.1',
    'https://0.0.0.0', 'https://[::1]', 'https://user:secret@backend.example',
    'https://backend.example?token=secret', 'https://backend.example#token',
  ]) {
    assert.match(resolveApiConfiguration({ PROD: true, VITE_API_BASE_URL: base }).error, /public HTTPS/);
  }
});

test('production supports HTTPS backend prefixes and legacy configuration', () => {
  assert.deepEqual(resolveApiConfiguration({ PROD: true, VITE_API_BASE_URL: ' https://backend.example/api/v1/ ' }), {
    baseUrl: 'https://backend.example/api/v1', error: null,
  });
  assert.equal(resolveApiConfiguration({ PROD: true, VITE_API_URL: 'https://backend.example' }).error, null);
});

test('only explicit opt-in permits a missing backend build, not invalid URLs or runtime requests', () => {
  assert.throws(() => validateProductionBuild(), /public HTTPS/);
  assert.throws(() => validateProductionBuild({ VITE_ALLOW_UNCONFIGURED_BACKEND: 'false' }), /public HTTPS/);
  assert.doesNotThrow(() => validateProductionBuild({ VITE_ALLOW_UNCONFIGURED_BACKEND: 'true' }));
  assert.doesNotThrow(() => validateProductionBuild({
    VITE_ALLOW_UNCONFIGURED_BACKEND: 'true', VITE_API_BASE_URL: '  ',
  }));
  for (const baseUrl of ['/', '/api', 'http://backend.example', 'https://localhost', 'https://backend.example?token=secret']) {
    assert.throws(() => validateProductionBuild({
      VITE_ALLOW_UNCONFIGURED_BACKEND: 'true', VITE_API_BASE_URL: baseUrl,
    }), /public HTTPS/);
  }
  assert.doesNotThrow(() => validateProductionBuild({ VITE_API_BASE_URL: 'https://backend.example/api/v1' }));
  assert.match(resolveApiConfiguration({ PROD: true, VITE_ALLOW_UNCONFIGURED_BACKEND: 'true' }).error, /public HTTPS/);
});
