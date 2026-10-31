import assert from 'node:assert/strict';
import test from 'node:test';
import { createStaleJobDetailFault } from './stale_job_detail_fault.mjs';
import { verifyOlderDetailCannotRegressReceipt } from './terminal_detail_assertions.mjs';

for (const status of ['pending', 'running']) {
  test(`pauses real unchanged ${status} detail, excludes status endpoint`, async () => {
    const calls = [];
    const fault = createStaleJobDetailFault(async method => {
      calls.push(method);
      return method === 'Fetch.getResponseBody' ?
        { body: JSON.stringify({ job_id: 'original', status }) } : {};
    }, 'https://api.integration.test:8453', 'original');
    const event = { requestId: 'detail', responseStatusCode: 200, request: {
      method: 'GET', url: 'https://api.integration.test:8453/jobs/original',
    } };
    try {
      assert.equal(await fault.paused({ ...event,
        request: { ...event.request, url: `${event.request.url}/status` } }), false);
      assert.equal(await fault.paused(event), true);
      assert.deepEqual(calls, ['Fetch.getResponseBody']);
      await fault.release();
      assert.equal(calls.at(-1), 'Fetch.continueResponse');
    } finally {
      await fault.cleanup();
    }
  });
}

function callbacks() {
  const inventory = { jobIds: ['original'], inference: { yolo_calls: 12 } };
  return {
    jobId: 'original', key: 'test-only-key',
    prepareSavedUncertainIdentity: async () => {},
    readPersistedRecovery: async () => ({ jobId: 'original', key: 'test-only-key' }),
    holdOriginalActiveDetail: async () => async () => {},
    receiveTerminalKeyOnlyReceipt: async () => ({ method: 'GET',
      body: { job_id: 'original', status: 'complete', frames: [] } }),
    observeMountedStatus: async () => {},
    stopMountedStatusObservation: async () => ({ observedTerminal: true, regressions: [] }),
    waitForFullResultOrReadError: async () => ({ kind: 'read-error', visible: true,
      retryable: true, jobId: 'original', status: 'complete', message: 'Read timed out; retry' }),
    settleBrowserPolling: async () => {},
    submissionRequests: () => [],
    readBackendInventory: async () => inventory,
  };
}

test('explicit retryable read error is honest, not a fabricated full result', async () => {
  assert.equal((await verifyOlderDetailCannotRegressReceipt(callbacks())).resultOutcome, 'read-error');
});

test('rejects transient mounted regression even if eventual error is terminal', async () => {
  const fixture = callbacks();
  fixture.stopMountedStatusObservation = async () => ({
    observedTerminal: true, regressions: ['running'],
  });
  await assert.rejects(verifyOlderDetailCannotRegressReceipt(fixture), assert.AssertionError);
});
