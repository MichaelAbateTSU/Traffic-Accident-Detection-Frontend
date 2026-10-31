import assert from 'node:assert/strict';
import test from 'node:test';
import { createReceiptAttribution } from './receipt_attribution.mjs';

const api = 'https://api.integration.test:8453';
const lookup = { requestId: 'original-lookup', request: {
  method: 'GET', url: `${api}/detection-submissions/v1`, headers: { 'Idempotency-Key': 'key' },
} };
function fixture(receipt = { job_id: 'original', status: 'complete', replayed: true, frames: [] }) {
  const calls = [];
  const fault = createReceiptAttribution(async (method, params) => {
    calls.push({ method, params });
    return method === 'Fetch.getResponseBody' ? { body: JSON.stringify(
      params.requestId.startsWith('list') ?
        { data: [{ job_id: 'original', status: 'running' }] } : receipt,
    ) } : {};
  }, api, 'key', 'original', true);
  return { fault, calls };
}

test('list arriving after key request release stays blocked through receipt consumption/full read', async () => {
  const { fault, calls } = fixture();
  try {
    await fault.paused(lookup);
    await fault.releaseRequest();
    await fault.paused({ requestId: 'list-late', responseStatusCode: 200,
      request: { method: 'GET', url: `${api}/jobs?status=running`, headers: {} } });
    assert.equal(fault.activeSnapshotHeld, true);
    assert.equal(calls.some(c=>c.method==='Fetch.continueResponse'), false);
    await assert.rejects(fault.releaseLists(), assert.AssertionError);
    await fault.paused({ ...lookup, responseStatusCode: 200 });
    await fault.deliverResponse();
    await assert.rejects(fault.releaseLists(), assert.AssertionError);
    fault.observed({ type: 'receipt-consumed', key: 'key', jobId: 'original', status: 'complete' });
    await assert.rejects(fault.releaseLists(), assert.AssertionError);
    assert.throws(()=>fault.observed({ type: 'driver-full-read', jobId: 'original' }), assert.AssertionError);
    assert.equal(fault.fullRead, false);
    fault.observed({ type: 'application-full-read', jobId: 'original' });
    assert.equal(fault.fullRead, false);
    await assert.rejects(fault.releaseLists(), assert.AssertionError);
    fault.observed({ type: 'network-full-read', jobId: 'original' });
    await assert.rejects(fault.releaseLists(), assert.AssertionError);
    fault.confirmedRenderedResult();
    await fault.releaseLists();
    assert.equal(calls.at(-1).params.requestId, 'list-late');
  } finally {
    await fault.cleanup();
  }
});

for (const receipt of [null, { job_id: 'original', status: 'running', frames: [] },
  { job_id: 'replacement', status: 'complete', replayed: true, frames: [] }]) {
  test(`missing/nonterminal/mismatched receipt fails: ${JSON.stringify(receipt)}`, async () => {
    const { fault } = fixture(receipt);
    try {
      await fault.paused(lookup);
      await fault.releaseRequest();
      await assert.rejects(fault.paused({ ...lookup, responseStatusCode: 200 }));
      await assert.rejects(fault.deliverResponse(), assert.AssertionError);
    } finally { await fault.cleanup(); }
  });
}

test('full read or consumption before verified delivery cannot establish attribution', async () => {
  const { fault } = fixture();
  try {
    assert.throws(()=>fault.observed({ type: 'application-full-read', jobId: 'original' }), assert.AssertionError);
    assert.throws(()=>fault.observed({ type: 'receipt-consumed', key: 'key', jobId: 'original', status: 'complete' }), assert.AssertionError);
    await fault.paused(lookup);
    await fault.releaseRequest();
    await assert.rejects(fault.paused({ ...lookup, requestId: 'unrelated', responseStatusCode: 200 }), assert.AssertionError);
  } finally { await fault.cleanup(); }
});

test('application binding without a real network GET cannot open lists or confirm rendered results', async () => {
  const { fault } = fixture();
  try {
    await fault.paused(lookup);
    await fault.releaseRequest();
    await fault.paused({ ...lookup, responseStatusCode: 200 });
    await fault.deliverResponse();
    fault.observed({ type: 'receipt-consumed', key: 'key', jobId: 'original', status: 'complete' });
    fault.observed({ type: 'application-full-read', jobId: 'original' });
    assert.equal(fault.fullRead, false);
    assert.throws(()=>fault.confirmedRenderedResult(), assert.AssertionError);
    await assert.rejects(fault.releaseLists(), assert.AssertionError);
    assert.throws(()=>fault.observed({ type: 'driver-full-read', jobId: 'original' }), assert.AssertionError);
  } finally { await fault.cleanup(); }
});
