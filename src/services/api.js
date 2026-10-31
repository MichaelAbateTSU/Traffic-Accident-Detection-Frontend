import { resolveApiConfiguration } from '../config.js';

export const API_CONFIGURATION = resolveApiConfiguration(import.meta.env);
const API_BASE = API_CONFIGURATION.baseUrl;
const TRIMMED_API_BASE = API_BASE.endsWith('/') ? API_BASE.slice(0, -1) : API_BASE;
const API_ORIGIN = TRIMMED_API_BASE.match(/^(?:[a-z][a-z\d+\-.]*:)?\/\/[^/?#]+/i)?.[0] ?? '';
let operatorToken = '';

export function setOperatorToken(token) {
  const value = String(token ?? '').trim();
  if (/[\r\n]/.test(value)) throw new Error('Operator token must not contain line breaks.');
  operatorToken = value;
}

function authorizationHeaders() {
  return operatorToken ? { Authorization: `Bearer ${operatorToken}` } : {};
}

export async function fetchArtifactBlob(path, { signal } = {}) {
  if (API_CONFIGURATION.error) throw createApiError(API_CONFIGURATION.error);
  if (!path || (/^[a-z][a-z\d+\-.]*:/i.test(path) && !/^https?:/i.test(path))) {
    throw createApiError('Unsupported artifact URL.');
  }
  const pageUrl = globalThis.location?.href ?? 'http://localhost/';
  const url = new URL(resolveAssetUrl(path), pageUrl);
  const backendUrl = new URL(`${TRIMMED_API_BASE}/`, pageUrl);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw createApiError('Unsupported artifact URL.');
  }
  const response = await fetch(url.href, {
    headers: url.origin === backendUrl.origin ? authorizationHeaders() : {},
    credentials: 'omit',
    redirect: 'error',
    signal,
  });
  if (!response.ok) throw createApiError(`Artifact request failed (HTTP ${response.status}).`, { status: response.status });
  const blob = await response.blob();
  if (!blob.type.startsWith('image/')) throw createApiError('Backend returned an invalid image.');
  return blob;
}

/**
 * Backend artifact URLs are rooted at the API host (e.g. "/artifacts/<job>/...").
 * Root-relative paths use the API origin; relative paths use the full API base.
 */
export function resolveAssetUrl(url) {
  if (url === undefined || url === null || url === '') return null;
  const value = String(url);
  if (/^(?:[a-z][a-z\d+\-.]*:)?\/\//i.test(value) || value.startsWith('data:') || value.startsWith('blob:')) {
    return value;
  }
  return value.startsWith('/') ? `${API_ORIGIN}${value}` : `${TRIMMED_API_BASE}/${value}`;
}

const SORT_REMAP = {
  '-confidence_score': '-confidence',
  confidence_score: 'confidence',
};

function buildQuery(params = {}) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    if (Array.isArray(value)) {
      value.forEach((entry) => {
        if (entry !== undefined && entry !== null && entry !== '') {
          query.append(key, String(entry));
        }
      });
      return;
    }
    query.append(key, String(value));
  });
  return query.toString();
}

function isEnvelope(payload) {
  // Bare resources such as JobResult carry their own `error` field, so only `data`/`meta` identify an envelope.
  return Boolean(payload) && typeof payload === 'object' && !Array.isArray(payload) && ('data' in payload || 'meta' in payload);
}

function pickFirst(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const casted = Number(value);
  return Number.isFinite(casted) ? casted : null;
}

function normalizeDetectionStatus(value) {
  const normalized = String(value ?? '').toLowerCase();
  if (['active', 'degraded', 'offline'].includes(normalized)) return normalized;
  if (['running', 'ok', 'healthy', 'online'].includes(normalized)) return 'active';
  if (['warning', 'warn'].includes(normalized)) return 'degraded';
  return normalized || 'offline';
}

function normalizeCameraStatus(value) {
  const normalized = String(value ?? '').toLowerCase();
  if (['online', 'warning', 'offline'].includes(normalized)) return normalized;
  if (['active', 'healthy'].includes(normalized)) return 'online';
  if (['degraded', 'warn'].includes(normalized)) return 'warning';
  return 'offline';
}

function createApiError(message, { status, requestId, details, code } = {}) {
  const error = new Error(message);
  error.status = status ?? null;
  error.requestId = requestId ?? null;
  error.details = details ?? null;
  error.code = code ?? null;
  return error;
}

