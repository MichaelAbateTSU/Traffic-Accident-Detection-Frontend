import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

test('mounted recovery prioritizes key lookup and listings over held HTTP/1.1 historic connections', async (t) => {
  const chrome = process.env.CHROME_PATH || '/usr/bin/google-chrome';
  try { await access(chrome, constants.X_OK); } catch (error) {
    if (!process.env.CHROME_PATH && error.code === 'ENOENT') return t.skip('Chrome unavailable');
    throw error;
  }
  const profile = await mkdtemp(join(tmpdir(), 'recovery-pressure-'));
  const held = new Set();
  const timers = new Set();
  let released = false;
  let peakHistorical = 0;
  let peakTerminal = 0;
  let receipts = 0;
  let server;
  try {
    server = await createServer({
      configFile: false, cacheDir: join(profile, 'vite-cache'),
      server: { host: '127.0.0.1', port: 0, hmr: false },
      plugins: [react(), {
        name: 'real-http-pressure', enforce: 'pre',
        resolveId(id, importer) {
          if (id.endsWith('/services/api.js') || (id === './api.js' && importer?.includes('/services/'))) return '\0pressure-api';
          if (id.endsWith('/hooks/useDashboardData.js')) return '\0pressure-data';
        },
        load(id) {
          if (id === '\0pressure-data') return 'export function useDashboardData(){return {incidents:[],cameras:[],jobs:[],reload(){}}}';
          if (id === '\0pressure-api') return `
            export const API_CONFIGURATION={baseUrl:location.origin+'/__pressure'};
            export function parseMaxFrames(n){return Number(n)}
            async function read(path,signal) {return (await fetch('/__pressure'+path,{signal,cache:'no-store'})).json()}
            export async function getJob(id,{signal}={}) {
              const result=await read('/jobs/'+id,signal);
              if(id==='new-active') window.pressureNewActive=result.item.status;
              return result;
            }
            export async function getJobs(query,{signal}={}) {
              const data=await read('/listing?status='+query.status,signal);
              (window.pressureListings ||= []).push(data.beforeRelease);return data;
            }
            export async function getSubmission(key,{signal}={}) {
              const data=await read('/receipt',signal);window.pressureCritical=data;
              window.pressureReceiptCount=(window.pressureReceiptCount||0)+1;
              return {item:{id:data.id,status:data.status}};
            }
            export async function submitDetection(){throw new Error('Unexpected inference POST')}
            export async function fetchArtifactBlob(){throw new Error('Unexpected artifact')}
            export async function updateIncidentStatus(){throw new Error('Unexpected mutation')}
          `;
        },
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (req.url.startsWith('/__pressure/')) {
              res.setHeader('Content-Type', 'application/json');
              if (req.url.includes('/jobs/historic-') || req.url.includes('/jobs/accepted-')) {
                held.add(res);
                res.history = req.url.includes('/jobs/historic-');
                peakHistorical = Math.max(peakHistorical, [...held].filter((response) => response.history).length);
                peakTerminal = Math.max(peakTerminal, [...held].filter((response) => !response.history).length);
                const timer = setTimeout(() => {
                  timers.delete(timer); released = true; held.delete(res);
                  res.end(JSON.stringify({ item: { id: req.url.split('/').pop(), status: 'complete' } }));
                }, 2000);
                timers.add(timer);
                res.on('close', () => { clearTimeout(timer); timers.delete(timer); held.delete(res); });
              } else if (req.url.includes('/receipt')) {
                const n = ++receipts;
                const send = () => res.end(JSON.stringify({ beforeRelease: !released, id: n === 8 ? 'new-active' : `accepted-${n}`, status: n === 8 ? 'pending' : 'complete' }));
                if (n === 8) {
                  const timer = setTimeout(() => { timers.delete(timer); send(); }, 100);
                  timers.add(timer);
                } else send();
              }
              else if (req.url.includes('/listing')) res.end(JSON.stringify({ beforeRelease: !released, items: [{ id: 'active', status: 'running' }], meta: { pagination: { has_next: false } } }));
              else res.end(JSON.stringify({ item: { id: req.url.split('/').pop(), status: 'complete', framesProcessed: 120 } }));
              return;
            }
            if (req.url !== '/__recovery-pressure') return next();
            try {
              res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'none'; media-src 'none'");
              res.setHeader('Content-Type', 'text/html');
              res.end(await vite.transformIndexHtml('/__recovery-pressure', '<html><body><div id="root"></div><script type="module" src="/tests/recovery-pressure-entry.jsx"></script></body></html>'));
            } catch (error) { next(error); }
          });
        },
      }],
    });
    await server.listen();
    const { stdout } = await promisify(execFile)(chrome, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--no-proxy-server',
      '--disable-background-networking', '--disable-breakpad', '--disable-crash-reporter',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
      `--user-data-dir=${profile}`, '--dump-dom', '--virtual-time-budget=15000',
      `http://127.0.0.1:${server.httpServer.address().port}/__recovery-pressure`,
    ], { timeout: 60000, maxBuffer: 1024 * 1024 });
    assert.ok(!stdout.includes('data-failure='), stdout.match(/data-failure="[^"]*"/)?.[0]);
    assert.ok(stdout.includes('data-result="passed"'), 'Mounted pressure scenario did not finish');
    assert.ok(stdout.includes('data-critical-before-release="true"'), 'Critical recovery must finish before held history releases browser connections');
    assert.ok(peakHistorical <= 2, `Historical HTTP concurrency exceeded two: ${peakHistorical}`);
    assert.ok(peakTerminal <= 2, `Terminal HTTP concurrency exceeded two: ${peakTerminal}`);
  } finally {
    for (const timer of timers) clearTimeout(timer);
    for (const response of held) response.destroy();
    await server?.close();
    await rm(profile, { recursive: true, force: true });
  }
});
