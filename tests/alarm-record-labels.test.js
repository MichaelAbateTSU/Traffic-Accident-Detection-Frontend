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

test('record-page filters retain API status keys with review labels and frame-record totals', async () => {
  const source = await readFile(new URL('../src/pages/Incidents/Incidents.jsx', import.meta.url), 'utf8');
  assert.match(source, /\['all', 'active', 'resolved'\]/);
  assert.match(source, /setStatus\(filterOption\)/);
  assert.match(source, /'Review open' : 'Review closed'/);
  assert.match(source, /total alarm-frame records/);
  assert.match(source, /does not mean a physical incident or live alarm is active or cleared/);
});

test('consecutive alarm-frame records remain separate rows with review-only statuses', async () => {
  for (const compact of [false, true]) {
    const harness = await componentHarness('../src/components/IncidentTable/IncidentTable.jsx', {
      '../../utils/formatters.js': formatters,
    });
    harness.render({ incidents: [records[0], { ...records[1], resolved: true, status: 'resolved' }], compact });
    assert.equal(harness.elements.filter(node => node.type === 'tr' && node.props.onClick).length, 2);
    const output = JSON.stringify(harness.elements);
    assert.match(output, /not a unique or confirmed accident/);
    assert.match(output, /Consecutive rows may be one episode/);
    assert.match(output, /Review open/);
    assert.match(output, /Review closed/);
    assert.doesNotMatch(output, /"label":"Active"|"label":"Resolved"/);
    harness.unmount();
  }
});

test('review actions retain active/resolved API values without claiming physical resolution', async () => {
  const submitted = [];
  const harness = await componentHarness('../src/components/IncidentDetailPanel/IncidentDetailPanel.jsx', {
    '../../utils/formatters.js': formatters,
    '../../services/api.js': {
      async updateIncidentStatus(id, payload) {
        submitted.push({ id, ...payload });
        return { item: { ...records[0], resolved: payload.status === 'resolved', status: payload.status } };
      },
    },
  });
  harness.render({ incident: records[0] });
  let button = harness.elements.find(node => node.type === 'button' && node.props.children === 'Close review');
  await button.props.onClick();
  await harness.flush();
  assert.equal(submitted[0].status, 'resolved');
  button = harness.elements.find(node => node.type === 'button' && node.props.children === 'Reopen review');
  await button.props.onClick();
  await harness.flush();
  assert.equal(submitted[1].status, 'active');
  assert.match(JSON.stringify(harness.elements), /not evidence that a physical incident or live alarm is active or cleared/);
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
        beginJobSubmission() {}, endJobSubmission() {}, saveJobMonitor() {},
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
    const metric = cards.find(node => node.props.label === 'Nonfailed-job Ratio');
    assert.equal(metric.props.value, `${ratio.toFixed(2)}%`);
    assert.match(metric.props.description, /including queued\/running/);
    assert.match(metric.props.description, /100% when no jobs exist/);
    assert.match(metric.props.description, /not measured system uptime/);
    assert.equal(cards.find(node => node.props.label === 'Alarm Frames Today').props.value, incidents.length);
    assert.ok(!cards.some(node => /Uptime|Incidents Today/.test(node.props.label)));
    if (incidents.length) {
      assert.match(harness.elements.find(node => node.type === 'AlertBanner').props.message, /2 open alarm-frame records on this page/);
      assert.equal(harness.elements.find(node => node.type === 'IncidentTable').props.incidents.length, 2);
    }
    harness.unmount();
  });
}
