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

test('structured errors retain HTTP status and protocol code; validation lists do not stringify or echo inputs', async () => {
  for (const status of [404, 409, 410, 503]) {
    const api = await loadApi({}, {
      fetch: async () => ({ ok: false, status, json: async () => ({
        detail: { code: `submission_${status}`, message: 'Submission receipt unavailable.' },
        meta: { request_id: 'request-1' },
      }) }),
    });
    await assert.rejects(api.getHealth(), (error) => {
      assert.equal(error.status, status);
      assert.equal(error.code, `submission_${status}`);
      assert.equal(error.requestId, 'request-1');
      assert.equal(error.message, 'Submission receipt unavailable.');
      return true;
    });
  }
  const api = await loadApi({}, {
    fetch: async () => ({ ok: false, status: 422, json: async () => ({
      detail: [{ loc: ['body', 'stream_url'], msg: 'invalid URL', input: 'private-source-input' }],
    }) }),
  });
  await assert.rejects(api.getHealth(), (error) => {
    assert.equal(error.status, 422);
    assert.equal(error.code, null);
    assert.equal(error.message, 'Request validation failed. Check the submission fields.');
    assert.ok(!error.message.includes('private-source-input'));
    assert.ok(!error.message.includes('[object Object]'));
    return true;
  });
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

const submissionKey = 'v1.1793484000.6e147bc2-2e7c-4e78-99ec-c211c5165f9c';
const submissionPayload = { stream_url: 'https://source.example/video.mp4?signature=dummy', max_frames: 120, save_frames: false };
const receipt = (replayed = false) => ({
  job_id: 'original-job', status: 'pending', replayed, idempotency_expires_at: new Date((Number(submissionKey.split('.')[1]) + 86400) * 1000).toISOString(),
  frames: [], artifacts_base_url: 'https://backend.example/artifacts',
});

test('keyed submissions and key-only recovery use the verified endpoint and exactly one stable header, with no legacy fallback', async () => {
  const calls = [];
  let replayed = false;
  const api = await loadApi({ VITE_API_BASE_URL: 'https://backend.example/api/v1' }, {
    fetch: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: options.method === 'GET' || replayed ? 200 : 202, json: async () => receipt(options.method === 'GET' || replayed) };
    },
  });
  api.setOperatorToken('dummy-operator-token');
  const accepted = await api.submitDetection(submissionPayload, { key: submissionKey });
  assert.equal(accepted.item.id, 'original-job');
  assert.equal(accepted.item.submissionReceiptOnly, true);
  assert.equal(accepted.replayed, false);
  replayed = true;
  const replay = await api.submitDetection(submissionPayload, { key: submissionKey });
  assert.equal(replay.item.id, accepted.item.id);
  assert.equal(replay.replayed, true);
  await api.getSubmission(submissionKey);
  assert.equal(calls.length, 3);
  for (const { url, options } of calls) {
    assert.equal(url, 'https://backend.example/api/v1/detection-submissions/v1');
    assert.deepEqual(Object.keys(options.headers).filter((key) => key.toLowerCase() === 'idempotency-key'), ['Idempotency-Key']);
    assert.equal(options.headers['Idempotency-Key'], submissionKey);
    assert.equal(options.headers.Authorization, 'Bearer dummy-operator-token');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.ok(!url.includes('signature'));
    assert.ok(!url.includes(submissionKey));
  }
  assert.deepEqual(JSON.parse(calls[0].options.body), submissionPayload);
  assert.equal(calls[2].options.method, 'GET');
  assert.equal(calls[2].options.body, undefined);
  assert.equal(calls[2].options.cache, 'no-store');
  await assert.rejects(api.submitDetection(submissionPayload, { key: submissionKey.split('.').at(-1) }), /stable v1/);
  assert.equal(calls.length, 3, 'a bare UUID must fail before any POST');
});

test('legacy or malformed success-shaped receipts never establish safe acceptance', async () => {
  for (const [status, body] of [
    [202, { job_id: 'legacy', status: 'pending' }],
    [202, { ...receipt(), replayed: true }],
    [200, receipt(false)],
    [202, { ...receipt(), idempotency_expires_at: 'not-a-date' }],
    [202, { ...receipt(), idempotency_expires_at: '2030-11-01T21:00:00+00:00' }],
    [202, { ...receipt(), idempotency_expires_at: '2026-11-01T21:00:00' }],
    [202, { ...receipt(), job_id: 'https://source.example/private' }],
    [201, receipt()],
  ]) {
    let requests = 0;
    const api = await loadApi({}, {
      fetch: async () => { requests++; return { ok: true, status, json: async () => body }; },
    });
    await assert.rejects(api.submitDetection(submissionPayload, { key: submissionKey }), (error) => error.code === 'invalid_submission_receipt');
    assert.equal(requests, 1);
  }
});

test('old servers fail closed after POST, and structured unknown/expiry/conflict codes remain distinguishable', async () => {
  for (const [status, detail] of [
    [404, 'Not Found'],
    [404, { code: 'idempotency_key_unknown', message: 'No receipt found yet.' }],
    [410, { code: 'idempotency_key_expired', message: 'Identity expired.' }],
    [410, { code: 'idempotency_result_expired', message: 'Result expired.' }],
    [409, { code: 'idempotency_key_conflict', message: 'Original parameters differ.' }],
    [503, { code: 'idempotency_unavailable', message: 'Durable storage unavailable.' }],
    [503, { code: 'submission_storage_unavailable', message: 'Submission storage is temporarily unavailable. Reconcile the original identity later.' }],
  ]) {
    const paths = [];
    const api = await loadApi({}, {
      fetch: async (url) => { paths.push(url); return { ok: false, status, json: async () => ({ detail }) }; },
    });
    await assert.rejects(api.submitDetection(submissionPayload, { key: submissionKey }), (error) => {
      assert.equal(error.status, status);
      assert.equal(error.code, status === 404 ? 'submission_endpoint_unavailable' : detail.code);
      assert.ok(!error.message.includes('[object Object]'));
      return true;
    });
    await assert.rejects(api.getSubmission(submissionKey), (error) => {
      assert.equal(error.status, status);
      assert.equal(error.code, typeof detail === 'string' ? null : detail.code);
      return true;
    });
    assert.ok(paths.every((path) => path.endsWith('/detection-submissions/v1')));
    assert.equal(paths.length, 2);
  }
});

test('queue admission failure preserves a validated original job identity without pretending inference succeeded', async () => {
  for (const malformed of [false, true]) {
    const api = await loadApi({}, {
      fetch: async () => ({ ok: false, status: 503, json: async () => ({
        detail: {
          code: 'inference_admission_failed', message: 'The inference worker is unavailable.',
          job_id: 'reserved-failed-job',
          ...(malformed ? {} : { idempotency_expires_at: receipt().idempotency_expires_at }),
        },
      }) }),
    });
    if (malformed) {
      await assert.rejects(api.submitDetection(submissionPayload, { key: submissionKey }), /valid versioned/);
    } else {
      const result = await api.submitDetection(submissionPayload, { key: submissionKey });
      assert.equal(result.item.id, 'reserved-failed-job');
      assert.equal(result.item.status, 'pending');
      assert.equal(result.item.admissionStatusUnknown, true);
      assert.equal(result.admissionFailed, true);
      assert.match(result.item.monitorError, /inference worker is unavailable.*status is unconfirmed/);
    }
  }
});
