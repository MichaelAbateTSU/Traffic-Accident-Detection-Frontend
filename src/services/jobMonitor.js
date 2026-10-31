import { API_CONFIGURATION, getJob, getJobs } from './api.js';

const storageKey = `tad_monitor:${API_CONFIGURATION.baseUrl}`;
let currentSubmission = null;
let finishSubmission;

export const JOB_READ_TIMEOUT_MS = 30000;

function awaitRequest(request, { signal, label, timeoutMs = JOB_READ_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    let timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (error) {
        reject(error);
        controller.abort();
      } else {
        resolve(value);
      }
    };
    const cancel = () => finish(new DOMException('Job monitoring cancelled.', 'AbortError'));
    if (signal?.aborted) {
      cancel();
      return;
    }
    signal?.addEventListener('abort', cancel, { once: true });
    if (timeoutMs != null) {
      timer = setTimeout(() => {
        finish(new Error(`${label} timed out after ${timeoutMs / 1000} seconds. Accepted jobs are not resubmitted; monitoring can retry.`));
      }, timeoutMs);
    }
    // Settle independently of abort: a transport may ignore the signal.
    Promise.resolve().then(() => {
      if (!settled) return request(controller.signal);
    }).then((value) => finish(null, value), (error) => finish(error));
  });
}

export function getMonitoredJob(id, { signal } = {}) {
  return awaitRequest((requestSignal) => getJob(id, { signal: requestSignal }), {
    signal, label: `Reading accepted job ${id}`,
  });
}

function getMonitoredJobs(query, { signal } = {}) {
  return awaitRequest((requestSignal) => getJobs(query, { signal: requestSignal }), {
    signal, label: `Recovering ${query.status} jobs (page ${query.page})`,
  });
}

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
  if (currentSubmission) {
    const submission = currentSubmission;
    // A pending POST has an unknown acceptance outcome; only cancellation may end this wait.
    await awaitRequest(() => submission, { signal, timeoutMs: null });
  }
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
      const { item } = await getMonitoredJob(id, { signal });
      recovered.set(id, item);
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      errors.push(`Cannot recover job ${id}: ${error.message}`);
      recovered.set(id, error.status === 404
        ? { id, status: 'failed', error: error.message }
        : { id, status: 'pending', monitorError: error.message });
    }
  }
  for (const status of ['pending', 'running']) {
    let page = 1;
    let more = true;
    while (more) {
      const { items, meta } = await getMonitoredJobs({ status, page, pageSize: 100, sort: 'created_at' }, { signal });
      for (const item of items) recovered.set(item.id, item);
      const pagination = meta?.pagination;
      more = pagination?.has_next ?? (pagination?.total_pages ? page < pagination.total_pages : items.length === 100);
      page++;
    }
  }
  return { jobs: [...recovered.values()], warning: saved.warning, error: errors.join(' ') || null };
}