function normalizeApiError(responseStatus, payload) {
  const requestId = payload?.meta?.request_id ?? payload?.request_id ?? null;
  const detail = payload?.detail;
  const message = [payload?.error?.message, detail?.message, detail, payload?.message, payload?.error]
    .find((value) => typeof value === 'string' && value.length > 0)
    ?? (Array.isArray(detail) ? 'Request validation failed. Check the submission fields.' : `HTTP ${responseStatus}`);
  const code = payload?.error?.code ?? detail?.code ?? payload?.code;
  return createApiError(message, {
    status: responseStatus,
    requestId,
    details: payload?.error ?? payload ?? null,
    code: typeof code === 'string' ? code : null,
  });
}

function mapMeta(meta = null) {
  if (!meta) return null;
  return {
    requestId: pickFirst(meta.request_id, meta.requestId, null),
    timestamp: pickFirst(meta.timestamp, null),
    durationMs: numberOrNull(pickFirst(meta.duration_ms, meta.durationMs, null)),
    filters: meta.filters ?? null,
    pagination: meta.pagination ?? null,
    raw: meta,
  };
}

function mapBoundingBox(rawBox) {
  const source = Array.isArray(rawBox) ? rawBox : [];
  if (source.length !== 4) return null;
  const [x1, y1, x2, y2] = source.map((value) => numberOrNull(value) ?? 0);
  return {
    values: [x1, y1, x2, y2],
    x1,
    y1,
    x2,
    y2,
    width: Math.max(0, x2 - x1),
    height: Math.max(0, y2 - y1),
    area: Math.max(0, x2 - x1) * Math.max(0, y2 - y1),
  };
}

function mapSignalValues(raw = {}) {
  const values = {
    suddenStop: numberOrNull(pickFirst(raw.sudden_stop, raw.suddenStop, null)),
    abruptDecel: numberOrNull(pickFirst(raw.abrupt_decel, raw.abruptDecel, null)),
    collisionIou: numberOrNull(pickFirst(raw.collision_iou, raw.collisionIou, null)),
    postCollision: numberOrNull(pickFirst(raw.post_collision, raw.postCollision, null)),
    trafficAnomaly: numberOrNull(pickFirst(raw.traffic_anomaly, raw.trafficAnomaly, null)),
  };

  const entries = Object.entries(values)
    .filter(([, value]) => value !== null)
    .map(([key, value]) => ({ key, value }));

  return {
    ...values,
    entries,
    raw,
  };
}

function mapFrameImagesApiToUi(item = {}) {
  const frameIndex = numberOrNull(pickFirst(item.frame_index, item.frameIndex, null));
  return {
    frameIndex,
    capture: resolveAssetUrl(pickFirst(item.capture, null)),
    captureAnnotated: resolveAssetUrl(pickFirst(item.capture_annotated, item.captureAnnotated, null)),
    pipelineOutput: resolveAssetUrl(pickFirst(item.pipeline_output, item.pipelineOutput, null)),
    raw: item,
  };
}

/**
 * @typedef {Object} FrameImages
 * @property {number} frameIndex
 * @property {string | null} capture
 * @property {string | null} captureAnnotated
 * @property {string | null} pipelineOutput
 * @property {Object} raw
 */

/**
 * @typedef {Object} JobAccepted
 * @property {string} jobId
 * @property {'pending'} status
 * @property {string | null} message
 * @property {string | null} artifactsBaseUrl
 * @property {FrameImages[]} frames
 */

/**
 * @typedef {Object} DetectionResult
 * @property {string} jobId
 * @property {'pending' | 'running' | 'complete' | 'failed'} status
 * @property {string | null} streamUrl
 * @property {string | null} artifactsBaseUrl
 * @property {number | null} maxFrames
 * @property {boolean | null} saveFrames
 * @property {number | null} framesProcessed
 * @property {boolean | null} accidentDetected
 * @property {number | null} peakConfidence
 * @property {Array} events
 * @property {FrameImages[]} frames
 * @property {string | null} error
 * @property {string | null} createdAt
 * @property {string | null} completedAt
 */

