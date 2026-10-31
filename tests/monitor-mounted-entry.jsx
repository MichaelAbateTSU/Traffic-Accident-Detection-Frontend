import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import Dashboard from '../src/pages/Dashboard/Dashboard.jsx';

function check(value, message) {
  if (!value) throw new Error(message);
}

async function wait(predicate, message) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Mounted scenario timed out: ${message}`);
}

const container = document.getElementById('root');
let root = createRoot(container);
function Navigation() {
  window.navigateTest = useNavigate();
  return null;
}
const jobCard = (id) => [...container.querySelectorAll('article')].find((node) => node.textContent.includes(`Job ID: ${id}`));
const readyToStart = () => [...container.querySelectorAll('button')].some((node) => node.textContent.includes('Run detection across') && !node.disabled);
const start = () => container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

try {
  localStorage.clear();
  window.monitorMode = 'independent';
  window.postCount = 0;
  window.postKeys = [];
  window.readCounts = {};
  root.render(<MemoryRouter><Navigation /><Routes><Route path="/" element={<Dashboard />} /><Route path="/away" element={<p>Away</p>} /></Routes></MemoryRouter>);
  await wait(readyToStart, 'initial recovery');
  start();
  await wait(() => window.releaseSecond && window.aRead, 'first accepted GET and second pending POST');
  const began = Date.now();
  check(jobCard('A'), 'Accepted A not visible during serial POST.');
  window.releaseSecond({ item: { id: 'B', status: 'pending' } });
  await wait(() => jobCard('B')?.textContent.includes('Frames processed: 17') && window.releaseThird, 'B update while A stalls');
  check(Date.now() - began < 30000, 'B waited for A deadline.');
  check(!window.aRead.signal.aborted, 'A was aborted to admit B.');
  check(window.readCounts.A === 1, 'Stalled A had overlapping GETs.');
  check(!jobCard('A').textContent.includes('Frames processed: 17'), 'B result assigned to A.');
  check(!readyToStart(), 'Pending submission allowed a duplicate batch.');

  window.navigateTest('/away');
  await wait(() => container.textContent === 'Away', 'navigation unmount');
  check(window.aRead.signal.aborted, 'Navigation did not cancel held A GET.');
  window.monitorMode = 'recovery';
  window.navigateTest('/');
  await wait(() => jobCard('A') && jobCard('B') && jobCard('C'), 'key lookup recovery while original POST remains unresolved');
  check(window.postCount === 3, 'Same-session recovery waited for or duplicated the held POST.');
  check(new Set(window.postKeys).size === 3, 'Batch sources reused request identities.');
  check(window.postKeys.every(key => /^v1\.\d{10}\./.test(key)), 'Stored/transmitted identity lacks its version or timestamp.');
  window.releaseThird({ item: { id: 'C', status: 'complete' } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  check(window.postCount === 3, 'Navigation issued another serial POST.');
  window.navigateTest('/away');
  await wait(() => container.textContent === 'Away', 'second navigation');
  window.navigateTest('/');
  await wait(() => container.textContent.includes('submission stopped after navigation'), 'partial warning recovery');
  check(container.textContent.includes('3 of 4 jobs started'), 'Partial batch count not retained.');
  check(container.textContent.includes('1 sources were not submitted'), 'Unsubmitted source count missing.');
  check(window.postCount === 3, 'Recovery resubmitted jobs.');
  check(jobCard('A') && jobCard('B') && jobCard('C'), 'Accepted jobs not recovered.');
  window.aRead.resolve({ item: { id: 'A', status: 'failed', framesProcessed: 999 } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  check(jobCard('A').textContent.includes('Status: done'), 'Late cancelled GET overwrote recovered state.');
  check(!jobCard('A').textContent.includes('Frames processed: 999'), 'Late cancelled GET overwrote recovered data.');
  root.unmount();

  localStorage.clear();
  window.monitorMode = 'rapid';
  window.postCount = 0;
  window.postKeys = [];
  root = createRoot(container);
  root.render(<MemoryRouter><Dashboard /></MemoryRouter>);
  for (let round = 0; round < 5; round++) {
    await wait(readyToStart, `rapid batch ${round + 1} readiness`);
    const initialCount = window.postCount;
    start();
    await wait(() => [1, 2, 3, 4].every((n) => jobCard(`rapid-${initialCount + n}`)?.textContent.includes('Frames processed: 17')), `rapid batch ${round + 1} results`);
    check(window.postCount === initialCount + 4, 'Rapid serial acceptance lost or duplicated POST.');
    for (let n = 1; n <= 4; n++) {
      check(jobCard(`rapid-${initialCount + n}`).textContent.includes('Status: done'), 'Rapid interleaving lost a terminal update.');
    }
  }
  root.unmount();
  document.body.dataset.result = 'passed';
  document.body.dataset.transport = 'mocked';
} catch (error) {
  document.body.dataset.result = 'failed';
  document.body.dataset.failure = error.message;
  root.unmount();
}
