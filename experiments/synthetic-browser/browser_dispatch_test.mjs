// Execute the actual browser dispatch body with controlled CDP only. This catches
// routing mistakes between the allowlist and genuine-response fault helpers.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createStaleJobDetailFault } from './stale_job_detail_fault.mjs';
import { createStaleActiveListFault } from './stale_active_list_fault.mjs';
import { createReceiptAttribution } from './receipt_attribution.mjs';

const browser = readFileSync(new URL('./keyed_browser.mjs', import.meta.url), 'utf8');
const start = browser.indexOf('(async () => {', browser.indexOf("message.method === 'Fetch.requestPaused'"));
const end = browser.indexOf('})().catch', start);
assert.ok(start >= 0 && end > start);
const body = browser.slice(start + '(async () => {'.length, end);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const dispatch = new AsyncFunction('event', 'permitted', 'send', 'olderDetailFault', 'activeListFault', 'attribution', `
  const api='https://api.integration.test:8453',frontend='https://frontend.integration.test:8454';
  let externalBlocked=0,legacyBoundary=false,fulfilledLegacyLookups=0,failOneLookup=false;
  const sparseFault=null,phase='test',loss=null;
  ${body}
`);

test('actual dispatch routes original job GET request and response to detail pause', async () => {
  const methods = [];
  const send = async method => {
    methods.push(method);
    return method === 'Fetch.getResponseBody' ?
      { body: JSON.stringify({ job_id: 'original', status: 'running' }) } : {};
  };
  const fault = createStaleJobDetailFault(send, 'https://api.integration.test:8453', 'original');
  const event = { requestId: 'detail', request: {
    method: 'GET', url: 'https://api.integration.test:8453/jobs/original',
  } };
  try {
    await dispatch(event, true, send, fault);
    await dispatch({ ...event, responseStatusCode: 200 }, true, send, fault);
    assert.equal(fault.held, true);
    assert.deepEqual(methods, ['Fetch.continueRequest', 'Fetch.getResponseBody']);
    await fault.release();
  } finally {
    await fault.cleanup();
  }
});

test('no-ID dispatch holds additional ID-revealing lists before terminal receipt', async () => {
  const methods = [];
  const send = async method => {
    methods.push(method);
    return method === 'Fetch.getResponseBody' ?
      { body: JSON.stringify({ data: [{ job_id: 'original', status: 'running' }] }) } : {};
  };
  const fault = createReceiptAttribution(send, 'https://api.integration.test:8453', 'test-only-key', 'original', true);
  try {
    await dispatch({ requestId: 'active', responseStatusCode: 200,
      request: { method: 'GET', url: 'https://api.integration.test:8453/jobs?status=running', headers: {} } },
    true, send, null, null, fault);
    assert.equal(fault.activeSnapshotHeld, true);
    await dispatch({ requestId: 'other', responseStatusCode: 200,
      request: { method: 'GET', url: 'https://api.integration.test:8453/jobs?page=1', headers: {} } },
    true, send, null, null, fault);
    assert.equal(methods.includes('Fetch.continueResponse'), false);
  } finally {
    await fault.cleanup();
  }
});

test('actual dispatch blocks disallowed origin before any response fault', async () => {
  const calls = [];
  await dispatch({ requestId: 'external', request: {
    method: 'GET', url: 'https://camera.invalid/jobs/original',
  } }, false, async (method, params) => calls.push({ method, params }), {
    paused() { throw new Error('Disallowed host reached fault'); },
  });
  assert.equal(calls[0].method, 'Fetch.failRequest');
  assert.equal(calls[0].params.errorReason, 'BlockedByClient');
});

test('actual dispatch routes active listing to genuine body pause', async () => {
    const methods = [];
    const send = async method => {
      methods.push(method);
      return method === 'Fetch.getResponseBody' ? {
        body: JSON.stringify({ data: [{ job_id: 'original', status: 'running' }] }),
      } : {};
    };
    const fault = createStaleActiveListFault(send, 'https://api.integration.test:8453', 'original');
    const event = { requestId: 'listing', request: {
      method: 'GET', url: 'https://api.integration.test:8453/jobs?status=running',
    } };
    try {
      await dispatch(event, true, send, null, fault);
      await dispatch({ ...event, responseStatusCode: 200 }, true, send, null, fault);
      assert.equal(fault.held, true);
      assert.deepEqual(methods, ['Fetch.continueRequest', 'Fetch.getResponseBody']);
      await fault.release();
    } finally {
      await fault.cleanup();
    }
});