function mapDetectionEventApiToUi(item = {}) {
  const confidenceScore = numberOrNull(pickFirst(item.confidence_score, item.confidenceScore, item.confidence)) ?? 0;
  const rawScore = numberOrNull(pickFirst(item.raw_score, item.rawScore, null));
  const boundingBox = mapBoundingBox(pickFirst(item.bounding_box, item.boundingBox, null));

  return {
    incidentId: pickFirst(item.incident_id, item.incidentId, null),
    frameIdx: numberOrNull(pickFirst(item.frame_idx, item.frameIdx, null)),
    timestampSec: numberOrNull(pickFirst(item.timestamp_sec, item.timestampSec, null)),
    detectedAt: pickFirst(item.detected_at, item.detectedAt, null),
    confidenceScore,
    confidence: confidenceScore,
    rawScore,
    boundingBox,
    involvedTrackIds: pickFirst(item.involved_track_ids, item.involvedTrackIds, []),
    accidentDetected: pickFirst(item.accident_detected, item.accidentDetected, null),
    signalValues: mapSignalValues(item.signal_values ?? item.signalValues ?? {}),
    raw: item,
  };
}

export async function apiFetch(path, { method = 'GET', params, body, signal } = {}) {
  if (API_CONFIGURATION.error) throw createApiError(API_CONFIGURATION.error);
  const qs = buildQuery(params);
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = `${TRIMMED_API_BASE}${normalizedPath}${qs ? `?${qs}` : ''}`;

  const headers = { Accept: 'application/json', ...authorizationHeaders() };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
    credentials: 'omit',
    redirect: 'error',
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    if (response.ok) {
      throw createApiError('Backend returned invalid JSON. Check the API URL and backend availability.', { status: response.status });
    }
  }

  if (!response.ok) {
    throw normalizeApiError(response.status, payload);
  }

  if (!payload || typeof payload !== 'object') {
    throw createApiError('Backend returned an invalid JSON resource.', { status: response.status });
  }

  if (isEnvelope(payload)) {
    if (payload.error) {
      throw normalizeApiError(response.status, payload);
    }
    return {
      data: payload.data,
      meta: payload.meta ?? null,
      error: payload.error ?? null,
    };
  }

  return { data: payload, meta: null, error: null };
}

export function mapStatsApiToUi(data = {}) {
  return {
    activeCameras: numberOrNull(pickFirst(data.active_cameras, data.activeCameras, 0)) ?? 0,
    totalCameras: numberOrNull(pickFirst(data.total_cameras, data.totalCameras, 0)) ?? 0,
    incidentsToday: numberOrNull(pickFirst(data.incidents_today, data.incidentsToday, 0)) ?? 0,
    detectionStatus: normalizeDetectionStatus(pickFirst(data.detection_status, data.detectionStatus)),
    uptimePercent: numberOrNull(pickFirst(data.uptime_percent, data.uptimePercent, 0)) ?? 0,
    activeJobs: numberOrNull(pickFirst(data.active_jobs, data.activeJobs, 0)) ?? 0,
    totalJobs: numberOrNull(pickFirst(data.total_jobs, data.totalJobs, 0)) ?? 0,
    refreshedAt: pickFirst(data.refreshed_at, data.refreshedAt, null),
    windowStart: pickFirst(data.window_start, data.windowStart, null),
    windowEnd: pickFirst(data.window_end, data.windowEnd, null),
    raw: data,
  };
}

export function mapIncidentSummaryApiToUi(item = {}) {
  const id = pickFirst(item.incident_id, item.id, '');
  const cameraId = pickFirst(item.camera_id, item.cameraId, 'Unknown');
  const detectedAt = pickFirst(item.detected_at, item.detectedAt, item.timestamp, null);
  const confidenceScore = numberOrNull(pickFirst(item.confidence_score, item.confidenceScore, item.confidence, 0)) ?? 0;
  const status = pickFirst(item.status, item.resolved ? 'resolved' : 'active', 'active');
  const resolved = pickFirst(item.resolved, String(status).toLowerCase() === 'resolved', false);
  const boundingBox = mapBoundingBox(pickFirst(item.bounding_box, item.boundingBox, null));

  return {
    id,
    incidentId: id,
    jobId: pickFirst(item.job_id, item.jobId, null),
    cameraId,
    cameraName: pickFirst(item.camera_name, item.cameraName, `Camera ${cameraId}`),
    type: pickFirst(item.detection_type, item.type, 'unknown'),
    resolved,
    status,
    confidenceScore,
    confidence: confidenceScore,
    rawScore: numberOrNull(pickFirst(item.raw_score, item.rawScore, null)),
    detectedAt,
    timestamp: detectedAt,
    boundingBox,
    involvedTrackIds: pickFirst(item.involved_track_ids, item.involvedTrackIds, []),
    thumbnailUrl: resolveAssetUrl(
      pickFirst(item.thumbnail_url, item.thumbnailUrl, item.frame_url, item.image_url, item.imageUrl, null),
    ),
    frameIdx: numberOrNull(pickFirst(item.frame_idx, item.frameIdx, null)),
    timestampSec: numberOrNull(pickFirst(item.timestamp_sec, item.timestampSec, null)),
    streamUrl: pickFirst(item.stream_url, item.streamUrl, null),
    jobStatus: pickFirst(item.job_status, item.jobStatus, null),
    createdAt: pickFirst(item.created_at, item.createdAt, null),
    completedAt: pickFirst(item.completed_at, item.completedAt, null),
    signalValues: mapSignalValues(item.signal_values ?? item.signalValues ?? {}),
    resolvedAt: pickFirst(item.resolved_at, item.resolvedAt) ?? null,
    note: pickFirst(item.note) ?? null,
    manuallyUpdated: Boolean(pickFirst(item.manually_updated, item.manuallyUpdated, false)),
    raw: item,
  };
}

