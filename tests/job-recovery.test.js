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

async function monitorHarness({ saved = null, getJob = async (id) => ({ item: { id, status: 'complete' } }), getJobs = async () => ({ items: [] }), clock = deadlineClock() } = {}) {
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
    : new SyntheticModule(['API_CONFIGURATION', 'getJob', 'getJobs'], function () {
    this.setExport('API_CONFIGURATION', { baseUrl: 'https://backend.example' });
    this.setExport('getJob', getJob);
    this.setExport('getJobs', getJobs);
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
  assert.deepEqual([...result.jobs.map((item) => item.id)], ['accepted-1', 'accepted-2', 'queued-9', 'running-1']);
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
  const persisted = [];
  const harness = await componentHarness('../src/pages/Dashboard/Dashboard.jsx', {
    '../../services/submissionJournal.js': options.journal ?? journalDependencies(),
    'react-router-dom': { Link: 'Link' },
    '../../constants/cameras.js': { FIXED_CAMERA_STREAM_URLS: options.sources ?? ['stream-1', 'stream-2'] },
    '../../services/api.js': {
      parseMaxFrames: Number,
      startDetectionJob: async (payload) => {
        submissions.push(payload);
        return options.startDetectionJob ? options.startDetectionJob(payload) : { item: { id: 'new', status: 'pending' } };
      },
    },
    '../../services/jobMonitor.js': {
      beginJobSubmission: options.beginJobSubmission ?? (() => {}),
      endJobSubmission: options.endJobSubmission ?? (() => {}),
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
  });
  return { harness, submissions, persisted };
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
  assert.equal(result.warning, 'Partial acceptance');
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
  assert.match(JSON.stringify(harness.elements), /pending jobs \(page 2\).*timed out/);
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
