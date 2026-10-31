import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import Dashboard from '../src/pages/Dashboard/Dashboard.jsx';
import { createSubmissionJournal } from '../src/services/submissionJournal.js';

try {
  localStorage.clear();
  const journal = createSubmissionJournal();
  const batch = await journal.prepareBatch(Array.from({ length: 8 }, (_, i) => `https://fixture.invalid/source-${i}`), {
    maxFrames: 120, saveFrames: false, sourceKind: 'arbitrary', protocol: 'keyed-v1',
  });
  for (const entry of batch.entries) journal.markSending(entry.key);
  localStorage.setItem(`tad_monitor:${journal.backendIdentity}`, JSON.stringify({
    ids: Array.from({ length: 12 }, (_, index) => `historic-${index}`), warning: null,
  }));
  const root = createRoot(document.getElementById('root'));
  root.render(<MemoryRouter><Dashboard /></MemoryRouter>);
  const end = Date.now() + 12000;
  const finished = () => window.pressureReceiptCount === 8 && window.pressureCritical && window.pressureListings?.length === 2
    && document.getElementById('root').textContent.includes('Frames processed: 120');
  while (!finished() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20));
  if (!finished()) throw new Error('Critical recovery and progressive active polling never completed');
  if (journal.read().batches[0].entries.some((entry) => entry.state !== 'accepted')) throw new Error('Later receipt identities did not reconcile');
  document.body.dataset.criticalBeforeRelease = String(window.pressureCritical.beforeRelease && window.pressureListings.every(Boolean));
  document.body.dataset.result = 'passed';
  root.unmount();
} catch (error) {
  document.body.dataset.failure = error.message;
}
