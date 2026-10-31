import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import { componentHarness } from './componentHarness.js';
import { FIXED_CAMERA_STREAM_URLS } from '../src/constants/cameras.js';
import * as formatters from '../src/utils/formatters.js';

test('dashboard fetch/refresh keeps automatically resolved completed-job frames alongside active and manual records', async () => {
  const records = [
    { id: 'auto:1', jobStatus: 'running', status: 'active', resolved: false, manuallyUpdated: false },
    { id: 'active:2', jobStatus: 'running', status: 'active', resolved: false, manuallyUpdated: false },
    { id: 'manual:3', jobStatus: 'complete', status: 'active', resolved: false, manuallyUpdated: true },
    { id: 'manual:4', jobStatus: 'running', status: 'resolved', resolved: true, manuallyUpdated: true },
  ];
  const calls = [];
  const slots = [], effects = [];
  let cursor = 0;
  const react = {
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = initial;
      return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }];
    },
    useCallback(callback) { return callback; },
    useEffect(callback, deps) {
      const i = cursor++;
      if (!slots[i] || deps.some((v, n) => v !== slots[i].deps[n])) {
        slots[i]?.cleanup?.();
        slots[i] = { deps };
        effects.push(() => { slots[i].cleanup = callback(); });
      }
    },
  };
  const api = {
    async getDashboard(query) {
      calls.push(query);
      const items = query.incidentsStatus === 'all' ? records : records.filter(r => r.status === query.incidentsStatus);
      return { stats: {}, incidents: { items: items.map(r => ({ ...r })), meta: { pagination: { total_items: items.length } } }, cameras: [] };
    },
    async getStats() { return { meta: null }; },
    async getHealth() { return { item: null, meta: null }; },
    async getJobs() { return { items: [], meta: null }; },
  };
  const context = createContext({ AbortController, console });
  const hook = new SourceTextModule(await readFile(new URL('../src/hooks/useDashboardData.js', import.meta.url), 'utf8'), { context });
  await hook.link(specifier => {
    const exports = specifier === 'react' ? react : api;
    return new SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
  });
  await hook.evaluate();
  let data;
  function renderHook(options) {
    cursor = 0;
    data = hook.namespace.useDashboardData(options);
    effects.splice(0).forEach(effect => effect());
    return data;
  }
  const dashboard = await componentHarness('../src/pages/Dashboard/Dashboard.jsx', {
    'react-router-dom': { Link: 'Link' },
    '../../constants/cameras.js': { FIXED_CAMERA_STREAM_URLS },
    '../../utils/formatters.js': formatters,
    '../../services/api.js': { getJob() {}, parseMaxFrames() {}, startDetectionJob() {} },
    '../../services/jobMonitor.js': { getMonitoredJob() {}, beginJobSubmission() {}, endJobSubmission() {}, saveJobMonitor() {}, recoverJobMonitor: async () => ({ jobs: [] }) },
    '../../hooks/useDashboardData.js': { useDashboardData: options => {
      assert.equal(options.incidentsStatus, 'all');
      return data;
    } },
  }, { URL });
  renderHook();
  await new Promise(resolve => setImmediate(resolve));
  renderHook();
  assert.equal(calls[0].incidentsStatus, 'all');
  records[0] = { ...records[0], jobStatus: 'complete', status: 'resolved', resolved: true };
  data.reload();
  renderHook();
  await new Promise(resolve => setImmediate(resolve));
  renderHook();
  dashboard.render();
  const table = dashboard.elements.find(node => node.type === 'IncidentTable');
  assert.deepEqual(table.props.incidents.map(r => r.id), records.map(r => r.id));
  assert.equal(table.props.incidents[0].resolved, true);
  assert.equal(table.props.incidents[0].manuallyUpdated, false);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].incidentsStatus, 'all');
  const banner = dashboard.elements.find(node => node.type === 'AlertBanner');
  assert.match(banner.props.message, /2 alarm-frame records with active record status on this page/);
  const section = dashboard.elements.find(node => node.type === 'SectionCard' && node.props.title === 'Recent Alarm Frames');
  assert.match(section.props.description, /latest 4 of 4 retained alarm-frame records across all statuses/);
  dashboard.unmount();
  slots.forEach(slot => slot?.cleanup?.());
});
