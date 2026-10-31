import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { createSubmissionJournal, hasUncertainSubmissions } from '../src/services/submissionJournal.js';
import * as journalServices from '../src/services/submissionJournal.js';

const BACKEND_SHA = 'ffc6990d7aa2ecd3c5e93caa0b45d414cb2af90b';

async function boundaryApi(baseUrl, transport) {
  const context = createContext({ URL, URLSearchParams, Blob, fetch: transport });
  const source = await readFile(new URL('../src/services/api.js', import.meta.url), 'utf8');
  const config = await readFile(new URL('../src/config.js', import.meta.url), 'utf8');
  const module = new SourceTextModule(source, {
    context, initializeImportMeta(meta) { meta.env = { VITE_API_BASE_URL: baseUrl }; },
  });
  await module.link(() => new SourceTextModule(config, { context }));
  await module.evaluate();
  return module.namespace;
}

async function boundaryMonitor(api, storage) {
  const context = createContext({
    URL, AbortController, DOMException, setTimeout, clearTimeout,
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
  });
  const source = await readFile(new URL('../src/services/jobMonitor.js', import.meta.url), 'utf8');
  const module = new SourceTextModule(source, { context });
  await module.link((specifier) => {
    const exports = specifier === './api.js' ? api : journalServices;
    return new SyntheticModule(Object.keys(exports), function () {
      for (const name of Object.keys(exports)) this.setExport(name, exports[name]);
    }, { context });
  });
  await module.evaluate();
  return module.namespace;
}

