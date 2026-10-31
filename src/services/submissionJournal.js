import { API_CONFIGURATION } from './api.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEYED_UUID = /^v1\.\d{10}\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const STATES = ['prepared', 'uncertain', 'not-recorded', 'expired', 'accepted'];
const REASONS = [null, 'submission', 'navigation'];

export function validateRecoveryBackend(backend, pageUrl = globalThis.location?.href ?? 'http://localhost/') {
  try {
    const url = new URL(backend || '/', pageUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    return url.href.replace(/\/+$/, '');
  } catch {
    throw new Error('Recovery requires an HTTP(S) backend base without credentials, query parameters or a fragment. No job was sent.');
  }
}

function invalid() {
  throw new Error('Submission recovery journal is invalid. New submissions are blocked; retain the stored recovery references.');
}

function fields(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !names.includes(key))
    || names.some((key) => !(key in value))) invalid();
}

function validate(document) {
  fields(document, ['version', 'batches']);
  if (document.version !== 1 || !Array.isArray(document.batches)) invalid();
  const keys = new Set();
  for (const batch of document.batches) {
    fields(batch, ['id', 'createdAt', 'reason', 'entries']);
    if (!UUID.test(batch.id) || keys.has(batch.id) || !Number.isSafeInteger(batch.createdAt)
      || !REASONS.includes(batch.reason) || !Array.isArray(batch.entries) || !batch.entries.length) invalid();
    keys.add(batch.id);
    for (const entry of batch.entries) {
      fields(entry, ['key', 'protocol', 'sourceKind', 'sourceIndex', 'maxFrames', 'saveFrames', 'fingerprint', 'state', 'jobId']);
      if (!(entry.protocol === 'legacy' ? UUID.test(entry.key) : KEYED_UUID.test(entry.key)) || keys.has(entry.key) || !['legacy', 'keyed-v1'].includes(entry.protocol)
        || !['fixed-camera', 'arbitrary'].includes(entry.sourceKind)
        || (entry.sourceKind === 'fixed-camera' ? !Number.isSafeInteger(entry.sourceIndex) || entry.sourceIndex < 0 : entry.sourceIndex !== null)
        || !Number.isInteger(entry.maxFrames) || entry.maxFrames < 1 || entry.maxFrames > 300
        || typeof entry.saveFrames !== 'boolean' || !DIGEST.test(entry.fingerprint)
        || !STATES.includes(entry.state)
        || (entry.state === 'accepted' ? typeof entry.jobId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(entry.jobId) : entry.jobId !== null)) invalid();
      keys.add(entry.key);
    }
  }
  return document;
}

export function submissionWarnings(document) {
  return document.batches.map((batch) => {
    const accepted = batch.entries.filter((entry) => entry.state === 'accepted').length;
    const uncertain = batch.entries.filter((entry) => ['uncertain', 'not-recorded', 'expired'].includes(entry.state)).length;
    const unsubmitted = batch.entries.filter((entry) => entry.state === 'prepared').length;
    if (!batch.reason && !uncertain && !unsubmitted) return null;
    return `${accepted} of ${batch.entries.length} jobs accepted; ${uncertain} submission outcomes unknown; ${unsubmitted} sources not submitted.${batch.reason === 'navigation' ? ' Submission stopped after navigation.' : ''}`;
  }).filter(Boolean);
}

export function hasUncertainSubmissions(document) {
  return document.batches.some((batch) => batch.entries.some((entry) => ['uncertain', 'not-recorded', 'expired'].includes(entry.state)));
}

