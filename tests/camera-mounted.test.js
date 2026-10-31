import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createServer } from 'vite';

test('real mounted camera parents preserve child effect errors/loading and neutral badges', async t => {
  const chrome = process.env.CHROME_PATH || '/opt/google/chrome/chrome';
  try {
    await access(chrome);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    t.skip('Chrome unavailable; set CHROME_PATH to run the mounted React browser regression');
    return;
  }
  const profile = await mkdtemp(join(tmpdir(), 'camera-mounted-'));
  const server = await createServer({
    cacheDir: join(profile, 'vite-cache'),
    server: { host: '127.0.0.1', port: 0 },
    plugins: [{
      name: 'isolated-camera-transport',
      enforce: 'pre',
      resolveId(id) {
        if (id === 'hls.js') return '\0camera-hls';
        if (id.endsWith('/services/api.js')) return '\0camera-api';
      },
      load(id) {
        if (id === '\0camera-api') return 'export async function getCameraStatus(){return {items:window.cameraStatus ? [window.cameraStatus] : []}}; export async function getCameraLatestFrame(){return {item:null}}; export async function fetchArtifactBlob(){throw new Error("unexpected image request")}';
        if (id === '\0camera-hls') return `export default class Hls {
          static Events={MANIFEST_PARSED:'manifest',LEVEL_LOADED:'level',ERROR:'error'};
          static isSupported(){return window.hlsSupported}
          constructor(){this.handlers={};(window.players ||= []).push(this)}
          on(event,callback){this.handlers[event]=callback}
          loadSource(src){this.source=src} attachMedia(){}
          error(details){this.handlers.error(null,{fatal:true,details})}
          destroy(){this.destroyed=true}
        }`;
      },
      configureServer(vite) {
        vite.middlewares.use('/__camera-mounted', async (req, res) => {
          res.setHeader('Content-Type', 'text/html');
          res.end(await vite.transformIndexHtml('/__camera-mounted', '<html><body><div id="root"></div><script type="module" src="/tests/camera-mounted-entry.jsx"></script></body></html>'));
        });
      },
    }],
  });
  try {
    await server.listen();
    const port = server.httpServer.address().port;
    const { stdout } = await promisify(execFile)(chrome, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--no-proxy-server',
      '--disable-background-networking', '--disable-breakpad', '--disable-crash-reporter',
      '--host-resolver-rules=MAP fixture.invalid ~NOTFOUND',
      `--user-data-dir=${profile}`, '--dump-dom', '--virtual-time-budget=10000',
      `http://127.0.0.1:${port}/__camera-mounted`,
    ], { timeout: 60000, maxBuffer: 1024 * 1024 });
    assert.ok(stdout.includes('data-result="passed"'), stdout.match(/data-failure="[^"]*"/)?.[0] || 'browser fixture did not finish');
  } finally {
    await server.close();
    await rm(profile, { recursive: true, force: true });
  }
});
