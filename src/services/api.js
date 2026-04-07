const API_BASE = import.meta.env.VITE_API_BASE_URL ?? import.meta.env.VITE_API_URL ?? 'http://localhost:8000';

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
  return payload && typeof payload === 'object' && ('data' in payload || 'meta' in payload || 'error' in payload);
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

function createApiError(message, { status, requestId, details } = {}) {
  const error = new Error(message);
  error.status = status ?? null;
  error.requestId = requestId ?? null;
  error.details = details ?? null;
  return error;
}

function normalizeApiError(responseStatus, payload) {
  const requestId = payload?.meta?.request_id ?? payload?.request_id ?? null;
  const message = payload?.error?.message ?? payload?.detail ?? payload?.message ?? payload?.error ?? `HTTP ${responseStatus}`;
  return createApiError(message, {
    status: responseStatus,
    requestId,
    details: payload?.error ?? payload ?? null,
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
  const qs = buildQuery(params);
  const trimmedBase = API_BASE.endsWith('/') ? API_BASE.slice(0, -1) : API_BASE;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = `${trimmedBase}${normalizedPath}${qs ? `?${qs}` : ''}`;

  const headers = { Accept: 'application/json' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch (_) {
    payload = null;
  }

  if (!response.ok) {
    throw normalizeApiError(response.status, payload);
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
    thumbnailUrl:
      pickFirst(item.thumbnail_url, item.thumbnailUrl, item.frame_url, item.image_url, item.imageUrl, null) ??
      'https://placehold.co/120x68/1e2535/8b9ab4?text=Incident',
    frameIdx: numberOrNull(pickFirst(item.frame_idx, item.frameIdx, null)),
    timestampSec: numberOrNull(pickFirst(item.timestamp_sec, item.timestampSec, null)),
    streamUrl: pickFirst(item.stream_url, item.streamUrl, null),
    jobStatus: pickFirst(item.job_status, item.jobStatus, null),
    createdAt: pickFirst(item.created_at, item.createdAt, null),
    completedAt: pickFirst(item.completed_at, item.completedAt, null),
    signalValues: mapSignalValues(item.signal_values ?? item.signalValues ?? {}),
    raw: item,
  };
}

export function mapIncidentDetailApiToUi(item = {}) {
  return mapIncidentSummaryApiToUi(item);
}

export function mapJobApiToUi(item = {}) {
  const id = pickFirst(item.job_id, item.id, '');
  return {
    id,
    jobId: id,
    status: pickFirst(item.status, 'unknown'),
    message: pickFirst(item.message, null),
    cameraId: pickFirst(item.camera_id, item.cameraId, null),
    streamUrl: pickFirst(item.stream_url, item.streamUrl, null),
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

export async function getLiveFrame(cameraId) {
  // TODO: replace with real endpoint, e.g. GET /cameras/{id}/frame
  return `https://placehold.co/640x360/1e2535/8b9ab4?text=Camera+${cameraId}`;
}

export async function getCameraStatus(request = {}) {
  const { data, meta } = await apiFetch('/cameras/status', { signal: request.signal });
  const items = Array.isArray(data) ? data.map(mapCameraApiToUi) : [];
  return { items, meta: mapMeta(meta) };
}

export async function getIncidents(options = {}, request = {}) {
  const normalized = typeof options === 'number' ? { pageSize: options } : options;
  const rawSort = normalized.sort ?? '-detected_at';
  const { data, meta } = await apiFetch('/incidents', {
    params: {
      page: normalized.page ?? 1,
      page_size: normalized.pageSize ?? 20,
      status: normalized.status,
      min_confidence: normalized.minConfidence,
      job_id: normalized.jobId,
      camera_id: normalized.cameraId,
      detection_type: normalized.detectionType,
      start_time: normalized.startTime,
      end_time: normalized.endTime,
      sort: SORT_REMAP[rawSort] ?? rawSort,
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
  const { data, meta } = await apiFetch(`/incidents/${incidentId}`, {
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

export async function startDetectionJob(payload, request = {}) {
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
