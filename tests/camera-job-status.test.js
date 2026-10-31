import assert from 'node:assert/strict';
import test from 'node:test';
import { componentHarness, deferred } from './componentHarness.js';
import { cameraJobStatusLabel } from '../src/utils/cameraJobStatus.js';
import * as formatters from '../src/utils/formatters.js';
import * as cameras from '../src/constants/cameras.js';

const camera = { id: 'CAM', streamUrl: 'https://camera.example/raw.m3u8', lastSeenAt: '2026-10-31T10:00:00Z' };
const common = {
  '../../utils/formatters.js': formatters,
  '../../utils/cameraJobStatus.js': { cameraJobStatusLabel },
};

for (const status of [undefined, 'unknown', 'online', 'offline', 'warning']) {
  test(`raw card playback is attempted on focus with ${status ?? 'missing'} job state`, async () => {
    const harness = await componentHarness('../src/components/CameraCard/CameraCard.jsx', {
      ...common, 'react-router-dom': { useNavigate: () => () => {} },
    });
    harness.render({ camera: { ...camera, status } });
    harness.elements.find(n => n.type === 'article').props.onFocus();
    await harness.flush();
    const player = harness.elements.find(n => n.type === 'CameraPlayer');
    assert.equal(player.props.src, camera.streamUrl);
    assert.equal(player.props.active, true);
    assert.equal(harness.elements.find(n => n.type === 'StatusBadge').props.label, cameraJobStatusLabel(status));
    assert.match(JSON.stringify(harness.elements), /Job timestamp/);
    assert.doesNotMatch(JSON.stringify(harness.elements), /Camera Offline|Last seen:/);
    player.props.onFatalError('Network request failed');
    await harness.flush();
    assert.match(JSON.stringify(harness.elements.find(n => n.props.role === 'alert')), /Network request failed/);
    harness.unmount();
  });

  test(`full view permits configured raw stream with ${status ?? 'missing'} latest job status`, async () => {
    const harness = await componentHarness('../src/pages/CameraView/CameraView.jsx', {
      ...common,
      'react-router-dom': { Link: 'Link', useNavigate: () => () => {}, useParams: () => ({ id: camera.id }), useLocation: () => ({ state: camera }) },
      '../../constants/cameras.js': { getStreamUrlForCameraId: () => camera.streamUrl },
      '../../services/api.js': {
        getCameraStatus: async () => ({ items: status ? [{ ...camera, status }] : [] }),
        getCameraLatestFrame: async () => ({ item: null }),
      },
    });
    harness.render();
    await harness.flush();
    const player = harness.elements.find(n => n.type === 'CameraPlayer');
    assert.equal(player.props.src, camera.streamUrl);
    assert.equal(player.props.active, true);
    const output = JSON.stringify(harness.elements);
    assert.match(output, /Raw live playback, not YOLO-processed/);
    assert.match(output, /Latest saved YOLO-processed frame \(not a live stream\)/);
    assert.doesNotMatch(output, /heartbeat|Camera Offline/);
    player.props.onFatalError('Decoder failed');
    await harness.flush();
    assert.match(JSON.stringify(harness.elements.find(n => n.props.role === 'alert')), /Decoder failed/);
    harness.unmount();
  });
}

