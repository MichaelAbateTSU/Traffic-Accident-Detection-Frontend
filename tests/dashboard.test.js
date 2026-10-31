import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import { transformWithEsbuild } from 'vite';
import { FIXED_CAMERA_STREAM_URLS } from '../src/constants/cameras.js';

const source = await readFile(new URL('../src/pages/Dashboard/Dashboard.jsx', import.meta.url), 'utf8');
const { code } = await transformWithEsbuild(source, 'Dashboard.jsx', { jsx: 'automatic' });
const apiSource = await readFile(new URL('../src/services/api.js', import.meta.url), 'utf8');
const configSource = await readFile(new URL('../src/config.js', import.meta.url), 'utf8');
const apiModule = new SourceTextModule(apiSource, { initializeImportMeta(meta) { meta.env = {}; } });
await apiModule.link(() => new SourceTextModule(configSource));
await apiModule.evaluate();
const { parseMaxFrames } = apiModule.namespace;

async function createDashboard({ failAt = Infinity, status = 'pending' } = {}) {
  const slots = [];
  let cursor = 0;
  let submissions = 0;
  let reloads = 0;
  const payloads = [];
  const refreshedIds = [];
  const timers = new Map();
  let nextTimer = 1;
  const context = createContext({
    console: { error() {} },
    setInterval(callback) {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    clearInterval(id) { timers.delete(id); },
  });
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (value) => {
        slots[index] = typeof value === 'function' ? value(slots[index]) : value;
      }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect() {},
    useMemo(callback) { return callback(); },
    useCallback(callback) { return callback; },
  };
  const jsx = (type, props) => ({ type, props });
  const dependencies = {
    react: hooks,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'react-router-dom': { Link: 'Link' },
    '../../constants/cameras.js': { FIXED_CAMERA_STREAM_URLS },
    '../../services/api.js': {
      parseMaxFrames,
      async startDetectionJob(payload) {
        payloads.push(payload);
        if (submissions++ === failAt) throw new Error('Submission unavailable');
        return { item: { id: `job-${submissions}`, status, peakConfidence: 0.87 } };
      },
      async getJob(id) {
        refreshedIds.push(id);
        return { item: { id, status } };
      },
    },
    '../../utils/formatters.js': {
      formatDateTime: String,
      formatNumber: String,
      formatPercent: String,
    },
    '../../hooks/useDashboardData.js': {
      useDashboardData: () => ({
        stats: null, incidents: [], cameras: [], jobs: [],
        reload() { reloads++; },
      }),
    },
  };
  const module = new SourceTextModule(code, { context });
  await module.link((specifier) => {
    const exports = dependencies[specifier] ?? {
      default: specifier.endsWith('.css') ? {} : specifier.split('/').at(-1).replace('.jsx', ''),
    };
    return new SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context });
  });
  await module.evaluate();

  function render() {
    cursor = 0;
    const tree = module.namespace.default();
    const elements = [];
    function visit(node) {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!node || typeof node !== 'object' || !node.props) return;
      elements.push(node);
      visit(node.props.children);
    }
    visit(tree);
    return elements;
  }
  return {
    render, timers, payloads, refreshedIds,
    setStatus(value) { status = value; },
    get reloads() { return reloads; },
    async submit() {
      await render().find((node) => node.type === 'form').props.onSubmit({ preventDefault() {} });
      await new Promise((resolve) => setImmediate(resolve));
    },
    async poll() {
      for (const callback of timers.values()) callback();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

for (const [label, failAt, accepted] of [
  ['full success', Infinity, FIXED_CAMERA_STREAM_URLS.length],
  ['partial success', 2, 2],
  ['all failure', 0, 0],
]) {
  test(`Dashboard monitors accepted jobs on ${label}`, async () => {
    const dashboard = await createDashboard({ failAt });
    await dashboard.submit();
    const jobs = dashboard.render().filter((node) => node.type === 'JobStatusCard');
    assert.equal(jobs.length, accepted);
    assert.equal(dashboard.refreshedIds.length, accepted);
    assert.equal(dashboard.timers.size, accepted ? 1 : 0);
    assert.equal(dashboard.reloads, accepted ? 1 : 0);
    assert.ok(dashboard.payloads.every((payload) => payload.save_frames === false));
    assert.ok(dashboard.payloads.every((payload) => payload.max_frames === 120));

    const warnings = () => dashboard.render().filter((node) => node.type === 'AlertBanner');
    if (failAt === Infinity) {
      assert.equal(warnings().length, 0);
    } else {
      assert.equal(warnings().length, 1);
      assert.equal(warnings()[0].props.message, 'Job submission error');
      assert.match(warnings()[0].props.detail, /Submission unavailable/);
      if (accepted) assert.match(warnings()[0].props.detail, /2 of 9 jobs started/);
    }
    await dashboard.poll();
    assert.equal(dashboard.refreshedIds.length, accepted * 2);
    assert.equal(warnings().length, failAt === Infinity ? 0 : 1);

    await dashboard.submit();
    assert.equal(dashboard.timers.size, 1);
    assert.equal(warnings().length, 0);
  });
}

test('already terminal accepted jobs do not start a polling timer', async () => {
  const dashboard = await createDashboard({ status: 'complete' });
  await dashboard.submit();
  assert.equal(dashboard.timers.size, 0);
  assert.equal(dashboard.refreshedIds.length, 0);
  assert.equal(dashboard.render().filter((node) => node.type === 'JobStatusCard').length, 9);
});

test('Dashboard explains peak accident scores as heuristics instead of confidence percentages', async () => {
  const dashboard = await createDashboard({ status: 'complete' });
  await dashboard.submit();
  const output = JSON.stringify(dashboard.render());
  assert.match(output, /Peak heuristic accident score \(0-1\)/);
  assert.match(output, /not calibrated probabilities/);
  assert.match(output, /0\.87/);
  assert.doesNotMatch(output, /Peak confidence/);
});

for (const finalStatus of ['complete', 'failed']) {
  test(`bounded long-running jobs keep polling through running and stop on ${finalStatus}`, async () => {
    const dashboard = await createDashboard();
    await dashboard.submit();
    dashboard.setStatus('running');
    await dashboard.poll();
    assert.equal(dashboard.timers.size, 1);
    assert.ok(dashboard.render().filter((node) => node.type === 'JobStatusCard').every((node) => node.props.job.status === 'running'));
    dashboard.setStatus(finalStatus);
    await dashboard.poll();
    assert.equal(dashboard.timers.size, 0);
    assert.ok(dashboard.render().filter((node) => node.type === 'JobStatusCard').every((node) => node.props.job.status === finalStatus));
    const summary = dashboard.render().find((node) => node.type === 'strong' && Array.isArray(node.props.children) && node.props.children[0] === 'All ');
    assert.equal(summary.props.children.join(''), finalStatus === 'failed'
      ? 'All 9 detection jobs finished: 0 complete, 9 failed.'
      : 'All 9 detection jobs finished: 9 complete, 0 failed.');
  });
}

test('Save frames is operator-controlled and the monitor explains its prerequisite', async () => {
  const dashboard = await createDashboard();
  const elements = dashboard.render();
  const checkbox = elements.find((node) => node.type === 'input' && node.props.type === 'checkbox');
  assert.equal(checkbox.props.checked, false);
  assert.match(JSON.stringify(elements), /before starting a job/);
  checkbox.props.onChange({ target: { checked: true } });
  await dashboard.submit();
  assert.ok(dashboard.payloads.every((payload) => payload.save_frames === true));
});

for (const frames of ['1', '120', '300']) {
  test(`Dashboard passes ${frames} frames to every camera in the batch`, async () => {
    const dashboard = await createDashboard();
    const input = dashboard.render().find((node) => node.props.id === 'maxFrames');
    assert.equal(input.props.value, '120');
    assert.equal(input.props.min, '1');
    assert.equal(input.props.max, '300');
    input.props.onChange({ target: { value: frames } });
    await dashboard.submit();
    assert.equal(dashboard.payloads.length, FIXED_CAMERA_STREAM_URLS.length);
    assert.ok(dashboard.payloads.every((payload) => payload.max_frames === Number(frames)));
    assert.equal(dashboard.render().filter((node) => node.type === 'JobStatusCard').length, FIXED_CAMERA_STREAM_URLS.length);
    await dashboard.poll();
    assert.equal(dashboard.timers.size, 1);
  });
}

for (const frames of ['', '0', '301', '-1', '1.5', 'NaN', 'Infinity', '1e2', ' 120 ']) {
  test(`invalid frame count ${JSON.stringify(frames)} leaves accepted jobs and polling intact`, async () => {
    const dashboard = await createDashboard();
    await dashboard.submit();
    const submitted = dashboard.payloads.length;
    dashboard.render().find((node) => node.props.id === 'maxFrames').props.onChange({ target: { value: frames } });
    await dashboard.submit();
    assert.equal(dashboard.payloads.length, submitted);
    assert.equal(dashboard.timers.size, 1);
    assert.equal(dashboard.render().filter((node) => node.type === 'JobStatusCard').length, submitted);
    assert.match(JSON.stringify(dashboard.render().find((node) => node.props.role === 'alert')), /whole number from 1 to 300/);
    dashboard.render().find((node) => node.props.id === 'maxFrames').props.onChange({ target: { value: '300' } });
    await dashboard.submit();
    assert.ok(dashboard.payloads.slice(submitted).every((payload) => payload.max_frames === 300));
  });
}
