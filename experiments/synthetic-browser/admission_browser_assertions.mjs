import assert from 'node:assert/strict';

// Candidate-specific DOM selectors/storage wiring must be supplied after review.
export async function verifyAdmissionFailureBoundary({
  submitFromUi, readReceipt, readDurableJob, readMountedJob, readRecoveryIdentity,
  navigateAndRemount, postCount, releaseWriter, waitForNormalRecovery,
}) {
  const beforePosts = postCount();
  const { jobId, key, response } = await submitFromUi();
  assert.equal(response.status, 503);
  assert.equal(response.body.detail.code, 'inference_admission_failed');
  assert.equal(response.body.detail.job_id, jobId);
  assert.equal(postCount(), beforePosts + 1);
  for (const remount of [false, true]) {
    if (remount) await navigateAndRemount();
    const receipt = await readReceipt(key);
    assert.equal(receipt.job_id, jobId);
    assert.equal(receipt.status, 'pending');
    assert.equal((await readDurableJob(jobId)).status, 'pending');
    const identity = await readRecoveryIdentity();
    assert.equal(identity.key, key);
    assert.equal(identity.jobId, jobId);
    const mounted = await readMountedJob(jobId);
    assert.equal(mounted.present, true);
    assert.equal(mounted.failed, false);
    assert.equal(postCount(), beforePosts + 1);
  }
  await releaseWriter();
  // This callback must await the real periodic recovery; never call fail_job or
  // mutate the database/status to manufacture a successful recovery assertion.
  await waitForNormalRecovery(jobId, 70000);
  assert.equal((await readDurableJob(jobId)).status, 'failed');
  assert.equal((await readReceipt(key)).status, 'failed');
  const mounted = await readMountedJob(jobId);
  assert.equal(mounted.present, true);
  assert.equal(mounted.failed, true);
  assert.equal(postCount(), beforePosts + 1);
  return { admissionFailureRecovered: true, replacementPosts: 0 };
}

export async function verifyTerminalReceiptWins({
  jobId, prepareSavedMonitorAndRemount, holdPendingActiveList,
  confirmTerminalReceipt, readMountedJob, settleBrowserPolling, postCount,
}) {
  const initialPosts = postCount();
  await prepareSavedMonitorAndRemount(jobId);
  const releaseStaleList = await holdPendingActiveList(jobId);
  try {
    await confirmTerminalReceipt(jobId);
    assert.equal((await readMountedJob(jobId)).failed, true);
  } finally {
    await releaseStaleList();
  }
  await settleBrowserPolling();
  const mounted = await readMountedJob(jobId);
  assert.equal(mounted.present, true);
  assert.equal(mounted.failed, true);
  assert.equal(postCount(), initialPosts);
  return { savedMonitorTerminalPreserved: true, staleListDidNotResurrectJob: true };
}
