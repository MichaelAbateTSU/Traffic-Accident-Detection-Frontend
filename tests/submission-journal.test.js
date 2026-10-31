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
    await assert.rejects(api.prepareBatch([payload.stream_url], options), /Recovery requires/);
    assert.equal(data.size, 0);
  }
  for (const backend of ['/api/one', '/api/two', 'https://backend.example/one', 'https://backend.example/two']) {
    const api = createSubmissionJournal({ ...dependencies, backend });
    assert.equal(api.read().batches.length, 0);
    await api.prepareBatch([payload.stream_url], options);
  }
  assert.equal(data.size, 4);
});

test('relative backend identities bind to the effective complete path and remain fixed for late acceptance', async () => {
  const { options: dependencies, data } = journalHarness();
  const first = createSubmissionJournal({ ...dependencies, backend: 'api/v1', pageUrl: 'https://frontend.example/one/dashboard' });
  const second = createSubmissionJournal({ ...dependencies, backend: 'api/v1', pageUrl: 'https://frontend.example/two/dashboard' });
  assert.equal(first.backendIdentity, 'https://frontend.example/one/api/v1');
  assert.equal(second.backendIdentity, 'https://frontend.example/two/api/v1');
  const batch = await first.prepareBatch([payload.stream_url], options);
  first.markSending(batch.entries[0].key);
  assert.equal(second.read().batches.length, 0);
  first.accept(batch.entries[0].key, 'late-first-backend');
  assert.equal(first.read().batches[0].entries[0].jobId, 'late-first-backend');
  assert.equal(second.read().batches.length, 0);
  assert.ok(data.has('tad_submissions:v1:https://frontend.example/one/api/v1'));
});

test('root-relative legacy UUID records migrate atomically without retroactive keying or deleting their reference', async () => {
  const { api, data, options: dependencies } = journalHarness();
  const legacy = await api.prepareBatch([payload.stream_url], { ...options, protocol: 'legacy' });
  api.markSending(legacy.entries[0].key);
  api.accept(legacy.entries[0].key, 'legacy-original');
  const document = api.read();
  data.clear();
  data.set('tad_submissions:v1:/api', JSON.stringify(document));
  const current = createSubmissionJournal({ ...dependencies, backend: '/api', pageUrl: 'https://frontend.example/dashboard' });
  assert.equal(current.read().batches[0].entries[0].key, legacy.entries[0].key);
  const fresh = await current.prepareBatch([payload.stream_url], options);
  const migrated = current.read();
  assert.equal(migrated.batches[0].entries[0].protocol, 'legacy');
  assert.equal(migrated.batches[0].entries[0].jobId, 'legacy-original');
  assert.equal(migrated.batches[1].entries[0].key, fresh.entries[0].key);
  assert.ok(data.has('tad_submissions:v1:/api'));
  assert.ok(data.has('tad_submissions:v1:https://frontend.example/api'));
});

