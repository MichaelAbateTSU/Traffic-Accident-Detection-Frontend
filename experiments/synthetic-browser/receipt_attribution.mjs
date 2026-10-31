import assert from 'node:assert/strict';

export function createReceiptAttribution(send, api, key, jobId, requireFullRead, maximumMs = 20000) {
  assert.ok(maximumMs > 0 && maximumMs <= 20000);
  const lookup = `${api}/detection-submissions/v1`;
  const heldLists = new Set();
  let lookupId, requestReleased = false, responseVerified = false;
  let responseDelivered = false, consumed = false, fullRead = false;
  let expired = false, transportError;
  let activeSnapshotHeld = false, responsePaused = false;
  const timer = setTimeout(() => {
    expired = true;
    cleanup().catch(error => { transportError = error; });
  }, maximumMs);
  async function cleanup() {
    clearTimeout(timer);
    if (lookupId && !requestReleased) {
      requestReleased = true;
      await send('Fetch.continueRequest', { requestId: lookupId });
    } else if (responsePaused && !responseDelivered) {
      responseDelivered = true;
      await send('Fetch.continueResponse', { requestId: lookupId });
    }
    for (const requestId of heldLists) {
      await send('Fetch.continueResponse', { requestId });
      heldLists.delete(requestId);
    }
  }
  function healthy() {
    assert.equal(expired, false, 'Receipt attribution exceeded its bounded deadline');
    if (transportError) throw transportError;
  }
  return {
    get requestId() { return lookupId; },
    get verified() { return responseVerified; },
    get consumed() { return consumed; },
    get fullRead() { return fullRead; },
    get activeSnapshotHeld() { return activeSnapshotHeld; },
    async paused(event) {
      healthy();
      const requestKey = Object.entries(event.request.headers)
        .find(([name]) => name.toLowerCase() === 'idempotency-key')?.[1];
      if (event.request.url === lookup && event.request.method === 'GET' && requestKey === key) {
        if (event.responseStatusCode == null) {
          assert.equal(lookupId, undefined, 'Unexpected competing same-key lookup');
          lookupId = event.requestId;
          return true;
        }
        assert.equal(event.requestId, lookupId, 'Terminal receipt must belong to the held request');
        responsePaused = true;
        assert.equal(requestReleased, true);
        assert.equal(event.responseStatusCode, 200, 'Held lookup did not return a real 200 receipt');
        const result = await send('Fetch.getResponseBody', { requestId: lookupId });
        const receipt = JSON.parse(result.base64Encoded ?
          Buffer.from(result.body, 'base64').toString('utf8') : result.body);
        assert.ok(receipt && typeof receipt === 'object', 'Missing real terminal receipt');
        assert.equal(receipt.job_id, jobId);
        assert.equal(receipt.status, 'complete');
        assert.equal(receipt.replayed, true);
        assert.deepEqual(receipt.frames, []);
        responseVerified = true;
        return true;
      }
      const url = new URL(event.request.url);
      if (requireFullRead && !fullRead && url.origin === api &&
          url.pathname === '/jobs' && event.request.method === 'GET') {
        if (event.responseStatusCode == null) {
          await send('Fetch.continueRequest', { requestId: event.requestId, interceptResponse: true });
          return true;
        }
        if (event.responseStatusCode === 200) {
          const result = await send('Fetch.getResponseBody', { requestId: event.requestId });
          const list = JSON.parse(result.base64Encoded ?
            Buffer.from(result.body, 'base64').toString('utf8') : result.body);
          if (list.data?.some(job => job.job_id === jobId)) {
            heldLists.add(event.requestId);
            if (list.data.some(job => job.job_id === jobId && ['pending', 'running'].includes(job.status))) {
              activeSnapshotHeld = true;
            }
            return true;
          }
        }
        await send('Fetch.continueResponse', { requestId: event.requestId });
        return true;
      }
      return false;
    },
    async releaseRequest() {
      healthy();
      assert.ok(lookupId, 'No original key lookup captured');
      assert.equal(requestReleased, false);
      requestReleased = true;
      await send('Fetch.continueRequest', { requestId: lookupId, interceptResponse: true });
    },
    async deliverResponse() {
      healthy();
      assert.equal(responseVerified, true, 'Missing or nonterminal receipt cannot be delivered');
      responseDelivered = true;
      await send('Fetch.continueResponse', { requestId: lookupId });
    },
    observed(event) {
      healthy();
      if (event.type === 'receipt-consumed' && event.key === key) {
        assert.equal(responseVerified && responseDelivered, true);
        assert.equal(event.jobId, jobId);
        assert.equal(event.status, 'complete');
        consumed = true;
      } else if (event.type === 'application-full-read' && event.jobId === jobId) {
        if (requireFullRead) assert.equal(consumed, true, 'Application full read preceded receipt consumption');
        if (consumed) fullRead = true;
      }
    },
    async releaseLists() {
      healthy();
      assert.equal(consumed, true);
      if (requireFullRead) assert.equal(fullRead, true);
      await cleanup();
    },
    cleanup,
  };
}
