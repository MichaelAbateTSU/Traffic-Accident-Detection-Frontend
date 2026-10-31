import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import { componentHarness, deferred, journalDependencies } from './componentHarness.js';

function deadlineClock() {
  const timers = new Map();
  let nextId = 1;
  return {
    timers,
    setTimeout(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    expire() {
      for (const [id, { callback, delay }] of [...timers]) {
        assert.equal(delay, 30000);
        timers.delete(id);
        callback();
      }
    },
  };
}

async function monitorHarness({ saved = null, getJob = async (id) => ({ item: { id, status: 'complete' } }), getJobs = async () => ({ items: [] }),
  getSubmission = async () => { throw Object.assign(new Error('No receipt found yet'), { status: 404, code: 'idempotency_key_unknown' }); },
  submitDetection = async () => { throw new Error('Unexpected submission'); }, clock = deadlineClock() } = {}) {
  const storage = new Map(saved ? [['tad_monitor:https://backend.example', JSON.stringify(saved)]] : []);
  const context = createContext({
    AbortController, DOMException,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
  });
  const source = await readFile(new URL('../src/services/jobMonitor.js', import.meta.url), 'utf8');
  const module = new SourceTextModule(source, { context });
  const journal = journalDependencies({ storage });
  await module.link((specifier) => specifier === './submissionJournal.js'
    ? new SyntheticModule(Object.keys(journal), function () {
      for (const [name, value] of Object.entries(journal)) this.setExport(name, value);
    }, { context })
    : new SyntheticModule(['API_CONFIGURATION', 'getJob', 'getJobs', 'getSubmission', 'submitDetection'], function () {
    this.setExport('API_CONFIGURATION', { baseUrl: 'https://backend.example' });
    this.setExport('getJob', getJob);
    this.setExport('getJobs', getJobs);
    this.setExport('getSubmission', getSubmission);
    this.setExport('submitDetection', submitDetection);
  }, { context }));
  await module.evaluate();
  return { api: module.namespace, storage, clock };
}

test('recovery merges saved partial/terminal jobs with every page of backend queued jobs', async () => {
  const calls = [];
  const { api, storage } = await monitorHarness({
    saved: { ids: ['accepted-1', 'accepted-2'], warning: '2 of 9 accepted; queue full' },
    async getJob(id) { return { item: { id, status: id === 'accepted-1' ? 'complete' : 'pending' } }; },
    async getJobs(query) {
      calls.push(query);
      if (query.status === 'running') return { items: [{ id: 'running-1', status: 'running' }] };
      return { items: [{ id: query.page === 1 ? 'accepted-2' : 'queued-9', status: 'pending' }], meta: { pagination: { has_next: query.page === 1 } } };
    },
  });

  const result = await api.recoverJobMonitor({});
  assert.deepEqual([...result.jobs.map((item) => item.id)].sort(), ['accepted-1', 'accepted-2', 'queued-9', 'running-1'].sort());
  assert.equal(result.jobs[0].status, 'complete');
  assert.match(result.warning, /2 of 9/);
  assert.equal(calls.length, 3);
  api.saveJobMonitor(result.jobs.map((item) => item.id), result.warning);
  assert.ok(![...storage.values()].join('').includes('Bearer'));
  const restored = await api.recoverJobMonitor({});
  assert.equal(restored.jobs.length, 4);
});

test('the submission journal remains authoritative for accepted IDs when the monitor is replaced; warnings do not duplicate on reload', async () => {
  const { api, storage } = await monitorHarness();
  const journal = journalDependencies({ storage }).createSubmissionJournal();
  const batch = await journal.prepareBatch(['source-1', 'source-2'], {
    maxFrames: 120, saveFrames: false, sourceKind: 'fixed-camera', protocol: 'legacy',
  });
  journal.markSending(batch.entries[0].key);
  journal.accept(batch.entries[0].key, 'accepted-durable');
  journal.markSending(batch.entries[1].key);
  journal.warn(batch.id, 'navigation');
  api.saveJobMonitor([], null);
  const first = await api.recoverJobMonitor({});
  assert.equal(first.jobs[0].id, 'accepted-durable');
  assert.match(first.warning, /1 of 2.*1 submission outcomes unknown/);
  api.saveJobMonitor([], first.warning);
  const second = await api.recoverJobMonitor({});
  assert.equal(second.warning, first.warning);
  assert.equal(second.jobs[0].id, 'accepted-durable');
});

async function waitForSubmissions(submissions, count, harness) {
  for (let attempt = 0; submissions.length < count && attempt < 100; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(submissions.length, count);
  await harness.flush();
}

for (const mode of ['success', 'late', 'journal-failure', 'late-journal-failure']) {
  test(`new keyed acceptance retains unavailable pre-journal monitor IDs across reload (${mode})`, async () => {
    const pending = deferred();
    const diagnostics = [];
    const { api, storage } = await monitorHarness({
      saved: { ids: ['pre-journal-unavailable'] },
      getJob: async (id) => {
        if (id === 'pre-journal-unavailable') throw Object.assign(new Error('Missing original record'), { status: 404 });
        return { item: { id, status: 'complete' } };
      },
      getJobs: async (query) => ({ items: mode === 'success' && query.status === 'running'
        ? [{ id: 'listing-only', status: 'running' }] : [] }),
    });
    const dependencies = journalDependencies({ storage });
    const original = dependencies.createSubmissionJournal();
    const journal = {
      ...dependencies,
      createSubmissionJournal: () => ({
        ...original,
        accept: (...args) => {
          if (mode.includes('journal-failure')) throw new Error('synthetic-private-url-token-key');
          return original.accept(...args);
        },
      }),
    };
    const first = await dashboardHarness(api.recoverJobMonitor, api.getMonitoredJob, {
      journal, sources: ['stream-1'],
      startDetectionJob: () => pending.promise,
      saveJobMonitor: api.saveJobMonitor,
      globals: { console: { error: (...args) => diagnostics.push(args.join(' ')) } },
    });
    first.harness.render();
    await first.harness.flush();
    const submitting = first.harness.elements.find((item) => item.type === 'form').props.onSubmit({ preventDefault() {} });
    await waitForSubmissions(first.submissions, 1, first.harness);
    if (mode.startsWith('late')) first.harness.unmount();
    pending.resolve({ item: { id: 'new-original', status: 'complete' } });
    await submitting;
    await first.harness.flush();
    first.harness.unmount();
    const saved = JSON.parse(storage.get('tad_monitor:https://backend.example'));
    assert.deepEqual(saved.ids.sort(), mode === 'success'
      ? ['listing-only', 'new-original', 'pre-journal-unavailable']
      : ['new-original', 'pre-journal-unavailable']);
    if (mode === 'late-journal-failure') {
      assert.ok(diagnostics.length);
      assert.ok(diagnostics.every((message) => message === 'Cannot persist accepted detection recovery after navigation. Keep existing browser recovery storage; outcome may remain unknown.'));
      assert.ok(saved.warning);
    }
    const reloaded = await api.recoverJobMonitor({ journal: original });
    assert.deepEqual([...reloaded.jobs.map((item) => item.id)].sort(), saved.ids);
    assert.equal(reloaded.jobs.find((item) => item.id === 'pre-journal-unavailable').status, 'unavailable');
    assert.equal(first.submissions.length, 1);
  });
}

test('job errors remain visible, 404 has unknown outcome, and listing failures reject unsafe recovery', async () => {
  const { api } = await monitorHarness({
    saved: { ids: ['missing', 'offline'], warning: null },
    async getJob(id) { throw Object.assign(new Error(id === 'missing' ? 'Job expired' : 'Network unavailable'), { status: id === 'missing' ? 404 : null }); },
  });
  const result = await api.recoverJobMonitor({});
  assert.equal(result.jobs[0].status, 'unavailable');
  assert.equal(result.jobs[0].error, undefined);
  assert.match(result.jobs[0].monitorError, /inference outcome is unknown/);
  assert.equal(result.jobs[1].status, 'pending');
  assert.match(result.error, /Job expired.*Network unavailable/);
  const failing = await monitorHarness({ getJobs: async () => { throw new Error('Unauthorized'); } });
  await assert.rejects(failing.api.recoverJobMonitor({}), /Unauthorized/);
});

async function dashboardHarness(recoverJobMonitor, getMonitoredJob = async (id) => ({ item: { id, status: 'running' } }), options = {}) {
  const submissions = [];
  const submissionKeys = [];
  const persisted = [];
  const harness = await componentHarness('../src/pages/Dashboard/Dashboard.jsx', {
    '../../services/submissionJournal.js': options.journal ?? journalDependencies(),
    'react-router-dom': { Link: 'Link' },
    '../../constants/cameras.js': { FIXED_CAMERA_STREAM_URLS: options.sources ?? ['stream-1', 'stream-2'] },
    '../../services/api.js': {
      parseMaxFrames: Number,
      startDetectionJob: async (payload, { key } = {}) => {
        submissions.push(payload);
        submissionKeys.push(key);
        return options.startDetectionJob ? options.startDetectionJob(payload, key) : { item: { id: 'new', status: 'pending' } };
      },
    },
    '../../services/jobMonitor.js': {
      beginJobSubmission: options.beginJobSubmission ?? (() => {}),
      endJobSubmission: options.endJobSubmission ?? (() => {}),
      ...(options.submitMonitoredDetection ? { submitMonitoredDetection: options.submitMonitoredDetection } : {}),
      recoverJobMonitor,
      getMonitoredJob,
      saveJobMonitor: (ids, warning) => {
        persisted.push({ ids, warning });
        options.saveJobMonitor?.(ids, warning);
      },
    },
    '../../utils/formatters.js': { formatDateTime: String, formatNumber: String, formatPercent: String },
    '../../hooks/useDashboardData.js': {
      useDashboardData: () => ({ stats: null, incidents: [], cameras: [], jobs: [], reload: options.reload ?? (() => {}) }),
    },
  }, options.globals);
  return { harness, submissions, submissionKeys, persisted };
}

test('remount/re-auth recovers accepted jobs and warning without duplicate submission', async () => {
  for (let remount = 0; remount < 2; remount++) {
    const { harness, submissions } = await dashboardHarness(async () => ({
      jobs: [{ id: 'accepted', status: 'pending' }, { id: 'finished', status: 'complete' }],
      warning: '1 of 2 accepted; queue full', error: null,
    }));
    harness.render();
    await harness.flush();
    assert.equal(harness.elements.filter((node) => node.type === 'JobStatusCard').length, 2);
    assert.equal(harness.timers.size, 1);
    assert.match(JSON.stringify(harness.elements), /queue full/);
    await harness.elements.find((node) => node.type === 'form').props.onSubmit({ preventDefault() {} });
    await harness.flush();
    assert.equal(submissions.length, 0);
    harness.unmount();
    assert.equal(harness.timers.size, 0);
  }
});

test('recovery failures block new starts and offer a safe retry; terminal recovery does not poll', async () => {
  let fail = true;
  const { harness, submissions } = await dashboardHarness(async () => {
    if (fail) throw new Error('Backend offline');
    return { jobs: [{ id: 'terminal', status: 'complete' }], warning: null, error: null };
  });
  harness.render();
  await harness.flush();
  assert.match(JSON.stringify(harness.elements), /Backend offline/);
  await harness.elements.find((node) => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(submissions.length, 0);
  fail = false;
  harness.elements.find((node) => node.type === 'button' && node.props.children === 'Retry job recovery').props.onClick();
  await harness.flush();
  assert.equal(harness.timers.size, 0);
  assert.equal(harness.elements.find((node) => node.type === 'JobStatusCard').props.job.id, 'terminal');
  harness.unmount();
});

test('keyed recovery distinguishes absent receipts, expired identities and unsupported servers without another POST', async () => {
  for (const [status, code, expected] of [
    [404, 'idempotency_key_unknown', 'not-recorded'],
    [410, 'idempotency_key_expired', 'expired'],
    [410, 'idempotency_result_expired', 'expired'],
    [404, null, 'uncertain'],
    [503, 'idempotency_unavailable', 'uncertain'],
    [401, null, 'uncertain'],
  ]) {
    const lookups = [];
    let posts = 0;
    const { api, storage } = await monitorHarness({
      getSubmission: async (key) => { lookups.push(key); throw Object.assign(new Error('Synthetic receipt error'), { status, code }); },
      submitDetection: async () => { posts++; throw new Error('No automatic inference allowed'); },
    });
    const journal = journalDependencies({ storage }).createSubmissionJournal();
    const batch = await journal.prepareBatch(['https://fixture.invalid/source.mp4'], {
      maxFrames: 120, saveFrames: false, sourceKind: 'arbitrary', protocol: 'keyed-v1',
    });
    const key = batch.entries[0].key;
    journal.markSending(key);
    const result = await api.recoverJobMonitor();
    assert.equal(result.intents.batches[0].entries[0].state, expected);
    assert.equal(result.intents.batches[0].entries[0].key, key);
    assert.equal(result.jobs.length, 0);
    assert.deepEqual(lookups, [key]);
    assert.equal(posts, 0);
    if (expected === 'uncertain') assert.match(result.submissionError, /acceptance remains unknown/);
    if (code === null && status === 404) assert.match(result.submissionError, /lookup is unavailable/);
  }
});

test('POST deadline retains its original key even when the transport ignores abort; lookup recovers acceptance without replay', async () => {
  const late = deferred();
  let postCalls = 0;
  let postSignal;
  const lookupKeys = [];
  const { api, storage, clock } = await monitorHarness({
    submitDetection: (payload, { signal }) => { postCalls++; postSignal = signal; return late.promise; },
    getSubmission: async (key) => { lookupKeys.push(key); return { item: { id: 'original', status: 'complete' } }; },
  });
  const journal = journalDependencies({ storage }).createSubmissionJournal();
  const batch = await journal.prepareBatch(['https://fixture.invalid/source.mp4'], {
    maxFrames: 120, saveFrames: false, sourceKind: 'arbitrary', protocol: 'keyed-v1',
  });
  const key = batch.entries[0].key;
  journal.markSending(key);
  const posting = api.submitMonitoredDetection({ stream_url: 'https://fixture.invalid/source.mp4', max_frames: 120, save_frames: false }, key);
  const rejected = assert.rejects(posting, /Submitting detection.*timed out after 30 seconds/);
  await new Promise((resolve) => setImmediate(resolve));
  clock.expire();
  await rejected;
  assert.equal(postSignal.aborted, true);
  assert.equal(journal.read().batches[0].entries[0].state, 'uncertain');
  late.resolve({ item: { id: 'original', status: 'complete' } });
  const recovered = await api.recoverJobMonitor();
  assert.equal(recovered.jobs[0].id, 'original');
  assert.equal(recovered.intents.batches[0].entries[0].jobId, 'original');
  assert.deepEqual(lookupKeys, [key]);
  assert.equal(postCalls, 1);
  assert.equal(clock.timers.size, 0);
});

test('bounded historic GETs share one pass deadline while a later healthy active listing progresses immediately', async () => {
  const progress = [];
  const { api, clock } = await monitorHarness({
    saved: { ids: ['held-1', 'held-2', 'healthy'], warning: 'Historic partial acceptance' },
    getJob: async (id) => id.startsWith('held') ? new Promise(() => {}) : { item: { id, status: 'complete', framesProcessed: 120 } },
    getJobs: async (query) => ({ items: query.status === 'running' ? [{ id: 'healthy', status: 'running', framesProcessed: 120 }] : [] }),
  });
  const recovery = api.recoverJobMonitor({ onJobs: (snapshot) => progress.push(...snapshot.jobs) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(clock.timers.size, 3, 'two held reads and one whole-pass deadline, not serial windows');
  assert.ok(progress.some((job) => job.id === 'healthy' && job.status === 'running' && !job.recoveringRead));
  clock.expire();
  const result = await recovery;
  assert.deepEqual([...result.jobs.map((job) => job.id)].sort(), ['healthy', 'held-1', 'held-2']);
  assert.ok(result.jobs.filter((job) => job.id.startsWith('held')).every((job) => job.status === 'pending' && /timed out/.test(job.monitorError)));
  assert.equal(result.jobs.find((job) => job.id === 'healthy').status, 'running');
  assert.equal(clock.timers.size, 0);
});

test('large history retains unstarted IDs after one deadline and explicit retry prioritizes deferred references', async () => {
  const calls = [];
  const ids = Array.from({ length: 20 }, (_, index) => `history-${index}`);
  const { api, clock } = await monitorHarness({
    saved: { ids },
    getJob: async (id) => { calls.push(id); return id === 'history-19' ? { item: { id, status: 'complete' } } : new Promise(() => {}); },
  });
  const recovery = api.recoverJobMonitor();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ids.slice(0, 2));
  clock.expire();
  const result = await recovery;
  assert.equal(result.jobs.length, 20);
  assert.equal(result.jobs.filter((item) => item.recoveryDeferred).length, 18);
  assert.equal(calls.length, 2, 'No unstarted request gets another 30-second deadline');
  assert.ok(result.jobs.filter((item) => item.recoveryDeferred).every((item) => item.status === 'pending' && /outcome unknown/.test(item.monitorError)));
  assert.equal(clock.timers.size, 0);
  const retry = api.recoverJobMonitor({ knownIds: ['history-19', ...ids.slice(2)] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls[2], 'history-19');
  clock.expire();
  const retried = await retry;
  assert.equal(retried.jobs.find((item) => item.id === 'history-19').status, 'complete');
  assert.equal(retried.jobs.length, 20);
  assert.equal(clock.timers.size, 0);
});

test('all keyed identities become visible before held accepted-job reads settle, with one recovery window', async () => {
  const lookedUp = [];
  const reads = [];
  const { api, clock, storage } = await monitorHarness({
    getSubmission: async (key) => {
      lookedUp.push(key);
      return { item: { id: `accepted-${lookedUp.length}`, status: 'pending' } };
    },
    getJob: async (id) => { reads.push(id); return new Promise(() => {}); },
  });
  const dependencies = journalDependencies({ storage });
  const journal = dependencies.createSubmissionJournal();
  const batch = await journal.prepareBatch(Array.from({ length: 8 }, (_, i) => `source-${i}`), {
    maxFrames: 120, saveFrames: false, sourceKind: 'fixed-camera', protocol: 'keyed-v1',
  });
  for (const entry of batch.entries) journal.markSending(entry.key);
  const { harness, submissions } = await dashboardHarness(api.recoverJobMonitor, api.getMonitoredJob, { journal: dependencies });
  harness.render();
  await harness.flush();
  assert.equal(lookedUp.length, 8, 'Held job reads must never occupy receipt workers');
  assert.equal(journal.read().batches[0].entries.filter((item) => item.state === 'accepted').length, 8);
  assert.equal(harness.elements.filter((item) => item.type === 'JobStatusCard').length, 8);
  assert.equal(reads.length, 2, 'Recovered status HTTP concurrency remains bounded');
  clock.expire();
  await harness.flush();
  assert.ok(harness.elements.filter((item) => item.type === 'JobStatusCard').every((item) => !item.props.job.recoveryDeferred));
  assert.equal(submissions.length, 0);
  harness.unmount();
  assert.equal(clock.timers.size, 0);
});

test('held receipt lookups have one pass budget and cancellation never starts queued receipt or job reads', async () => {
  for (const cancel of [false, true]) {
    const lookedUp = [];
    const { api, clock, storage } = await monitorHarness({
      getSubmission: async (key) => { lookedUp.push(key); return new Promise(() => {}); },
      getJob: async () => { throw new Error('Unexpected job read'); },
    });
    const journal = journalDependencies({ storage }).createSubmissionJournal();
    const batch = await journal.prepareBatch(Array.from({ length: 8 }, (_, i) => `source-${i}`), {
      maxFrames: 120, saveFrames: false, sourceKind: 'fixed-camera', protocol: 'keyed-v1',
    });
    for (const entry of batch.entries) journal.markSending(entry.key);
    const controller = new AbortController();
    const recovery = api.recoverJobMonitor({ journal, signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(lookedUp.length, 2);
    if (cancel) {
      controller.abort();
      await assert.rejects(recovery, { name: 'AbortError' });
    } else {
      clock.expire();
      const result = await recovery;
      assert.match(result.submissionError, /deadline.*acceptance remains unknown/);
    }
    assert.equal(lookedUp.length, 2);
    assert.ok(journal.read().batches[0].entries.every((item) => item.state === 'uncertain'));
    assert.equal(clock.timers.size, 0);
  }
});

test('receipt terminal outcomes remain confirmed when their subsequent status GETs time out', async () => {
  let count = 0;
  const { api, clock, storage } = await monitorHarness({
    getSubmission: async () => ({ item: { id: `terminal-${++count}`, status: count === 1 ? 'complete' : 'failed' } }),
    getJob: async () => new Promise(() => {}),
  });
  const journal = journalDependencies({ storage }).createSubmissionJournal();
  const batch = await journal.prepareBatch(['one', 'two'], {
    maxFrames: 120, saveFrames: false, sourceKind: 'fixed-camera', protocol: 'keyed-v1',
  });
  for (const entry of batch.entries) journal.markSending(entry.key);
  const progress = [];
  const recovering = api.recoverJobMonitor({ journal, onJobs: ({ jobs }) => progress.push(...jobs) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(progress.some((item) => item.status === 'complete'));
  assert.ok(progress.some((item) => item.status === 'failed'));
  clock.expire();
  const result = await recovering;
  assert.deepEqual([...result.jobs.map((item) => item.status)], ['complete', 'failed']);
  assert.ok(result.jobs.every((item) => /timed out/.test(item.monitorError)));
  assert.equal(clock.timers.size, 0);
});

for (const status of ['complete', 'failed']) {
  test(`terminal ${status} receipt replaces saved fallback placeholder and survives older listing/GET`, async () => {
    const listing = deferred();
    const read = deferred();
    const { api, clock, storage } = await monitorHarness({
      saved: { ids: ['original-fallback'] },
      getSubmission: async () => ({ item: { id: 'original-fallback', status, framesProcessed: 120 } }),
      getJob: () => read.promise,
      getJobs: async (query) => query.status === 'running' ? listing.promise : { items: [] },
    });
    const dependencies = journalDependencies({ storage });
    const journal = dependencies.createSubmissionJournal();
    const batch = await journal.prepareBatch(['source'], {
      maxFrames: 120, saveFrames: false, sourceKind: 'fixed-camera', protocol: 'keyed-v1',
    });
    journal.markSending(batch.entries[0].key);
    const { harness, submissions } = await dashboardHarness(api.recoverJobMonitor, api.getMonitoredJob, { journal: dependencies });
    harness.render();
    await harness.flush();
    const card = () => harness.elements.find((item) => item.type === 'JobStatusCard').props.job;
    assert.equal(card().status, status, 'Receipt must replace the saved pending placeholder immediately');
    listing.resolve({ items: [{ id: 'original-fallback', status: 'running', framesProcessed: 1 }] });
    await harness.flush();
    assert.equal(card().status, status);
    if (status === 'failed') clock.expire();
    else read.resolve({ item: { id: 'original-fallback', status: 'pending', framesProcessed: 0 } });
    await harness.flush();
    assert.equal(card().status, status);
    assert.equal(card().framesProcessed, 120);
    assert.equal(submissions.length, 0);
    assert.equal(clock.timers.size, 0);
    harness.unmount();
  });
}

for (const replay of [false, true]) {
  test(`admission failure retains original identity and gates new inference until durable status recovers (${replay ? 'replay' : 'initial'})`, async () => {
    let completed = false;
    const storage = new Map();
    const dependencies = journalDependencies({ storage });
    const journal = dependencies.createSubmissionJournal();
    if (replay) {
      const batch = await journal.prepareBatch(['stream-1'], {
        maxFrames: 120, saveFrames: false, sourceKind: 'fixed-camera', protocol: 'keyed-v1',
      });
      journal.markSending(batch.entries[0].key);
    }
    const { harness, submissions } = await dashboardHarness(async () => ({ jobs: [], intents: journal.read() }),
      async (id) => ({ item: { id, status: completed ? 'failed' : 'pending' } }), {
        journal: dependencies, sources: ['stream-1'],
        startDetectionJob: async () => ({
          item: { id: 'reserved-original', status: 'pending', admissionStatusUnknown: true, monitorError: 'Failure persistence awaits recovery.' },
          admissionFailed: true,
        }),
      });
    harness.render();
    await harness.flush();
    if (replay) await harness.elements.find((item) => item.props.children === 'Submit original request with same key').props.onClick();
    else await harness.elements.find((item) => item.type === 'form').props.onSubmit({ preventDefault() {} });
    await harness.flush();
    const card = () => harness.elements.find((item) => item.type === 'JobStatusCard').props.job;
    assert.equal(card().status, 'pending');
    assert.match(JSON.stringify(harness.elements), /inference admission failed|Original inference admission failed/);
    assert.ok(harness.elements.find((item) => item.type === 'button' && item.props.type === 'submit').props.disabled);
    assert.equal(journal.read().batches[0].entries[0].jobId, 'reserved-original');
    completed = true;
    for (const tick of harness.timers.values()) tick();
    await harness.flush();
    assert.equal(card().status, 'failed');
    assert.equal(card().admissionStatusUnknown, false);
    assert.equal(submissions.length, 1);
    harness.unmount();
  });
}

test('admission-failure card labels durable status unconfirmed instead of failed or pending', async () => {
  const harness = await componentHarness('../src/components/JobStatusCard/JobStatusCard.jsx', {
    '../../utils/formatters.js': { formatDateTime: String, formatNumber: String },
  });
  harness.render({ job: { id: 'reserved', status: 'pending', admissionStatusUnknown: true } });
  assert.match(JSON.stringify(harness.elements), /accepted \(durable status unconfirmed\)/);
  harness.unmount();
});

test('delayed active receipt resumes Dashboard polling before two stale history reads settle', async () => {
  const receipt = deferred();
  const reads = [];
  const { api, clock, storage } = await monitorHarness({
    saved: { ids: ['old-held-1', 'old-held-2'] },
    getSubmission: () => receipt.promise,
    getJob: async (id) => {
      reads.push(id);
      return id === 'new-active' ? { item: { id, status: 'complete', framesProcessed: 120 } } : new Promise(() => {});
    },
  });
  const dependencies = journalDependencies({ storage });
  const journal = dependencies.createSubmissionJournal();
  const batch = await journal.prepareBatch(['source'], {
    maxFrames: 120, saveFrames: false, sourceKind: 'fixed-camera', protocol: 'keyed-v1',
  });
  journal.markSending(batch.entries[0].key);
  const { harness, submissions } = await dashboardHarness(api.recoverJobMonitor, api.getMonitoredJob, { journal: dependencies });
  harness.render();
  await harness.flush();
  assert.deepEqual(reads, ['old-held-1', 'old-held-2']);
  receipt.resolve({ item: { id: 'new-active', status: 'pending' } });
  await harness.flush();
  const card = harness.elements.find((item) => item.type === 'JobStatusCard' && item.props.job.id === 'new-active').props.job;
  assert.equal(card.status, 'complete', 'New active receipt must not wait for held history');
  assert.equal(card.framesProcessed, 120);
  assert.equal(submissions.length, 0);
  harness.unmount();
  await harness.flush();
  assert.equal(clock.timers.size, 0);
});

test('Dashboard does not poll the deferred history queue and its read-only retry restores those references', async () => {
  let responsive = false;
  const reads = [];
  const { api, clock, storage } = await monitorHarness({
    saved: { ids: Array.from({ length: 6 }, (_, index) => `saved-${index}`) },
    getJob: async (id) => {
      reads.push(id);
      return responsive ? { item: { id, status: 'complete' } } : new Promise(() => {});
    },
  });
  const { harness, submissions } = await dashboardHarness(api.recoverJobMonitor, api.getMonitoredJob, {
    journal: journalDependencies({ storage }),
  });
  harness.render();
  await harness.flush();
  assert.equal(reads.length, 2);
  responsive = true;
  clock.expire();
  await harness.flush();
  assert.equal(reads.length, 4, 'Only the two attempted historic IDs resume polling');
  assert.equal(harness.elements.filter((item) => item.type === 'JobStatusCard' && item.props.job.recoveryDeferred).length, 4);
  const retry = harness.elements.find((item) => item.props.children === 'Retry deferred historical recovery (read only)');
  assert.ok(retry);
  retry.props.onClick();
  await harness.flush();
  assert.ok(harness.elements.filter((item) => item.type === 'JobStatusCard').every((item) => item.props.job.status === 'complete' && !item.props.job.recoveryDeferred));
  assert.equal(submissions.length, 0);
  assert.equal(harness.timers.size, 0);
  assert.equal(clock.timers.size, 0);
  harness.unmount();
});

test('a malformed GET job identity preserves the original reference and does not invent a completed outcome', async () => {
  const { api } = await monitorHarness({
    saved: { ids: ['original'] },
    getJob: async () => ({ item: { id: 'unrelated', status: 'complete' } }),
  });
  const result = await api.recoverJobMonitor();
  assert.equal(result.jobs[0].id, 'original');
  assert.equal(result.jobs[0].status, 'pending');
  assert.equal(result.jobs[0].recoveringRead, false);
  assert.match(result.jobs[0].monitorError, /mismatched job identity/);
});

test('persisted warnings preserve counts without retaining arbitrary URLs or credential-bearing error text', async () => {
  const { api, storage } = await monitorHarness();
  api.saveJobMonitor(['accepted'], '2 of 9 accepted; source https://fixture.invalid/video?signed=synthetic-secret; Bearer synthetic-token');
  const stored = [...storage.values()].join('');
  assert.match(stored, /2 of 9/);
  assert.ok(!stored.includes('signed'));
  assert.ok(!stored.includes('synthetic-secret'));
  assert.ok(!stored.includes('Bearer'));
  assert.ok(!stored.includes('synthetic-token'));
  const recovered = await api.recoverJobMonitor();
  assert.match(recovered.warning, /previous submission warning retained/);
  assert.equal(recovered.jobs[0].id, 'accepted');
  const previous = [...storage.values()][0];
  assert.throws(() => api.saveJobMonitor(['https://fixture.invalid/private'], 'unsafe'), /Invalid accepted/);
  assert.equal([...storage.values()][0], previous);
});

test('progressive recovery does not overwrite a healthy polling result when another historic GET settles later', async () => {
  const held = deferred();
  let healthyReads = 0;
  const { api, storage } = await monitorHarness({
    saved: { ids: ['held', 'healthy'] },
    getJob: async (id) => id === 'held' ? held.promise : {
      item: { id, status: ++healthyReads === 1 ? 'running' : 'complete', framesProcessed: healthyReads === 1 ? 5 : 120 },
    },
  });
  const { harness } = await dashboardHarness(api.recoverJobMonitor, api.getMonitoredJob, {
    journal: journalDependencies({ storage }),
  });
  harness.render();
  await harness.flush();
  const job = () => harness.elements.find((element) => element.type === 'JobStatusCard' && element.props.job.id === 'healthy').props.job;
  assert.equal(job().status, 'complete');
  assert.equal(job().framesProcessed, 120);
  held.resolve({ item: { id: 'held', status: 'complete' } });
  await harness.flush();
  assert.equal(job().status, 'complete');
  assert.equal(job().framesProcessed, 120);
  harness.unmount();
});

test('a timed-out historic read resumes normal polling instead of leaving a permanent recovery-read flag', async () => {
  let recoveredBackend = false;
  let reads = 0;
  const { api, storage, clock } = await monitorHarness({
    saved: { ids: ['held-original'] },
    getJob: async (id) => {
      reads++;
      return recoveredBackend ? { item: { id, status: 'complete', framesProcessed: 120 } } : new Promise(() => {});
    },
  });
  const { harness, submissions } = await dashboardHarness(api.recoverJobMonitor, api.getMonitoredJob, {
    journal: journalDependencies({ storage }),
  });
  harness.render();
  await harness.flush();
  assert.equal(reads, 1);
  recoveredBackend = true;
  clock.expire();
  await harness.flush();
  const job = harness.elements.find((element) => element.type === 'JobStatusCard').props.job;
  assert.equal(job.id, 'held-original');
  assert.equal(job.status, 'complete');
  assert.equal(job.recoveringRead, false);
  assert.equal(job.framesProcessed, 120);
  assert.ok(reads >= 2);
  assert.equal(submissions.length, 0);
  assert.equal(harness.timers.size, 0);
  assert.equal(clock.timers.size, 0);
  harness.unmount();
});

test('a late active-job listing cannot downgrade a newer terminal polling result after a failed historic read', async () => {
  const runningListing = deferred();
  let reads = 0;
  const { api, storage } = await monitorHarness({
    saved: { ids: ['historic-read-failure'] },
    getJob: async (id) => {
      reads++;
      if (reads === 1) throw new Error('Synthetic failed historic read');
      if (reads === 2) return { item: { id, status: 'complete', framesProcessed: 120 } };
      return new Promise(() => {});
    },
    getJobs: async (query) => query.status === 'running'
      ? runningListing.promise
      : { items: [], meta: { pagination: { has_next: false } } },
  });
  const { harness } = await dashboardHarness(api.recoverJobMonitor, api.getMonitoredJob, {
    journal: journalDependencies({ storage }),
  });
  harness.render();
  await harness.flush();
  assert.equal(harness.elements.find((element) => element.type === 'JobStatusCard').props.job.status, 'complete');
  runningListing.resolve({
    items: [{ id: 'historic-read-failure', status: 'running', framesProcessed: 7 }],
    meta: { pagination: { has_next: false } },
  });
  await harness.flush();
  const job = harness.elements.find((element) => element.type === 'JobStatusCard').props.job;
  assert.equal(job.status, 'complete');
  assert.equal(job.framesProcessed, 120);
  assert.equal(reads, 2);
  assert.equal(harness.timers.size, 0);
  harness.unmount();
});

test('unmounted recovery cannot install jobs or timers', async () => {
  const request = deferred();
  const { harness } = await dashboardHarness(() => request.promise);
  harness.render();
  harness.unmount();
  request.resolve({ jobs: [{ id: 'late', status: 'pending' }] });
  await harness.flush();
  assert.equal(harness.timers.size, 0);
});

test('Recent Jobs includes a full nine-camera batch', async () => {
  const source = await readFile(new URL('../src/hooks/useDashboardData.js', import.meta.url), 'utf8');
  assert.match(source, /getJobs\(\{ page: 1, pageSize: 9,/);
});

test('navigation recovery waits for an in-flight batch before reading its final accepted IDs', async () => {
  const { api } = await monitorHarness();
  api.beginJobSubmission();
  let done = false;
  const recovery = api.recoverJobMonitor({}).then((value) => { done = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(done, false);
  api.saveJobMonitor(['accepted-1', 'accepted-2'], 'Partial acceptance');
  api.endJobSubmission();
  const result = await recovery;
  assert.equal(result.jobs.length, 2);
  assert.match(result.warning, /Previous submission warning retained/);
});

test('a stalled poll does not withhold successful jobs; timeout retries without losing partial acceptance', async () => {
  const stalled = deferred();
  const signals = [];
  let retry = false;
  const { api, clock } = await monitorHarness({
    getJob(id, { signal }) {
      signals.push(signal);
      return id === 'stalled' && !retry ? stalled.promise : Promise.resolve({
        item: { id, status: 'complete', events: [], frames: [] },
      });
    },
  });
  const { harness, submissions } = await dashboardHarness(async () => ({
    jobs: [
      { id: 'stalled', status: 'running', events: [{ incidentId: 'saved-event' }], frames: [{ frameIndex: 1, capture: 'saved.jpg' }] },
      { id: 'successful', status: 'pending' },
    ],
    warning: '2 of 9 accepted; queue full',
  }), api.getMonitoredJob);
  const jobs = () => harness.elements.filter((node) => node.type === 'JobStatusCard').map((node) => node.props.job);
  harness.render();
  await harness.flush();
  assert.equal(jobs()[1].status, 'complete');
  assert.equal(jobs()[0].status, 'running');
  assert.equal(clock.timers.size, 1);
  for (const tick of harness.timers.values()) tick();
  await harness.flush();
  assert.equal(signals.length, 2, 'the stalled job cannot overlap its own GET before the deadline');
  clock.expire();
  await harness.flush();
  assert.match(jobs()[0].monitorError, /stalled.*timed out after 30 seconds/);
  assert.equal(signals[0].aborted, true);
  assert.equal(clock.timers.size, 0);
  await harness.elements.find((node) => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(submissions.length, 0, 'a timeout must not permit duplicate submission');
  retry = true;
  for (const tick of harness.timers.values()) tick();
  await harness.flush();
  assert.equal(jobs()[0].status, 'complete');
  assert.equal(jobs()[0].monitorError, null);
  assert.equal(jobs()[0].events[0].incidentId, 'saved-event');
  assert.equal(jobs()[0].frames[0].capture, 'saved.jpg');
  assert.match(JSON.stringify(harness.elements), /queue full/);
  assert.equal(harness.timers.size, 0);
  assert.equal(clock.timers.size, 0);
  stalled.resolve({ item: { id: 'stalled', status: 'running', frames: [] } });
  await harness.flush();
  assert.equal(jobs()[0].status, 'complete', 'late timed-out completion cannot overwrite the retry');
  harness.unmount();
});

test('saved-job deadlines preserve uncertain accepted IDs and allow recovery to finish', async () => {
  const stalled = deferred();
  let signal;
  const { api, clock } = await monitorHarness({
    saved: { ids: ['stalled', 'successful'], warning: 'Partial acceptance' },
    getJob(id, request) {
      if (id !== 'stalled') return Promise.resolve({ item: { id, status: 'complete' } });
      signal = request.signal;
      return stalled.promise;
    },
  });
  const recovery = api.recoverJobMonitor();
  await new Promise((resolve) => setImmediate(resolve));
  clock.expire();
  const result = await recovery;
  assert.equal(result.jobs[0].id, 'stalled');
  assert.equal(result.jobs[0].status, 'pending');
  assert.match(result.jobs[0].monitorError, /timed out/);
  assert.equal(result.jobs[1].status, 'complete');
  assert.equal(result.warning, 'Partial acceptance');
  assert.equal(signal.aborted, true);
  assert.equal(clock.timers.size, 0);
  stalled.resolve({ item: { id: 'stalled', status: 'complete' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.jobs[0].status, 'pending');
});

test('a paginated listing timeout blocks submission and preserves storage until explicit recovery succeeds', async () => {
  const late = deferred();
  let fail = true;
  let signal;
  const { api, clock, storage } = await monitorHarness({
    saved: { ids: ['accepted'], warning: 'Partial acceptance' },
    getJobs(query, request) {
      if (query.status === 'running') return Promise.resolve({ items: [] });
      if (query.page === 1) return Promise.resolve({
        items: [{ id: 'queued', status: 'pending' }], meta: { pagination: { has_next: true } },
      });
      if (!fail) return Promise.resolve({ items: [] });
      signal = request.signal;
      return late.promise;
    },
  });
  const { harness, submissions, persisted } = await dashboardHarness(api.recoverJobMonitor, api.getMonitoredJob);
  const originalStorage = [...storage.values()][0];
  harness.render();
  await harness.flush();
  clock.expire();
  await harness.flush();
  assert.match(JSON.stringify(harness.elements), /Job recovery timed out.*Active listing is incomplete/);
  assert.equal(signal.aborted, true);
  assert.equal(persisted.length, 0);
  assert.equal([...storage.values()][0], originalStorage);
  await harness.elements.find((node) => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(submissions.length, 0);
  fail = false;
  harness.elements.find((node) => node.type === 'button' && node.props.children === 'Retry job recovery').props.onClick();
  await harness.flush();
  assert.equal(harness.elements.filter((node) => node.type === 'JobStatusCard').length, 2);
  assert.match(JSON.stringify(harness.elements), /Partial acceptance/);
  assert.equal(persisted.length, 1);
  late.resolve({ items: [{ id: 'stale', status: 'pending' }] });
  await harness.flush();
  assert.ok(!JSON.stringify(harness.elements).includes('"stale"'));
  assert.equal(clock.timers.size, 0);
  harness.unmount();
});

test('unmount cancels a never-settling poll and ignores late completion without request or timer leaks', async () => {
  const late = deferred();
  let signal;
  const { api, clock } = await monitorHarness({
    getJob(id, request) {
      signal = request.signal;
      return late.promise;
    },
  });
  const { harness } = await dashboardHarness(async () => ({
    jobs: [{ id: 'accepted', status: 'running' }],
  }), api.getMonitoredJob);
  harness.render();
  await harness.flush();
  const before = JSON.stringify(harness.elements);
  assert.equal(clock.timers.size, 1);
  harness.unmount();
  await harness.flush();
  assert.equal(signal.aborted, true);
  assert.equal(clock.timers.size, 0);
  assert.equal(harness.timers.size, 0);
  late.resolve({ item: { id: 'accepted', status: 'complete' } });
  await harness.flush();
  assert.equal(JSON.stringify(harness.elements), before);
});

test('aborting recovery cancels stalled saved reads, listings and submission waits even without transport cooperation', async () => {
  for (const phase of ['saved', 'listing', 'submission']) {
    let requestSignal;
    let calls = 0;
    const parent = new AbortController();
    const { api, clock } = await monitorHarness({
      saved: { ids: phase === 'saved' ? ['accepted'] : [] },
      getJob(id, { signal }) { calls++; requestSignal = signal; return new Promise(() => {}); },
      getJobs(query, { signal }) { calls++; requestSignal = signal; return new Promise(() => {}); },
    });
    if (phase === 'submission') api.beginJobSubmission();
    const recovery = api.recoverJobMonitor({ signal: parent.signal });
    await new Promise((resolve) => setImmediate(resolve));
    parent.abort();
    await assert.rejects(recovery, { name: 'AbortError' });
    assert.equal(clock.timers.size, 0);
    if (phase === 'submission') {
      assert.equal(calls, 0);
      api.endJobSubmission();
    } else {
      assert.equal(requestSignal.aborted, true);
    }
  }
});

test('bounded reads clean up parent listeners and deadlines on success, failure, timeout and cancellation', async () => {
  for (const outcome of ['success', 'failure', 'timeout', 'cancel', 'already-aborted']) {
    const late = deferred();
    const parent = new AbortController();
    const listeners = new Set();
    const add = parent.signal.addEventListener.bind(parent.signal);
    const remove = parent.signal.removeEventListener.bind(parent.signal);
    parent.signal.addEventListener = (...args) => { listeners.add(args[1]); add(...args); };
    parent.signal.removeEventListener = (...args) => { listeners.delete(args[1]); remove(...args); };
    if (outcome === 'already-aborted') parent.abort();
    let calls = 0;
    const { api, clock } = await monitorHarness({
      getJob() { calls++; return late.promise; },
    });
    const request = api.getMonitoredJob('accepted', { signal: parent.signal });
    const checked = outcome === 'success'
      ? request.then((result) => assert.equal(result.item.id, 'accepted'))
      : assert.rejects(request, outcome === 'failure' ? /Offline/
        : outcome === 'timeout' ? /timed out after 30 seconds/ : { name: 'AbortError' });
    await new Promise((resolve) => setImmediate(resolve));
    if (outcome === 'success') late.resolve({ item: { id: 'accepted' } });
    if (outcome === 'failure') late.reject(new Error('Offline'));
    if (outcome === 'timeout') clock.expire();
    if (outcome === 'cancel') parent.abort();
    await checked;
    assert.equal(clock.timers.size, 0);
    assert.equal(listeners.size, 0);
    assert.equal(calls, outcome === 'already-aborted' ? 0 : 1);
    if (['timeout', 'cancel'].includes(outcome)) late.reject(new Error('Late ignored transport error'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(clock.timers.size, 0);
  }
});

test('job cards distinguish transient monitoring errors from backend job failures', async () => {
  const harness = await componentHarness('../src/components/JobStatusCard/JobStatusCard.jsx', {
    '../../utils/formatters.js': { formatDateTime: String, formatNumber: String },
  });
  harness.render({ job: { id: 'accepted', status: 'running', monitorError: 'Reading accepted job timed out.' } });
  const alert = harness.elements.find((node) => node.props.role === 'alert');
  assert.equal(alert.props.children, 'Reading accepted job timed out.');
  harness.render({ job: { id: 'accepted', status: 'complete', monitorError: null } });
  assert.ok(!harness.elements.some((node) => node.props.role === 'alert'));
});

test('an accepted job polls while the next POST never settles; unmount cancels GETs but does not retry the POST', async () => {
  const pendingPost = deferred();
  const lateGet = deferred();
  let reads = 0;
  let signal;
  let submissionFinished = 0;
  const { api, clock } = await monitorHarness({
    getJob(id, request) {
      reads++;
      if (reads === 1) return Promise.resolve({ item: { id, status: 'running', framesProcessed: 12 } });
      signal = request.signal;
      return lateGet.promise;
    },
  });
  const { harness, submissions, persisted } = await dashboardHarness(async () => ({ jobs: [] }), api.getMonitoredJob, {
    startDetectionJob: (payload) => payload.stream_url === 'stream-1'
      ? Promise.resolve({ item: { id: 'accepted-first', status: 'pending' } })
      : pendingPost.promise,
    endJobSubmission: () => { submissionFinished++; },
  });
  harness.render();
  await harness.flush();
  const batch = harness.elements.find((node) => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await waitForSubmissions(submissions, 2, harness);
  assert.equal(submissions.length, 2);
  assert.equal(persisted.at(-1).ids[0], 'accepted-first');
  const job = harness.elements.find((node) => node.type === 'JobStatusCard').props.job;
  assert.equal(job.status, 'running');
  assert.equal(job.framesProcessed, 12);
  assert.equal(harness.timers.size, 1);
  for (const tick of harness.timers.values()) tick();
  await harness.flush();
  assert.equal(reads, 2, 'the accepted job continues polling during the pending POST');
  await harness.elements.find((node) => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await harness.flush();
  assert.equal(submissions.length, 2);
  assert.equal(submissionFinished, 0, 'the unresolved POST remains honestly in progress');
  const before = JSON.stringify(harness.elements);
  harness.unmount();
  await harness.flush();
  assert.equal(signal.aborted, true);
  assert.equal(clock.timers.size, 0);
  assert.equal(harness.timers.size, 0);
  lateGet.resolve({ item: { id: 'accepted-first', status: 'complete' } });
  await harness.flush();
  assert.equal(JSON.stringify(harness.elements), before);
  assert.equal(submissions.length, 2);
  assert.equal(submissionFinished, 0);
  // Resolve only for test cleanup: this was never required to display or poll the first job.
  pendingPost.resolve({ item: { id: 'accepted-late', status: 'pending' } });
  await batch;
  await harness.flush();
  assert.equal(persisted.at(-1).ids.join(','), 'accepted-first,accepted-late');
  assert.equal(harness.timers.size, 0);
  assert.equal(submissionFinished, 1);
  assert.equal(JSON.stringify(harness.elements), before);
});

test('serial acceptance preserves progressive GET results and completed jobs do not permit starts during an unresolved POST', async () => {
  const pendingPost = deferred();
  let call = 0;
  const { harness, submissions } = await dashboardHarness(async () => ({ jobs: [] }), async (id) => ({
    item: { id, status: 'complete', framesProcessed: 120, frames: [{ frameIndex: 1, capture: `${id}.jpg` }] },
  }), {
    sources: ['stream-1', 'stream-2', 'stream-3'],
    startDetectionJob: async () => ++call === 3 ? pendingPost.promise : { item: { id: `accepted-${call}`, status: 'pending' } },
  });
  harness.render();
  await harness.flush();
  const batch = harness.elements.find((node) => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await waitForSubmissions(submissions, 3, harness);
  for (const tick of harness.timers.values()) tick();
  await harness.flush();
  const jobs = () => harness.elements.filter((node) => node.type === 'JobStatusCard').map((node) => node.props.job);
  assert.equal(submissions.length, 3);
  assert.equal(jobs().length, 2);
  assert.ok(jobs().every((job) => job.status === 'complete' && job.framesProcessed === 120));
  assert.equal(harness.timers.size, 0);
  await harness.elements.find((node) => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(submissions.length, 3, 'terminal accepted jobs do not override the pending POST lock');
  pendingPost.reject(new Error('Later submission unavailable'));
  await batch;
  await harness.flush();
  assert.ok(jobs().every((job) => job.status === 'complete' && job.frames.length === 1));
  assert.match(JSON.stringify(harness.elements), /2 of 3 jobs started.*Later submission unavailable/);
  assert.equal(harness.timers.size, 0);
  harness.unmount();
});

test('late confirmed acceptance after navigation is persisted without issuing remaining serial POSTs', async () => {
  const late = deferred();
  let reloads = 0;
  const { api } = await monitorHarness();
  const { harness, submissions, persisted } = await dashboardHarness(async () => ({ jobs: [] }), async () => {
    throw new Error('Unmounted accepted jobs must not start polling');
  }, {
    sources: ['stream-1', 'stream-2', 'stream-3'],
    startDetectionJob: () => late.promise,
    reload: () => { reloads++; },
    saveJobMonitor: api.saveJobMonitor,
  });
  harness.render();
  await harness.flush();
  const batch = harness.elements.find((node) => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await waitForSubmissions(submissions, 1, harness);
  harness.unmount();
  const before = JSON.stringify(harness.elements);
  late.resolve({ item: { id: 'late-accepted', status: 'pending' } });
  await batch;
  await harness.flush();
  assert.equal(submissions.length, 1);
  assert.equal(persisted.at(-1).ids[0], 'late-accepted');
  assert.match(persisted.at(-1).warning, /1 of 3 jobs started.*navigation: 2 sources were not submitted/);
  assert.equal(harness.timers.size, 0);
  assert.equal(reloads, 0);
  assert.equal(JSON.stringify(harness.elements), before);
  const restored = await api.recoverJobMonitor();
  assert.equal(restored.jobs[0].id, 'late-accepted');
  assert.equal(restored.warning, persisted.at(-1).warning);
});

test('navigation after the final source POST does not invent a partial warning on recovery', async () => {
  const lastPost = deferred();
  const { api } = await monitorHarness();
  const { harness, submissions, persisted } = await dashboardHarness(async () => ({ jobs: [] }), async (id) => ({
    item: { id, status: 'running' },
  }), {
    startDetectionJob: (payload) => payload.stream_url === 'stream-1'
      ? Promise.resolve({ item: { id: 'first', status: 'pending' } })
      : lastPost.promise,
    saveJobMonitor: api.saveJobMonitor,
  });
  harness.render();
  await harness.flush();
  const batch = harness.elements.find((node) => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await waitForSubmissions(submissions, 2, harness);
  harness.unmount();
  lastPost.resolve({ item: { id: 'last', status: 'pending' } });
  await batch;
  await harness.flush();
  assert.equal(submissions.length, 2);
  assert.equal(persisted.at(-1).ids.join(','), 'first,last');
  assert.equal(persisted.at(-1).warning, null);
  assert.equal(harness.timers.size, 0);
  const restored = await api.recoverJobMonitor();
  assert.equal(restored.warning, null);
  assert.equal(restored.jobs.length, 2);
});

test('missing saved jobs remain unavailable without inventing failure and later explicit recovery reconciles them', async () => {
  let missing = true;
  const { api, clock } = await monitorHarness({
    saved: { ids: ['missing', 'accepted'], warning: 'Partial acceptance' },
    async getJob(id) {
      if (id === 'missing' && missing) throw Object.assign(new Error('Expired or never existed'), { status: 404 });
      return { item: { id, status: id === 'missing' ? 'complete' : 'running' } };
    },
  });
  const { harness, submissions, persisted } = await dashboardHarness(api.recoverJobMonitor, api.getMonitoredJob);
  const jobs = () => harness.elements.filter((node) => node.type === 'JobStatusCard').map((node) => node.props.job);
  harness.render();
  await harness.flush();
  assert.equal(jobs()[0].status, 'unavailable');
  assert.equal(jobs()[1].status, 'running');
  assert.equal(persisted.at(-1).ids.join(','), 'missing,accepted');
  assert.equal(harness.elements.find((node) => node.type === 'strong' && Array.isArray(node.props.children)
    && node.props.children.includes(' complete, ')).props.children.join(''), '0 complete, 0 failed, out of 2 jobs.');
  assert.match(JSON.stringify(harness.elements), /outcomes are unknown, not failed/);
  assert.ok(!JSON.stringify(harness.elements).includes('All 2 detection jobs finished'));
  assert.equal(harness.timers.size, 1, 'actual active jobs keep polling');
  await harness.elements.find((node) => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(submissions.length, 0);
  missing = false;
  harness.elements.find((node) => node.type === 'button' && node.props.children === 'Retry unavailable job recovery').props.onClick();
  await harness.elements.find((node) => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(submissions.length, 0, 'explicit recovery locks submission before rerender');
  await harness.flush();
  assert.equal(jobs()[0].status, 'complete');
  assert.equal(jobs()[0].monitorError, undefined);
  assert.match(JSON.stringify(harness.elements), /Partial acceptance/);
  assert.ok(!harness.elements.some((node) => node.type === 'button' && node.props.children === 'Retry unavailable job recovery'));
  assert.equal(clock.timers.size, 0);
  harness.unmount();
});

test('backend listing reconciles a missing saved job in the same recovery and clears its transient error', async () => {
  const { api } = await monitorHarness({
    saved: { ids: ['accepted'] },
    async getJob() { throw Object.assign(new Error('Not found'), { status: 404 }); },
    async getJobs(query) {
      return { items: query.status === 'running' ? [{ id: 'accepted', status: 'running' }] : [] };
    },
  });
  const result = await api.recoverJobMonitor();
  assert.equal(result.jobs[0].status, 'running');
  assert.equal(result.jobs[0].monitorError, undefined);
  assert.equal(result.error, null);
});

test('an unavailable job alone does not poll or block an explicitly started new batch, preserving existing start policy', async () => {
  const { api } = await monitorHarness({
    saved: { ids: ['missing'] },
    async getJob() { throw Object.assign(new Error('Not found'), { status: 404 }); },
  });
  const { harness, submissions } = await dashboardHarness(api.recoverJobMonitor);
  harness.render();
  await harness.flush();
  assert.equal(harness.timers.size, 0);
  assert.equal(harness.elements.find((node) => node.type === 'JobStatusCard').props.job.status, 'unavailable');
  assert.ok(!JSON.stringify(harness.elements).includes('All 1 detection jobs finished'));
  await harness.elements.find((node) => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await harness.flush();
  assert.equal(submissions.length, 2, 'no new product rule blocks jobs for expired records');
  harness.unmount();
});

test('a monitored job becoming unavailable retains progressive data and offers later reconciliation without failed counts', async () => {
  let missing = true;
  const { api } = await monitorHarness({
    async getJob(id) {
      if (missing) throw Object.assign(new Error('Job record expired'), { status: 404 });
      return { item: { id, status: 'failed', error: 'Actual inference failure' } };
    },
  });
  const { harness } = await dashboardHarness(async () => ({
    jobs: [{ id: 'accepted', status: 'running', frames: [{ frameIndex: 1, capture: 'saved.jpg' }] }],
  }), api.getMonitoredJob);
  harness.render();
  await harness.flush();
  const job = harness.elements.find((node) => node.type === 'JobStatusCard').props.job;
  assert.equal(job.status, 'unavailable');
  assert.equal(job.frames[0].capture, 'saved.jpg');
  assert.match(job.monitorError, /inference outcome is unknown/);
  assert.equal(harness.timers.size, 0);
  assert.equal(harness.elements.find((node) => node.type === 'strong' && Array.isArray(node.props.children)
    && node.props.children.includes(' complete, ')).props.children.join(''), '0 complete, 0 failed, out of 1 jobs.');
  harness.unmount();
  missing = false;
  const result = await api.getMonitoredJob('accepted');
  assert.equal(result.item.status, 'failed', 'a later real backend failure is distinct from a 404');
});

test('unavailable job cards use unknown outcome labels rather than failure badges', async () => {
  const harness = await componentHarness('../src/components/JobStatusCard/JobStatusCard.jsx', {
    '../../utils/formatters.js': { formatDateTime: String, formatNumber: String },
  });
  harness.render({ job: { id: 'missing', status: 'unavailable', monitorError: 'Outcome unknown.' } });
  const badge = harness.elements.find((node) => node.type === 'StatusBadge');
  assert.equal(badge.props.status, 'offline');
  assert.equal(badge.props.label, 'unavailable (outcome unknown)');
});

test('job B accepted after stalled GET A updates before A times out with one request per job and lifecycle cleanup', async () => {
  const postB = deferred();
  const stalledA = deferred();
  const reads = [];
  const { api, clock } = await monitorHarness({
    getJob(id, { signal }) {
      reads.push({ id, signal });
      return id === 'A' ? stalledA.promise : Promise.resolve({
        item: { id, status: 'running', framesProcessed: 42 },
      });
    },
  });
  const { harness, submissions } = await dashboardHarness(async () => ({ jobs: [] }), api.getMonitoredJob, {
    startDetectionJob: (payload) => payload.stream_url === 'stream-1'
      ? Promise.resolve({ item: { id: 'A', status: 'pending' } })
      : postB.promise,
  });
  harness.render();
  await harness.flush();
  const batch = harness.elements.find((node) => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await waitForSubmissions(submissions, 2, harness);
  assert.equal(reads.length, 1);
  assert.equal(reads[0].id, 'A');
  assert.equal(clock.timers.size, 1);
  postB.resolve({ item: { id: 'B', status: 'pending' } });
  await batch;
  await harness.flush();
  const jobs = () => harness.elements.filter((node) => node.type === 'JobStatusCard').map((node) => node.props.job);
  assert.equal(jobs().find((job) => job.id === 'B').framesProcessed, 42);
  assert.equal(reads.filter((read) => read.id === 'B').length, 1);
  assert.equal(reads.filter((read) => read.id === 'A').length, 1);
  assert.equal(reads[0].signal.aborted, false, 'B updates without waiting for A deadline or aborting A');
  assert.equal(clock.timers.size, 1);
  for (const tick of harness.timers.values()) tick();
  await harness.flush();
  assert.equal(reads.filter((read) => read.id === 'A').length, 1, 'A remains single-flight');
  assert.equal(reads.filter((read) => read.id === 'B').length, 2, 'B can refresh again while A stalls');
  await harness.elements.find((node) => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await harness.flush();
  assert.equal(submissions.length, 2);
  const before = JSON.stringify(harness.elements);
  harness.unmount();
  await harness.flush();
  assert.equal(reads[0].signal.aborted, true);
  assert.equal(clock.timers.size, 0);
  assert.equal(harness.timers.size, 0);
  stalledA.resolve({ item: { id: 'A', status: 'complete' } });
  await harness.flush();
  assert.equal(JSON.stringify(harness.elements), before);
});

test('explicit recovery replaces and cancels per-job reads without stale results or old cleanup removing new reads', async () => {
  const oldRead = deferred();
  const newRead = deferred();
  const requests = [];
  let recovery = 0;
  const { api, clock } = await monitorHarness({
    getJob(id, { signal }) {
      requests.push({ id, signal });
      return requests.length === 1 ? oldRead.promise : newRead.promise;
    },
  });
  const { harness } = await dashboardHarness(async () => ({
    jobs: ++recovery === 1
      ? [{ id: 'A', status: 'pending' }, { id: 'missing', status: 'unavailable', monitorError: 'Unknown outcome' }]
      : [{ id: 'A', status: 'running' }, { id: 'missing', status: 'complete' }],
  }), api.getMonitoredJob);
  harness.render();
  await harness.flush();
  harness.elements.find((node) => node.type === 'button' && node.props.children === 'Retry unavailable job recovery').props.onClick();
  await harness.flush();
  assert.equal(requests.length, 2);
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(requests[1].signal.aborted, false);
  assert.equal(clock.timers.size, 1);
  oldRead.resolve({ item: { id: 'A', status: 'failed' } });
  await harness.flush();
  for (const tick of harness.timers.values()) tick();
  await harness.flush();
  assert.equal(requests.length, 2, 'old attempt cleanup cannot remove the replacement single-flight entry');
  assert.equal(harness.elements.find((node) => node.type === 'JobStatusCard').props.job.status, 'running');
  newRead.resolve({ item: { id: 'A', status: 'complete' } });
  await harness.flush();
  assert.equal(harness.elements.find((node) => node.type === 'JobStatusCard').props.job.status, 'complete');
  assert.equal(clock.timers.size, 0);
  assert.equal(harness.timers.size, 0);
  harness.unmount();
});
