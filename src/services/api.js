/**
 * api.js
 * -------
 * Thin wrapper around the Traffic Accident Detection backend API.
 * All functions return Promises.
 *
 * BASE_URL is read from the environment variable VITE_API_URL, falling back to
 * '/api' which Vite proxies to http://localhost:8000 in development (see vite.config.js).
 *
 * Replace the stub implementations with real fetch calls once the backend is
 * running and you know the exact endpoint shapes.
 */

const BASE_URL = import.meta.env.VITE_API_URL ?? '/api';

// ─── Helpers ────────────────────────────────────────────────────────────────

async function get(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${res.statusText}`);
  return res.json();
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
 * @returns {Promise<Array<{id: string, name: string, status: 'online'|'warning'|'offline', fps: number}>>}
 */
export async function getCameraStatus() {
  // TODO: replace with real endpoint, e.g. GET /api/cameras
  // return get('/cameras');

  // STUB
  return [
    { id: 'CAM-01', name: 'Highway I-95 North', status: 'online',  fps: 24 },
    { id: 'CAM-02', name: 'Highway I-95 South', status: 'online',  fps: 24 },
    { id: 'CAM-03', name: 'Exit 22 Interchange', status: 'warning', fps: 12 },
    { id: 'CAM-04', name: 'Downtown Overpass',   status: 'offline', fps: 0  },
  ];
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
export async function getIncidents(limit = 20) {
  // TODO: replace with real endpoint, e.g. GET /api/incidents?limit=20
  // return get(`/incidents?limit=${limit}`);

  // STUB
  const now = Date.now();
  const minute = 60 * 1000;

  return [
    {
      id: 'INC-001',
      cameraId: 'CAM-01',
      cameraName: 'Highway I-95 North',
      timestamp: new Date(now - 5 * minute).toISOString(),
      type: 'Collision',
      confidence: 0.94,
      thumbnailUrl: 'https://placehold.co/120x68/1e2535/ef4444?text=INC-001',
      resolved: false,
    },
    {
      id: 'INC-002',
      cameraId: 'CAM-03',
      cameraName: 'Exit 22 Interchange',
      timestamp: new Date(now - 32 * minute).toISOString(),
      type: 'Debris',
      confidence: 0.81,
      thumbnailUrl: 'https://placehold.co/120x68/1e2535/f59e0b?text=INC-002',
      resolved: true,
    },
    {
      id: 'INC-003',
      cameraId: 'CAM-02',
      cameraName: 'Highway I-95 South',
      timestamp: new Date(now - 78 * minute).toISOString(),
      type: 'Stalled Vehicle',
      confidence: 0.77,
      thumbnailUrl: 'https://placehold.co/120x68/1e2535/3b82f6?text=INC-003',
      resolved: true,
    },
    {
      id: 'INC-004',
      cameraId: 'CAM-01',
      cameraName: 'Highway I-95 North',
      timestamp: new Date(now - 140 * minute).toISOString(),
      type: 'Collision',
      confidence: 0.98,
      thumbnailUrl: 'https://placehold.co/120x68/1e2535/ef4444?text=INC-004',
      resolved: true,
    },
  ].slice(0, limit);
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
export async function getStats() {
  // TODO: replace with real endpoint, e.g. GET /api/stats
  // return get('/stats');

  // STUB
  return {
    activeCameras: 3,
    totalCameras: 4,
    incidentsToday: 2,
    detectionStatus: 'active',
    uptimePercent: 99.2,
  };
}
