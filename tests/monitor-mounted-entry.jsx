import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import Dashboard from '../src/pages/Dashboard/Dashboard.jsx';

const check = (value, message) => { if (!value) throw new Error(message); };
const wait = async predicate => {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Mounted scenario condition timed out');
};
const container = document.getElementById('root');
let root = createRoot(container);
function Navigation() {
  window.navigateTest = useNavigate();
  return null;
}
const jobCard = id => [...container.querySelectorAll('article')].find(n => n.textContent.includes(`Job ID: ${id}`));
const start = () => container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
try {
  localStorage.clear();
  window.monitorMode = 'independent';
  window.postCount = 0;
  root.render(<MemoryRouter><Navigation /><Routes><Route path="/" element={<Dashboard />} /><Route path="/away" element={<p>Away</p>} /></Routes></MemoryRouter>);
  await wait(() => [...container.querySelectorAll('button')].some(n => n.textContent.includes('Run detection across') && !n.disabled));
  start();
  await wait(() => window.releaseSecond && window.aRead);
  const began = Date.now();
  check(jobCard('A'), 'accepted A not visible during serial POST');
  window.releaseSecond({ item: { id: 'B', status: 'pending' } });
  await wait(() => jobCard('B')?.textContent.includes('Frames processed: 17'));
  check(Date.now() - began < 30000, 'B waited for A deadline');
  check(!window.aRead.signal.aborted, 'A was aborted to admit B');
  check(!jobCard('A').textContent.includes('Frames processed: 17'), 'B result assigned to A');
  window.navigateTest('/away');
  await wait(() => container.textContent === 'Away');
  check(window.aRead.signal.aborted, 'navigation did not cancel held A GET');
  window.releaseThird({ item: { id: 'C', status: 'complete' } });
  await new Promise(resolve => setTimeout(resolve, 50));
  check(window.postCount === 3, 'navigation issued another serial POST');
  window.monitorMode = 'recovery';
  window.navigateTest('/');
  await wait(() => container.textContent.includes('submission stopped after navigation'));
  check(container.textContent.includes('3 of 4 jobs started'), 'partial batch count not retained');
  check(container.textContent.includes('1 sources were not submitted'), 'unsubmitted source count missing');
  check(window.postCount === 3, 'recovery resubmitted jobs');
  check(jobCard('A') && jobCard('B') && jobCard('C'), 'accepted jobs not recovered');
  root.unmount();
  localStorage.clear();
  window.monitorMode = 'rapid';
  window.postCount = 0;
  root = createRoot(container);
  root.render(<MemoryRouter><Dashboard /></MemoryRouter>);
  for (let round = 0; round < 5; round++) {
    await wait(() => [...container.querySelectorAll('button')].some(n => n.textContent.includes('Run detection across') && !n.disabled));
    const initialCount = window.postCount;
    start();
    await wait(() => [1, 2, 3, 4].every(n => jobCard(`rapid-${initialCount + n}`)?.textContent.includes('Frames processed: 17')));
    check(window.postCount === initialCount + 4, 'rapid serial acceptance lost or duplicated POST');
    for (let n = 1; n <= 4; n++) {
      check(jobCard(`rapid-${initialCount + n}`).textContent.includes('Status: done'), 'rapid interleaving lost a terminal update');
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
