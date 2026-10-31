import assert from 'node:assert/strict';

const token = process.env.API_TOKEN;
const api = 'https://api.integration.test:8453';
const frontend = 'https://frontend.integration.test:8454';
const source = 'https://mcleansfs3.us-east-1.skyvdn.com/rtplive/R2_061/playlist.m3u8';
let stage = 'browser_start';
let posted = 0;
let artifactRequests = 0;
let errors = 0;
let job;
let framesRendered = 0;
let ws;
try {
  const targets = await (await fetch('http://127.0.0.1:9225/json/list')).json();
  const target = targets.find(t => t.type === 'page');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let serial = 0;
  const pending = new Map();
  const requestMethods = new Map();
  const authenticatedPosts = [];
  ws.onmessage = ({data}) => {
    const message = JSON.parse(data);
    if (message.id) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error('CDP command failed'));
      else waiter.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') {
      errors++;
    } else if (message.method === 'Network.requestWillBeSent') {
      const {request, requestId} = message.params;
      requestMethods.set(requestId, request.method);
      if (request.url.startsWith(api + '/artifacts/')) artifactRequests++;
      if (request.url === api + '/detect-accident' && request.method === 'POST') {
        posted++;
        const payload = JSON.parse(request.postData);
        assert.deepEqual(payload, {stream_url:source,max_frames:12,save_frames:false});
        authenticatedPosts.push(Object.entries(request.headers).some(([key,value]) => key.toLowerCase() === 'authorization' && value === `Bearer ${token}`));
      }
    }
  };
  function send(method, params = {}) {
    const id = ++serial;
    return new Promise((resolve,reject) => {
      pending.set(id,{resolve,reject});
      ws.send(JSON.stringify({id,method,params}));
    });
  }
  async function evaluate(expression) {
    const result = await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    if (result.exceptionDetails) throw new Error('Browser evaluation failed');
    return result.result.value;
  }
  async function waitFor(expression, timeout=160000) {
    const deadline = Date.now()+timeout;
    while(Date.now()<deadline) {
      const value = await evaluate(expression);
      if(value) return value;
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    throw new Error('Bounded browser wait timed out');
  }
  async function fill(selector,value) {
    await evaluate(`(() => {
      const input=document.querySelector(${JSON.stringify(selector)});
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});
      input.dispatchEvent(new Event('input',{bubbles:true}));
    })()`);
  }
  async function click(text) {
    await evaluate(`(() => {
      const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});
      if(!button||button.disabled) throw new Error('Button unavailable');
      button.click();
    })()`);
  }
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled',{cacheDisabled:true});
  await send('Page.enable');
  await send('Page.navigate',{url:frontend});
  stage='operator_authentication';
  await waitFor('Boolean(document.querySelector("#operator-token"))',30000);
  assert.equal(await evaluate(`fetch(${JSON.stringify(api+'/jobs')}).then(r=>r.status)`),401);
  assert.equal(await evaluate(`fetch(${JSON.stringify(api+'/jobs')},{headers:{Authorization:'Bearer invalid'}}).then(r=>r.status)`),401);
  await fill('#operator-token',token);
  await click('Connect');
  await waitFor('[...document.querySelectorAll("button")].some(b=>b.textContent.trim()==="Run single video"&&!b.disabled)',30000);
  stage='single_source_submission';
  await fill('#maxFrames','12');
  await fill('#videoSource',source);
  assert.equal(await evaluate('[...document.querySelectorAll("label")].find(l=>l.textContent.includes("Save frames")).querySelector("input").checked'),false);
  await click('Run single video');
  stage='terminal_polling';
  await waitFor('document.body.innerText.includes("All 1 detection jobs finished:")');
  const list = await evaluate(`fetch(${JSON.stringify(api+'/jobs')},{headers:{Authorization:${JSON.stringify(`Bearer ${token}`)}}}).then(r=>r.json())`);
  assert.equal(list.data.length,1);
  job = await evaluate(`fetch(${JSON.stringify(api+'/jobs/'+list.data[0].job_id)},{headers:{Authorization:${JSON.stringify(`Bearer ${token}`)}}}).then(r=>r.json())`);
  assert.ok(['complete','failed'].includes(job.status));
  assert.equal(job.save_frames,false);
  assert.equal(job.max_frames,12);
  assert.equal(job.frames.length,0);
  assert.equal(posted,1);
  assert.deepEqual(authenticatedPosts,[true]);
  assert.equal(artifactRequests,0);
  framesRendered=await evaluate('document.querySelectorAll("img").length');
  assert.equal(framesRendered,0);
  assert.equal(errors,0);
  assert.equal(await evaluate(`JSON.stringify({local:{...localStorage},session:{...sessionStorage}}).includes(${JSON.stringify(token)})`),false);
  assert.equal(await evaluate('document.body.innerText.includes("not calibrated probabilities")'),true);
  if(job.status==='complete') {
    assert.equal(job.frames_processed,12);
    assert.equal(await evaluate('document.body.innerText.includes("All 1 detection jobs finished: 1 complete, 0 failed.")'),true);
  }
  const summary = {
    browser:'actual_headless_chrome',stage:'finished',job_status:job.status,
    requested_frames:12,frames_processed:job.frames_processed,
    peak_heuristic_score:job.peak_confidence,event_count:job.events.length,
    accident_detected:job.accident_detected,published_frame_count:job.frames.length,
    authenticated_single_posts:posted,artifact_requests:artifactRequests,rendered_images:framesRendered,
    token_stored:false,js_exceptions:errors,ui_terminal_rendered:true,
    error_category:job.status==='failed' ? 'pipeline_failure_details_suppressed' : null,
  };
  if((job.error||'').includes('Could not open approved stream')) summary.error_category='approved_stream_open_failed';
  console.log(JSON.stringify(summary));
  process.exitCode=job.status==='complete'?0:1;
} catch (error) {
  console.log(JSON.stringify({browser:'actual_headless_chrome',stage,status:'browser_smoke_failed',error_type:error.name,authenticated_single_posts:posted,artifact_requests:artifactRequests,js_exceptions:errors}));
  process.exitCode=1;
} finally {
  ws?.close();
}
