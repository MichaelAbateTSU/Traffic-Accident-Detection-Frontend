// Contract checks only; candidate DOM/image adapters are intentionally not mocked
// into the application and these checks are not mounted-browser evidence.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertFullTerminalResult, verifyUncertainTerminalDetails,
  verifyLateSparseReceiptPreservesDetails, verifyExplicitSameKeyReplayDetails,
} from './terminal_detail_assertions.mjs';

const expected = {
  job_id: 'original', status: 'complete', frames_processed: 12, peak_confidence: 0.2206,
  events: [{ frame_idx: 4, confidence: 0.7 }],
  frames: [{ capture: 'https://api.integration.test:8453/artifacts/original/frame.jpg' }],
};
function rendered() {
  return {
    present: true, jobId: 'original', status: 'complete', framesProcessed: 12,
    peakConfidence: 0.2206, events: expected.events,
    savedFrameUrls: [expected.frames[0].capture], metricsVisible: true,
    eventDetailsVisible: true, decodedSavedImages: 1,
  };
}

test('checks every result detail rather than terminal status alone', () => {
  assertFullTerminalResult(rendered(), expected);
  for (const replacement of [
    { framesProcessed: undefined }, { peakConfidence: undefined }, { events: [] },
    { savedFrameUrls: [] }, { decodedSavedImages: 0 }, { metricsVisible: false },
  ]) {
    assert.throws(() => assertFullTerminalResult({ ...rendered(), ...replacement }, expected),
      assert.AssertionError);
  }
});

test('allows genuine zero-event results without inventing an accident', () => {
  assertFullTerminalResult({ ...rendered(), events: [] }, { ...expected, events: [] });
});

test('uncertain key must fetch full job even after a delayed active listing', async () => {
  let gets = 0;
  let released = false;
  const callbacks = {
    jobId: 'original', expected,
    prepareUncertainKeyAndRemount: async () => {},
    readPersistedRecovery: async () => ({ jobId: null, key: 'test-only-key' }),
    holdActiveList: async () => async () => { released = true; },
    deliverCompleteReceipt: async () => ({ job_id: 'original', status: 'complete', frames: [] }),
    readMountedFullResult: async () => rendered(),
    waitForFullResult: async () => { assert.equal(released, true); gets++; },
    settleBrowserPolling: async () => {},
    postCount: () => 0,
    fullJobGetCount: () => gets,
  };
  assert.equal((await verifyUncertainTerminalDetails(callbacks)).replacementPosts, 0);
  callbacks.waitForFullResult = async () => {};
  await assert.rejects(verifyUncertainTerminalDetails(callbacks), assert.AssertionError);
});

test('late sparse receipt cannot erase metrics, events or artifact URLs', async () => {
  let erased = false;
  await assert.rejects(verifyLateSparseReceiptPreservesDetails({
    jobId: 'original', expected,
    holdCompleteReceipt: async () => async () => { erased = true; },
    waitForFullResult: async () => {},
    readMountedFullResult: async () => erased ?
      { ...rendered(), framesProcessed: undefined, events: [], savedFrameUrls: [] } : rendered(),
    settleBrowserPolling: async () => {},
    postCount: () => 0,
  }), assert.AssertionError);
});

test('allows one explicit identical replay without another job or inference', async () => {
  const requests = [];
  const body = { stream_url: 'https://synthetic.invalid/authorized.mp4', max_frames: 12, save_frames: true };
  const inventory = { jobIds: ['original'], inference: { yolo_calls: 12, tracker_calls: 12, scorer_calls: 12 } };
  const callbacks = {
    jobId: 'original', key: 'test-only-key', originalBody: body, expected,
    readBackendInventory: async () => inventory,
    submissionRequests: () => requests,
    requestReplayFromUi: async () => {
      requests.push({ key: 'test-only-key', body });
      return { status: 200, body: { job_id: 'original', replayed: true, status: 'complete', frames: [] } };
    },
    waitForFullResult: async () => {},
    readMountedFullResult: async () => rendered(),
    settleBrowserPolling: async () => {},
  };
  assert.deepEqual(await verifyExplicitSameKeyReplayDetails(callbacks),
    { explicitReplayPosts: 1, automaticReplacementPosts: 0, duplicateInferences: 0 });
  callbacks.requestReplayFromUi = async () => {
    requests.push({ key: 'replacement-key', body });
    return { status: 200, body: { job_id: 'original', replayed: true, status: 'complete', frames: [] } };
  };
  await assert.rejects(verifyExplicitSameKeyReplayDetails(callbacks), assert.AssertionError);
});