async function dashboard(journal, { post = async () => ({ item: { id: 'accepted', status: 'pending' } }), recovered = [], configurationError = null, saveJobMonitor = () => {}, getJob = async (id) => ({ item: { id, status: 'complete' } }), globals = {} } = {}) {
  const sent = [];
  const sentKeys = [];
  const harness = await componentHarness('../src/pages/Dashboard/Dashboard.jsx', {
    '../../services/submissionJournal.js': { ...journalDependencies(), createSubmissionJournal: () => journal },
    'react-router-dom': { Link: 'Link' },
    '../../constants/cameras.js': { FIXED_CAMERA_STREAM_URLS: ['first', 'second', 'third'] },
    '../../services/api.js': {
      API_CONFIGURATION: { error: configurationError },
      parseMaxFrames: Number,
      startDetectionJob: async (value, { key } = {}) => { sent.push(value); sentKeys.push(key); return post(value, key); },
    },
    '../../services/jobMonitor.js': {
      beginJobSubmission() {}, endJobSubmission() {}, saveJobMonitor,
      recoverJobMonitor: async () => ({ jobs: recovered, warning: null }),
      getMonitoredJob: getJob,
    },
    '../../hooks/useDashboardData.js': { useDashboardData: () => ({ incidents: [], cameras: [], jobs: [], reload() {} }) },
    '../../utils/formatters.js': { formatDateTime: String, formatNumber: String, formatPercent: String },
  }, globals);
  harness.render();
  await harness.flush();
  return { harness, sent, sentKeys, submit: () => harness.elements.find((element) => element.type === 'form').props.onSubmit({ preventDefault() {} }) };
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

test('unconfigured frontend rejects before creating an uncertain intent or sending any request', async () => {
  const { api, data } = journalHarness();
  const { harness, sent, submit } = await dashboard(api, { configurationError: 'Backend not configured.' });
  await submit();
  await harness.flush();
  assert.equal(sent.length, 0);
  assert.equal(data.size, 0);
  assert.match(JSON.stringify(harness.elements), /Backend not configured/);
  harness.unmount();
});

test('reloaded arbitrary sources require exact re-entry; manual replay keeps the full original key and saved options', async () => {
  const { api, options: dependencies, data } = journalHarness();
  const first = await dashboard(api, { post: async () => { throw new TypeError('Synthetic lost response'); } });
  first.harness.elements.find((element) => element.props.id === 'videoSource').props.onChange({ target: { value: payload.stream_url } });
  await first.harness.flush();
  await first.harness.elements.filter((element) => element.type === 'form')[1].props.onSubmit({ preventDefault() {} });
  await first.harness.flush();
  assert.equal(first.sent.length, 1);
  const key = first.sentKeys[0];
  assert.match(key, /^v1\.\d{10}\.[0-9a-f-]{36}$/);
  assert.equal(api.read().batches[0].entries[0].key, key);
  first.harness.unmount();
  const second = await dashboard(createSubmissionJournal(dependencies), { post: async () => ({ item: { id: 'original-job', status: 'complete' } }) });
  const replay = () => second.harness.elements.find((element) => element.type === 'button' && element.props.children === 'Submit original request with same key').props.onClick();
  await replay();
  await second.harness.flush();
  assert.equal(second.sent.length, 0);
  assert.match(JSON.stringify(second.harness.elements), /Re-enter the exact original/);
  second.harness.elements.find((element) => element.props.id === 'maxFrames').props.onChange({ target: { value: '300' } });
  second.harness.elements.find((element) => element.type === 'input' && element.props.type === 'checkbox').props.onChange({ target: { checked: true } });
  second.harness.elements.find((element) => element.props.id === `replay-${key}`).props.onChange({ target: { value: 'https://different.example/source.mp4' } });
  await second.harness.flush();
  await replay();
  await second.harness.flush();
  assert.equal(second.sent.length, 0);
  assert.match(JSON.stringify(second.harness.elements), /exact original source URL and options/);
  second.harness.elements.find((element) => element.props.id === `replay-${key}`).props.onChange({ target: { value: payload.stream_url } });
  await second.harness.flush();
  await Promise.all([replay(), replay()]);
  await second.harness.flush();
  assert.equal(second.sent.length, 1, 'simultaneous replay actions must not issue multiple POSTs');
  assert.deepEqual({ ...second.sent[0] }, payload);
  assert.equal(second.sentKeys[0], key);
  assert.equal(api.read().batches[0].entries[0].jobId, 'original-job');
  assert.equal(second.harness.elements.filter((element) => element.type === 'JobStatusCard').length, 1);
  assert.ok(![...data.values()].join('').includes('signature'));
  second.harness.unmount();
});

test('late acceptance plus both persistence failures emits a non-secret diagnostic and retains the original recovery key', async () => {
  const { api, failWrites, data } = journalHarness();
  const pending = deferred();
  const diagnostics = [];
  let failingMonitor = false;
  const first = await dashboard(api, {
    post: () => pending.promise,
    saveJobMonitor: () => { if (failingMonitor) throw new Error('Synthetic private storage detail'); },
    globals: { console: { error: (...args) => diagnostics.push(args.join(' ')) } },
  });
  const submitting = first.submit();
  for (let attempt = 0; !first.sent.length && attempt < 100; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(first.sent.length, 1);
  const key = first.sentKeys[0];
  first.harness.unmount();
  failWrites();
  failingMonitor = true;
  pending.resolve({ item: { id: 'late-original', status: 'complete' } });
  await submitting;
  assert.ok(diagnostics.length > 0);
  assert.ok(diagnostics.every((message) => /Cannot persist accepted detection recovery after navigation/.test(message)));
  assert.ok(diagnostics.every((message) => !message.includes(key) && !message.includes('private storage detail') && !message.includes('Bearer')));
  assert.equal(api.read().batches[0].entries[0].key, key);
  assert.equal(api.read().batches[0].entries[0].state, 'uncertain');
  assert.ok(![...data.values()].join('').includes('signature'));
});

test('late exact-key replay reports selective journal failure even when monitor writes succeed', async () => {
  const { api, failWrites, data } = journalHarness();
  const batch = await api.prepareBatch([payload.stream_url], options);
  const key = batch.entries[0].key;
  api.markSending(key);
  const pending = deferred();
  const diagnostics = [];
  const saved = [];
  const view = await dashboard(api, {
    post: () => pending.promise,
    recovered: [{ id: 'pre-journal-old', status: 'unavailable' }],
    saveJobMonitor: (ids, warning) => saved.push({ ids: [...ids], warning }),
    globals: { console: { error: (...args) => diagnostics.push(args.join(' ')) } },
  });
  view.harness.elements.find((item) => item.props.id === `replay-${key}`).props.onChange({ target: { value: payload.stream_url } });
  await view.harness.flush();
  const replaying = view.harness.elements.find((item) => item.props.children === 'Submit original request with same key').props.onClick();
  for (let attempt = 0; !view.sent.length && attempt < 100; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(view.sent.length, 1);
  view.harness.unmount();
  failWrites();
  pending.resolve({ item: { id: 'replay-original', status: 'complete' } });
  await replaying;
  assert.deepEqual(saved.at(-1).ids.sort(), ['pre-journal-old', 'replay-original']);
  assert.ok(saved.at(-1).warning);
  assert.ok(diagnostics.length);
  assert.ok(diagnostics.every((message) => message === 'Cannot persist accepted detection recovery after navigation. Keep existing browser recovery storage; outcome may remain unknown.'));
  assert.equal(api.read().batches[0].entries[0].state, 'uncertain');
  assert.ok(![...data.values(), ...diagnostics].join('').includes(payload.stream_url));
  assert.equal(view.sentKeys[0], key);
});

test('journal warning failure after navigation is diagnosed even when acceptance and monitor storage succeed', async () => {
  const { api } = journalHarness();
  const diagnostics = [];
  const pending = deferred();
  const saved = [];
  const view = await dashboard({
    ...api, warn: () => { throw new Error('private signed URL, key and token detail'); },
  }, {
    post: () => pending.promise,
    saveJobMonitor: (ids, warning) => saved.push({ ids: [...ids], warning }),
    globals: { console: { error: (...args) => diagnostics.push(args.join(' ')) } },
  });
  const submitting = view.submit();
  for (let attempt = 0; !view.sent.length && attempt < 100; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  view.harness.unmount();
  pending.resolve({ item: { id: 'confirmed-before-warning-failure', status: 'complete' } });
  await submitting;
  assert.equal(api.read().batches[0].entries[0].jobId, 'confirmed-before-warning-failure');
  assert.deepEqual(saved.at(-1).ids, ['confirmed-before-warning-failure']);
  assert.ok(saved.at(-1).warning);
  assert.ok(diagnostics.length);
  assert.ok(diagnostics.every((message) => message === 'Cannot persist accepted detection recovery after navigation. Keep existing browser recovery storage; outcome may remain unknown.'));
  assert.equal(view.sent.length, 1);
});

test('late admission-failure identity is retained after unmount without submitting remaining sources', async () => {
  const { api } = journalHarness();
  const pending = deferred();
  const saved = [];
  const view = await dashboard(api, {
    post: () => pending.promise,
    saveJobMonitor: (ids, warning) => saved.push({ ids: [...ids], warning }),
  });
  const submitting = view.submit();
  for (let attempt = 0; !view.sent.length && attempt < 100; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  view.harness.unmount();
  pending.resolve({
    item: { id: 'admission-original', status: 'pending', admissionStatusUnknown: true },
    admissionFailed: true,
  });
  await submitting;
  assert.equal(api.read().batches[0].entries[0].jobId, 'admission-original');
  assert.deepEqual(saved.at(-1).ids, ['admission-original']);
  assert.equal(view.sent.length, 1);
});

test('explicit sparse terminal replay loads full details and cannot erase an existing terminal result', async () => {
  for (const existing of [false, true]) {
    const { api } = journalHarness();
    const batch = await api.prepareBatch([payload.stream_url], options);
    const key = batch.entries[0].key;
    api.markSending(key);
    const full = {
      id: 'replay-full', status: 'complete', framesProcessed: 120, peakConfidence: 0.87,
      eventCount: 1, events: [{ id: 'event' }],
      frames: [{ frame_index: 1, capture: 'https://backend.example/artifacts/replay/frame.jpg' }],
    };
    const view = await dashboard(api, {
      recovered: existing ? [full] : [],
      post: async () => ({ item: {
        id: 'replay-full', status: 'complete', submissionReceiptOnly: true,
        framesProcessed: null, peakConfidence: null, eventCount: 0, frames: [], events: [],
      } }),
      getJob: async () => ({ item: full }),
    });
    view.harness.elements.find((item) => item.props.id === `replay-${key}`).props.onChange({ target: { value: payload.stream_url } });
    await view.harness.flush();
    await view.harness.elements.find((item) => item.props.children === 'Submit original request with same key').props.onClick();
    await view.harness.flush();
    const job = view.harness.elements.find((item) => item.type === 'JobStatusCard').props.job;
    assert.equal(job.framesProcessed, 120);
    assert.equal(job.peakConfidence, 0.87);
    assert.equal(job.eventCount, 1);
    assert.equal(job.events.length, 1);
    assert.ok(JSON.stringify(job.frames).includes('frame.jpg'));
    assert.equal(view.sent.length, 1);
    view.harness.unmount();
  }
});

test('terminal replay detail 404 keeps terminal status and offers explicit read-only result recovery', async () => {
  const { api } = journalHarness();
  const batch = await api.prepareBatch([payload.stream_url], options);
  const key = batch.entries[0].key;
  api.markSending(key);
  const view = await dashboard(api, {
    post: async () => ({ item: { id: 'expired-detail', status: 'complete', submissionReceiptOnly: true } }),
    getJob: async () => { throw Object.assign(new Error('Result unavailable'), { status: 404 }); },
  });
  view.harness.elements.find((item) => item.props.id === `replay-${key}`).props.onChange({ target: { value: payload.stream_url } });
  await view.harness.flush();
  await view.harness.elements.find((item) => item.props.children === 'Submit original request with same key').props.onClick();
  await view.harness.flush();
  const job = view.harness.elements.find((item) => item.type === 'JobStatusCard').props.job;
  assert.equal(job.status, 'complete');
  assert.match(job.monitorError, /Result unavailable/);
  assert.ok(view.harness.elements.find((item) => item.props.children === 'Retry job result recovery (read only)'));
  assert.equal(view.sent.length, 1);
  view.harness.unmount();
});

test('late sparse active replay cannot downgrade a full terminal result', async () => {
  const { api } = journalHarness();
  const batch = await api.prepareBatch([payload.stream_url], options);
  const key = batch.entries[0].key;
  api.markSending(key);
  const full = { id: 'original', status: 'complete', framesProcessed: 120, peakConfidence: 0.87 };
  const view = await dashboard(api, {
    recovered: [full],
    post: async () => ({ item: { id: 'original', status: 'pending', submissionReceiptOnly: true, framesProcessed: null } }),
    getJob: async () => ({ item: { id: 'original', status: 'pending', framesProcessed: 1 } }),
  });
  view.harness.elements.find((item) => item.props.id === `replay-${key}`).props.onChange({ target: { value: payload.stream_url } });
  await view.harness.flush();
  await view.harness.elements.find((item) => item.props.children === 'Submit original request with same key').props.onClick();
  await view.harness.flush();
  const job = view.harness.elements.find((item) => item.type === 'JobStatusCard').props.job;
  assert.equal(job.status, 'complete');
  assert.equal(job.framesProcessed, 120);
  assert.equal(view.sent.length, 1);
  view.harness.unmount();
});

test('acceptance during asynchronous replay validation cannot return a stale replay authorization', async () => {
  const { api } = journalHarness();
  const batch = await api.prepareBatch([payload.stream_url], options);
  const key = batch.entries[0].key;
  api.markSending(key);
  const checking = api.verifyReplay(key, payload);
  api.accept(key, 'accepted-while-checking');
  await assert.rejects(checking, /changed while checking/);
});

test('mutation during asynchronous payload verification cannot change the authorized original replay body', async () => {
  const { api } = journalHarness();
  const batch = await api.prepareBatch([payload.stream_url], options);
  const key = batch.entries[0].key;
  api.markSending(key);
  const mutable = { ...payload };
  const checking = api.verifyReplay(key, mutable);
  mutable.stream_url = 'https://different.example/new.mp4';
  mutable.max_frames = 300;
  mutable.save_frames = true;
  const original = await checking;
  assert.deepEqual(original.payload, payload);
  assert.equal(original.key, key);
});

test('failure of the durable send transition leaves the existing monitor intact and never sends', async () => {
  const { api, failWrites } = journalHarness();
  const journal = {
    ...api,
    prepareBatch: async (...args) => {
      const batch = await api.prepareBatch(...args);
      failWrites();
      return batch;
    },
  };
  const { harness, sent, submit } = await dashboard(journal, { recovered: [{ id: 'existing-terminal', status: 'complete' }] });
  await submit();
  await harness.flush();
  assert.equal(sent.length, 0);
  assert.equal(harness.elements.find((element) => element.type === 'JobStatusCard').props.job.id, 'existing-terminal');
  assert.equal(api.read().batches[0].entries[0].state, 'prepared');
  assert.match(JSON.stringify(harness.elements), /Cannot persist durable/);
  harness.unmount();
});
