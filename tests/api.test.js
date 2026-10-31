import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createContext, SourceTextModule } from 'node:vm';

const source = await readFile(new URL('../src/services/api.js', import.meta.url), 'utf8');
const configSource = await readFile(new URL('../src/config.js', import.meta.url), 'utf8');

async function loadApi(env, globals = {}) {
  const context = createContext({ URL, URLSearchParams, Blob, setTimeout, ...globals });
  // Supply Vite's build-time environment without changing the production module.
  const module = new SourceTextModule(source, {
    context,
    initializeImportMeta(meta) {
      meta.env = env;
    },
  });
  await module.link((specifier) => {
    if (specifier === '../config.js') return new SourceTextModule(configSource, { context });
    throw new Error('Unexpected import in API module');
  });
  await module.evaluate();
  return module.namespace;
}

test('production requests fail closed without a backend URL', async () => {
  const api = await loadApi({ PROD: true }, {
    fetch() { assert.fail('Invalid deployment must not make network requests'); },
  });
  await assert.rejects(api.getHealth(), /public HTTPS/);
  await assert.rejects(api.exportIncidentsCsv(), /public HTTPS/);
  await assert.rejects(api.fetchArtifactBlob('/artifacts/frame.jpg'), /public HTTPS/);
});

test('operator token authorizes API calls and is cleared on sign out', async () => {
  const calls = [];
  const api = await loadApi({ PROD: true, VITE_API_BASE_URL: 'https://backend.example/api/v1' }, {
    async fetch(url, options) {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ data: { status: 'healthy' }, meta: {} }) };
    },
  });
  api.setOperatorToken(' operator-secret ');
  await api.getHealth();
  assert.equal(calls[0].url, 'https://backend.example/api/v1/health');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer operator-secret');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.redirect, 'error');
  assert.ok(!calls[0].url.includes('operator-secret'));
  api.setOperatorToken('');
  await api.getHealth();
  assert.equal(calls[1].options.headers.Authorization, undefined);
  assert.throws(() => api.setOperatorToken('invalid\nheader'), /line breaks/);
});

test('artifact authentication is restricted to backend origin, including resolved root paths', async () => {
  const calls = [];
  const api = await loadApi({ PROD: true, VITE_API_BASE_URL: 'https://backend.example/api/v1' }, {
    async fetch(url, options) {
      calls.push({ url, options });
      return { ok: true, blob: async () => new Blob(['image'], { type: 'image/png' }) };
    },
  });
  api.setOperatorToken('operator-secret');
  await api.fetchArtifactBlob('/artifacts/frame.jpg');
  await api.fetchArtifactBlob('//cdn.example/frame.jpg');
  await api.fetchArtifactBlob('https://backend.example.evil.test/frame.jpg');
  assert.equal(calls[0].url, 'https://backend.example/artifacts/frame.jpg');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer operator-secret');
  for (const call of calls.slice(1)) {
    assert.equal(call.options.headers.Authorization, undefined);
    assert.equal(call.options.credentials, 'omit');
    assert.equal(call.options.redirect, 'error');
  }
  await assert.rejects(api.fetchArtifactBlob('https://user:secret@backend.example/frame.jpg'), /Unsupported/);
  await assert.rejects(api.fetchArtifactBlob('javascript:alert(1)'), /invalid|Unsupported/i);
});

test('backend errors and successful HTML instead of JSON or images are explicit failures', async () => {
  const env = { PROD: true, VITE_API_BASE_URL: 'https://backend.example' };
  const invalid = await loadApi(env, {
    fetch: async () => ({
      ok: true, status: 200,
      json: async () => { throw new SyntaxError('HTML'); },
      blob: async () => new Blob(['<html>'], { type: 'text/html' }),
    }),
  });
  await assert.rejects(invalid.getHealth(), /invalid JSON/);
  await assert.rejects(invalid.fetchArtifactBlob('/artifacts/image'), /invalid image/);
  const unauthorized = await loadApi(env, {
    fetch: async () => ({ ok: false, status: 401, json: async () => ({ detail: 'Invalid operator token' }) }),
  });
  await assert.rejects(unauthorized.getHealth(), /Invalid operator token/);
  await assert.rejects(unauthorized.fetchArtifactBlob('/artifacts/image'), /HTTP 401/);
});