export function mapIncidentDetailApiToUi(item = {}) {
  return mapIncidentSummaryApiToUi(item);
}

/**
 * @param {Object} item
 * @returns {DetectionResult | JobAccepted}
 */
export function mapJobApiToUi(item = {}) {
  const id = pickFirst(item.job_id, item.id, '');
  const frames = Array.isArray(item.frames)
    ? item.frames
        .map(mapFrameImagesApiToUi)
        .filter((frame) => frame.frameIndex !== null)
        .sort((a, b) => a.frameIndex - b.frameIndex)
    : [];

  return {
    id,
    jobId: id,
    status: pickFirst(item.status, 'unknown'),
    message: pickFirst(item.message, null),
    cameraId: pickFirst(item.camera_id, item.cameraId, null),
    streamUrl: pickFirst(item.stream_url, item.streamUrl, null),
    artifactsBaseUrl: pickFirst(item.artifacts_base_url, item.artifactsBaseUrl, null),
    maxFrames: numberOrNull(pickFirst(item.max_frames, item.maxFrames, null)),
    saveFrames: pickFirst(item.save_frames, item.saveFrames, null),
    createdAt: pickFirst(item.created_at, item.createdAt, null),
    startedAt: pickFirst(item.started_at, item.startedAt, null),
    completedAt: pickFirst(item.completed_at, item.completedAt, null),
    updatedAt: pickFirst(item.updated_at, item.updatedAt, null),
    framesProcessed: numberOrNull(pickFirst(item.frames_processed, item.framesProcessed, null)),
    accidentDetected: pickFirst(item.accident_detected, item.accidentDetected, null),
    peakConfidence: numberOrNull(pickFirst(item.peak_confidence, item.peakConfidence, null)),
    eventCount: numberOrNull(pickFirst(item.event_count, item.eventCount, null)),
    totalDetections: numberOrNull(pickFirst(item.total_detections, item.totalDetections, null)),
    progressPercent: numberOrNull(pickFirst(item.progress_percent, item.progressPercent, item.progress, null)),
    progress: numberOrNull(pickFirst(item.progress, item.progress_percent, null)),
    events: Array.isArray(item.events) ? item.events.map(mapDetectionEventApiToUi) : [],
    frames,
    error: item.error ?? null,
    errorMessage: pickFirst(item.error_message, item.errorMessage, null),
    raw: item,
  };
}

export function mapCameraApiToUi(item = {}) {
  const id = String(pickFirst(item.id, item.camera_id, item.cameraId, 'unknown'));
  return {
    id,
    cameraId: id,
    name: pickFirst(item.name, `Camera ${id}`),
    status: normalizeCameraStatus(item.status),
    streamUrl: pickFirst(item.stream_url, item.streamUrl, null),
    lastJobId: pickFirst(item.last_job_id, item.lastJobId, null),
    lastSeenAt: pickFirst(item.last_seen_at, item.lastSeenAt, null),
    fps: numberOrNull(item.fps),
    raw: item,
  };
}

export function mapHealthApiToUi(data = {}) {
  return {
    status: String(pickFirst(data.status, 'unknown')).toLowerCase(),
    modelLoaded: Boolean(pickFirst(data.model_loaded, data.modelLoaded, false)),
    activeJobs: numberOrNull(pickFirst(data.active_jobs, data.activeJobs, 0)) ?? 0,
    totalJobs: numberOrNull(pickFirst(data.total_jobs, data.totalJobs, 0)) ?? 0,
    raw: data,
  };
}

