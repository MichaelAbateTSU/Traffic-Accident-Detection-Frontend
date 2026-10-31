import assert from 'node:assert/strict';
import fs from 'node:fs';

const token = process.env.API_TOKEN;
const api = 'https://api.integration.test:8453';
const frontend = 'https://frontend.integration.test:8454';
const source = 'https://media.githubusercontent.com/media/accidentbench/accidentbench.github.io/main/assets/videos/synthetic/Town03_head-on_clear_30.mp4';
const phase = process.argv[2] || 'initial';
let stage = 'devtools';
let posts = 0, imageGets = 0, errors = 0;
let ws;
let blockedExternalRequests = 0;
let cancelledInterceptions = 0, interceptionErrors = 0;
try {
  const targets = await (await fetch('http://127.0.0.1:9225/json/list')).json();
  ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve,reject) => { ws.onopen=resolve; ws.onerror=reject; });
  let serial=0;
  const pending=new Map();
  const authPosts=[];
  const imageAuth=[];
  ws.onmessage=({data})=>{
    const message=JSON.parse(data);
    if(message.id) {
      const waiter=pending.get(message.id);
      pending.delete(message.id);
      message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
    } else if(message.method==='Fetch.requestPaused') {
      const url=message.params.request.url;
      const permitted=url.startsWith(api+'/') || url.startsWith(frontend+'/');
      if(!permitted) blockedExternalRequests++;
      send(permitted?'Fetch.continueRequest':'Fetch.failRequest', {
        requestId:message.params.requestId,
        ...(permitted?{}:{errorReason:'BlockedByClient'}),
      }).catch(error=>{
        if(error.message.includes('Invalid InterceptionId')) cancelledInterceptions++;
        else interceptionErrors++;
      });
    } else if(message.method==='Runtime.exceptionThrown') {
      errors++;
    } else if(message.method==='Network.requestWillBeSent') {
      const r=message.params.request;
      const authorized=Object.entries(r.headers).some(([k,v])=>k.toLowerCase()==='authorization' && v===`Bearer ${token}`);
      if(r.url===api+'/detect-accident'&&r.method==='POST') {
        posts++;
        authPosts.push(authorized);
        assert.deepEqual(JSON.parse(r.postData),{stream_url:source,max_frames:12,save_frames:true});
      }
      if(r.url.startsWith(api+'/artifacts/')&&r.method==='GET') {
        imageGets++;
        imageAuth.push(authorized);
      }
    }
  };
  function send(method,params={}) {
    const id=++serial;
    return new Promise((resolve,reject)=>{
      pending.set(id,{resolve,reject}); ws.send(JSON.stringify({id,method,params}));
    });
  }
  async function evaluate(expression) {
    const response=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    if(response.exceptionDetails) throw new Error('Browser evaluation failed');
    return response.result.value;
  }
  async function wait(expression,timeout=120000) {
    const deadline=Date.now()+timeout;
    while(Date.now()<deadline) {
      const value=await evaluate(expression);
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
      const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});
      if(!b||b.disabled) throw new Error('Button unavailable');
      b.click();
    })()`);
  }
  async function signIn(value=token) {
    await wait('Boolean(document.querySelector("#operator-token"))',30000);
    await fill('#operator-token',value);
    await click('Connect');
  }
  async function request(path) {
    return evaluate(`fetch(${JSON.stringify(api+path)},{headers:{Authorization:${JSON.stringify(`Bearer ${token}`)}}}).then(async r=>({status:r.status,body:await r.json()}))`);
  }
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled',{cacheDisabled:true});
  await send('Page.enable');
  await send('Fetch.enable',{patterns:[{urlPattern:'http*',requestStage:'Request'}]});
  await send('Page.navigate',{url:frontend});
  stage='authentication';
  if(phase==='initial') {
    await signIn('invalid-test-token');
    await wait('document.body.innerText.includes("Cannot connect as operator")',30000);
  }
  await signIn();
  await wait('Boolean(document.querySelector("#videoSource")) && [...document.querySelectorAll("button")].some(b=>b.textContent.trim()==="Run single video"&&!b.disabled)',30000);
  if(phase==='initial') {
    stage='submission';
    await fill('#maxFrames','12');
    await evaluate(`(() => {
      const input=[...document.querySelectorAll('label')].find(l=>l.textContent.includes('Save frames')).querySelector('input');
      if(!input.checked) input.click();
    })()`);
    await fill('#videoSource',source);
    await click('Run single video');
  }
  stage='terminal_monitor';
  await wait('document.body.innerText.includes("All 1 detection jobs finished: 1 complete, 0 failed.")');
  const listed=(await request('/jobs')).body.data;
  assert.equal(listed.length,1);
  const job=(await request('/jobs/'+listed[0].job_id)).body;
  assert.equal(job.status,'complete');
  assert.equal(job.frames_processed,12);
  assert.equal(job.frames.length,12);
  assert.equal(job.max_frames,12);
  assert.equal(job.save_frames,true);
  assert.ok(job.frames.every(f=>f.capture.startsWith(api+'/artifacts/')));
  for(const key of ['created_at','started_at','completed_at']) assert.equal(job[key],listed[0][key]);
  if(phase==='initial') {
    assert.equal(posts,1);
    assert.deepEqual(authPosts,[true]);
    fs.writeFileSync(process.env.RESULT_FILE,JSON.stringify(job));
  } else {
    const prior=JSON.parse(fs.readFileSync(process.env.RESULT_FILE,'utf8'));
    assert.deepEqual(job,prior);
    assert.equal(posts,0);
  }
  stage='decoded_saved_gallery';
  await evaluate(`(() => {
    const title=[...document.querySelectorAll('h3')].find(h=>h.textContent.includes('Frame Images - Job'));
    title.parentElement.scrollIntoView();
  })()`);
  const decoded=await wait(`(() => {
    const title=[...document.querySelectorAll('h3')].find(h=>h.textContent.includes('Frame Images - Job'));
    const imgs=[...title.parentElement.querySelectorAll('img')];
    return imgs.length===9&&imgs.every(i=>i.src.startsWith('blob:')&&i.complete&&i.naturalWidth>0) ? imgs.length : null;
  })()`);
  assert.ok(imageGets>=9);
  assert.ok(imageAuth.every(Boolean));
  const finalArtifact=job.frames.at(-1).pipeline_output;
  const verifiedImage=await evaluate(`(async()=>{
    const unauthorized=await fetch(${JSON.stringify(finalArtifact)});
    const response=await fetch(${JSON.stringify(finalArtifact)},{headers:{Authorization:${JSON.stringify(`Bearer ${token}`)}}});
    const blob=await response.blob(), bitmap=await createImageBitmap(blob);
    return {unauthenticated_status:unauthorized.status,status:response.status,width:bitmap.width,height:bitmap.height,type:blob.type};
  })()`);
  assert.equal(verifiedImage.unauthenticated_status,401);
  assert.equal(verifiedImage.status,200);
  assert.equal(verifiedImage.type,'image/jpeg');
  assert.ok(verifiedImage.width>0);
  assert.equal(await evaluate(`JSON.stringify({local:{...localStorage},session:{...sessionStorage}}).includes(${JSON.stringify(token)})`),false);
  assert.equal(await evaluate('document.body.innerText.includes("not calibrated probabilities")'),true);
  stage='camera_job_state_presentation';
  await evaluate(`document.querySelector('a[href^="/camera/"]').click()`);
  stage='camera_complete_label';
  await wait('document.body.textContent.includes("Job complete")',30000);
  stage='camera_blocked_player_failure';
  await wait('document.body.innerText.includes("Raw playback error:")',30000);
  assert.equal(await evaluate('Boolean(document.querySelector("video"))'),true);
  assert.equal(await evaluate('document.body.innerText.includes("Latest saved YOLO-processed frame (not a live stream)")'),true);
  assert.ok(blockedExternalRequests>0);
  await click('Back');
  stage='camera_return_dashboard';
  await wait('Boolean(document.querySelector("#videoSource"))',30000);
  await evaluate(`[...document.querySelectorAll('a')].find(a=>a.textContent.trim()==='Open full feed').click()`);
  stage='live_unknown_source_summary';
  await wait('document.body.innerText.includes("9 Sources with unknown latest job state")',30000);
  assert.equal(await evaluate('document.querySelectorAll("article").length'),9);
  assert.equal(await evaluate('document.body.innerText.includes("Raw camera playback, not YOLO-processed.")'),true);
  assert.equal(await evaluate(`JSON.stringify({local:{...localStorage},session:{...sessionStorage}}).includes(${JSON.stringify(token)})`),false);
  assert.equal(errors,0);
  assert.equal(interceptionErrors,0);
  if(phase==='recovery') {
    await click('Sign out');
    await wait('Boolean(document.querySelector("#operator-token"))',30000);
  }
  console.log(JSON.stringify({
    phase,job_status:job.status,frames_processed:job.frames_processed,
    peak_heuristic_score:job.peak_confidence,event_count:job.events.length,
    authenticated_posts:posts,decoded_gallery_images:decoded,
    image_auth_checks_passed:true,last_image:verifiedImage,
    token_persisted:false,js_exceptions:errors,
    result_identical_after_restart:phase==='recovery',ui_terminal_rendered:true,
    camera_complete_job_player_attempted:true,raw_external_requests_blocked:blockedExternalRequests,
    real_camera_hosts_contacted:0,unknown_configured_sources:9,
    cancelled_interceptions:cancelledInterceptions,interception_errors:interceptionErrors,
  }));
} catch(error) {
  console.log(JSON.stringify({phase,status:'browser_check_failed',stage,error_type:error.name,authenticated_posts:posts,js_exceptions:errors,raw_external_requests_blocked:blockedExternalRequests,cancelled_interceptions:cancelledInterceptions,interception_errors:interceptionErrors}));
  process.exitCode=1;
} finally {
  ws?.close();
}
