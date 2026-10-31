// CDP pauses the real response before Chromium exposes it to fetch().
export function createSubmissionResponseFault(send, verifyReceipt) {
  let armed = true;
  const identities = new Map();
  const counts = { admittedResponsesDropped: 0 };
  return {
    counts,
    async paused(event) {
      const { requestId, request, responseStatusCode } = event;
      if (request.method !== 'POST' || !request.url.endsWith('/detection-submissions/v1')) return false;
      if (responseStatusCode == null) {
        const key = Object.entries(request.headers).find(([name]) => name.toLowerCase() === 'idempotency-key')?.[1];
        if (!key) throw new Error('Keyed browser submission lacks identity');
        identities.set(requestId, key);
        await send('Fetch.continueRequest', { requestId, interceptResponse: true });
        return true;
      }
      const key = identities.get(requestId);
      identities.delete(requestId);
      if (armed && responseStatusCode === 202) {
        if (!key) throw new Error('Admission response cannot be correlated');
        await verifyReceipt(key);
        armed = false;
        await send('Fetch.failRequest', { requestId, errorReason: 'ConnectionClosed' });
        counts.admittedResponsesDropped++;
      } else {
        await send('Fetch.continueResponse', { requestId });
      }
      return true;
    },
  };
}
