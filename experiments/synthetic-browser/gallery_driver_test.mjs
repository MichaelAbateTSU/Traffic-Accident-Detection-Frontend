// Driver-contract regression only: actual saved images remain verified by Chrome
// against the genuine backend in the smoke, not by these controlled evaluations.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./keyed_browser.mjs', import.meta.url), 'utf8');
const start = source.indexOf('async function verifyAllMountedDetails(job) {');
const end = source.indexOf('async function seedUncertainIdentity', start);
assert.ok(start >= 0 && end > start);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const drive = new AsyncFunction('job', 'cardExpression', 'wait', 'evaluate', 'artifactRequests', 'assert',
  `${source.slice(start, end)}; return verifyAllMountedDetails(job);`);

test('real gallery driver waits for authenticated img nodes before lazy scrolling all36', async () => {
  let imagesReady = false, scrolled = 0, pages = 0;
  const frames = Array.from({ length: 12 }, (_, frame_index) => ({
    frame_index, capture: `https://fixture.invalid/${frame_index}/original`,
    capture_annotated: `https://fixture.invalid/${frame_index}/annotated`,
    pipeline_output: `https://fixture.invalid/${frame_index}/output`,
  }));
  const authorized = new Map(frames.flatMap(frame =>
    [frame.capture, frame.capture_annotated, frame.pipeline_output].map(url => [url, true])));
  const decoded = await drive({ job_id: 'original', frames, peak_confidence: 0.2206 },
    () => 'card', async expression => {
      if (expression.includes('querySelectorAll("img").length===9')) imagesReady = true;
      return true;
    }, async expression => {
      if (expression.includes("const select=")) { imagesReady = false; pages++; }
      if (/querySelectorAll\("img"\)\[\d+\]\.scrollIntoView/.test(expression)) {
        assert.equal(imagesReady, true, 'Driver scrolled before authenticated nodes existed');
        scrolled++;
      }
      return true;
    }, authorized, assert);
  assert.equal(decoded, 36);
  assert.equal(scrolled, 36);
  assert.equal(pages, 4);
});
