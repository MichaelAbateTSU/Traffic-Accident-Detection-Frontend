import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import { createSubmissionJournal, hasUncertainSubmissions, submissionWarnings } from '../src/services/submissionJournal.js';
import { componentHarness, deferred, journalDependencies } from './componentHarness.js';

function journalHarness() {
  const data = new Map();
  let failing = false;
  let readFailing = false;
  const storage = {
    getItem(key) {
      if (readFailing) throw new Error('private storage error');
      return data.get(key) ?? null;
    },
    setItem(key, value) {
      if (failing) throw new Error('private quota error');
      data.set(key, value);
    },
  };
  const options = { storage: () => storage, cryptography: () => webcrypto, backend: 'https://backend.example' };
  return {
    api: createSubmissionJournal(options), options, data,
    failWrites(value = true) { failing = value; },
    failReads(value = true) { readFailing = value; },
  };
}

const payload = { stream_url: 'https://source.example/video.mp4?signature=private-source-credential', max_frames: 120, save_frames: false };
const options = { maxFrames: 120, saveFrames: false, sourceKind: 'arbitrary', protocol: 'keyed-v1' };

test('every batch entry gets a distinct durable cryptographic key, without persisting sources or secrets', async () => {
  const { api, data } = journalHarness();
  const batch = await api.prepareBatch([payload.stream_url, payload.stream_url], options);
  assert.notEqual(batch.entries[0].key, batch.entries[1].key);
  assert.equal(batch.entries[0].fingerprint, batch.entries[1].fingerprint);
  const raw = [...data.values()].join('');
  for (const privateText of ['https://source.example', 'signature', 'private-source-credential', 'Bearer', 'stream_url']) {
    assert.ok(!raw.includes(privateText));
  }
  assert.equal(api.read().batches[0].entries.length, 2);
  assert.equal(api.read().batches[0].entries[0].sourceIndex, null);
  const fixed = await api.prepareBatch(['camera-1', 'camera-2'], { ...options, sourceKind: 'fixed-camera' });
  assert.deepEqual(fixed.entries.map((entry) => entry.sourceIndex), [0, 1]);
});

test('persistence failures stop preparation or send transitions, without erasing prior recovery references', async () => {
  const harness = journalHarness();
  const { api } = harness;
  harness.failWrites();
  await assert.rejects(api.prepareBatch([payload.stream_url], options), /Cannot persist/);
  assert.equal(harness.data.size, 0);
  harness.failWrites(false);
  const batch = await api.prepareBatch([payload.stream_url], options);
  const original = [...harness.data.values()][0];
  harness.failWrites();
  assert.throws(() => api.markSending(batch.entries[0].key), /Cannot persist/);
  assert.equal([...harness.data.values()][0], original);
  harness.failReads();
  assert.throws(() => api.read(), /Cannot read/);
});

test('navigation/reload retain unknown outcomes, accepted IDs and partial warnings even if monitor storage is replaced', async () => {
  const { api, options: dependencies } = journalHarness();
  const batch = await api.prepareBatch(['first', 'second', 'third'], { ...options, sourceKind: 'fixed-camera' });
  api.markSending(batch.entries[0].key);
  api.accept(batch.entries[0].key, 'accepted-first');
  api.markSending(batch.entries[1].key);
  api.warn(batch.id, 'navigation');
  const reloaded = createSubmissionJournal(dependencies);
  const document = reloaded.read();
  assert.equal(document.batches[0].entries[0].jobId, 'accepted-first');
  assert.equal(document.batches[0].entries[1].state, 'uncertain');
  assert.equal(document.batches[0].entries[2].state, 'prepared');
  assert.match(submissionWarnings(document)[0], /1 of 3.*1 submission outcomes unknown.*1 sources not submitted.*navigation/);
  assert.equal(hasUncertainSubmissions(document), true);
  await assert.rejects(reloaded.prepareBatch(['new'], options), /must be reconciled/);
});