test('raw feed lists all configured cameras as unknown without jobs and preserves playback on status errors', async () => {
  for (const failure of [false, true]) {
    const harness = await componentHarness('../src/pages/LiveFeed/LiveFeed.jsx', {
      '../../constants/cameras.js': cameras,
      '../../utils/formatters.js': formatters,
      '../../services/api.js': { getCameraStatus: async () => {
        if (failure) throw new Error('Status network failed');
        return { items: [] };
      } },
    });

    test('slow metadata requests survive multiple polling intervals without hiding streams or overlapping', async () => {
      for (const lateFailure of [false, true]) {
        const requests = [];
        const harness = await componentHarness('../src/pages/LiveFeed/LiveFeed.jsx', {
          '../../constants/cameras.js': cameras,
          '../../utils/formatters.js': formatters,
          '../../services/api.js': { getCameraStatus: ({ signal }) => {
            const request = { ...deferred(), signal };
            requests.push(request);
            return request.promise;
          } },
        });
        const cards = () => harness.elements.filter(n => n.type === 'CameraCard');
        const tick = async () => {
          for (const callback of harness.timers.values()) callback();
          await harness.flush();
        };
        harness.render();
        assert.equal(cards().length, cameras.FIXED_CAMERA_STREAM_URLS.length);
        assert.equal(harness.elements.find(n => n.type === 'DataState').props.loading, false);
        for (let i = 0; i < 4; i++) await tick();
        harness.elements.find(n => n.type === 'button').props.onClick();
        await harness.flush();
        assert.equal(requests.length, 1);
        assert.equal(requests[0].signal.aborted, false);
        const source = cameras.FIXED_CAMERA_STREAM_URLS[0];
        requests[0].resolve({ items: [{ id: cameras.getCameraIdFromStreamUrl(source), status: 'offline', streamUrl: source }] });
        await harness.flush();
        assert.equal(cards()[0].props.camera.status, 'offline');
        assert.match(JSON.stringify(harness.elements), /Sources with latest job complete/);
        await tick();
        assert.equal(requests.length, 2);
        await tick();
        assert.equal(requests.length, 2);
        requests[1].reject(new Error('Metadata unavailable'));
        await harness.flush();
        assert.match(JSON.stringify(harness.elements.find(n => n.props.role === 'alert')), /Metadata unavailable/);
        assert.ok(cards().every(n => n.props.camera.status === 'unknown'));
        assert.equal(cards().length, cameras.FIXED_CAMERA_STREAM_URLS.length);
        await tick();
        assert.equal(requests.length, 3);
        const beforeUnmount = JSON.stringify(harness.elements);
        harness.unmount();
        assert.equal(harness.timers.size, 0);
        assert.equal(requests[2].signal.aborted, true);
        if (lateFailure) requests[2].reject(new Error('Late failure'));
        else requests[2].resolve({ items: [{ id: cameras.getCameraIdFromStreamUrl(source), status: 'online' }] });
        await harness.flush();
        assert.equal(JSON.stringify(harness.elements), beforeUnmount);
        assert.equal(requests.length, 3);
      }
    });
    harness.render();
    await harness.flush();
    const cards = harness.elements.filter(n => n.type === 'CameraCard');
    assert.equal(cards.length, cameras.FIXED_CAMERA_STREAM_URLS.length);
    assert.ok(cards.every(n => n.props.camera.status === 'unknown' && n.props.camera.streamUrl));
    assert.equal(harness.elements.find(n => n.type === 'DataState').props.error, null);
    if (failure) assert.match(JSON.stringify(harness.elements.find(n => n.props.role === 'alert')), /Status network failed/);
    assert.match(JSON.stringify(harness.elements), /Raw camera playback, not YOLO-processed/);
    harness.unmount();
  }
});

test('native player errors and autoplay rejection are surfaced with manual video controls', async () => {
  const handlers = new Map();
  const errors = [];
  const video = {
    canPlayType: () => 'probably',
    addEventListener: (event, handler) => handlers.set(event, handler),
    removeEventListener: event => handlers.delete(event),
    play: () => Promise.reject(Object.assign(new Error('Policy'), { name: 'NotAllowedError' })),
    pause() {}, removeAttribute() {}, load() {},
  };
  const harness = await componentHarness('../src/components/CameraPlayer/CameraPlayer.jsx', { 'hls.js': { default: {} } });
  const props = { src: camera.streamUrl, onFatalError: error => errors.push(error) };
  harness.render(props, false);
  harness.elements.find(n => n.type === 'video').props.ref.current = video;
  harness.render(props);
  await harness.flush();
  assert.equal(harness.elements.find(n => n.type === 'video').props.controls, true);
  assert.match(errors[0], /Autoplay blocked.*controls/);
  handlers.get('playing')();
  assert.equal(errors.at(-1), '');
  handlers.get('error')();
  assert.match(errors.at(-1), /Failed to load raw camera stream/);
  harness.unmount();
  assert.equal(handlers.size, 0);
});

