const API_BASE =
  import.meta.env.VITE_API_BASE_URL ??
  import.meta.env.VITE_API_URL ??
  'http://localhost:8000';

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
  return (
    payload &&
    typeof payload === 'object' &&
    ('data' in payload || 'meta' in payload || 'error' in payload)
  );
}

function normalizeDetectionStatus(value) {
  const normalized = String(value ?? '').toLowerCase();
  if (['active', 'degraded', 'offline'].includes(normalized)) return normalized;
  if (['running', 'ok', 'healthy', 'online'].includes(normalized)) return 'active';
  if (['warning', 'warn'].includes(normalized)) return 'degraded';
  return normalized || 'offline';
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
  const message =
    payload?.error?.message ??
    payload?.detail ??
    payload?.message ??
    payload?.error ??
    `HTTP ${responseStatus}`;
  return createApiError(message, {
    status: responseStatus,
    requestId,
    details: payload?.error ?? payload ?? null,
  });
}

export async function apiFetch(path, { method = 'GET', params, body, signal } = {}) {
  const qs = buildQuery(params);
  const trimmedBase = API_BASE.endsWith('/') ? API_BASE.slice(0, -1) : API_BASE;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = `${trimmedBase}${normalizedPath}${qs ? `?${qs}` : ''}`;

  const headers = {
    Accept: 'application/json',
  };
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
    activeCameras: data.active_cameras ?? data.activeCameras ?? 0,
    totalCameras: data.total_cameras ?? data.totalCameras ?? 0,
    incidentsToday: data.incidents_today ?? data.incidentsToday ?? 0,
    detectionStatus: normalizeDetectionStatus(data.detection_status ?? data.detectionStatus),
    uptimePercent: data.uptime_percent ?? data.uptimePercent ?? 0,
    activeJobs: data.active_jobs ?? data.activeJobs ?? 0,
    totalJobs: data.total_jobs ?? data.totalJobs ?? 0,
    refreshedAt: data.refreshed_at ?? data.refreshedAt ?? null,
  };
}

export function mapIncidentSummaryApiToUi(item = {}) {
  const id = item.incident_id ?? item.id ?? '';
  const cameraId = item.camera_id ?? item.cameraId ?? 'Unknown';
  const detectedAt = item.detected_at ?? item.detectedAt ?? item.timestamp ?? null;
  const confidenceScore = item.confidence_score ?? item.confidenceScore ?? item.confidence ?? 0;
  const status = item.status ?? (item.resolved ? 'resolved' : 'active');
  const resolved = item.resolved ?? String(status).toLowerCase() === 'resolved';

  return {
    id,
    incidentId: id,
    jobId: item.job_id ?? item.jobId ?? null,
    cameraId,
    cameraName: item.camera_name ?? item.cameraName ?? `Camera ${cameraId}`,
    type: item.detection_type ?? item.type ?? 'Unknown',
    resolved,
    status,
    confidenceScore: Number(confidenceScore ?? 0),
    confidence: Number(confidenceScore ?? 0),
    rawScore: item.raw_score ?? item.rawScore ?? null,
    detectedAt,
    timestamp: detectedAt,
    boundingBox: item.bounding_box ?? item.boundingBox ?? null,
    involvedTrackIds: item.involved_track_ids ?? item.involvedTrackIds ?? [],
    thumbnailUrl:
      item.thumbnail_url ??
      item.thumbnailUrl ??
      item.frame_url ??
      item.image_url ??
      item.imageUrl ??
      'https://placehold.co/120x68/1e2535/8b9ab4?text=Incident',
  };
}

export function mapIncidentDetailApiToUi(item = {}) {
  const summary = mapIncidentSummaryApiToUi(item);
  return {
    ...summary,
    streamUrl: item.stream_url ?? item.streamUrl ?? null,
    maxFrames: item.max_frames ?? item.maxFrames ?? null,
    saveFrames: item.save_frames ?? item.saveFrames ?? null,
    metadata: item.metadata ?? {},
  };
}

export function mapJobApiToUi(item = {}) {
  return {
    id: item.job_id ?? item.id ?? '',
    status: item.status ?? 'unknown',
    streamUrl: item.stream_url ?? item.streamUrl ?? null,
    createdAt: item.created_at ?? item.createdAt ?? null,
    startedAt: item.started_at ?? item.startedAt ?? null,
    completedAt: item.completed_at ?? item.completedAt ?? null,
    updatedAt: item.updated_at ?? item.updatedAt ?? null,
    progress: item.progress ?? null,
    totalDetections: item.total_detections ?? item.totalDetections ?? null,
    errorMessage: item.error_message ?? item.errorMessage ?? null,
  };
}

