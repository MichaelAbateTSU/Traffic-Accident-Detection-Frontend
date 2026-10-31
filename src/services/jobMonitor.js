import { API_CONFIGURATION, getJob, getJobs, getSubmission, submitDetection } from './api.js';
import { createSubmissionJournal, submissionWarnings, validateRecoveryBackend } from './submissionJournal.js';

let currentSubmission = null;
let finishSubmission;
let keyedSubmission = false;
const JOB_REFERENCE = /^[a-zA-Z0-9_-]{1,128}$/;

export const JOB_READ_TIMEOUT_MS = 30000;

async function mapBounded(items, action, concurrency = 2) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) await action(items[next++]);
  }));
}

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
  if (typeof id !== 'string' || !JOB_REFERENCE.test(id)) {
    return Promise.reject(new Error('Invalid accepted job identity; no monitoring request was sent.'));
  }
  return awaitRequest((requestSignal) => getJob(id, { signal: requestSignal }), {
    signal, label: `Reading accepted job ${id}`,
  }).then((result) => {
    if (result.item?.id !== id) throw new Error('Backend returned a mismatched job identity. The original recovery reference is retained; outcome remains unknown.');
    return result;
  });
}

export function submitMonitoredDetection(payload, key, { signal } = {}) {
  const original = { ...payload };
  return awaitRequest((requestSignal) => submitDetection(original, { key, signal: requestSignal }), {
    signal, label: 'Submitting detection (acceptance remains uncertain on timeout)',
  });
}

async function reconcileIntents(journal, { signal, ownerSignal = signal, expired = () => false, onAccepted } = {}) {
  const errors = [];
  const entries = journal.read().batches.flatMap((batch) => batch.entries)
    .filter((entry) => entry.protocol === 'keyed-v1' && ['uncertain', 'not-recorded', 'expired'].includes(entry.state));
  await mapBounded(entries, async (entry) => {
    ownerSignal?.throwIfAborted();
    if (expired()) {
      errors.push('Submission lookup deferred after the recovery deadline; original identity retained, acceptance remains unknown.');
      return;
    }
    let receipt;
    let readError;
    try {
      receipt = await awaitRequest((requestSignal) => getSubmission(entry.key, { signal: requestSignal }), {
        signal, label: 'Looking up uncertain submission',
      });
    } catch (error) {
      if (error.name === 'AbortError') {
        ownerSignal?.throwIfAborted();
        errors.push('Submission lookup timed out at the recovery deadline; original identity retained, acceptance remains unknown.');
        return;
      }
      readError = error;
    }
    ownerSignal?.throwIfAborted();
    if (receipt) {
      journal.accept(entry.key, receipt.item.id);
      onAccepted?.(receipt.item);
    } else if (readError.status === 404 && readError.code === 'idempotency_key_unknown') {
      journal.recordLookup(entry.key, 'not-recorded');
    } else if (readError.status === 410 && ['idempotency_key_expired', 'idempotency_result_expired'].includes(readError.code)) {
      journal.recordLookup(entry.key, 'expired');
    } else {
      errors.push(readError.status === 404
        ? 'Versioned submission lookup is unavailable; acceptance remains unknown. No legacy fallback is allowed.'
        : `Submission lookup failed; acceptance remains unknown. ${readError.message}`);
    }
  });
  return errors.join(' ') || null;
}

function getMonitoredJobs(query, { signal } = {}) {
  return awaitRequest((requestSignal) => getJobs(query, { signal: requestSignal }), {
    signal, label: `Recovering ${query.status} jobs (page ${query.page})`,
  });
}

export function beginJobSubmission({ keyed = false } = {}) {
  keyedSubmission = keyed;
  currentSubmission = new Promise((resolve) => { finishSubmission = resolve; });
}

export function endJobSubmission() {
  finishSubmission?.();
  currentSubmission = null;
  finishSubmission = null;
  keyedSubmission = false;
}

function durableWarning(warning) {
  if (warning == null) return null;
  if (typeof warning !== 'string') throw new Error('Invalid job monitor warning; existing recovery references are retained.');
  const pattern = /\b\d{1,6} of \d{1,6} jobs accepted; \d{1,6} submission outcomes unknown; \d{1,6} sources not submitted\.(?: Submission stopped after navigation\.)?|\b\d{1,6} of \d{1,6} jobs started; submission stopped after navigation: \d{1,6} sources were not submitted\./g;
  const messages = [...new Set([...warning.matchAll(pattern)].map((match) => match[0]))];
  const residual = warning.replace(pattern, '').trim();
  if (residual) {
    const counts = residual.match(/\b(\d{1,6}) of (\d{1,6}) (?:jobs )?(?:started|accepted)\b/);
    messages.unshift(counts
      ? `${counts[1]} of ${counts[2]} jobs accepted; previous submission warning retained.`
      : 'Previous submission warning retained; reconcile uncertain original requests before replay.');
  }
  return messages.join(' ') || null;
}

