import { API_CONFIGURATION, getJob, getJobs } from './api.js';

const storageKey = `tad_monitor:${API_CONFIGURATION.baseUrl}`;
let currentSubmission = null;
let finishSubmission;

export function beginJobSubmission() {
  currentSubmission = new Promise((resolve) => { finishSubmission = resolve; });
}

export function endJobSubmission() {
  finishSubmission?.();
  currentSubmission = null;
  finishSubmission = null;
}

export function saveJobMonitor(ids, warning = null) {
  localStorage.setItem(storageKey, JSON.stringify({ ids, warning }));
}

export async function recoverJobMonitor({ signal } = {}) {
  if (currentSubmission) await currentSubmission;
  signal?.throwIfAborted();
  const stored = localStorage.getItem(storageKey);
  const saved = stored ? JSON.parse(stored) : { ids: [], warning: null };
  if (!Array.isArray(saved.ids) || saved.ids.some((id) => typeof id !== 'string')) {
    throw new Error('Saved job monitor is invalid. Clear this site\'s stored monitor before submitting new jobs.');
  }
  const recovered = new Map();
  const errors = [];
  for (const id of saved.ids) {
    try {
      const { item } = await getJob(id, { signal });
      recovered.set(id, item);
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      errors.push(`Cannot recover job ${id}: ${error.message}`);
      recovered.set(id, { id, status: error.status === 404 ? 'failed' : 'pending', error: error.message });
    }
  }
  for (const status of ['pending', 'running']) {
    let page = 1;
    let more = true;
    while (more) {
      const { items, meta } = await getJobs({ status, page, pageSize: 100, sort: 'created_at' }, { signal });
      for (const item of items) recovered.set(item.id, item);
      const pagination = meta?.pagination;
      more = pagination?.has_next ?? (pagination?.total_pages ? page < pagination.total_pages : items.length === 100);
      page++;
    }
  }
  return { jobs: [...recovered.values()], warning: saved.warning, error: errors.join(' ') || null };
}
