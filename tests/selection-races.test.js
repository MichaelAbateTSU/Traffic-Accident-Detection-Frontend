import assert from 'node:assert/strict';
import test from 'node:test';
import { componentHarness, deferred } from './componentHarness.js';
import { FIXED_CAMERA_STREAM_URLS } from '../src/constants/cameras.js';

const formatters = { formatDateTime: String, formatNumber: String, formatPercent: String };
const incidentA = { id: 'A', cameraId: 'camera-A', note: 'note A', resolved: false, status: 'active' };
const incidentB = { id: 'B', cameraId: 'camera-B', note: 'note B', resolved: false, status: 'active' };

test('camera selection hides previous images immediately and ignores stale frame responses', async () => {
  let cameraId = 'A';
  const requests = [];
  const harness = await componentHarness('../src/pages/CameraView/CameraView.jsx', {
    '../../components/AuthenticatedImage/AuthenticatedImage.jsx': { default: 'img' },
    'react-router-dom': {
      Link: 'Link', useNavigate: () => () => {},
      useParams: () => ({ id: cameraId }), useLocation: () => ({ state: { name: `Camera ${cameraId}` } }),
    },
    '../../constants/cameras.js': { getStreamUrlForCameraId: (id) => `https://stream/${id}` },
    '../../utils/formatters.js': formatters,
    '../../services/api.js': {
      getCameraStatus: async () => ({ items: [] }),
      getCameraLatestFrame(id, { signal }) {
        const request = { id, signal, ...deferred() };
        requests.push(request);
        return request.promise;
      },
    },
  });
  harness.render();
  requests[0].resolve({ item: { url: '/A.jpg' } });
  await harness.flush();
  assert.equal(harness.elements.find((node) => node.type === 'img').props.src, '/A.jpg');
  for (const callback of harness.timers.values()) callback();
  const pendingA = requests[1];
  cameraId = 'B';
  assert.equal(harness.render().filter((node) => node.type === 'img').length, 0);
  await harness.flush();
  assert.equal(pendingA.signal.aborted, true);
  pendingA.resolve({ item: { url: '/stale-A.jpg' } });
  await harness.flush();
  assert.equal(harness.elements.filter((node) => node.type === 'img').length, 0);
  requests[2].resolve({ item: { url: '/B.jpg' } });
  await harness.flush();
  assert.equal(harness.elements.find((node) => node.type === 'img').props.src, '/B.jpg');
  for (const callback of harness.timers.values()) callback();
  requests[3].reject(new Error('Refresh unavailable'));
  await harness.flush();
  assert.equal(harness.elements.find((node) => node.type === 'img').props.src, '/B.jpg');
  assert.match(JSON.stringify(harness.elements.find((node) => node.props.role === 'alert')), /Refresh unavailable/);
  cameraId = 'C';
  harness.render();
  await harness.flush();
  assert.equal(harness.elements.filter((node) => node.type === 'img').length, 0);
  assert.equal(harness.elements.filter((node) => node.props.role === 'alert').length, 0);
  harness.unmount();
});

for (const failure of [false, true]) {
  test(`incident A save ${failure ? 'failure' : 'success'} cannot overwrite incident B state or its pending save`, async () => {
    const requests = [];
    const updates = [];
    const harness = await componentHarness('../src/components/IncidentDetailPanel/IncidentDetailPanel.jsx', {
      '../../utils/formatters.js': formatters,
      '../../services/api.js': {
        updateIncidentStatus(id, payload) {
          const request = { id, payload, ...deferred() };
          requests.push(request);
          return request.promise;
        },
      },
    });
    harness.render({ incident: incidentA, onIncidentUpdated: (item) => updates.push(item) });
    await harness.flush();
    const savingA = harness.elements.find((node) => node.type === 'button').props.onClick();
    harness.render({ incident: incidentB, onIncidentUpdated: (item) => updates.push(item) });
    await harness.flush();
    assert.equal(harness.elements.find((node) => node.type === 'textarea').props.value, 'note B');
    assert.equal(harness.elements.find((node) => node.type === 'button').props.disabled, false);
    const savingB = harness.elements.find((node) => node.type === 'button').props.onClick();
    if (failure) requests[0].reject(new Error('A update failed'));
    else requests[0].resolve({ item: { ...incidentA, note: 'saved A', resolved: true } });
    await savingA;
    await harness.flush();
    assert.equal(harness.elements.find((node) => node.type === 'textarea').props.value, 'note B');
    assert.equal(harness.elements.find((node) => node.type === 'button').props.disabled, true);
    assert.equal(harness.elements.filter((node) => node.props.role === 'alert').length, 0);
    assert.equal(updates.length, failure ? 0 : 1);
    requests[1].resolve({ item: { ...incidentB, note: 'saved B', resolved: true } });
    await savingB;
    await harness.flush();
    assert.equal(harness.elements.find((node) => node.type === 'textarea').props.value, 'saved B');
    assert.equal(harness.elements.find((node) => node.type === 'button').props.disabled, false);
    assert.equal(updates.at(-1).id, 'B');
    harness.unmount();
  });
}

