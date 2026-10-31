import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { componentHarness } from './componentHarness.js';
import * as formatters from '../src/utils/formatters.js';
import { FIXED_CAMERA_STREAM_URLS } from '../src/constants/cameras.js';

const records = [10, 11].map(frameIdx => ({
  id: `job-1:${frameIdx}`, jobId: 'job-1', frameIdx,
  confidence: 0.8, confidenceScore: 0.8, resolved: false, status: 'active',
}));

test('record-page filters retain API status keys with neutral labels and frame-record totals', async () => {
  const source = await readFile(new URL('../src/pages/Incidents/Incidents.jsx', import.meta.url), 'utf8');
  assert.match(source, /\['all', 'active', 'resolved'\]/);
  assert.match(source, /setStatus\(filterOption\)/);
  assert.match(source, /'Record active' : 'Record resolved'/);
  assert.match(source, /total alarm-frame records/);
  assert.match(source, /Neither status confirms review, accident resolution or a live alarm/);
});

test('consecutive alarm-frame records remain separate rows with neutral statuses', async () => {
  for (const compact of [false, true]) {
    const harness = await componentHarness('../src/components/IncidentTable/IncidentTable.jsx', {
      '../../utils/formatters.js': formatters,
    });
    harness.render({ incidents: [records[0], { ...records[1], resolved: true, status: 'resolved' }], compact });
    assert.equal(harness.elements.filter(node => node.type === 'tr' && node.props.onClick).length, 2);
    const output = JSON.stringify(harness.elements);
    assert.match(output, /not a unique or confirmed accident/);
    assert.match(output, /Consecutive rows may be one episode/);
    assert.match(output, /Record active/);
    assert.match(output, /Record resolved/);
    assert.match(output, /unless manually overridden/);
    assert.doesNotMatch(output, /"label":"Active"|"label":"Resolved"/);
    harness.unmount();
  }
});

test('manual status actions retain active/resolved API values without certifying review', async () => {
  const submitted = [];
  const harness = await componentHarness('../src/components/IncidentDetailPanel/IncidentDetailPanel.jsx', {
    '../../utils/formatters.js': formatters,
    '../../services/api.js': {
      async updateIncidentStatus(id, payload) {
        submitted.push({ id, ...payload });
        return { item: { ...records[0], resolved: payload.status === 'resolved', status: payload.status, manuallyUpdated: true } };
      },
    },
  });
  harness.render({ incident: records[0] });
  let button = harness.elements.find(node => node.type === 'button' && node.props.children === 'Set record resolved');
  await button.props.onClick();
  await harness.flush();
  assert.equal(submitted[0].status, 'resolved');
  assert.match(JSON.stringify(harness.elements), /Manual override/);
  button = harness.elements.find(node => node.type === 'button' && node.props.children === 'Set record active');
  await button.props.onClick();
  await harness.flush();
  assert.equal(submitted[1].status, 'active');
  assert.match(JSON.stringify(harness.elements), /Neither the status nor a manual override confirms review/);
  harness.unmount();
});

test('job counts describe every consecutive alarm frame rather than unique accidents', async () => {
  const harness = await componentHarness('../src/components/JobStatusCard/JobStatusCard.jsx', {
    '../../utils/formatters.js': formatters,
  });
  harness.render({ job: { id: 'job-1', events: records, eventCount: 2, accidentDetected: true } });
  assert.equal(harness.elements.filter(node => node.type === 'strong' && node.props.children === 'Frame:').length, 2);
  assert.match(JSON.stringify(harness.elements), /Alarm-frame records/);
  assert.match(JSON.stringify(harness.elements), /not unique or confirmed accidents/);
  assert.doesNotMatch(JSON.stringify(harness.elements), /Accident detected:/);
  harness.unmount();
});

for (const [ratio, incidents] of [[100, []], [75, records]]) {
  test(`dashboard preserves ${ratio}% nonfailed-job ratio and explains empty-window convention`, async () => {
    const harness = await componentHarness('../src/pages/Dashboard/Dashboard.jsx', {
      'react-router-dom': { Link: 'Link' },
      '../../utils/formatters.js': formatters,
      '../../constants/cameras.js': { FIXED_CAMERA_STREAM_URLS },
      '../../services/api.js': { parseMaxFrames() {}, getJob() {}, startDetectionJob() {} },
      '../../services/jobMonitor.js': {
        getMonitoredJob() {}, beginJobSubmission() {}, endJobSubmission() {}, saveJobMonitor() {},
        recoverJobMonitor: async () => ({ jobs: [], warning: null, error: null }),
      },
      '../../hooks/useDashboardData.js': {
        useDashboardData: () => ({
          stats: { uptimePercent: ratio, incidentsToday: incidents.length },
          incidents, jobs: [], cameras: [], reload() {},
        }),
      },
    }, { URL });
    harness.render();
    const cards = harness.elements.filter(node => node.type === 'StatCard');
    const metric = cards.find(node => node.props.label === 'Legacy Nonfailed-job Ratio');
    assert.equal(metric.props.value, `${ratio.toFixed(2)}%`);
    assert.match(metric.props.description, /including queued\/running/);
    assert.match(metric.props.description, /100% for an empty window/);
    assert.match(metric.props.description, /at most 10,000 listed jobs/);
    assert.match(metric.props.description, /divided by all jobs in the window/);
    assert.match(metric.props.description, /Larger restored histories can undercount the numerator/);
    assert.match(metric.props.description, /not measured system uptime/);
    assert.equal(cards.find(node => node.props.label === 'Alarm Frames Today').props.value, incidents.length);
    assert.ok(!cards.some(node => /Uptime|Incidents Today/.test(node.props.label)));
    if (incidents.length) {
      assert.match(harness.elements.find(node => node.type === 'AlertBanner').props.message, /2 alarm-frame records with active record status on this page/);
      assert.equal(harness.elements.find(node => node.type === 'IncidentTable').props.incidents.length, 2);
    }

    harness.unmount();
  });
}

for (const [jobStatus, resolved, manual] of [
  ['pending', false, false], ['running', false, false],
  ['complete', true, false], ['failed', true, false],
  ['complete', false, true], ['running', true, true],
]) {
  test(`${jobStatus} record ${resolved ? 'resolved' : 'active'} with ${manual ? 'manual override' : 'automatic default'} never implies review`, async () => {
    const harness = await componentHarness('../src/components/IncidentDetailPanel/IncidentDetailPanel.jsx', {
      '../../utils/formatters.js': formatters,
      '../../services/api.js': { updateIncidentStatus() {} },
    });
    harness.render({ incident: { ...records[0], jobStatus, resolved, manuallyUpdated: manual } });
    const output = JSON.stringify(harness.elements);
    assert.match(output, resolved ? /Record resolved/ : /Record active/);
    assert.match(output, manual ? /Manual override/ : /Automatic job-derived default/);
    assert.match(output, /active while the job is pending\/running and resolved when it finishes/);
    assert.match(output, /Neither the status nor a manual override confirms review/);
    assert.doesNotMatch(output, /Review open|Review closed|Close review|Reopen review/);
    harness.unmount();
  });
}