test('CSV exports carry authorization and revoke their temporary download URL', async () => {
  const calls = [];
  const revoked = [];
  const link = { click() {}, remove() {} };
  class TestURL extends URL {
    static createObjectURL() { return 'blob:download'; }
    static revokeObjectURL(url) { revoked.push(url); }
  }
  const api = await loadApi({ PROD: true, VITE_API_BASE_URL: 'https://backend.example' }, {
    URL: TestURL,
    setTimeout: (callback) => callback(),
    document: { createElement: () => link, body: { appendChild() {} } },
    async fetch(url, options) {
      calls.push({ url, options });
      return {
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="filtered.csv"' }),
        blob: async () => new Blob(['id\n1'], { type: 'text/csv' }),
      };
    },
  });
  api.setOperatorToken('operator-secret');
  const result = await api.exportIncidentsCsv({ cameraId: 'CAM-01' });
  assert.equal(calls[0].options.headers.Authorization, 'Bearer operator-secret');
  assert.equal(calls[0].options.redirect, 'error');
  assert.match(calls[0].url, /camera_id=CAM-01/);
  assert.equal(result.filename, 'filtered.csv');
  assert.equal(link.href, 'blob:download');
  assert.deepEqual(revoked, ['blob:download']);
});
const configurations = [
  ['http://host:8000', 'http://host:8000'],
  ['http://host:8000/', 'http://host:8000'],
  ['http://host:8000/api/v1', 'http://host:8000'],
  ['https://host:8443/api/v1/', 'https://host:8443'],
  ['//host:8000/api/v1', '//host:8000'],
  ['/api/v1', ''],
  ['/api/v1/', ''],
  ['api/v1', ''],
  ['', ''],
];

for (const [base, origin] of configurations) {
  test(`artifact resolution with API base ${JSON.stringify(base)}`, async () => {
    const { resolveAssetUrl } = await loadApi({ VITE_API_BASE_URL: base });
    for (const path of [
      '/artifacts/job/capture/000001.jpg',
      '/api/v1/artifacts/job/capture/000001.jpg',
      '/api/v1/artifacts/job/frame%20one.jpg?download=1#preview',
    ]) {
      assert.equal(resolveAssetUrl(path), `${origin}${path}`);
    }

    const trimmedBase = base.endsWith('/') ? base.slice(0, -1) : base;
    assert.equal(
      resolveAssetUrl('artifacts/job/capture/000001.jpg?size=small'),
      `${trimmedBase}/artifacts/job/capture/000001.jpg?size=small`,
    );

    for (const url of [
      'http://cdn.example/frame.jpg',
      'https://cdn.example/frame.jpg?size=small#preview',
      '//cdn.example/frame.jpg',
      'data:image/png;base64,aGVsbG8=',
      'blob:https://ui.example/frame-id',
    ]) {
      assert.equal(resolveAssetUrl(url), url);
    }
    for (const value of [undefined, null, '']) {
      assert.equal(resolveAssetUrl(value), null);
    }
  });
}

test('default and legacy API environment settings remain supported', async () => {
  const defaults = await loadApi({});
  assert.equal(defaults.resolveAssetUrl('/artifacts/frame.jpg'), '/artifacts/frame.jpg');
  assert.equal(defaults.API_CONFIGURATION.baseUrl, '/api');

  const legacy = await loadApi({ VITE_API_URL: 'https://legacy.example/api/v1' });
  assert.equal(legacy.resolveAssetUrl('/api/v1/artifacts/frame.jpg'), 'https://legacy.example/api/v1/artifacts/frame.jpg');

  const preferred = await loadApi({
    VITE_API_BASE_URL: 'https://preferred.example/api/v1',
    VITE_API_URL: 'https://legacy.example',
  });

  assert.equal(preferred.resolveAssetUrl('/artifacts/frame.jpg'), 'https://preferred.example/artifacts/frame.jpg');
});

test('single detection submissions preserve max_frames and omission compatibility', async () => {
  const payloads = [];
  const api = await loadApi({ VITE_API_BASE_URL: 'https://backend.example' }, {
    async fetch(url, options) {
      assert.equal(url, 'https://backend.example/detect-accident');
      payloads.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ data: { job_id: 'accepted', status: 'pending' }, meta: {} }) };
    },
  });
  for (const max_frames of [1, 120, 300]) {
    await api.startDetectionJob({ stream_url: 'https://stream.example/live', save_frames: true, max_frames });
    assert.equal(payloads.at(-1).max_frames, max_frames);
    assert.equal(payloads.at(-1).save_frames, true);
  }
  await api.startDetectionJob({ stream_url: 'https://stream.example/live', save_frames: false });
  assert.equal('max_frames' in payloads.at(-1), false);
  assert.equal(api.parseMaxFrames('120'), 120);
});

test('invalid single detection frame counts never reach the backend', async () => {
  const api = await loadApi({}, {
    fetch() { assert.fail('Invalid frame count must not make a request'); },
  });
  for (const max_frames of [0, 301, -1, 1.5, NaN, Infinity, true, null, '120', '']) {
    await assert.rejects(api.startDetectionJob({ stream_url: 'https://stream.example', max_frames }), /integer|whole number/);
  }
});