test('missing/expired receipts never imply safe resubmission; confirmed acceptance cannot be downgraded or cleared', async () => {
  const { api, failWrites } = journalHarness();
  const batch = await api.prepareBatch([payload.stream_url], options);
  const key = batch.entries[0].key;
  assert.throws(() => api.accept(key, 'premature'), /Invalid acceptance/);
  api.markSending(key);
  assert.throws(() => api.markSending(key), /already attempted/);
  api.recordLookup(key, 'not-recorded');
  assert.equal(hasUncertainSubmissions(api.read()), true);
  api.recordLookup(key, 'expired');
  api.recordLookup(key, 'not-recorded');
  assert.equal(api.read().batches[0].entries[0].state, 'expired');
  await assert.rejects(api.verifyReplay(key, payload), /cannot be replayed/);
  failWrites();
  assert.throws(() => api.accept(key, 'accepted'), /Cannot persist/);
  assert.equal(api.read().batches[0].entries[0].key, key);
  failWrites(false);
  api.accept(key, 'accepted');
  api.accept(key, 'accepted');
  api.recordLookup(key, 'expired');
  assert.equal(api.read().batches[0].entries[0].jobId, 'accepted');
  assert.equal(api.read().batches[0].entries[0].state, 'accepted');
  assert.throws(() => api.accept(key, 'duplicate'), /Conflicting/);
  const next = await api.prepareBatch(['next'], options);
  assert.notEqual(next.entries[0].key, key);
  assert.equal(api.read().batches[0].entries[0].jobId, 'accepted');
});

test('manual replay verification requires the exact key/payload and never supports legacy or automatic replay', async () => {
  const { api } = journalHarness();
  const batch = await api.prepareBatch([payload.stream_url], options);
  const key = batch.entries[0].key;
  api.markSending(key);
  api.recordLookup(key, 'not-recorded');
  assert.deepEqual(await api.verifyReplay(key, payload), { key, payload });
  for (const changed of [
    { ...payload, stream_url: 'https://source.example/video.mp4?signature=different' },
    { ...payload, max_frames: 121 }, { ...payload, save_frames: true },
  ]) {
    await assert.rejects(api.verifyReplay(key, changed), /exact original/);
  }
  api.accept(key, 'accepted');
  const legacy = await api.prepareBatch(['legacy'], { ...options, protocol: 'legacy' });
  api.markSending(legacy.entries[0].key);
  assert.throws(() => api.recordLookup(legacy.entries[0].key, 'not-recorded'), /Legacy/);
  await assert.rejects(api.verifyReplay(legacy.entries[0].key, payload), /cannot be replayed/);
});

test('corruption and unavailable cryptography fail closed without leaking payloads or making weak identities', async () => {
  const { api, data, options: dependencies } = journalHarness();
  await api.prepareBatch([payload.stream_url], options);
  const [storageKey, original] = [...data][0];
  for (const corrupt of ['{', '{"version":2,"batches":[]}', original.replace('"jobId":null', '"jobId":null,"token":"private"')]) {
    data.set(storageKey, corrupt);
    assert.throws(() => api.read(), /journal is invalid/);
  }
  data.set(storageKey, original);
  const noCrypto = createSubmissionJournal({ ...dependencies, cryptography: () => undefined });
  await assert.rejects(noCrypto.prepareBatch([payload.stream_url], options), /Secure submission identity is unavailable/);
  assert.equal(data.get(storageKey), original);
});

test('recovery rejects credential-bearing backend bases in development and keeps full backend paths isolated', async () => {
  const { data, options: dependencies } = journalHarness();
  for (const backend of ['https://user:dummy@backend.example/api', 'https://backend.example/api?signed=dummy', '/api?token=dummy', '/api#credential']) {
    const api = createSubmissionJournal({ ...dependencies, backend });
    await assert.rejects(api.prepareBatch([payload.stream_url], options), /Cannot read/);
    assert.equal(data.size, 0);
  }
  for (const backend of ['/api/one', '/api/two', 'https://backend.example/one', 'https://backend.example/two']) {
    const api = createSubmissionJournal({ ...dependencies, backend });
    assert.equal(api.read().batches.length, 0);
    await api.prepareBatch([payload.stream_url], options);
  }
  assert.equal(data.size, 4);
});