// ─── Camera / Live Feed ─────────────────────────────────────────────────────

/**
 * Returns the URL of the latest YOLO-processed frame for a camera.
 * The backend may return an image directly or a JSON payload with a URL.
 *
 * @param {string|number} cameraId
 * @returns {Promise<string>} image URL
 */
export async function getLiveFrame(cameraId) {
  // TODO: replace with real endpoint, e.g. GET /api/cameras/{id}/frame
  // return `${BASE_URL}/cameras/${cameraId}/frame`;

  // STUB — returns a placeholder image URL for development
  return `https://placehold.co/640x360/1e2535/8b9ab4?text=Camera+${cameraId}`;
}

/**
 * Returns status information for all monitored cameras.
 *
 * @returns {Promise<Array<{id: string, status: 'online'|'warning'|'offline', stream_url: string, last_job_id: string, last_seen_at: string}>>}
 */
export async function getCameraStatus(request = {}) {
  const { data } = await apiFetch('/cameras/status', { signal: request.signal });
  return Array.isArray(data) ? data : [];
}

// ─── Incidents ──────────────────────────────────────────────────────────────

/**
 * Returns a list of detected accident incidents, most recent first.
 *
 * @param {number} [limit=20]
 * @returns {Promise<Array<{
 *   id: string,
 *   cameraId: string,
 *   cameraName: string,
 *   timestamp: string,       // ISO 8601
 *   type: string,            // e.g. "Collision", "Debris"
 *   confidence: number,      // 0–1
 *   thumbnailUrl: string,
 *   resolved: boolean,
 * }>>}
 */
const SORT_REMAP = {
  '-confidence_score': '-confidence',
  'confidence_score': 'confidence',
};

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
  return { items, meta };
}

// ─── Dashboard Stats ─────────────────────────────────────────────────────────

/**
 * Returns high-level statistics for the dashboard.
 *
 * @returns {Promise<{
 *   activeCameras: number,
 *   totalCameras: number,
 *   incidentsToday: number,
 *   detectionStatus: 'active'|'degraded'|'offline',
 *   uptimePercent: number,
 * }>}
 */
export async function getStats({ historyDays = 30 } = {}, request = {}) {
  const { data, meta } = await apiFetch('/stats/overview', {
    params: { history_days: historyDays },
    signal: request.signal,
  });
  return { ...mapStatsApiToUi(data), _meta: meta };
}

/**
 * Single-call bootstrap for the Dashboard page.
 * Returns stats, recent incidents, and camera statuses in one response.
 */
export async function getDashboard(options = {}, request = {}) {
  const { data } = await apiFetch('/dashboard', {
    params: {
      history_days: options.historyDays,
      incidents_page_size: options.incidentsPageSize,
      incidents_status: options.incidentsStatus,
    },
    signal: request.signal,
  });
  return data;
}

export async function getIncidentById(incidentId, request = {}) {
  const { data, meta } = await apiFetch(`/incidents/${incidentId}`, {
    signal: request.signal,
  });
  return { item: mapIncidentDetailApiToUi(data), meta };
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
  return { items, meta };
}

export async function getJobStatus(jobId, request = {}) {
  const { data, meta } = await apiFetch(`/jobs/${jobId}/status`, {
    signal: request.signal,
  });
  return { item: mapJobApiToUi(data), meta };
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
  const mapper = options.detail === 'full' ? mapIncidentDetailApiToUi : mapIncidentSummaryApiToUi;
  const items = Array.isArray(data) ? data.map(mapper) : [];
  return { items, meta };
}

export async function startDetectionJob(payload, request = {}) {
  const { data, meta } = await apiFetch('/detect-accident', {
    method: 'POST',
    body: payload,
    signal: request.signal,
  });
  return { item: mapJobApiToUi(data ?? {}), meta };
}

export async function getJob(jobId, request = {}) {
  const { data, meta } = await apiFetch(`/jobs/${jobId}`, {
    signal: request.signal,
  });
  return { item: mapJobApiToUi(data), meta };
}

export async function getHealth(request = {}) {
  const { data, meta } = await apiFetch('/health', {
    signal: request.signal,
  });
  return { data, meta };
}
