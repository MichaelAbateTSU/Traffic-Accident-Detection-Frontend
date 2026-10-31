import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import Dashboard from '../src/pages/Dashboard/Dashboard.jsx';
import { createSubmissionJournal } from '../src/services/submissionJournal.js';

try {
  localStorage.clear();
  const journal = createSubmissionJournal();
  const batch = await journal.prepareBatch(['https://fixture.invalid/source'], {
    maxFrames: 120, saveFrames: false, sourceKind: 'arbitrary', protocol: 'keyed-v1',
  });
  journal.markSending(batch.entries[0].key);
  localStorage.setItem(`tad_monitor:${journal.backendIdentity}`, JSON.stringify({
    ids: Array.from({ length: 12 }, (_, index) => `historic-${index}`), warning: null,
  }));
  const root = createRoot(document.getElementById('root'));
  root.render(<MemoryRouter><Dashboard /></MemoryRouter>);
  const end = Date.now() + 12000;
  const finished = () => window.pressureCritical && window.pressureListings?.length === 2
    && document.getElementById('root').textContent.includes('Frames processed: 120');
  while (!finished() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20));
  if (!finished()) throw new Error('Critical recovery and progressive active polling never completed');
  document.body.dataset.criticalBeforeRelease = String(window.pressureCritical.beforeRelease && window.pressureListings.every(Boolean));
  document.body.dataset.result = 'passed';
  root.unmount();
} catch (error) {
  document.body.dataset.failure = error.message;
}
