import assert from 'node:assert/strict';

// Pause a real sparse terminal receipt; never replace its body or invent metrics.
export function createSparseReceiptFault(send, apiBase, key, jobId, maximumHoldMs = 20000) {
  assert.ok(maximumHoldMs > 0 && maximumHoldMs <= 20000);
  const endpoint = `${apiBase.replace(/\/$/, '')}/detection-submissions/v1`;
  let heldId, timer, automaticRelease, transportError;
  let expired = false;
  let released = false;
  return {
    async paused(event) {
      const requestKey = Object.entries(event.request.headers)
        .find(([name]) => name.toLowerCase() === 'idempotency-key')?.[1];
      if (event.request.url !== endpoint || requestKey !== key ||
          !['GET', 'POST'].includes(event.request.method)) return false;
      if (event.responseStatusCode == null) {
        await send('Fetch.continueRequest', { requestId: event.requestId, interceptResponse: true });
        return true;
      }
      if (!heldId && event.responseStatusCode === 200) {
        const result = await send('Fetch.getResponseBody', { requestId: event.requestId });
        const receipt = JSON.parse(result.base64Encoded ?
          Buffer.from(result.body, 'base64').toString('utf8') : result.body);
        if (receipt.job_id === jobId && receipt.status === 'complete') {
          assert.deepEqual(receipt.frames, []);
          for (const field of ['frames_processed', 'peak_confidence', 'events']) {
            assert.equal(Object.hasOwn(receipt, field), false);
          }
          heldId = event.requestId;
          timer = setTimeout(() => {
            expired = true;
            automaticRelease = send('Fetch.continueResponse', { requestId: heldId })
              .catch(error => { transportError = error; });
          }, maximumHoldMs);
          return true;
        }
      }
      await send('Fetch.continueResponse', { requestId: event.requestId });
      return true;
    },
    async release() {
      clearTimeout(timer);
      assert.equal(expired, false, 'Sparse receipt pause exceeded the bounded scenario');
      assert.ok(heldId, 'No actual complete sparse receipt was held');
      assert.equal(released, false);
      released = true;
      await send('Fetch.continueResponse', { requestId: heldId });
    },
    async cleanup() {
      clearTimeout(timer);
      if (automaticRelease) await automaticRelease;
      if (heldId && !released && !expired) {
        released = true;
        await send('Fetch.continueResponse', { requestId: heldId });
      }
      if (transportError) throw transportError;
    },
  };
}