export function saveJobMonitor(ids, warning = null, backend = API_CONFIGURATION.baseUrl) {
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !JOB_REFERENCE.test(id))) {
    throw new Error('Invalid accepted job references; existing recovery storage is retained.');
  }
  const identity = validateRecoveryBackend(backend);
  localStorage.setItem(`tad_monitor:${identity}`, JSON.stringify({ ids, warning: durableWarning(warning) }));
}

export async function recoverJobMonitor({ signal, onJobs, knownIds = [], journal: providedJournal } = {}) {
  if (currentSubmission && !keyedSubmission) {
    const submission = currentSubmission;
    // A pending POST has an unknown acceptance outcome; only cancellation may end this wait.
    await awaitRequest(() => submission, { signal, timeoutMs: null });
  }
  signal?.throwIfAborted();
  const journalApi = providedJournal ?? createSubmissionJournal();
  const identity = journalApi.backendIdentity;
  if (identity !== validateRecoveryBackend(API_CONFIGURATION.baseUrl)) {
    throw new Error('The effective backend location changed. Retain the original recovery journal; no reconciliation request was sent.');
  }
  let stored = localStorage.getItem(`tad_monitor:${identity}`);
  const rawBackend = API_CONFIGURATION.baseUrl;
  if (stored === null && identity === validateRecoveryBackend(rawBackend) && identity !== rawBackend) {
    const legacy = localStorage.getItem(`tad_monitor:${rawBackend}`);
    if (legacy !== null && rawBackend && !rawBackend.startsWith('/') && !/^https?:\/\//i.test(rawBackend)) {
      throw new Error('Legacy relative-backend monitor is ambiguous. Retain its references and use the original explicit backend location.');
    }
    stored = legacy;
  }
  let saved;
  try {
    saved = stored === null ? { ids: [], warning: null } : JSON.parse(stored);
    if (!saved || !Array.isArray(saved.ids) || saved.ids.some((id) => typeof id !== 'string' || !JOB_REFERENCE.test(id))
      || (saved.warning != null && typeof saved.warning !== 'string')) throw new Error();
  } catch {
    throw new Error('Saved job monitor is invalid. Retain original recovery references; new submissions remain blocked.');
  }
  const journal = journalApi.read();
  if (!Array.isArray(knownIds) || knownIds.some((id) => typeof id !== 'string' || !JOB_REFERENCE.test(id))) throw new Error('Invalid known recovery references.');
  saved.ids = [...new Set([...knownIds, ...saved.ids, ...journal.batches.flatMap((batch) => batch.entries)
    .filter((entry) => entry.state === 'accepted').map((entry) => entry.jobId)])];
  const recovered = new Map(saved.ids.map((id) => [id, { id, status: 'pending', recoveringRead: true }]));
  const errors = new Map();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const requestSignal = controller.signal;
  const reads = new Map();
  const listings = new Map();
  const acceptedReads = [];
  const historyController = new AbortController();
  const cancelHistory = () => historyController.abort();
  requestSignal.addEventListener('abort', cancelHistory, { once: true });
  let historyExpired = false;
  let historyTimer;
  const emit = (jobs = [...recovered.values()]) => {
    if (!requestSignal.aborted) onJobs?.({ jobs, error: [...errors.values()].join(' ') || null });
  };
  const restore = (id, historical = false) => {
    if (reads.has(id)) return reads.get(id);
    if (!recovered.has(id)) recovered.set(id, { id, status: 'pending', recoveringRead: true });
    const read = (async () => {
      try {
        const { item } = await getMonitoredJob(id, { signal: historical ? historyController.signal : requestSignal });
        requestSignal.throwIfAborted();
        const previous = recovered.get(id);
        const staleActive = ['complete', 'failed'].includes(previous?.status) && ['pending', 'running'].includes(item.status);
        recovered.set(id, {
          ...(staleActive ? previous : item),
          recoveringRead: false, recoveryDeferred: false, admissionStatusUnknown: false,
          submissionReceiptOnly: staleActive ? previous.submissionReceiptOnly : false,
          monitorError: staleActive ? 'An older active job read cannot confirm terminal result details. Retry job result recovery (read only).' : item.monitorError,
        });
        if (staleActive) errors.set(id, recovered.get(id).monitorError);
        else errors.delete(id);
      } catch (error) {
        if (error.name === 'AbortError') {
          if (!historical || !historyExpired || requestSignal.aborted) throw error;
          error = new Error('Historical recovery pass timed out after 30 seconds. Original job reference is retained; outcome remains unknown.');
        }
        const message = error.status === 404
          ? `Job ${id} is unavailable (expired or unknown); its inference outcome is unknown. ${error.message}`
          : `Cannot recover job ${id}: ${error.message}`;
        errors.set(id, message);
        const previous = recovered.get(id);
        const terminal = ['complete', 'failed'].includes(previous?.status);
        const listed = terminal ? null : listings.get(id);
        if (listed) {
          recovered.set(id, { ...listed, recoveringRead: false, recoveryDeferred: false });
          errors.delete(id);
        } else {
          recovered.set(id, error.status === 404 && !terminal
            ? { id, status: 'unavailable', recoveringRead: false, recoveryDeferred: false, monitorError: message }
            : { ...recovered.get(id), id, recoveringRead: false, recoveryDeferred: false, monitorError: message });
        }
      }
      emit([recovered.get(id)]);
    })();
    reads.set(id, read);
    return read;
  };
  async function listStatus(status) {
    let page = 1;
    let more = true;
    while (more) {
      const { items, meta } = await getMonitoredJobs({ status, page, pageSize: 100, sort: 'created_at' }, { signal: historyController.signal });
      requestSignal.throwIfAborted();
      const changed = [];
      for (const item of items) {
        if (typeof item.id !== 'string' || !JOB_REFERENCE.test(item.id)) {
          throw new Error('Backend listed an invalid job identity. Original recovery references are retained; new submissions remain blocked.');
        }
        const previous = recovered.get(item.id);
        if (previous && ['complete', 'failed'].includes(previous.status) && ['pending', 'running'].includes(item.status)) continue;
        listings.set(item.id, item);
        if (!previous || previous.recoveringRead || errors.has(item.id)) {
          recovered.set(item.id, { ...item, recoveringRead: false, recoveryDeferred: false, admissionStatusUnknown: false });
          errors.delete(item.id);
          changed.push(recovered.get(item.id));
        }
      }
      emit(changed);
      const pagination = meta?.pagination;
      more = pagination?.has_next ?? (pagination?.total_pages ? page < pagination.total_pages : items.length === 100);
      page++;
    }
  }
  try {
    signal?.throwIfAborted();
    emit();
    historyTimer = setTimeout(() => {
      historyExpired = true;
      historyController.abort();
    }, JOB_READ_TIMEOUT_MS);
    // Receipt workers persist and emit acceptance without waiting for job reads.
    const critical = Promise.all([
      reconcileIntents(journalApi, {
        signal: historyController.signal, ownerSignal: requestSignal, expired: () => historyExpired,
        onAccepted: (item) => {
          const previous = recovered.get(item.id);
          const active = ['pending', 'running'].includes(item.status);
          if (!previous || !['complete', 'failed'].includes(previous.status)) {
            recovered.set(item.id, {
              ...(previous && item.submissionReceiptOnly ? { ...item, ...previous, id: item.id, status: item.status } : { ...previous, ...item }),
              recoveringRead: !active, recoveryDeferred: false, admissionStatusUnknown: false, monitorError: null,
              submissionReceiptOnly: item.submissionReceiptOnly,
            });
          }
          emit([recovered.get(item.id)]);
          if (!active) acceptedReads.push(item.id);
        },
      }),
      ...['pending', 'running'].map(listStatus),
    ]);
    const readHistory = async (id) => {
      if (reads.has(id)) {
        await reads.get(id);
        const item = recovered.get(id);
        if (!item?.submissionReceiptOnly || !['complete', 'failed'].includes(item.status)) return;
        reads.delete(id);
      }
      if (listings.has(id) && !['complete', 'failed'].includes(recovered.get(id)?.status)) return;
      if (historyExpired) {
        const message = `Historical job ${id} read deferred after the recovery deadline. Reference retained; outcome unknown. Retry historical recovery explicitly.`;
        errors.set(id, message);
        recovered.set(id, { ...recovered.get(id), id, recoveringRead: false, recoveryDeferred: true, monitorError: message });
        emit([recovered.get(id)]);
        return;
      }
      await restore(id, true);
    };
    const history = mapBounded(saved.ids, readHistory);
    const [[submissionError]] = await Promise.all([critical, history]);
    await mapBounded(acceptedReads, readHistory);
    const updated = journalApi.read();
    saved.warning = [saved.warning, ...submissionWarnings(updated).filter((warning) => !saved.warning?.includes(warning))].filter(Boolean).join(' ') || null;
    return { jobs: [...recovered.values()], warning: saved.warning, error: [...errors.values()].join(' ') || null,
      intents: updated, submissionError };
  } catch (error) {
    if (historyExpired && !requestSignal.aborted && error.name === 'AbortError') {
      throw new Error('Job recovery timed out after its 30-second pass deadline. Active listing is incomplete; retain original references and retry read-only recovery before new submissions.');
    }
    throw error;
  } finally {
    clearTimeout(historyTimer);
    historyController.abort();
    requestSignal.removeEventListener('abort', cancelHistory);
    controller.abort();
    signal?.removeEventListener('abort', cancel);
  }
}