test('frontend receipt/privacy contract against pinned backend HTTP, auth and SQLite (fake queue, no inference)', async (t) => {
  const root = process.env.TAD_BACKEND_CONTRACT_ROOT;
  const python = process.env.TAD_BOUNDARY_PYTHON;
  if (!root || !python) {
    t.skip('Set TAD_BACKEND_CONTRACT_ROOT and TAD_BOUNDARY_PYTHON for pinned backend HTTP verification.');
    return;
  }
  const { stdout } = await promisify(execFile)('git', ['-C', root, 'rev-parse', 'HEAD']);
  assert.equal(stdout.trim(), BACKEND_SHA, 'Backend HTTP test must use the independently reviewed revision.');
  const profile = await mkdtemp(join(tmpdir(), 'tad-keyed-boundary-'));
  const token = webcrypto.randomUUID();
  let child;
  let stderr = '';
  try {
    child = spawn(python, [new URL('./keyed-backend-boundary.py', import.meta.url).pathname, join(profile, 'jobs.sqlite')], {
      cwd: profile,
      env: { ...process.env, PYTHONPATH: root, API_TOKEN: token, ENVIRONMENT: 'development', JOB_DATABASE_PATH: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Pinned backend fixture did not start.')), 15000);
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk;
        const line = output.split('\n')[0];
        if (!output.includes('\n')) return;
        clearTimeout(timer);
        try { resolve(JSON.parse(line).port); } catch (error) { reject(error); }
      });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`Backend fixture exited before readiness: ${stderr}`)); });
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
    const base = `http://127.0.0.1:${port}`;
    const auth = { Authorization: `Bearer ${token}` };
    let ready = false;
    for (let attempt = 0; !ready && attempt < 100; attempt++) {
      try { ready = (await fetch(`${base}/__fixture/count`, { headers: auth })).ok; } catch (error) {
        if (attempt === 99) throw error;
      }
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(ready, 'Backend fixture must be responsive.');
    const storage = new Map();
    const journal = createSubmissionJournal({
      backend: `${base}/api`, cryptography: () => webcrypto,
      storage: () => ({ getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }),
    });
    const source = 'https://fixture.invalid/video.mp4?signature=synthetic-private-query';
    const payload = { stream_url: source, max_frames: 120, save_frames: false };
    const batch = await journal.prepareBatch([source], { maxFrames: 120, saveFrames: false, sourceKind: 'arbitrary', protocol: 'keyed-v1' });
    const key = batch.entries[0].key;
    journal.markSending(key);
    let dropResponse = true;
    const requests = [];
    const api = await boundaryApi(`${base}/api`, async (url, options) => {
      requests.push({ url, method: options.method, key: options.headers['Idempotency-Key'] });
      const response = await fetch(url, options);
      if (dropResponse && options.method === 'POST') {
        dropResponse = false;
        assert.equal(response.status, 202);
        await response.arrayBuffer();
        throw new TypeError('Synthetic lost acceptance response');
      }
      return response;
    });
    api.setOperatorToken(token);
    await assert.rejects(api.submitDetection(payload, { key }), /lost acceptance/);
    assert.equal(hasUncertainSubmissions(journal.read()), true);
    const reloadedApi = await boundaryApi(`${base}/api`, fetch);
    reloadedApi.setOperatorToken(token);
    const reloadedJournal = createSubmissionJournal({
      backend: `${base}/api`, cryptography: () => webcrypto,
      storage: () => ({ getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }),
    });
    const monitor = await boundaryMonitor(reloadedApi, storage);
    const progress = [];
    monitor.beginJobSubmission({ keyed: true });
    const recovery = await monitor.recoverJobMonitor({
      journal: reloadedJournal, onJobs: ({ jobs }) => progress.push(...jobs),
    });
    monitor.endJobSubmission();
    const recoveredId = reloadedJournal.read().batches[0].entries[0].jobId;
    assert.equal(recovery.jobs.find((item) => item.id === recoveredId).status, 'complete');
    assert.ok(progress.some((item) => item.id === recoveredId && item.status === 'complete'));
    assert.equal(hasUncertainSubmissions(reloadedJournal.read()), false);
    monitor.saveJobMonitor(recovery.jobs.map((item) => item.id), recovery.warning, reloadedJournal.backendIdentity);
    const originalJob = await reloadedApi.getJob(recoveredId);
    assert.equal(originalJob.item.maxFrames, 120);
    assert.equal(originalJob.item.framesProcessed, 120);
    const replay = await reloadedApi.submitDetection(payload, { key });
    assert.equal(replay.item.id, recoveredId);
    assert.equal(replay.replayed, true);
    await assert.rejects(reloadedApi.submitDetection({ ...payload, max_frames: 121 }, { key }),
      (error) => error.status === 409 && error.code === 'idempotency_key_conflict');
    const fresh = `v1.${Math.floor(Date.now() / 1000)}.${webcrypto.randomUUID()}`;
    await assert.rejects(reloadedApi.getSubmission(fresh),
      (error) => error.status === 404 && error.code === 'idempotency_key_unknown');
    const expired = `v1.${Math.floor(Date.now() / 1000) - 86401}.${webcrypto.randomUUID()}`;
    await assert.rejects(reloadedApi.getSubmission(expired),
      (error) => error.status === 410 && error.code === 'idempotency_key_expired');
    const failedPayload = { ...payload, stream_url: 'https://fixture.invalid/admission-failure.mp4' };
    const failedBatch = await journal.prepareBatch([failedPayload.stream_url], {
      maxFrames: 120, saveFrames: false, sourceKind: 'arbitrary', protocol: 'keyed-v1',
    });
    const failedKey = failedBatch.entries[0].key;
    journal.markSending(failedKey);
    const failed = await reloadedApi.submitDetection(failedPayload, { key: failedKey });
    assert.equal(failed.item.status, 'failed');
    assert.equal(failed.admissionFailed, true);
    journal.accept(failedKey, failed.item.id);
    const reconciledFailed = await reloadedApi.submitDetection(failedPayload, { key: failedKey });
    assert.equal(reconciledFailed.item.id, failed.item.id);
    assert.equal(reconciledFailed.item.status, 'failed');
    const raceBatch = await journal.prepareBatch([source], { maxFrames: 120, saveFrames: false, sourceKind: 'arbitrary', protocol: 'keyed-v1' });
    const raceKey = raceBatch.entries[0].key;
    journal.markSending(raceKey);
    await assert.rejects(reloadedApi.getSubmission(raceKey), (error) => error.code === 'idempotency_key_unknown');
    journal.recordLookup(raceKey, 'not-recorded');
    const exactReplay = await journal.verifyReplay(raceKey, payload);
    journal.markReplaySending(raceKey);
    const raced = await Promise.all([
      reloadedApi.submitDetection(exactReplay.payload, { key: exactReplay.key }),
      reloadedApi.submitDetection(payload, { key: raceKey }),
    ]);
    assert.equal(raced[0].item.id, raced[1].item.id);
    assert.deepEqual(raced.map((item) => item.replayed).sort(), [false, true]);
    journal.accept(raceKey, raced[0].item.id);
    journal.accept(raceKey, raced[1].item.id);
    assert.equal((await (await fetch(`${base}/__fixture/count`, { headers: auth })).json()).count, 3,
      'Two same-key arrivals after an unknown lookup reserve just one additional job.');
    const heldPayload = { ...payload, stream_url: 'https://fixture.invalid/held-job.mp4' };
    const heldBatch = await journal.prepareBatch([heldPayload.stream_url], {
      maxFrames: 120, saveFrames: false, sourceKind: 'arbitrary', protocol: 'keyed-v1',
    });
    const heldKey = heldBatch.entries[0].key;
    journal.markSending(heldKey);
    const held = await reloadedApi.submitDetection(heldPayload, { key: heldKey });
    journal.accept(heldKey, held.item.id);
    const activeRecovery = await monitor.recoverJobMonitor({ journal: reloadedJournal });
    assert.equal(activeRecovery.jobs.find((item) => item.id === held.item.id).status, 'pending');
    assert.equal(activeRecovery.jobs.find((item) => item.id === failed.item.id).status, 'failed');
    assert.equal(activeRecovery.jobs.find((item) => item.id === recoveredId).framesProcessed, 120);
    assert.equal(activeRecovery.jobs.length, 4);
    assert.equal((await (await fetch(`${base}/__fixture/count`, { headers: auth })).json()).count, 4,
      'Restoring saved, journal and actively listed jobs never starts additional inference.');
    reloadedApi.setOperatorToken('');
    await assert.rejects(reloadedApi.getSubmission(key), (error) => error.status === 401);
    assert.equal(requests.filter((item) => item.method === 'POST').length, 1);
    assert.ok(requests.every((item) => item.url.endsWith('/detection-submissions/v1') && item.key === key));
    const persisted = [...storage.values()].join('');
    assert.ok(!persisted.includes(source));
    assert.ok(!persisted.includes('signature'));
    assert.ok(!persisted.includes(token));
    assert.equal(journal.read().batches[0].entries[0].jobId, recoveredId);
  } finally {
    if (child && child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
    await rm(profile, { recursive: true, force: true });
  }
});