test('HLS transport failure propagates from the real player event path', async () => {
  const callbacks = new Map();
  let loadedSource;
  let destroyed = false;
  class Hls {
    static Events = { MANIFEST_PARSED: 'manifest', LEVEL_LOADED: 'level', ERROR: 'error' };
    static isSupported() { return true; }
    on(event, handler) { callbacks.set(event, handler); }
    loadSource(src) { loadedSource = src; }
    attachMedia() {}
    destroy() { destroyed = true; }
  }
  const errors = [];
  const video = { canPlayType: () => '', addEventListener() {}, removeEventListener() {}, pause() {}, removeAttribute() {}, load() {} };
  const harness = await componentHarness('../src/components/CameraPlayer/CameraPlayer.jsx', { 'hls.js': { default: Hls } });
  const props = { src: camera.streamUrl, onFatalError: error => errors.push(error) };
  harness.render(props, false);
  harness.elements.find(n => n.type === 'video').props.ref.current = video;
  harness.render(props);
  assert.equal(loadedSource, camera.streamUrl);
  callbacks.get('error')(null, { fatal: true, details: 'manifestLoadError' });
  assert.equal(errors[0], 'manifestLoadError');
  harness.unmount();
  assert.equal(destroyed, true);
});

test('dashboard zero retained sources is never all-online and counts remain job-derived', async () => {
  const harness = await componentHarness('../src/pages/Dashboard/Dashboard.jsx', {
    ...common,
    'react-router-dom': { Link: 'Link' },
    '../../constants/cameras.js': cameras,
    '../../services/api.js': { getJob() {}, parseMaxFrames() {}, startDetectionJob() {} },
    '../../services/jobMonitor.js': { beginJobSubmission() {}, endJobSubmission() {}, saveJobMonitor() {}, recoverJobMonitor: async () => ({ jobs: [] }) },
    '../../hooks/useDashboardData.js': { useDashboardData: () => ({ stats: { activeCameras: 0, totalCameras: 0 }, cameras: [], incidents: [], jobs: [], reload() {} }) },
  }, { URL });
  harness.render();
  const card = harness.elements.find(n => n.type === 'StatCard' && n.props.label === 'Job Sources Pending/Running');
  assert.equal(card.props.value, '0/0');
  assert.equal(card.props.trend, 'No retained job sources');
  assert.match(card.props.description, /not cameras online or raw-stream availability/);
  assert.doesNotMatch(JSON.stringify(harness.elements), /All online|Cameras currently online/);
  harness.unmount();
});

test('dashboard counts a source with an older pending job even when its latest job is complete', async () => {
  const source = cameras.FIXED_CAMERA_STREAM_URLS[0];
  const harness = await componentHarness('../src/pages/Dashboard/Dashboard.jsx', {
    ...common,
    'react-router-dom': { Link: 'Link' },
    '../../constants/cameras.js': cameras,
    '../../services/api.js': { getJob() {}, parseMaxFrames() {}, startDetectionJob() {} },
    '../../services/jobMonitor.js': { beginJobSubmission() {}, endJobSubmission() {}, saveJobMonitor() {}, recoverJobMonitor: async () => ({ jobs: [] }) },
    '../../hooks/useDashboardData.js': { useDashboardData: () => ({
      stats: { activeCameras: 1, totalCameras: 1 },
      cameras: [{ id: 'source', streamUrl: source, status: 'offline' }],
      jobs: [{ id: 'older', status: 'pending', videoUrl: source }, { id: 'newer', status: 'complete', videoUrl: source }],
      incidents: [], reload() {},
    }) },
  }, { URL });
  harness.render();
  const card = harness.elements.find(n => n.type === 'StatCard' && n.props.label === 'Job Sources Pending/Running');
  assert.equal(card.props.value, '1/1');
  assert.match(card.props.description, /any retained pending\/running job/);
  assert.match(card.props.description, /even if a newer job completed/);
  assert.doesNotMatch(card.props.description, /pending\/running latest jobs/);
  harness.unmount();
});