// Each mutation replaces one complete document. Accepted IDs never depend on deleting an intent.
export function createSubmissionJournal({
  storage = () => globalThis.localStorage,
  cryptography = () => globalThis.crypto,
  backend = API_CONFIGURATION.baseUrl,
  pageUrl = globalThis.location?.href ?? 'http://localhost/',
} = {}) {
  const identity = () => validateRecoveryBackend(backend, pageUrl);
  const storageKey = () => `tad_submissions:v1:${identity()}`;
  function read() {
    const key = storageKey();
    let raw;
    let legacy = false;
    try {
      raw = storage().getItem(key);
      if (raw === null && key !== `tad_submissions:v1:${backend}`) {
        raw = storage().getItem(`tad_submissions:v1:${backend}`);
        legacy = raw !== null;
      }
    } catch {
      throw new Error('Cannot read durable submission recovery storage. No new jobs can be sent.');
    }
    let document;
    try {
      document = validate(raw === null ? { version: 1, batches: [] } : JSON.parse(raw));
    } catch {
      invalid();
    }
    if (legacy && backend && !backend.startsWith('/') && !/^https?:\/\//i.test(backend) && document.batches.length) {
      throw new Error('Legacy relative-backend recovery is ambiguous. Retain its references and use the original explicit backend location.');
    }
    return document;
  }
  function write(document) {
    const serialized = JSON.stringify(validate(document));
    try {
      storage().setItem(storageKey(), serialized);
      if (storage().getItem(storageKey()) !== serialized) throw new Error();
    } catch {
      throw new Error('Cannot persist durable submission recovery storage. Submission stopped; retain existing recovery references.');
    }
    return document;
  }
  function update(key, change) {
    const document = read();
    const entry = document.batches.flatMap((batch) => batch.entries).find((item) => item.key === key);
    if (!entry) throw new Error('Submission recovery reference was not found. Submission blocked.');
    change(entry);
    return write(document);
  }
  async function fingerprint(payload) {
    if (typeof payload.stream_url !== 'string' || !payload.stream_url
      || !Number.isInteger(payload.max_frames) || payload.max_frames < 1 || payload.max_frames > 300
      || typeof payload.save_frames !== 'boolean'
      || Object.keys(payload).some((key) => !['stream_url', 'max_frames', 'save_frames'].includes(key))) {
      throw new Error('Invalid submission payload. No job was sent.');
    }
    try {
      const bytes = new TextEncoder().encode(JSON.stringify([payload.stream_url, payload.max_frames, payload.save_frames]));
      const digest = await cryptography().subtle.digest('SHA-256', bytes);
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    } catch {
      throw new Error('Secure submission identity is unavailable. No job was sent.');
    }
  }
  function randomKey() {
    try {
      const key = cryptography().randomUUID();
      if (!UUID.test(key)) throw new Error();
      return key;
    } catch {
      throw new Error('Secure submission identity is unavailable. No job was sent.');
    }
  }
  return {
    get backendIdentity() { return identity(); },
    read,
    async prepareBatch(sources, { maxFrames, saveFrames, sourceKind, protocol }) {
      if (!sources.length) throw new Error('No submission sources supplied.');
      const id = randomKey();
      const entries = await Promise.all(sources.map(async (source, index) => ({
        key: protocol === 'keyed-v1' ? `v1.${Math.floor(Date.now() / 1000)}.${randomKey()}` : randomKey(), protocol, sourceKind,
        sourceIndex: sourceKind === 'fixed-camera' ? index : null,
        maxFrames, saveFrames,
        fingerprint: await fingerprint({ stream_url: source, max_frames: maxFrames, save_frames: saveFrames }),
        state: 'prepared', jobId: null,
      })));
      // Re-read after asynchronous hashing, before committing the new batch.
      const document = read();
      if (hasUncertainSubmissions(document)) throw new Error('Unknown submission outcomes must be reconciled before starting another batch.');
      document.batches.push({ id, createdAt: Date.now(), reason: null, entries });
      write(document);
      return { id, entries };
    },
    markSending(key) {
      return update(key, (entry) => {
        if (entry.state !== 'prepared') throw new Error('Submission was already attempted. Automatic replay is blocked.');
        entry.state = 'uncertain';
      });
    },
    markReplaySending(key) {
      return update(key, (entry) => {
        if (entry.protocol !== 'keyed-v1' || !['uncertain', 'not-recorded'].includes(entry.state)) {
          throw new Error('This submission cannot be replayed safely.');
        }
        entry.state = 'uncertain';
      });
    },
    accept(key, jobId) {
      return update(key, (entry) => {
        if (entry.state === 'accepted') {
          if (entry.jobId !== jobId) throw new Error('Conflicting accepted identity. Retain the original recovery reference.');
          return;
        }
        if (!['uncertain', 'not-recorded', 'expired'].includes(entry.state)) throw new Error('Invalid acceptance transition.');
        entry.state = 'accepted';
        entry.jobId = jobId;
      });
    },
    recordLookup(key, state) {
      return update(key, (entry) => {
        if (entry.protocol !== 'keyed-v1') throw new Error('Legacy submissions cannot be reconciled by key.');
        if (!['not-recorded', 'expired'].includes(state)) throw new Error('Invalid reconciliation state.');
        if (entry.state === 'accepted') return;
        if (!['uncertain', 'not-recorded', 'expired'].includes(entry.state)) throw new Error('No submission attempt to reconcile.');
        if (entry.state !== 'expired') entry.state = state;
      });
    },
    warn(batchId, reason) {
      const document = read();
      const batch = document.batches.find((item) => item.id === batchId);
      if (!batch || !REASONS.includes(reason)) throw new Error('Invalid submission warning.');
      batch.reason = reason;
      return write(document);
    },
    async verifyReplay(key, payload) {
      const original = { ...payload };
      const entry = read().batches.flatMap((batch) => batch.entries).find((item) => item.key === key);
      if (!entry || entry.protocol !== 'keyed-v1' || !['uncertain', 'not-recorded'].includes(entry.state)) {
        throw new Error('This submission cannot be replayed safely.');
      }
      if (await fingerprint(original) !== entry.fingerprint) throw new Error('Recovery requires the exact original source URL and options. No job was sent.');
      const current = read().batches.flatMap((batch) => batch.entries).find((item) => item.key === key);
      if (!current || !['uncertain', 'not-recorded'].includes(current.state) || current.fingerprint !== entry.fingerprint) {
        throw new Error('Submission recovery changed while checking the payload. No job was sent.');
      }
      return { key, payload: original };
    },
  };
}
