import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { componentHarness } from './componentHarness.js';
import * as formatters from '../src/utils/formatters.js';

const incident = {
  id: 'event-1', cameraId: 'CAM-01', confidenceScore: 0.87, confidence: 0.87,
  rawScore: 0.92, resolved: false, status: 'active', frameIdx: 10,
  timestampSec: 12.5,
};
const recharts = Object.fromEntries([
  'CartesianGrid', 'Line', 'LineChart', 'ResponsiveContainer', 'Tooltip', 'XAxis', 'YAxis',
  'Bar', 'BarChart',
].map((name) => [name, name]));

for (const [path, props] of [
  ['../src/components/JobStatusCard/JobStatusCard.jsx', { job: { id: 'job-1', peakConfidence: 0.87, events: [incident] } }],
  ['../src/components/IncidentDetailPanel/IncidentDetailPanel.jsx', { incident }],
  ['../src/components/IncidentTable/IncidentTable.jsx', { incidents: [incident] }],
  ['../src/components/IncidentTable/IncidentTable.jsx', { incidents: [incident], compact: true }],
]) {
  test(`${path} labels accident scores as decimal heuristics, not probabilities`, async () => {
    const harness = await componentHarness(path, {
      '../../utils/formatters.js': formatters,
      '../../services/api.js': { updateIncidentStatus() {} },
    });
    harness.render(props);
    const output = JSON.stringify(harness.elements);
    assert.match(output, /[Hh]euristic.*accident score/);
    assert.match(output, /not calibrated probabilities/);
    assert.match(output, /0\.87/);
    assert.doesNotMatch(output, /87(?:\.0+)?%/);
    if (!props.compact) assert.match(output, /0\.92/);
    if (path.includes('JobStatusCard') || path.includes('IncidentDetailPanel')) {
      assert.match(output, /Processing elapsed time/);
      assert.match(output, /wall-clock since job start, not source-video time/);
      assert.match(output, /12\.5/);
    }
    harness.unmount();
  });
}

test('score trend retains original values with clear heuristic series and decimal tooltip', async () => {
  const harness = await componentHarness('../src/components/charts/ConfidenceTrendChart.jsx', {
    recharts,
    '../../utils/formatters.js': formatters,
  });
  harness.render({ events: [incident] });
  assert.match(JSON.stringify(harness.elements), /not calibrated probabilities/);
  const chart = harness.elements.find((node) => node.type === 'LineChart');
  assert.equal(chart.props.data[0].confidence, 0.87);
  assert.equal(chart.props.data[0].raw, 0.92);
  const lines = harness.elements.filter((node) => node.type === 'Line');
  assert.equal(lines[0].props.name, 'Heuristic accident score');
  assert.equal(lines[1].props.name, 'Raw heuristic score');
  assert.equal(harness.elements.find((node) => node.type === 'Tooltip').props.formatter(0.87), '0.87');
  harness.unmount();
});

test('supporting heuristic signals are not displayed as probabilities', async () => {
  const harness = await componentHarness('../src/components/charts/DetectionSignalsChart.jsx', {
    recharts,
    '../../utils/formatters.js': formatters,
  });
  harness.render({ signalValues: { entries: [{ key: 'suddenStop', value: 0.5 }] } });
  assert.match(JSON.stringify(harness.elements), /not probabilities/);
  assert.equal(harness.elements.find((node) => node.type === 'Tooltip').props.formatter(0.5), '0.50');
  harness.unmount();
});

test('incident filter and sort labels change without renaming API keys', async () => {
  const source = await readFile(new URL('../src/pages/Incidents/Incidents.jsx', import.meta.url), 'utf8');
  assert.match(source, /value="-confidence_score">Heuristic score \(High-Low\)/);
  assert.match(source, /value="confidence_score">Heuristic score \(Low-High\)/);
  assert.match(source, /Minimum heuristic accident score \(0-1\), not a probability/);
  assert.match(source, /setMinConfidence\(e.target.value\)/);
  const settings = await readFile(new URL('../src/pages/Settings/Settings.jsx', import.meta.url), 'utf8');
  assert.match(settings, /Heuristic Accident Score Threshold/);
  assert.match(settings, /does not change backend scoring or detection thresholds/);
  assert.doesNotMatch(settings, /YOLO confidence above/);
});
