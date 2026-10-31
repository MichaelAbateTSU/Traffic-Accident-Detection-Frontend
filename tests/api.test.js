import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { SourceTextModule } from 'node:vm';

const source = await readFile(new URL('../src/services/api.js', import.meta.url), 'utf8');

async function loadApi(env) {
  // Supply Vite's build-time environment without changing the production module.
  const module = new SourceTextModule(source, {
    initializeImportMeta(meta) {
      meta.env = env;
    },
  });
  await module.link(() => {
    throw new Error('Unexpected import in API module');
  });
  await module.evaluate();
  return module.namespace;
}

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
  assert.equal(defaults.resolveAssetUrl('/artifacts/frame.jpg'), 'http://localhost:8000/artifacts/frame.jpg');

  const legacy = await loadApi({ VITE_API_URL: 'https://legacy.example/api/v1' });
  assert.equal(legacy.resolveAssetUrl('/api/v1/artifacts/frame.jpg'), 'https://legacy.example/api/v1/artifacts/frame.jpg');

  const preferred = await loadApi({
    VITE_API_BASE_URL: 'https://preferred.example/api/v1',
    VITE_API_URL: 'https://legacy.example',
  });
  assert.equal(preferred.resolveAssetUrl('/artifacts/frame.jpg'), 'https://preferred.example/artifacts/frame.jpg');
});
