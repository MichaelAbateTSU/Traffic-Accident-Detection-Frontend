// Assertion-contract unit tests only; these do not mount the candidate application.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  verifyAdmissionFailureBoundary, verifyTerminalReceiptWins,
} from './admission_browser_assertions.mjs';

function boundary() {
  let posts = 0;
  let status = 'pending';
  let remounts = 0;
  let released = false;
  const callbacks = {
    submitFromUi: async () => {
      posts++;
      return {
        jobId: 'original', key: 'test-only-key',
        response: { status: 503, body: { detail: {
          code: 'inference_admission_failed', job_id: 'original',
        } } },
      };
    },
    readReceipt: async () => ({ job_id: 'original', status }),
    readDurableJob: async () => ({ status }),
    readRecoveryIdentity: async () => ({ key: 'test-only-key', jobId: 'original' }),
    readMountedJob: async () => ({ present: true, failed: status === 'failed' }),
    navigateAndRemount: async () => { remounts++; },
    postCount: () => posts,
    releaseWriter: async () => { released = true; },
    waitForNormalRecovery: async (jobId, deadline) => {
      assert.equal(jobId, 'original');
      assert.equal(deadline, 70000);
      assert.equal(released, true);
      status = 'failed';
    },
  };
  return { callbacks, remounts: () => remounts };
}

test('asserts pending across remount, then durable terminal without replacement', async () => {
  const fixture = boundary();
  assert.deepEqual(await verifyAdmissionFailureBoundary(fixture.callbacks),
    { admissionFailureRecovered: true, replacementPosts: 0 });
  assert.equal(fixture.remounts(), 1);
});

test('rejects invented failed UI while receipt is still pending', async () => {
  const { callbacks } = boundary();
  callbacks.readMountedJob = async () => ({ present: true, failed: true });
  await assert.rejects(verifyAdmissionFailureBoundary(callbacks), assert.AssertionError);
});

test('rejects replacing the durable original identity on remount', async () => {
  const { callbacks } = boundary();
  callbacks.readRecoveryIdentity = async () => ({ key: 'replacement', jobId: 'original' });
  await assert.rejects(verifyAdmissionFailureBoundary(callbacks), assert.AssertionError);
});

test('rejects stale-list resurrection of a confirmed terminal saved monitor', async () => {
  let failed = false;
  await assert.rejects(verifyTerminalReceiptWins({
    jobId: 'original',
    prepareSavedMonitorAndRemount: async jobId => assert.equal(jobId, 'original'),
    holdPendingActiveList: async () => async () => { failed = false; },
    confirmTerminalReceipt: async () => { failed = true; },
    readMountedJob: async () => ({ present: true, failed }),
    settleBrowserPolling: async () => {},
    postCount: () => 0,
  }), assert.AssertionError);
});
