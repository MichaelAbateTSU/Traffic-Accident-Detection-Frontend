import assert from 'node:assert/strict';
import test from 'node:test';
import { componentHarness } from './componentHarness.js';

const frames = Array.from({ length: 300 }, (_, frameIndex) => ({
  frameIndex, capture: `/original/${frameIndex}`, captureAnnotated: `/annotated/${frameIndex}`, pipelineOutput: `/pipeline/${frameIndex}`,
}));

test('300 saved frames render only nine images per page while keeping all 900 artifacts accessible', async () => {
  const harness = await componentHarness('../src/components/FrameGallery/FrameGallery.jsx');
  const seen = new Set();
  for (let page = 0; page < 100; page++) {
    harness.render({ frames, jobId: 'job-1' });
    if (page) {
      harness.elements.find((node) => node.type === 'select').props.onChange({ target: { value: String(page) } });
      harness.render();
    }
    const images = harness.elements.filter((node) => node.type === 'AuthenticatedImage');
    assert.equal(images.length, 9);
    for (const image of images) {
      seen.add(image.props.src);
      assert.equal(image.props.loading, 'lazy');
    }
  }
  assert.equal(seen.size, 900);
  const next = harness.elements.find((node) => node.type === 'button' && node.props.children === 'Next frames');
  assert.equal(next.props.disabled, true);
  harness.render({ frames: frames.slice(0, 5), jobId: 'job-1' });
  assert.equal(harness.elements.filter((node) => node.type === 'AuthenticatedImage').length, 6);
  harness.render({ frames, jobId: 'other' });
  assert.equal(harness.elements.find((node) => node.type === 'AuthenticatedImage').props.src, '/original/0');
  harness.unmount();
});

test('progressively appended frames remain reachable without moving the selected page', async () => {
  const harness = await componentHarness('../src/components/FrameGallery/FrameGallery.jsx');
  harness.render({ frames: frames.slice(0, 3), jobId: 'job' });
  assert.equal(harness.elements.find((node) => node.type === 'button' && node.props.children === 'Next frames').props.disabled, true);
  harness.render({ frames, jobId: 'job' });
  assert.equal(harness.elements.find((node) => node.type === 'button' && node.props.children === 'Next frames').props.disabled, false);
  assert.equal(harness.elements.find((node) => node.type === 'select').props.value, 0);
  harness.unmount();
});

test('both JobStatusCard and Dashboard route 300-frame lists through bounded gallery', async () => {
  const job = { id: 'job-1', status: 'complete', frames, events: [] };
  const card = await componentHarness('../src/components/JobStatusCard/JobStatusCard.jsx', {
    '../../utils/formatters.js': { formatDateTime: String, formatNumber: String },
  });
  card.render({ job });
  assert.equal(card.elements.filter((node) => node.type === 'FrameGallery').length, 1);
  assert.equal(card.elements.find((node) => node.type === 'FrameGallery').props.frames.length, 300);
  assert.equal(card.elements.filter((node) => node.type === 'AuthenticatedImage').length, 0);
  card.unmount();
  const dashboard = await componentHarness('../src/pages/Dashboard/Dashboard.jsx', {
    'react-router-dom': { Link: 'Link' },
    '../../constants/cameras.js': { FIXED_CAMERA_STREAM_URLS: [] },
    '../../services/api.js': { parseMaxFrames: Number, getJob() {}, startDetectionJob() {} },
    '../../services/jobMonitor.js': { beginJobSubmission() {}, endJobSubmission() {}, recoverJobMonitor: async () => ({ jobs: [job] }), saveJobMonitor() {} },
    '../../utils/formatters.js': { formatDateTime: String, formatNumber: String, formatPercent: String },
    '../../hooks/useDashboardData.js': { useDashboardData: () => ({ incidents: [], cameras: [], jobs: [], reload() {} }) },
  });
  dashboard.render();
  await dashboard.flush();
  assert.equal(dashboard.elements.find((node) => node.type === 'FrameGallery').props.frames.length, 300);
  assert.equal(dashboard.elements.filter((node) => node.type === 'AuthenticatedImage').length, 0);
  dashboard.unmount();
});

test('lazy authenticated blobs are not fetched before entering the viewport', async () => {
  let notify;
  let disconnected = 0;
  let fetches = 0;
  const harness = await componentHarness('../src/components/AuthenticatedImage/AuthenticatedImage.jsx', {
    '../../services/api.js': {
      fetchArtifactBlob: async () => { fetches++; return 'image'; },
    },
  }, {
    IntersectionObserver: class {
      constructor(callback) { notify = callback; }
      observe() {}
      disconnect() { disconnected++; }
    },
    URL: { createObjectURL: () => 'blob:image', revokeObjectURL() {} },
  });
  harness.render({ src: '/frame', loading: 'lazy', alt: 'Frame' });
  await harness.flush();
  assert.equal(fetches, 0);
  notify([{ isIntersecting: false }]);
  await harness.flush();
  assert.equal(fetches, 0);
  notify([{ isIntersecting: true }]);
  await harness.flush();
  assert.equal(fetches, 1);
  assert.equal(harness.elements.find((node) => node.type === 'img').props.src, 'blob:image');
  harness.unmount();
  assert.ok(disconnected > 0);
});
