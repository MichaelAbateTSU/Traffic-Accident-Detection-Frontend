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

async function runDriver(wrongCurrentImage = false) {
  let imageReady = false, placeholderScrolled = false, scrolled = 0, pages = 0;
  let ready, page = -1, delayedWaits = 0;
  const frames = Array.from({ length: 12 }, (_, frame_index) => ({
    frame_index, capture: `https://fixture.invalid/${frame_index}/original`,
    capture_annotated: `https://fixture.invalid/${frame_index}/annotated`,
    pipeline_output: `https://fixture.invalid/${frame_index}/output`,
  }));
  const authorized = new Map(frames.flatMap(frame =>
    [frame.capture, frame.capture_annotated, frame.pipeline_output].map(url => [url, true])));
  const decoded = await drive({ job_id: 'original', frames, peak_confidence: 0.2206 },
    () => 'card', async expression => {
      if (expression.startsWith('Boolean(') && expression.includes('querySelector("img")')) {
        assert.equal(placeholderScrolled, true, 'Lazy fetch needs visible placeholder first');
        assert.equal(imageReady, false, 'Fixture must genuinely delay its authenticated image node');
        await ready;
        delayedWaits++;
      }
      return true;
    }, async expression => {
      if (expression.includes("const select=")) { imageReady = false; pages++; page++; }
      if (/querySelectorAll\("figure"\)\[\d+\]\.scrollIntoView/.test(expression)) {
        placeholderScrolled = true;
        imageReady = false;
        ready = new Promise(resolve => setTimeout(() => { imageReady = true; resolve(); }, 5));
      }
      if (expression.endsWith('.querySelector("img").scrollIntoView()')) {
        assert.equal(imageReady, true, 'Driver scrolled before authenticated node existed');
        scrolled++;
      }
      if (expression.includes('figcaption') || expression.includes('currentObjectUrlSources')) {
        const match = expression.match(/\("figure"\)\[(\d+)\]/);
        assert.ok(match);
        const index = Number(match[1]);
        if (expression.includes('figcaption')) return ['Original', 'Annotated', 'Pipeline output'][index % 3];
        return {
          url: wrongCurrentImage ? frames[0].capture :
            frames[page * 3 + Math.floor(index / 3)][['capture', 'capture_annotated', 'pipeline_output'][index % 3]],
          authenticated: true,
        };
      }
      return true;
    }, authorized, assert);
  assert.equal(decoded, 36);
  assert.equal(scrolled, 36);
  assert.equal(pages, 4);
  assert.equal(delayedWaits, 36);
}

test('actual gallery driver waits after each placeholder before decoding all36', async () => {
  await runDriver();
});

test('historically correct requests cannot conceal currently duplicated frame variants', async () => {
  await assert.rejects(runDriver(true), assert.AssertionError);
});
