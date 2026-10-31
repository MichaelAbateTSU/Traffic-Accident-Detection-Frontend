import assert from 'node:assert/strict';
import test from 'node:test';
import { componentHarness, deferred } from './componentHarness.js';

test('authenticated image hides stale frames, cancels requests and revokes object URLs', async () => {
  const requests = [];
  const created = [];
  const revoked = [];
  const harness = await componentHarness('../src/components/AuthenticatedImage/AuthenticatedImage.jsx', {
    '../../services/api.js': {
      fetchArtifactBlob(src, { signal }) {
        const request = { src, signal, ...deferred() };
        requests.push(request);
        return request.promise;
      },
    },
  }, {
    URL: {
      createObjectURL(blob) { created.push(blob); return `blob:frame-${created.length}`; },
      revokeObjectURL(url) { revoked.push(url); },
    },
  });
  harness.render({ src: '/A.jpg', alt: 'A', openLink: true });
  requests[0].resolve('A');
  await harness.flush();
  assert.equal(harness.elements.find((node) => node.type === 'img').props.src, 'blob:frame-1');
  assert.equal(harness.elements.find((node) => node.type === 'a').props.href, 'blob:frame-1');
  assert.equal(harness.render({ src: '/B.jpg', alt: 'B' }).filter((node) => node.type === 'img').length, 0);
  assert.equal(requests[0].signal.aborted, true);
  assert.deepEqual(revoked, ['blob:frame-1']);
  harness.render({ src: '/C.jpg', alt: 'C' });
  requests[1].resolve('stale B');
  requests[2].resolve('C');
  await harness.flush();
  assert.deepEqual(created, ['A', 'C']);
  assert.equal(harness.elements.find((node) => node.type === 'img').props.src, 'blob:frame-2');
  harness.unmount();
  assert.equal(requests[2].signal.aborted, true);
  assert.deepEqual(revoked, ['blob:frame-1', 'blob:frame-2']);
});

test('image HTTP failures show an error and unmounted responses cannot create URLs', async () => {
  const request = deferred();
  let created = 0;
  const harness = await componentHarness('../src/components/AuthenticatedImage/AuthenticatedImage.jsx', {
    '../../services/api.js': { fetchArtifactBlob: () => request.promise },
  }, {
    URL: { createObjectURL() { created++; }, revokeObjectURL() {} },
  });
  harness.render({ src: '/A.jpg', alt: 'A' });
  request.reject(new Error('Artifact request failed (HTTP 401).'));
  await harness.flush();
  assert.match(JSON.stringify(harness.elements.find((node) => node.props.role === 'alert')), /HTTP 401/);
  harness.unmount();

  const pending = deferred();
  const unmounted = await componentHarness('../src/components/AuthenticatedImage/AuthenticatedImage.jsx', {
    '../../services/api.js': { fetchArtifactBlob: () => pending.promise },
  }, {
    URL: { createObjectURL() { created++; }, revokeObjectURL() {} },
  });
  unmounted.render({ src: '/B.jpg', alt: 'B' });
  unmounted.unmount();
  pending.resolve('B');
  await unmounted.flush();
  assert.equal(created, 0);
});

for (const failure of [false, true]) {
  test(`operator connection ${failure ? 'failure clears the token' : 'success unlocks the app'} without storing it`, async () => {
    const tokens = [];
    let authenticated = false;
    const harness = await componentHarness('../src/components/OperatorAccess/OperatorAccess.jsx', {
      '../../services/api.js': {
        setOperatorToken(token) { tokens.push(token); },
        async getCameraStatus() {
          if (failure) throw new Error('Invalid operator token');
          return { items: [] };
        },
      },
    });
    harness.render({ onAuthenticated() { authenticated = true; } });
    harness.elements.find((node) => node.type === 'input').props.onChange({ target: { value: 'operator-secret' } });
    harness.render();
    await harness.elements.find((node) => node.type === 'form').props.onSubmit({ preventDefault() {} });
    await harness.flush();
    assert.equal(authenticated, !failure);
    assert.equal(harness.elements.find((node) => node.type === 'input').props.value, '');
    assert.deepEqual(tokens, failure ? ['operator-secret', ''] : ['operator-secret']);
    if (failure) assert.match(JSON.stringify(harness.elements.find((node) => node.props.role === 'alert')), /Invalid operator token/);
    harness.unmount();
  });
}

test('production app gates access and clears the token on sign out', async () => {
  const tokens = [];
  const harness = await componentHarness('../src/App.jsx', {
    'react-router-dom': { BrowserRouter: 'BrowserRouter', HashRouter: 'HashRouter', Routes: 'Routes', Route: 'Route', Navigate: 'Navigate' },
    './services/api.js': {
      API_CONFIGURATION: { baseUrl: 'https://backend.example', error: null },
      setOperatorToken(token) { tokens.push(token); },
    },
  }, {}, { PROD: true, VITE_ROUTER_MODE: 'hash', BASE_URL: '/Traffic-Accident-Detection-Frontend/' });
  harness.render();
  assert.equal(harness.elements.filter((node) => node.type === 'HashRouter').length, 0);
  harness.elements.find((node) => node.type === 'OperatorAccess').props.onAuthenticated();
  harness.render();
  assert.equal(harness.elements.find((node) => node.type === 'HashRouter').props.basename, undefined);
  harness.elements.find((node) => node.type === 'button' && node.props.children === 'Sign out').props.onClick();
  harness.render();
  assert.deepEqual(tokens, ['']);
  assert.equal(harness.elements.filter((node) => node.type === 'HashRouter').length, 0);
  harness.unmount();
});

test('invalid deployment displays an error instead of an operator prompt or dashboard', async () => {
  const harness = await componentHarness('../src/App.jsx', {
    'react-router-dom': { BrowserRouter: 'BrowserRouter', HashRouter: 'HashRouter', Routes: 'Routes', Route: 'Route', Navigate: 'Navigate' },
    './services/api.js': {
      API_CONFIGURATION: { baseUrl: '', error: 'Configure the public HTTPS backend URL.' },
      setOperatorToken() {},
    },
  }, {}, { PROD: true });
  harness.render();
  assert.match(JSON.stringify(harness.elements.find((node) => node.props.role === 'alert')), /HTTPS/);
  assert.equal(harness.elements.filter((node) => node.type === 'OperatorAccess').length, 0);
  harness.unmount();
});