function mapLatestFrameApiToUi(item = {}) {
  const imageUrl = resolveAssetUrl(pickFirst(item.image_url, item.imageUrl, null));
  const annotatedUrl = resolveAssetUrl(pickFirst(item.annotated_url, item.annotatedUrl, null));
  return {
    cameraId: pickFirst(item.camera_id, item.cameraId, null),
    jobId: pickFirst(item.job_id, item.jobId, null),
    frameIndex: numberOrNull(pickFirst(item.frame_index, item.frameIndex, null)),
    imageUrl,
    annotatedUrl,
    url: annotatedUrl ?? imageUrl,
    capturedAt: pickFirst(item.captured_at, item.capturedAt, null),
    jobStatus: pickFirst(item.job_status, item.jobStatus, null),
    raw: item,
  };
}

/**
 * Latest processed frame for a camera, or null when the backend has none yet (404).
 */
export async function getCameraLatestFrame(cameraId, request = {}) {
  try {
    const { data, meta } = await apiFetch(`/cameras/${encodeURIComponent(cameraId)}/latest-frame`, {
      signal: request.signal,
    });
    return { item: mapLatestFrameApiToUi(data ?? {}), meta: mapMeta(meta) };
  } catch (error) {
    if (error?.status === 404) return { item: null, meta: null };
    throw error;
  }
}

/**
 * URL of the latest annotated frame for a camera, or null if none exists yet.
 */
export async function getLiveFrame(cameraId, request = {}) {
  const { item } = await getCameraLatestFrame(cameraId, request);
  return item?.url ?? null;
}

export async function updateIncidentStatus(incidentId, { status, note } = {}, request = {}) {
  const body = { status };
  if (note !== undefined) body.note = note;
  const { data, meta } = await apiFetch(`/incidents/${encodeURIComponent(incidentId)}`, {
    method: 'PATCH',
    body,
    signal: request.signal,
  });
  return { item: mapIncidentDetailApiToUi(data ?? {}), meta: mapMeta(meta) };
}

function buildIncidentFilterParams(options = {}) {
  const rawSort = options.sort ?? '-detected_at';
  return {
    status: options.status,
    min_confidence: options.minConfidence,
    job_id: options.jobId,
    camera_id: options.cameraId,
    detection_type: options.detectionType,
    start_time: options.startTime,
    end_time: options.endTime,
    sort: SORT_REMAP[rawSort] ?? rawSort,
  };
}

/**
 * Download incidents matching the given filters as CSV via GET /incidents/export.
 */
export async function exportIncidentsCsv(options = {}, request = {}) {
  if (API_CONFIGURATION.error) throw createApiError(API_CONFIGURATION.error);
  const qs = buildQuery(buildIncidentFilterParams(options));
  const response = await fetch(`${TRIMMED_API_BASE}/incidents/export${qs ? `?${qs}` : ''}`, {
    headers: { Accept: 'text/csv', ...authorizationHeaders() },
    signal: request.signal,
    credentials: 'omit',
    redirect: 'error',
  });
  if (!response.ok) {
    let payload = null;
    try {
      payload = await response.json();
    } catch (_) {
      payload = null;
    }
    throw normalizeApiError(response.status, payload);
  }

  if (!response.headers.get('Content-Type')?.toLowerCase().includes('text/csv')) {
    throw createApiError('Backend returned an invalid CSV export.', { status: response.status });
  }
  const blob = await response.blob();
  const disposition = response.headers.get('Content-Disposition') ?? '';
  const match = disposition.match(/filename="?([^";]+)"?/i);
  const filename = match?.[1] ?? 'incidents.csv';

  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  return { filename, size: blob.size };
}

export async function getCameraStatus(request = {}) {
  const { data, meta } = await apiFetch('/cameras/status', { signal: request.signal });
  const items = Array.isArray(data) ? data.map(mapCameraApiToUi) : [];
  return { items, meta: mapMeta(meta) };
}

