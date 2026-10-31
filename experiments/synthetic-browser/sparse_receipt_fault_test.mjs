import assert from 'node:assert/strict';
import test from 'node:test';
import { createSparseReceiptFault } from './sparse_receipt_fault.mjs';

for (const method of ['GET', 'POST']) {
  test(`holds unchanged sparse terminal ${method} receipt, not unrelated traffic`, async () => {
    const calls = [];
    const fault = createSparseReceiptFault(async (name, params) => {
      calls.push(name);
      return name === 'Fetch.getResponseBody' ?
        { body: JSON.stringify({ job_id: 'original', status: 'complete', frames: [] }) } : {};
    }, 'https://api.integration.test:8453', 'test-only-key', 'original');
    const event = { requestId: 'receipt', request: {
      method, url: 'https://api.integration.test:8453/detection-submissions/v1',
      headers: { 'Idempotency-Key': 'test-only-key' },
    } };
    try {
      assert.equal(await fault.paused({ ...event, request: { ...event.request, headers: {} } }), false);
      assert.equal(await fault.paused(event), true);
      assert.equal(await fault.paused({ ...event, responseStatusCode: 200 }), true);
      assert.deepEqual(calls, ['Fetch.continueRequest', 'Fetch.getResponseBody']);
      await fault.release();
      assert.equal(calls.at(-1), 'Fetch.continueResponse');
    } finally {
      await fault.cleanup();
    }
  });
}
