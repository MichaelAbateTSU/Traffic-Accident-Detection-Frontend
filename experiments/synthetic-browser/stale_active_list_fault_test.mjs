import assert from 'node:assert/strict';
import test from 'node:test';
import { createStaleActiveListFault } from './stale_active_list_fault.mjs';

test('holds actual response-stage body unchanged and releases once', async () => {
  const calls = [];
  const send = async (method, params) => {
    calls.push({ method, params });
    if (method === 'Fetch.getResponseBody') {
      return { body: JSON.stringify({ data: [{ job_id: 'original', status: 'pending' }] }) };
    }
    return {};
  };
  const fault = createStaleActiveListFault(send, 'https://api.integration.test:8453', 'original');
  const event = { requestId: 'request', request: {
    method: 'GET', url: 'https://api.integration.test:8453/jobs?status=pending',
  } };
  try {
    assert.equal(await fault.paused(event), true);
    assert.equal(calls[0].params.interceptResponse, true);
    assert.equal(await fault.paused({ ...event, responseStatusCode: 200 }), true);
    assert.equal(calls.length, 2);
    await fault.release();
    assert.equal(calls[2].method, 'Fetch.continueResponse');
    assert.deepEqual(fault.counts, { pendingSnapshotsHeld: 1, staleSnapshotsReleased: 1 });
  } finally {
    await fault.cleanup();
  }
});

test('does not handle external hosts or unrelated status endpoints', async () => {
  const fault = createStaleActiveListFault(() => { throw new Error('Unexpected transport'); },
    'https://api.integration.test:8453', 'original');
  for (const url of [
    'https://outside.invalid/jobs?status=pending',
    'https://api.integration.test:8453/jobs/original/status',
  ]) {
    assert.equal(await fault.paused({ requestId: 'request', request: { method: 'GET', url } }), false);
  }
  await fault.cleanup();
});

test('also holds a genuine running snapshot', async () => {
  const fault = createStaleActiveListFault(async method => method === 'Fetch.getResponseBody' ?
    { body: JSON.stringify({ data: [{ job_id: 'original', status: 'running' }] }) } : {},
  'https://api.integration.test:8453', 'original');
  try {
    assert.equal(await fault.paused({
      requestId: 'running', responseStatusCode: 200,
      request: { method: 'GET', url: 'https://api.integration.test:8453/jobs?status=running' },
    }), true);
    assert.equal(fault.counts.pendingSnapshotsHeld, 1);
    await fault.release();
  } finally {
    await fault.cleanup();
  }
});
