import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import { componentHarness, deferred } from './componentHarness.js';

async function monitorHarness({ saved = null, getJob = async (id) => ({ item: { id, status: 'complete' } }), getJobs = async () => ({ items: [] }) } = {}) {
  const storage = new Map(saved ? [['tad_monitor:https://backend.example', JSON.stringify(saved)]] : []);
  const context = createContext({
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
  });
  const source = await readFile(new URL('../src/services/jobMonitor.js', import.meta.url), 'utf8');
  const module = new SourceTextModule(source, { context });
  await module.link(() => new SyntheticModule(['API_CONFIGURATION', 'getJob', 'getJobs'], function () {
    this.setExport('API_CONFIGURATION', { baseUrl: 'https://backend.example' });
    this.setExport('getJob', getJob);
    this.setExport('getJobs', getJobs);
  }, { context }));
  await module.evaluate();
  return { api: module.namespace, storage };
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

test('job errors remain visible, 404 is terminal, and listing failures reject unsafe recovery', async () => {
  const { api } = await monitorHarness({
    saved: { ids: ['missing', 'offline'], warning: null },
    async getJob(id) { throw Object.assign(new Error(id === 'missing' ? 'Job expired' : 'Network unavailable'), { status: id === 'missing' ? 404 : null }); },
  });
  const result = await api.recoverJobMonitor({});
  assert.equal(result.jobs[0].status, 'failed');
  assert.equal(result.jobs[1].status, 'pending');
  assert.match(result.error, /Job expired.*Network unavailable/);
  const failing = await monitorHarness({ getJobs: async () => { throw new Error('Unauthorized'); } });
  await assert.rejects(failing.api.recoverJobMonitor({}), /Unauthorized/);
});

async function dashboardHarness(recoverJobMonitor) {
  const submissions = [];
  const persisted = [];
  const harness = await componentHarness('../src/pages/Dashboard/Dashboard.jsx', {
    'react-router-dom': { Link: 'Link' },
    '../../constants/cameras.js': { FIXED_CAMERA_STREAM_URLS: ['stream-1', 'stream-2'] },
    '../../services/api.js': {
      parseMaxFrames: Number,
      getJob: async (id) => ({ item: { id, status: 'running' } }),
      startDetectionJob: async (payload) => { submissions.push(payload); return { item: { id: 'new', status: 'pending' } }; },
    },
    '../../services/jobMonitor.js': {
      beginJobSubmission() {}, endJobSubmission() {},
      recoverJobMonitor,
      saveJobMonitor: (ids, warning) => persisted.push({ ids, warning }),
    },
    '../../utils/formatters.js': { formatDateTime: String, formatNumber: String, formatPercent: String },
    '../../hooks/useDashboardData.js': {
      useDashboardData: () => ({ stats: null, incidents: [], cameras: [], jobs: [], reload() {} }),
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
