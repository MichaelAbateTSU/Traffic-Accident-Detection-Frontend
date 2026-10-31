import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import CameraCard from '../src/components/CameraCard/CameraCard.jsx';
import CameraView from '../src/pages/CameraView/CameraView.jsx';
import CameraPlayer from '../src/components/CameraPlayer/CameraPlayer.jsx';
import CameraPreviewCard from '../src/components/CameraPreviewCard/CameraPreviewCard.jsx';
import LiveFeed from '../src/pages/LiveFeed/LiveFeed.jsx';
import StatusBadge from '../src/components/StatusBadge/StatusBadge.jsx';

const pause = () => new Promise(resolve => setTimeout(resolve, 30));
const check = (value, message) => { if (!value) throw new Error(message); };
HTMLMediaElement.prototype.canPlayType = () => '';
HTMLMediaElement.prototype.pause = () => {};
HTMLMediaElement.prototype.load = () => {};
HTMLMediaElement.prototype.play = () => Promise.resolve();
window.hlsSupported = false;
window.observers = [];
window.refreshCallbacks = new Map();
const originalInterval = window.setInterval.bind(window);
const originalClearInterval = window.clearInterval.bind(window);
window.setInterval = (callback, delay) => {
  const id = originalInterval(callback, delay);
  window.refreshCallbacks.set(id, callback);
  return id;
};
window.clearInterval = id => { window.refreshCallbacks.delete(id); originalClearInterval(id); };
window.IntersectionObserver = class {
  constructor(callback) { this.callback = callback; window.observers.push(this); }
  observe() { this.callback([{ isIntersecting: true }]); }
  disconnect() {}
};
const container = document.getElementById('root');
let root;
const render = async node => {
  if (!root) root = createRoot(container);
  root.render(node);
  await pause();
  await pause();
};
const unmount = () => { root.unmount(); root = null; };
const card = source => <MemoryRouter><CameraCard camera={{ id: 'camera', streamUrl: source, status: 'offline' }} /></MemoryRouter>;
function RoutedView({ source }) {
  const navigate = useNavigate();
  React.useEffect(() => {
    navigate('/camera/camera', { state: { id: 'camera', streamUrl: source } });
  }, [navigate, source]);
  return <CameraView />;
}
const view = source => <MemoryRouter initialEntries={[{ pathname: '/camera/camera', state: { id: 'camera', streamUrl: source } }]}><RoutedView source={source} /></MemoryRouter>;
try {
  await render(view('https://fixture.invalid/one.m3u8'));
  check(container.textContent.includes('HLS is not supported in this browser.'), 'mounted CameraView erased synchronous unsupported error');
  check(!container.textContent.includes('Initializing stream'), 'unsupported view remained loading');
  const viewBadge = [...container.querySelectorAll('span')].find(n => n.textContent === 'Job state unknown');
  check(viewBadge && /idle/.test(viewBadge.className), 'unknown full-view badge not neutral');
  unmount();
  await render(card('https://fixture.invalid/one.m3u8'));
  check(container.textContent.includes('HLS is not supported in this browser.'), 'mounted CameraCard erased synchronous unsupported error');
  await render(card('https://fixture.invalid/two.m3u8'));
  check(container.textContent.includes('HLS is not supported in this browser.'), 'source change erased unsupported error');
  window.observers.at(-1).callback([{ isIntersecting: false }]);
  await pause();
  check(!container.querySelector('[role="alert"]'), 'deactivated card retained old playback error');
  window.hlsSupported = true;
  window.observers.at(-1).callback([{ isIntersecting: true }]);
  await pause();
  check(container.textContent.includes('Loading live preview'), 'reactivated card erased loading');
  check(!container.querySelector('[role="alert"]'), 'reactivated card retained stale error');
  unmount();
  window.cameraStatus = { id: 'camera', status: 'offline', streamUrl: 'https://fixture.invalid/recording.mp4' };
  await render(view('https://fixture.invalid/three.m3u8'));
  check(container.textContent.includes('Initializing stream'), 'mounted CameraView erased initial loading');
  const completedViewBadge = [...container.querySelectorAll('span')].find(n => n.textContent === 'Job complete');
  check(completedViewBadge && /idle/.test(completedViewBadge.className), 'completed full-view badge not neutral');
  check(window.players.at(-1).source === 'https://fixture.invalid/three.m3u8', 'job recording replaced configured raw stream');
  for (const callback of window.refreshCallbacks.values()) callback();
  await pause();
  check(window.players.at(-1).source === 'https://fixture.invalid/three.m3u8', 'later status refresh replaced configured stream');
  const player = window.players.at(-1);
  player.error('fixture decode failure');
  await pause();
  check(container.textContent.includes('fixture decode failure'), 'async player failure missing');
  await render(view('https://fixture.invalid/four.m3u8'));
  check(container.textContent.includes('Initializing stream'), 'full-view source change erased loading');
  check(!container.textContent.includes('fixture decode failure'), 'full-view source change retained old error');
  check(window.players.at(-1).source === 'https://fixture.invalid/four.m3u8', 'legitimate route replacement did not update raw stream');
  for (const callback of window.refreshCallbacks.values()) callback();
  await pause();
  check(window.players.at(-1).source === 'https://fixture.invalid/four.m3u8', 'status refresh overwrote replacement route stream');
  unmount();
  check(player.destroyed, 'player not destroyed on parent unmount');
  await render(view(undefined));
  check(window.players.at(-1).source === 'https://fixture.invalid/recording.mp4', 'unconfigured source could not discover job URL');
  unmount();
  const changes = [];
  const onError = value => changes.push(value);
  await render(<CameraPlayer src="https://fixture.invalid/a.m3u8" onFatalError={onError} />);
  const prior = window.players.at(-1);
  prior.error('old error');
  await render(<CameraPlayer src="https://fixture.invalid/b.m3u8" onFatalError={onError} />);
  check(changes.at(-1) === '', 'new source did not reset error');
  prior.error('late old error');
  check(changes.at(-1) === '', 'destroyed source delivered stale error');
  await render(<CameraPlayer src="https://fixture.invalid/b.m3u8" active={false} onFatalError={onError} />);
  check(window.players.at(-1).destroyed, 'deactivation did not destroy player');
  check(changes.at(-1) === '', 'deactivation retained playback error');
  unmount();
  for (const status of ['unknown', 'offline']) {
    await render(<MemoryRouter><CameraPreviewCard camera={{ id: 'no-stream', status }} /></MemoryRouter>);
    const previewBadge = [...container.querySelectorAll('span')].find(n => n.textContent === (status === 'offline' ? 'Job complete' : 'Job state unknown'));
    check(previewBadge && /idle/.test(previewBadge.className) && !/offline/.test(previewBadge.className), `${status} dashboard camera badge not neutral`);
    unmount();
    await render(<MemoryRouter><CameraCard camera={{ id: 'no-stream', status }} /></MemoryRouter>);
    const badge = [...container.querySelectorAll('span')].find(n => n.textContent === (status === 'offline' ? 'Job complete' : 'Job state unknown'));
    check(badge && /idle|neutral/.test(badge.className) && !/offline/.test(badge.className), `${status} camera badge not neutral`);
    unmount();
  }
  await render(<StatusBadge status="offline" />);
  check(/offline/.test(container.firstElementChild.className), 'shared offline meaning changed');
  unmount();
  const { FIXED_CAMERA_STREAM_URLS, getCameraIdFromStreamUrl } = await import('../src/constants/cameras.js');
  window.cameraStatus = { id: getCameraIdFromStreamUrl(FIXED_CAMERA_STREAM_URLS[0]), status: 'offline' };
  document.documentElement.style.setProperty('--color-text-secondary', 'rgb(139, 154, 180)');
  await render(<MemoryRouter><LiveFeed /></MemoryRouter>);
  const completeDot = container.querySelector('[data-status="complete"]');
  check(completeDot && getComputedStyle(completeDot).backgroundColor === 'rgb(139, 154, 180)', 'completed source summary dot not neutral');
  check(!container.querySelector('[data-status="offline"]'), 'completed source summary retained red offline variant');
  unmount();
  document.body.dataset.result = 'passed';
} catch (error) {
  document.body.dataset.result = 'failed';
  document.body.dataset.failure = error.message;
  root?.unmount();
}