test('returning to incident A does not revive its earlier save request', async () => {
  const request = deferred();
  const harness = await componentHarness('../src/components/IncidentDetailPanel/IncidentDetailPanel.jsx', {
    '../../utils/formatters.js': formatters,
    '../../services/api.js': { updateIncidentStatus: () => request.promise },
  });
  harness.render({ incident: incidentA });
  await harness.flush();
  const saving = harness.elements.find((node) => node.type === 'button').props.onClick();
  harness.render({ incident: incidentB });
  await harness.flush();
  harness.render({ incident: incidentA });
  await harness.flush();
  request.resolve({ item: { ...incidentA, note: 'stale saved A', resolved: true } });
  await saving;
  await harness.flush();
  assert.equal(harness.elements.find((node) => node.type === 'textarea').props.value, 'note A');
  assert.equal(harness.elements.find((node) => node.type === 'button').props.disabled, false);
  harness.unmount();
});

test('Dashboard stale update refreshes the list without replacing a new selection', async () => {
  let reloads = 0;
  const harness = await componentHarness('../src/pages/Dashboard/Dashboard.jsx', {
    'react-router-dom': { Link: 'Link' },
    '../../constants/cameras.js': { FIXED_CAMERA_STREAM_URLS },
    '../../utils/formatters.js': formatters,
    '../../services/api.js': { getJob() {}, startDetectionJob() {}, parseMaxFrames() {} },
    '../../services/jobMonitor.js': { beginJobSubmission() {}, endJobSubmission() {}, getMonitoredJob() {}, recoverJobMonitor: async () => ({ jobs: [] }), saveJobMonitor() {} },
    '../../hooks/useDashboardData.js': {
      useDashboardData: () => ({
        stats: null, incidents: [incidentA, incidentB], cameras: [], jobs: [],
        reload() { reloads++; },
      }),
    },
  });
  harness.render();
  harness.elements.find((node) => node.type === 'IncidentTable').props.onRowClick(incidentA);
  await harness.flush();
  const callbackA = harness.elements.find((node) => node.type === 'IncidentDetailPanel').props.onIncidentUpdated;
  harness.elements.find((node) => node.type === 'IncidentTable').props.onRowClick(incidentB);
  await harness.flush();
  callbackA({ ...incidentA, resolved: true });
  await harness.flush();
  assert.equal(harness.elements.find((node) => node.type === 'IncidentDetailPanel').props.incident.id, 'B');
  assert.equal(reloads, 1);
  harness.elements.find((node) => node.type === 'IncidentDetailPanel').props.onIncidentUpdated({ ...incidentB, resolved: true });
  await harness.flush();
  assert.equal(harness.elements.find((node) => node.type === 'IncidentDetailPanel').props.incident.resolved, true);
  harness.unmount();
});

test('Incidents stale update changes the correct list entry but preserves the selected detail', async () => {
  const tableState = {
    page: 1, pageSize: 20, status: 'all', sort: '-detected_at', query: {},
  };
  const harness = await componentHarness('../src/pages/Incidents/Incidents.jsx', {
    '../../hooks/useIncidentsTableState.js': { useIncidentsTableState: () => tableState },
    '../../services/api.js': {
      exportIncidentsCsv() {},
      getIncidents: async () => ({ items: [incidentA, incidentB] }),
      getIncidentById: async (id) => ({ item: id === 'A' ? incidentA : incidentB }),
    },
  });
  harness.render();
  await harness.flush();
  harness.elements.find((node) => node.type === 'IncidentTable').props.onRowClick(incidentA);
  await harness.flush();
  const callbackA = harness.elements.find((node) => node.type === 'IncidentDetailPanel').props.onIncidentUpdated;
  harness.elements.find((node) => node.type === 'IncidentTable').props.onRowClick(incidentB);
  await harness.flush();
  callbackA({ ...incidentA, resolved: true });
  await harness.flush();
  assert.equal(harness.elements.find((node) => node.type === 'IncidentDetailPanel').props.incident.id, 'B');
  const items = harness.elements.find((node) => node.type === 'IncidentTable').props.incidents;
  assert.equal(items[0].resolved, true);
  assert.equal(items[1].resolved, false);
  harness.elements.find((node) => node.type === 'IncidentDetailPanel').props.onIncidentUpdated({ ...incidentB, resolved: true });
  await harness.flush();
  assert.equal(harness.elements.find((node) => node.type === 'IncidentDetailPanel').props.incident.resolved, true);
  harness.unmount();
});

test('an aborted detail response cannot replace a later incident selection', async () => {
  const requests = [];
  const tableState = { page: 1, pageSize: 20, status: 'all', query: {} };
  const harness = await componentHarness('../src/pages/Incidents/Incidents.jsx', {
    '../../hooks/useIncidentsTableState.js': { useIncidentsTableState: () => tableState },
    '../../services/api.js': {
      exportIncidentsCsv() {},
      getIncidents: async () => ({ items: [incidentA, incidentB] }),
      getIncidentById(id, { signal }) {
        const request = { id, signal, ...deferred() };
        requests.push(request);
        return request.promise;
      },
    },
  });
  harness.render();
  await harness.flush();
  harness.elements.find((node) => node.type === 'IncidentTable').props.onRowClick(incidentA);
  await harness.flush();
  harness.elements.find((node) => node.type === 'IncidentTable').props.onRowClick(incidentB);
  await harness.flush();
  assert.equal(requests[0].signal.aborted, true);
  requests[1].resolve({ item: incidentB });
  await harness.flush();
  requests[0].resolve({ item: incidentA });
  await harness.flush();
  assert.equal(harness.elements.find((node) => node.type === 'IncidentDetailPanel').props.incident.id, 'B');
  harness.unmount();
});