async function dashboard(journal, { post = async () => ({ item: { id: 'accepted', status: 'pending' } }), recovered = [] } = {}) {
  const sent = [];
  const harness = await componentHarness('../src/pages/Dashboard/Dashboard.jsx', {
    '../../services/submissionJournal.js': { ...journalDependencies(), createSubmissionJournal: () => journal },
    'react-router-dom': { Link: 'Link' },
    '../../constants/cameras.js': { FIXED_CAMERA_STREAM_URLS: ['first', 'second', 'third'] },
    '../../services/api.js': { parseMaxFrames: Number, startDetectionJob: async (value) => { sent.push(value); return post(value); } },
    '../../services/jobMonitor.js': {
      beginJobSubmission() {}, endJobSubmission() {}, saveJobMonitor() {},
      recoverJobMonitor: async () => ({ jobs: recovered, warning: null }),
      getMonitoredJob: async (id) => ({ item: { id, status: 'complete' } }),
    },
    '../../hooks/useDashboardData.js': { useDashboardData: () => ({ incidents: [], cameras: [], jobs: [], reload() {} }) },
    '../../utils/formatters.js': { formatDateTime: String, formatNumber: String, formatPercent: String },
  });
  harness.render();
  await harness.flush();
  return { harness, sent, submit: () => harness.elements.find((element) => element.type === 'form').props.onSubmit({ preventDefault() {} }) };
}

test('Dashboard visibly fails before POST when storage fails and preserves its existing monitor', async () => {
  const { api, failWrites } = journalHarness();
  const { harness, sent, submit } = await dashboard(api, { recovered: [{ id: 'previous', status: 'complete' }] });
  failWrites();
  await submit();
  await harness.flush();
  assert.equal(sent.length, 0);
  assert.match(JSON.stringify(harness.elements), /Cannot persist durable/);
  assert.equal(harness.elements.find((element) => element.type === 'JobStatusCard').props.job.id, 'previous');
  harness.unmount();
});

test('uncertain POST survives navigation and a fresh Dashboard without retrying; later acceptance is durable', async () => {
  const { api, options: dependencies } = journalHarness();
  const pending = deferred();
  const first = await dashboard(api, { post: () => pending.promise });
  const submission = first.submit();
  for (let count = 0; !first.sent.length && count < 100; count++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(first.sent.length, 1);
  const key = api.read().batches[0].entries[0].key;
  first.harness.unmount();
  const second = await dashboard(createSubmissionJournal(dependencies));
  assert.match(JSON.stringify(second.harness.elements), /acceptance uncertain/);
  assert.ok(second.harness.elements.find((element) => element.type === 'button' && element.props.type === 'submit').props.disabled);
  await second.submit();
  assert.equal(second.sent.length, 0);
  pending.resolve({ item: { id: 'late-accepted', status: 'pending' } });
  await submission;
  assert.equal(first.sent.length, 1);
  assert.equal(api.read().batches[0].entries[0].key, key);
  assert.equal(api.read().batches[0].entries[0].jobId, 'late-accepted');
  assert.match(submissionWarnings(api.read())[0], /2 sources not submitted/);
  second.harness.unmount();
});

test('Dashboard retains confirmed job IDs if journal acceptance storage fails and sends no later batch entries', async () => {
  const { api, failWrites } = journalHarness();
  const { harness, sent, submit } = await dashboard(api, {
    post: async () => { failWrites(); return { item: { id: 'accepted', status: 'pending' } }; },
  });
  await submit();
  await harness.flush();
  assert.equal(sent.length, 1);
  assert.equal(harness.elements.find((element) => element.type === 'JobStatusCard').props.job.id, 'accepted');
  assert.equal(hasUncertainSubmissions(api.read()), true);
  assert.match(JSON.stringify(harness.elements), /Cannot persist durable/);
  harness.unmount();
});
