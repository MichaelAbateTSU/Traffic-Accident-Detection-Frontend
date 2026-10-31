import assert from 'node:assert/strict';

// Existing browser allowlist must run first. The real body is never replaced.
export function createStaleJobDetailFault(send, apiBase, jobId, maximumHoldMs = 20000) {
  assert.ok(maximumHoldMs > 0 && maximumHoldMs <= 20000);
  const endpoint = `${apiBase.replace(/\/$/, '')}/jobs/${encodeURIComponent(jobId)}`;
  let heldId, timer, automaticRelease, transportError;
  let expired = false, released = false;
  return {
    async paused(event) {
      if (event.request.method !== 'GET' || event.request.url !== endpoint) return false;
      if (event.responseStatusCode == null) {
        await send('Fetch.continueRequest', { requestId: event.requestId, interceptResponse: true });
        return true;
      }
      if (!heldId && event.responseStatusCode === 200) {
        const result = await send('Fetch.getResponseBody', { requestId: event.requestId });
        const job = JSON.parse(result.base64Encoded ?
          Buffer.from(result.body, 'base64').toString('utf8') : result.body);
        if (job.job_id === jobId && ['pending', 'running'].includes(job.status)) {
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
      assert.equal(expired, false, 'Real job completion did not fit the bounded detail pause');
      assert.ok(heldId, 'No genuine active original job detail was captured');
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
