import assert from 'node:assert/strict';

// Invoke only after the existing request-origin allowlist has permitted the event.
export function createStaleActiveListFault(send, apiBase, jobId, maximumHoldMs = 20000) {
  assert.ok(maximumHoldMs > 0 && maximumHoldMs <= 20000);
  const jobsUrl = new URL(`${apiBase.replace(/\/$/, '')}/jobs`);
  let heldId;
  let timer;
  let released = false;
  let expired = false;
  let transportError;
  let automaticRelease;
  const counts = { pendingSnapshotsHeld: 0, staleSnapshotsReleased: 0 };
  return {
    counts,
    async paused(event) {
      const url = new URL(event.request.url);
      if (event.request.method !== 'GET' || url.origin !== jobsUrl.origin ||
          url.pathname !== jobsUrl.pathname ||
          !['pending', 'running'].includes(url.searchParams.get('status'))) {
        return false;
      }
      if (event.responseStatusCode == null) {
        await send('Fetch.continueRequest', { requestId: event.requestId, interceptResponse: true });
        return true;
      }
      if (counts.pendingSnapshotsHeld === 0 && event.responseStatusCode === 200) {
        const result = await send('Fetch.getResponseBody', { requestId: event.requestId });
        const body = JSON.parse(result.base64Encoded ?
          Buffer.from(result.body, 'base64').toString('utf8') : result.body);
        if (body.data?.some(job => job.job_id === jobId &&
            ['pending', 'running'].includes(job.status))) {
          heldId = event.requestId;
          counts.pendingSnapshotsHeld++;
          timer = setTimeout(() => {
            expired = true;
            automaticRelease = send('Fetch.continueResponse', { requestId: heldId }).catch(error => {
              transportError = error;
            });
          }, maximumHoldMs);
          return true;
        }
      }
      await send('Fetch.continueResponse', { requestId: event.requestId });
      return true;
    },
    async release() {
      clearTimeout(timer);
      assert.equal(expired, false, 'Stale-list pause exceeded the bounded browser scenario');
      if (transportError) throw transportError;
      assert.ok(heldId, 'No actual pending list snapshot was held');
      assert.equal(released, false);
      released = true;
      await send('Fetch.continueResponse', { requestId: heldId });
      counts.staleSnapshotsReleased++;
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
