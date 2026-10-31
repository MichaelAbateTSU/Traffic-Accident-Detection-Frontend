import assert from 'node:assert/strict';

export function assertFullTerminalResult(mounted, expected) {
  assert.equal(expected.status, 'complete');
  assert.ok(Number.isInteger(expected.frames_processed) && expected.frames_processed > 0);
  assert.ok(Number.isFinite(expected.peak_confidence));
  assert.ok(Array.isArray(expected.events));
  assert.ok(Array.isArray(expected.frames) && expected.frames.length > 0);
  const savedUrls = expected.frames.flatMap(frame =>
    ['capture', 'capture_annotated', 'pipeline_output'].flatMap(name =>
      frame[name] ? [frame[name]] : []));
  assert.ok(savedUrls.length > 0);
  assert.equal(mounted.present, true);
  assert.equal(mounted.jobId, expected.job_id);
  assert.equal(mounted.status, 'complete');
  assert.equal(mounted.framesProcessed, expected.frames_processed);
  assert.equal(mounted.peakConfidence, expected.peak_confidence);
  assert.deepEqual(mounted.events, expected.events);
  assert.deepEqual(mounted.savedFrameUrls, savedUrls);
  // Adapter must read actual rendered metrics/event details and load each saved
  // image through the real authenticated artifact helper, not inspect React state.
  assert.equal(mounted.metricsVisible, true);
  assert.equal(mounted.eventDetailsVisible, true);
  assert.equal(mounted.decodedSavedImages, savedUrls.length);
}

export async function verifyUncertainTerminalDetails({
  jobId, expected, prepareUncertainKeyAndRemount, readPersistedRecovery,
  holdActiveList, deliverCompleteReceipt, readMountedFullResult,
  waitForFullResult, settleBrowserPolling, postCount, fullJobGetCount,
}) {
  const posts = postCount();
  const fullGets = fullJobGetCount(jobId);
  await prepareUncertainKeyAndRemount();
  const identity = await readPersistedRecovery();
  assert.equal(identity.jobId, null);
  assert.equal(typeof identity.key, 'string');
  assert.ok(identity.key.length > 0);
  const releaseStale = await holdActiveList(jobId);
  try {
    const receipt = await deliverCompleteReceipt();
    assert.equal(receipt.job_id, jobId);
    assert.equal(receipt.status, 'complete');
    assert.deepEqual(receipt.frames, []);
    for (const field of ['frames_processed', 'peak_confidence', 'events']) {
      assert.equal(Object.hasOwn(receipt, field), false);
    }
  } finally {
    await releaseStale();
  }
  await waitForFullResult(jobId, 30000);
  await settleBrowserPolling();
  assert.ok(fullJobGetCount(jobId) > fullGets,
    'An uncertain key with no saved ID must obtain the original full job result');
  assertFullTerminalResult(await readMountedFullResult(jobId), expected);
  assert.equal(postCount(), posts);
  return { uncertainOriginalFullResultVisible: true, replacementPosts: 0 };
}

export async function verifyLateSparseReceiptPreservesDetails({
  jobId, expected, holdCompleteReceipt, waitForFullResult,
  readMountedFullResult, settleBrowserPolling, postCount,
}) {
  const posts = postCount();
  const releaseReceipt = await holdCompleteReceipt(jobId);
  try {
    await waitForFullResult(jobId, 30000);
    assertFullTerminalResult(await readMountedFullResult(jobId), expected);
  } finally {
    await releaseReceipt();
  }
  await settleBrowserPolling();
  assertFullTerminalResult(await readMountedFullResult(jobId), expected);
  assert.equal(postCount(), posts);
  return { lateSparseReceiptPreservedFullResult: true, replacementPosts: 0 };
}

export async function verifyExplicitSameKeyReplayDetails({
  jobId, key, originalBody, expected, readBackendInventory, submissionRequests,
  requestReplayFromUi, waitForFullResult, readMountedFullResult, settleBrowserPolling,
}) {
  const before = await readBackendInventory();
  assert.deepEqual(before.jobIds, [jobId]);
  for (const count of ['yolo_calls', 'tracker_calls', 'scorer_calls']) {
    assert.equal(before.inference[count], expected.frames_processed);
  }
  const requestOffset = submissionRequests().length;
  const replay = await requestReplayFromUi();
  assert.equal(replay.status, 200);
  assert.equal(replay.body.job_id, jobId);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.status, 'complete');
  assert.deepEqual(replay.body.frames, []);
  await waitForFullResult(jobId, 30000);
  await settleBrowserPolling();
  assertFullTerminalResult(await readMountedFullResult(jobId), expected);
  const requests = submissionRequests().slice(requestOffset);
  assert.equal(requests.length, 1, 'Only the explicitly requested replay POST is allowed');
  assert.equal(requests[0].key, key);
  assert.deepEqual(requests[0].body, originalBody);
  assert.deepEqual(await readBackendInventory(), before);
  return { explicitReplayPosts: 1, automaticReplacementPosts: 0, duplicateInferences: 0 };
}
