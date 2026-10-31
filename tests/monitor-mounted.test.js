import assert from 'node:assert/strict';
import test from 'node:test';
import { constants } from 'node:fs';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

async function findChrome() {
  const candidates = process.env.CHROME_PATH ? [process.env.CHROME_PATH] : [
    '/usr/bin/google-chrome', '/opt/google/chrome/chrome',
    '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch (error) {
      if (process.env.CHROME_PATH || !['ENOENT', 'EACCES'].includes(error.code)) throw error;
    }
  }
  return null;
}

test('mounted Dashboard independently polls acceptances, recovers navigation warnings and preserves rapid updates', async (t) => {
  const chrome = await findChrome();
  if (!chrome) {
    t.skip('Chrome unavailable; set CHROME_PATH to run mounted browser regressions.');
    return;
  }
  const profile = await mkdtemp(join(tmpdir(), 'monitor-mounted-'));
  let server;
  try {
    server = await createServer({
      configFile: false,
      cacheDir: join(profile, 'vite-cache'),
      server: { host: '127.0.0.1', port: 0, hmr: false },
      plugins: [react(), {
        name: 'isolated-monitor-transport',
        enforce: 'pre',
        resolveId(id, importer) {
          if (id.endsWith('/services/api.js') || (id === './api.js' && importer?.endsWith('/services/jobMonitor.js'))) return '\0monitor-api';
          if (id.endsWith('/hooks/useDashboardData.js')) return '\0monitor-dashboard-data';
          if (id.endsWith('/constants/cameras.js')) return '\0monitor-sources';
        },
        load(id) {
          if (id === '\0monitor-sources') {
            return 'export const FIXED_CAMERA_STREAM_URLS=["https://fixture.invalid/1","https://fixture.invalid/2","https://fixture.invalid/3","https://fixture.invalid/4"];';
          }
          if (id === '\0monitor-dashboard-data') {
            return 'export function useDashboardData(){return {stats:null,incidents:[],cameras:[],jobs:[],reload(){}}}';
          }
          if (id === '\0monitor-api') return `
            export const API_CONFIGURATION={baseUrl:'https://fixture.invalid/api'};
            export function parseMaxFrames(n){return Number(n)}
            export async function getJobs(){return {items:[]}}
            export async function fetchArtifactBlob(){throw new Error('Unexpected image request')}
            export async function updateIncidentStatus(){throw new Error('Unexpected incident action')}
            export async function getJob(id,{signal}={}) {
              window.readCounts[id]=(window.readCounts[id]||0)+1;
              if(window.monitorMode==='rapid') {
                await new Promise(resolve=>setTimeout(resolve,0));
                return {item:{id,status:'complete',framesProcessed:17}};
              }
              if(window.monitorMode==='recovery') return {item:{id,status:'complete',framesProcessed:17}};
              if(id==='A') return new Promise(resolve=>{window.aRead={signal,resolve}});
              return {item:{id,status:'complete',framesProcessed:17}};
            }
            export async function startDetectionJob(){
              const n=++window.postCount;
              if(window.monitorMode==='rapid') {
                await Promise.resolve();
                return {item:{id:'rapid-'+n,status:'pending'}};
              }
              if(n===1) return {item:{id:'A',status:'pending'}};
              if(n===2) return new Promise(resolve=>{window.releaseSecond=resolve});
              if(n===3) return new Promise(resolve=>{window.releaseThird=resolve});
              throw new Error('Unexpected fourth submission');
            }`;
        },
        configureServer(vite) {
          vite.middlewares.use('/__monitor-mounted', async (req, res, next) => {
            try {
              // Only local test modules may load; no camera, media, or backend access.
              res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'none'; media-src 'none'");
              res.setHeader('Content-Type', 'text/html');
              res.end(await vite.transformIndexHtml('/__monitor-mounted',
                '<html><body><div id="root"></div><script>window.addEventListener("error",e=>{document.body.dataset.failure=e.message});window.addEventListener("unhandledrejection",e=>{document.body.dataset.failure=String(e.reason)})</script><script type="module" src="/tests/monitor-mounted-entry.jsx"></script></body></html>'));
            } catch (error) {
              next(error);
            }
          });
        },
      }],
    });
    await server.listen();
    const { port } = server.httpServer.address();
    const { stdout } = await promisify(execFile)(chrome, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--no-proxy-server',
      '--disable-background-networking', '--disable-breakpad', '--disable-crash-reporter',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
      `--user-data-dir=${profile}`, '--dump-dom', '--virtual-time-budget=15000',
      `http://127.0.0.1:${port}/__monitor-mounted`,
    ], { timeout: 60000, maxBuffer: 1024 * 1024 });
    const failure = stdout.match(/data-failure="[^"]*"/)?.[0];
    assert.ok(!failure, failure);
    assert.ok(stdout.includes('data-result="passed"'), 'Mounted browser scenarios did not finish.');
    assert.ok(stdout.includes('data-transport="mocked"'));
  } finally {
    try {
      await server?.close();
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  }
});
