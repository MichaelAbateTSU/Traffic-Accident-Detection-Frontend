import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createSubmissionResponseFault } from './submission_response_fault.mjs';
import { createSparseReceiptFault } from './sparse_receipt_fault.mjs';
import { createStaleJobDetailFault } from './stale_job_detail_fault.mjs';

const api = 'https://api.integration.test:8453';
const frontend = 'https://frontend.integration.test:8454';
const token = process.env.API_TOKEN;
const source = 'https://media.githubusercontent.com/media/accidentbench/accidentbench.github.io/main/assets/videos/synthetic/Town03_head-on_clear_30.mp4';
const phase = process.argv[2] || 'initial';
let stage = 'devtools', ws, serial = 0;
const pending = new Map();
const posts = [];
let exceptions = 0, externalBlocked = 0, cancelled = 0;
const interceptionFailures = [];
let send, evaluate;
let sparseFault;
let failOneLookup = false;
let fulfilledLegacyLookups = 0;
let legacyBoundary = false;
let olderDetailFault, gatedIdentity, gatedLookupId;
let olderDetailVerified = false;
function container(script) {
  return JSON.parse(execFileSync('docker', ['exec', 'r2-browser-api', 'python', '-c', script],
    { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }));
}
try {
  const targets = await (await fetch('http://127.0.0.1:9225/json/list')).json();
  ws = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  evaluate = async expression => {
    const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error('Actual browser evaluation failed');
    return response.result.value;
  };
  const request = (path, key) => evaluate(`fetch(${JSON.stringify(api + path)}, {
    headers: {Authorization:${JSON.stringify(`Bearer ${token}`)}${key ? `,'Idempotency-Key':${JSON.stringify(key)}` : ''}}
  }).then(async response => ({status:response.status,body:await response.json()}))`);
  const loss = createSubmissionResponseFault(send, async key => {
    const receipt = await request('/detection-submissions/v1', key);
    assert.equal(receipt.status, 200);
    assert.ok(receipt.body.job_id);
  });
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (!waiter) return;
      message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
    } else if (message.method === 'Fetch.requestPaused') {
      const event = message.params;
      const url = new URL(event.request.url);
      const permitted = [api, frontend].includes(url.origin);
      (async () => {
        if (!permitted) {
          externalBlocked++;
          await send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' });
          return;
        }
        if (event.request.url === `${api}/detection-submissions/v1` &&
            event.request.method === 'GET' && event.responseStatusCode == null) {
          if (gatedIdentity) {
            assert.equal(gatedLookupId, undefined);
            gatedLookupId = event.requestId;
            return;
          }
          if (legacyBoundary) {
            fulfilledLegacyLookups++;
            await send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 404,
              responseHeaders: [{ name: 'Content-Type', value: 'application/json' },
                { name: 'Access-Control-Allow-Origin', value: frontend },
                { name: 'Vary', value: 'Origin' }],
              body: Buffer.from(JSON.stringify({ detail: 'Not Found' })).toString('base64') });
            return;
          }
          if (failOneLookup) {
            failOneLookup = false;
            await send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'ConnectionClosed' });
            return;
          }
        }
        if (olderDetailFault && await olderDetailFault.paused(event)) return;
        if (sparseFault && await sparseFault.paused(event)) return;
        if (phase === 'initial' && await loss.paused(event)) return;
        await send(event.responseStatusCode == null ? 'Fetch.continueRequest' : 'Fetch.continueResponse',
          { requestId: event.requestId });
      })().catch(error => {
        if (error.message.includes('Invalid InterceptionId')) cancelled++;
        else interceptionFailures.push(error.name);
      });
    } else if (message.method === 'Runtime.exceptionThrown') {
      exceptions++;
    } else if (message.method === 'Network.requestWillBeSent') {
      const r = message.params.request;
      if (r.url === `${api}/detection-submissions/v1` && r.method === 'POST') {
        const headers = Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k.toLowerCase(), v]));
        assert.equal(headers.authorization, `Bearer ${token}`);
        assert.deepEqual(JSON.parse(r.postData), { stream_url: source, max_frames: 12, save_frames: true });
        posts.push({ key: headers['idempotency-key'], body: JSON.parse(r.postData) });
      }
    }
  };
  async function wait(expression, timeout = 30000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const result = await evaluate(expression);
      if (result) return result;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Bounded mounted browser wait failed');
  }
  async function fill(selector, value) {
    await evaluate(`(() => {
      const input=document.querySelector(${JSON.stringify(selector)});
      if(!input) throw new Error('Missing mounted input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});
      input.dispatchEvent(new Event('input',{bubbles:true}));
    })()`);
  }
  async function click(text) {
    await evaluate(`(() => {
      const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});
      if(!button||button.disabled) throw new Error('Mounted button unavailable');
      button.click();
    })()`);
  }
  async function navigateAwayAndBack() {
    await evaluate(`document.querySelector('a[href="/incidents"]').click()`);
    await wait('location.pathname==="/incidents"');
    await evaluate(`document.querySelector('a[href="/"]').click()`);
    await wait('location.pathname==="/" && Boolean(document.querySelector("#videoSource"))');
  }
  const journalExpression = `JSON.parse(localStorage.getItem(${JSON.stringify(`tad_submissions:v1:${api}`)})||'{"batches":[]}')`;
  const cardExpression = id => `([...document.querySelectorAll('article')].find(n=>n.textContent.includes(${JSON.stringify(`Job ID: ${id}`)})))`;
  async function seedUncertainIdentity(key, jobId, retainSavedId = true) {
    await evaluate(`(() => {
      const journal=${journalExpression};
      const entry=journal.batches.flatMap(b=>b.entries)[0];
      entry.key=${JSON.stringify(key)};entry.state="uncertain";entry.jobId=null;
      localStorage.setItem(${JSON.stringify(`tad_submissions:v1:${api}`)},JSON.stringify(journal));
      localStorage.setItem(${JSON.stringify(`tad_monitor:${api}`)},JSON.stringify({
        ids:${JSON.stringify(retainSavedId ? [jobId] : [])},warning:null}));
    })()`);
  }
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const original=window.fetch;
    window.submissionTransportObservation={statuses:[],rejections:0};
    window.fetch=async function(input,options) {
      const submission=String(input).endsWith('/detection-submissions/v1')&&options?.method==='POST';
      try {
        const response=await original.apply(this,arguments);
        if(submission)window.submissionTransportObservation.statuses.push(response.status);
        return response;
      } catch(error) {
        if(submission)window.submissionTransportObservation.rejections++;
        throw error;
      }
    };
  })()` });
  await send('Fetch.enable', { patterns: [{ urlPattern: 'http*', requestStage: 'Request' }] });
  if (phase === 'admission') await evaluate('localStorage.clear()');
  await send('Page.navigate', { url: frontend });
  await wait('Boolean(document.querySelector("#operator-token"))');
  if (phase === 'initial') {
    await fill('#operator-token', 'bad-test-token');
    await click('Connect');
    await wait('document.body.textContent.includes("Cannot connect as operator")');
  }
  await fill('#operator-token', token);
  await click('Connect');
  await wait('Boolean(document.querySelector("#videoSource")) && [...document.querySelectorAll("button")].some(b=>b.textContent.trim()==="Run single video"&&!b.disabled)');
  if (phase !== 'recovery') {
    stage = 'mounted_keyed_submission';
    await fill('#maxFrames', '12');
    await fill('#videoSource', source);
    await evaluate(`(() => {const input=[...document.querySelectorAll('label')].find(l=>l.textContent.includes('Save frames')).querySelector('input'); if(!input.checked)input.click()})()`);
    await click('Run single video');
    await wait(`${journalExpression}.batches.some(b=>b.entries.some(e=>e.state==="uncertain"||e.state==="accepted"))`);
    if (phase === 'initial') {
      await wait('document.body.textContent.includes("acceptance") || document.body.textContent.includes("unknown")');
      const observationDeadline = Date.now() + 10000;
      while (loss.counts.admittedResponsesDropped === 0 && Date.now() < observationDeadline) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      await wait('window.submissionTransportObservation.rejections===1');
      assert.deepEqual(await evaluate('window.submissionTransportObservation.statuses'), []);
      stage = 'genuine_older_detail_interleaving';
      const originalKey = posts[0].key;
      const originalReceipt = await request('/detection-submissions/v1', originalKey);
      assert.equal(originalReceipt.status, 200);
      const originalId = originalReceipt.body.job_id;
      await seedUncertainIdentity(originalKey, originalId);
      olderDetailFault = createStaleJobDetailFault(send, api, originalId);
      gatedIdentity = originalKey;
      await navigateAwayAndBack();
      const captureDeadline = Date.now() + 10000;
      while ((!olderDetailFault.held || !gatedLookupId) && Date.now() < captureDeadline) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.equal(olderDetailFault.held, true, 'Actual active detail could not be captured in time');
      assert.ok(gatedLookupId);
      container("from pathlib import Path; Path('/tmp/synthetic-detail-gate-release').touch(); print('{}')");
      const completeDeadline = Date.now() + 12000;
      let genuineComplete = false;
      while (Date.now() < completeDeadline) {
        const durable = container(`import sqlite3,json; c=sqlite3.connect('/data/jobs.sqlite3'); print(c.execute('SELECT payload FROM jobs WHERE id=?',(${JSON.stringify(originalId)},)).fetchone()[0])`);
        if (durable.status === 'complete') { genuineComplete = true; break; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.equal(genuineComplete, true, 'Genuine inference exceeded bounded detail interleaving');
      gatedIdentity = undefined;
      await send('Fetch.continueRequest', { requestId: gatedLookupId });
      await wait(`${cardExpression(originalId)}?.textContent.includes("Status: done")`, 5000);
      await evaluate(`(() => {
        window.terminalRegressions=[];
        const inspect=()=> {
          const card=${cardExpression(originalId)};
          if(card && /Status:\\s*(pending|in-progress)/.test(card.textContent))window.terminalRegressions.push('active');
        };
        window.terminalObserver=new MutationObserver(inspect);
        window.terminalObserver.observe(document.body,{subtree:true,childList:true,characterData:true});
        inspect();
      })()`);
      await olderDetailFault.release();
      await olderDetailFault.cleanup();
      olderDetailFault = undefined;
      await wait(`${cardExpression(originalId)}?.textContent.includes("Frames processed: 12") || [...document.querySelectorAll('[role="alert"]')].some(n=>n.textContent.includes("older active")&&n.textContent.includes("Retry"))`);
      await new Promise(resolve => setTimeout(resolve, 500));
      assert.deepEqual(await evaluate('window.terminalRegressions'), []);
      await evaluate('window.terminalObserver.disconnect()');
      if (!await evaluate(`${cardExpression(originalId)}.textContent.includes("Frames processed: 12")`)) {
        await click('Retry job result recovery (read only)');
        await wait(`${cardExpression(originalId)}?.textContent.includes("Frames processed: 12")`);
      }
      assert.equal(posts.length, 1);
      olderDetailVerified = true;
    }
  }
  const entry = await wait(`${journalExpression}.batches.flatMap(b=>b.entries)[0]`);
  const receipt = await request('/detection-submissions/v1', entry.key);
  assert.equal(receipt.status, 200);
  const id = receipt.body.job_id;
  if (phase === 'admission') {
    stage = 'admission_real_sqlite_lock';
    const fault = container("import json; from pathlib import Path; print(Path('/tmp/synthetic-admission-fault/state.json').read_text())");
    assert.equal(fault.job_id, id);
    assert.equal(fault.writer_locked, true);
    assert.equal(receipt.body.status, 'pending');
    const persisted = container(`import sqlite3,json; c=sqlite3.connect('/data/jobs.sqlite3'); print(c.execute('SELECT payload FROM jobs WHERE id=?',(${JSON.stringify(id)},)).fetchone()[0])`);
    assert.equal(persisted.status, 'pending');
    await wait(`${cardExpression(id)} && !${cardExpression(id)}.textContent.includes("Status: failed")`);
    await navigateAwayAndBack();
    await wait(`${cardExpression(id)} && !${cardExpression(id)}.textContent.includes("Status: failed")`);
    assert.equal(posts.length, 1);
    await wait('window.submissionTransportObservation.statuses.includes(503)');
    const transport = await evaluate('window.submissionTransportObservation.statuses');
    assert.deepEqual(transport, [503]);
    container("import json; from pathlib import Path; Path('/tmp/synthetic-admission-fault/release').touch(); print('{}')");
    await wait(`${cardExpression(id)}?.textContent.includes("Status: failed")`, 70000);
    const terminal = await request('/detection-submissions/v1', entry.key);
    assert.equal(terminal.body.job_id, id);
    assert.equal(terminal.body.status, 'failed');
    const durable = container(`import sqlite3,json; c=sqlite3.connect('/data/jobs.sqlite3'); print(c.execute('SELECT payload FROM jobs WHERE id=?',(${JSON.stringify(id)},)).fetchone()[0])`);
    assert.equal(durable.status, 'failed');
    assert.equal(posts.length, 1);
    const counts = container("from pathlib import Path; print(Path('/data/inference-counts.json').read_text())");
    assert.equal(counts.yolo_calls, 12);
    console.log(JSON.stringify({ status: 'passed', phase, originalPendingDurable: true,
      navigationPreservedIdentity: true, normalPeriodicFailureRecovery: true,
      browserPosts: posts.length, additionalInference: 0, exceptions, externalBlocked }));
  } else {
    stage = 'real_terminal_full_result';
    await wait(`${cardExpression(id)}?.textContent.includes("Status: done") && ${cardExpression(id)}?.textContent.includes("Frames processed: 12")`, 120000);
    const job = (await request(`/jobs/${id}`)).body;
    assert.equal(job.status, 'complete');
    assert.equal(job.frames_processed, 12);
    assert.equal(job.frames.length, 12);
    assert.ok(Number.isFinite(job.peak_confidence));
    assert.equal(job.events.length, 0);
    stage = 'mounted_zero_event_details';
    await wait(`${cardExpression(id)}.textContent.includes("Alarm frames (0)")`);
    stage = 'decoded_authenticated_gallery';
    await evaluate(`(() => {
      const title=[...document.querySelectorAll('h3')].find(h=>h.textContent.includes('Frame Images - Job'));
      if(!title)throw new Error('Mounted gallery missing');
      title.parentElement.scrollIntoView();
    })()`);
    await wait('document.querySelectorAll("img[src^=\\"blob:\\"]").length>=9 && [...document.querySelectorAll("img[src^=\\"blob:\\"]")].every(i=>i.complete&&i.naturalWidth>0)');
    const badAuth = await evaluate(`fetch(${JSON.stringify(job.frames[0].capture)}).then(r=>r.status)`);
    assert.equal(badAuth, 401);
    const frameAuth = await evaluate(`fetch(${JSON.stringify(job.frames[0].capture)},{headers:{Authorization:${JSON.stringify(`Bearer ${token}`)}}}).then(r=>r.status)`);
    assert.equal(frameAuth, 200);
    const storage = await evaluate('JSON.stringify({...localStorage,...sessionStorage})');
    assert.equal(storage.includes(token), false);
    assert.equal(storage.includes(source), false);
    assert.equal(storage.includes('frames_processed'), false);
    if (phase === 'initial') {
      assert.equal(loss.counts.admittedResponsesDropped, 1);
      assert.equal(posts.length, 1);
      fs.writeFileSync(process.env.RESULT_FILE, JSON.stringify({ job, key: entry.key }));
    } else {
      const previous = JSON.parse(fs.readFileSync(process.env.RESULT_FILE, 'utf8'));
      assert.deepEqual(job, previous.job);
      assert.equal(entry.key, previous.key);
      assert.equal(posts.length, 0);
      stage = 'late_real_sparse_receipt_full_result';
      await seedUncertainIdentity(entry.key, id);
      sparseFault = createSparseReceiptFault(send, api, entry.key, id);
      await navigateAwayAndBack();
      await wait(`${cardExpression(id)}?.textContent.includes("Frames processed: 12")`);
      const pauseDeadline = Date.now() + 10000;
      while (!sparseFault.held && Date.now() < pauseDeadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal(sparseFault.held, true);
      await sparseFault.release();
      await sparseFault.cleanup();
      sparseFault = undefined;
      await wait(`${journalExpression}.batches.flatMap(b=>b.entries)[0].state==="accepted"`);
      assert.ok(await evaluate(`${cardExpression(id)}.textContent.includes("Frames processed: 12") && ${cardExpression(id)}.textContent.includes("Alarm frames (0)")`));
      assert.equal(posts.length, 0);
      stage = 'explicit_actual_same_key_replay';
      await seedUncertainIdentity(entry.key, id);
      failOneLookup = true;
      await navigateAwayAndBack();
      await wait('[...document.querySelectorAll("button")].some(b=>b.textContent.trim()==="Submit original request with same key"&&!b.disabled)');
      await fill(`[id=${JSON.stringify(`replay-${entry.key}`)}]`, source);
      await click('Submit original request with same key');
      await wait(`${journalExpression}.batches.flatMap(b=>b.entries)[0].state==="accepted"`);
      await wait(`${cardExpression(id)}?.textContent.includes("Frames processed: 12") && ${cardExpression(id)}?.textContent.includes("Alarm frames (0)")`);
      assert.equal(posts.length, 1);
      assert.equal(posts[0].key, entry.key);
      assert.deepEqual(posts[0].body, { stream_url: source, max_frames: 12, save_frames: true });
      assert.deepEqual((await request(`/jobs/${id}`)).body, job);
      const inference = container("from pathlib import Path; print(Path('/data/inference-counts.json').read_text())");
      for (const name of ['yolo_calls', 'tracker_calls', 'scorer_calls']) assert.equal(inference[name], 12);
      stage = 'mocked_legacy_transport_rejection';
      await seedUncertainIdentity(entry.key, id);
      legacyBoundary = true;
      await navigateAwayAndBack();
      await wait('document.body.textContent.includes("Versioned submission lookup is unavailable")');
      assert.equal(posts.length, 1);
      assert.equal(fulfilledLegacyLookups, 1);
      legacyBoundary = false;
      stage = 'real_expired_key_structured_ui';
      const expiredKey = `v1.${Math.floor(Date.now()/1000)-90000}.${crypto.randomUUID()}`;
      await seedUncertainIdentity(expiredKey, id, false);
      await navigateAwayAndBack();
      await wait('document.body.textContent.includes("identity expired; outcome unknown")');
      assert.equal(posts.length, 1);
      assert.equal(await evaluate('[...document.querySelectorAll("button")].some(b=>b.textContent.trim()==="Submit original request with same key")'), false);
    }
    const listed = (await request('/jobs')).body.data;
    assert.deepEqual(listed.map(j=>j.job_id), [id]);
    assert.deepEqual(interceptionFailures, []);
    assert.equal(exceptions, 0);
    console.log(JSON.stringify({ status: 'passed', phase, job_status: job.status,
      frames_processed: job.frames_processed, peak_heuristic: job.peak_confidence,
      event_count: job.events.length, browserPosts: posts.length,
      admissionResponsesDroppedBeforeBrowserHeaders: loss.counts.admittedResponsesDropped,
      actualOlderActiveDetailAfterTerminalReceipt: olderDetailVerified,
      savedImagesDecoded: 9, artifactNoTokenStatus: badAuth, artifactTokenStatus: frameAuth,
      recoveryStoragePrivate: true,
      ...(phase === 'recovery' ? { lateRealSparseReceiptPreservedDetails: true,
        explicitReplayPosts: 1, additionalInference: 0, mockedLegacyLookupRejection: true,
        actualBackdatedExpiredKeyRejected: true } : {}),
      exceptions, externalBlocked, cancelled }));
  }
} catch (error) {
  console.log(JSON.stringify({ status: 'failed', phase, stage, errorType: error.name,
    // Assertion messages are intentionally omitted: operands can contain keys/media URLs.
    exceptions, interceptionFailureCount: interceptionFailures.length }));
  process.exitCode = 1;
} finally {
  await sparseFault?.cleanup();
  await olderDetailFault?.cleanup();
  ws?.close();
}
