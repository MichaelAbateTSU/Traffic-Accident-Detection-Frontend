import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

test('actual page observer records consumption before application read and distinguishes driver fetch', async () => {
  const file = readFileSync(new URL('./keyed_browser.mjs', import.meta.url), 'utf8');
  const start = file.indexOf("await send('Page.addScriptToEvaluateOnNewDocument', { source:");
  const end = file.indexOf("await send('Fetch.enable'", start);
  assert.ok(start > 0 && end > start);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  let script;
  await new AsyncFunction('send', 'api', 'token', file.slice(start, end))(
    async (method, params) => { script = params.source; }, 'https://api.integration.test:8453', 'test-only-token');
  const events = [];
  const nativeCalls = [];
  const window = {
    receiptAttributionEvent: value=>events.push(JSON.parse(value)),
    fetch: async (url, options) => {
      nativeCalls.push(url);
      return { status: 200, json: async()=>({ job_id: 'original', status: 'complete' }) };
    },
  };
  class TestURL extends URL {
    static createObjectURL() {}
    static revokeObjectURL() {}
  }
  vm.runInNewContext(script, { window, URL: TestURL, location: { href: 'https://frontend.integration.test:8454/' },
    Headers, WeakMap, Map, JSON });
  const response = await window.fetch('https://api.integration.test:8453/detection-submissions/v1',
    { headers: { 'Idempotency-Key': 'key' } });
  assert.deepEqual(events, []);
  await response.json();
  await window.fetch('https://api.integration.test:8453/jobs/original');
  assert.deepEqual(events.map(event=>event.type), ['receipt-consumed', 'application-full-read']);
  assert.equal(events[0].key, 'key');
  assert.equal(events[0].jobId, 'original');
  const eventCount = events.length;
  await window.testDriverFetch('https://api.integration.test:8453/jobs/original');
  assert.equal(events.length, eventCount + 1);
  assert.equal(events.at(-1).type, 'driver-full-read');
  assert.equal(nativeCalls.length, 3);
});