export async function getIncidents(options = {}, request = {}) {
  const normalized = typeof options === 'number' ? { pageSize: options } : options;
  const { data, meta } = await apiFetch('/incidents', {
    params: {
      page: normalized.page ?? 1,
      page_size: normalized.pageSize ?? 20,
      ...buildIncidentFilterParams(normalized),
    },
    signal: request.signal,
  });
  const items = Array.isArray(data) ? data.map(mapIncidentSummaryApiToUi) : [];
  return { items, meta: mapMeta(meta) };
}

export async function getStats({ historyDays = 30 } = {}, request = {}) {
  const { data, meta } = await apiFetch('/stats/overview', {
    params: { history_days: historyDays },
    signal: request.signal,
  });
  return {
    item: mapStatsApiToUi(data ?? {}),
    meta: mapMeta(meta),
  };
}

export async function getDashboard(options = {}, request = {}) {
  const { data } = await apiFetch('/dashboard', {
    params: {
      history_days: options.historyDays,
      incidents_page_size: options.incidentsPageSize,
      incidents_status: options.incidentsStatus,
    },
    signal: request.signal,
  });
  return {
    stats: mapStatsApiToUi(data?.stats ?? {}),
    incidents: {
      items: Array.isArray(data?.incidents?.items)
        ? data.incidents.items.map(mapIncidentSummaryApiToUi)
        : [],
      meta: mapMeta(data?.incidents?.meta ?? null),
    },
    cameras: Array.isArray(data?.cameras) ? data.cameras.map(mapCameraApiToUi) : [],
    raw: data,
  };
}

export async function getIncidentById(incidentId, request = {}) {
  const { data, meta } = await apiFetch(`/incidents/${encodeURIComponent(incidentId)}`, {
    signal: request.signal,
  });
  return { item: mapIncidentDetailApiToUi(data), meta: mapMeta(meta) };
}

export async function getJobs(options = {}, request = {}) {
  const { data, meta } = await apiFetch('/jobs', {
    params: {
      page: options.page ?? 1,
      page_size: options.pageSize ?? 20,
      status: options.status,
      start_time: options.startTime,
      end_time: options.endTime,
      sort: options.sort ?? '-created_at',
    },
    signal: request.signal,
  });
  const items = Array.isArray(data) ? data.map(mapJobApiToUi) : [];
  return { items, meta: mapMeta(meta) };
}

export async function getJobStatus(jobId, request = {}) {
  const { data, meta } = await apiFetch(`/jobs/${jobId}/status`, {
    signal: request.signal,
  });
  return { item: mapJobApiToUi(data), meta: mapMeta(meta) };
}

export async function getJobDetections(jobId, options = {}, request = {}) {
  const { data, meta } = await apiFetch(`/jobs/${jobId}/detections`, {
    params: {
      detail: options.detail ?? 'summary',
      page: options.page ?? 1,
      page_size: options.pageSize ?? 50,
      min_confidence: options.minConfidence,
      start_time: options.startTime,
      end_time: options.endTime,
      sort: options.sort ?? '-detected_at',
    },
    signal: request.signal,
  });
  const items = Array.isArray(data) ? data.map(mapDetectionEventApiToUi) : [];
  return { items, meta: mapMeta(meta) };
}

export function parseMaxFrames(value) {
  if (typeof value === 'string' && !/^\d+$/.test(value)) {
    throw new Error('Frames per camera must be a whole number from 1 to 300.');
  }
  const frames = typeof value === 'string' ? Number(value) : value;
  if (typeof frames !== 'number' || !Number.isInteger(frames) || frames < 1 || frames > 300) {
    throw new Error('Frames per camera must be a whole number from 1 to 300.');
  }
  return frames;
}

export async function startDetectionJob(payload, request = {}) {
  if (payload.max_frames !== undefined) {
    if (typeof payload.max_frames !== 'number') throw new Error('max_frames must be an integer from 1 to 300.');
    parseMaxFrames(payload.max_frames);
  }
  const { data, meta } = await apiFetch('/detect-accident', {
    method: 'POST',
    body: payload,
    signal: request.signal,
  });
  return { item: mapJobApiToUi(data ?? {}), meta: mapMeta(meta) };
}

export async function getJob(jobId, request = {}) {
  const { data, meta } = await apiFetch(`/jobs/${jobId}`, {
    signal: request.signal,
  });
  return { item: mapJobApiToUi(data), meta: mapMeta(meta) };
}

export async function getHealth(request = {}) {
  const { data, meta } = await apiFetch('/health', {
    signal: request.signal,
  });
  return { item: mapHealthApiToUi(data ?? {}), meta: mapMeta(meta) };
}
