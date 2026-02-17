import { useState, useEffect } from 'react';
import StatusBadge from '../StatusBadge/StatusBadge.jsx';
import { getLiveFrame } from '../../services/api.js';
import styles from './CameraCard.module.css';

/**
 * CameraCard — displays a single camera feed with polling.
 * @param {{ id: string, name: string, status: string, fps: number }} camera
 * @param {number} [pollInterval=5000]  — ms between frame refreshes (0 = no polling)
 */
export default function CameraCard({ camera, pollInterval = 5000 }) {
  const [frameUrl, setFrameUrl] = useState(null);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchFrame() {
      try {
        const url = await getLiveFrame(camera.id);
        if (!cancelled) {
          setFrameUrl(url);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchFrame();

    if (pollInterval > 0 && camera.status !== 'offline') {
      const interval = setInterval(fetchFrame, pollInterval);
      return () => { cancelled = true; clearInterval(interval); };
    }

    return () => { cancelled = true; };
  }, [camera.id, camera.status, pollInterval]);

  return (
    <article className={styles.card}>
      <div className={styles.imageWrapper}>
        {loading && (
          <div className={styles.placeholder}>
            <span className={styles.loadingText}>Loading…</span>
          </div>
        )}
        {!loading && error && (
          <div className={styles.placeholder}>
            <span className={styles.errorText}>⚠ Feed unavailable</span>
          </div>
        )}
        {!loading && !error && frameUrl && (
          <img
            src={frameUrl}
            alt={`Live feed from ${camera.name}`}
            className={styles.frame}
          />
        )}
        {camera.status === 'offline' && (
          <div className={styles.offlineOverlay}>
            <span>OFFLINE</span>
          </div>
        )}
      </div>

      <div className={styles.footer}>
        <div className={styles.info}>
          <span className={styles.cameraId}>{camera.id}</span>
          <span className={styles.cameraName}>{camera.name}</span>
        </div>
        <div className={styles.meta}>
          <StatusBadge status={camera.status} />
          {camera.status !== 'offline' && (
            <span className={styles.fps}>{camera.fps} fps</span>
          )}
        </div>
      </div>
    </article>
  );
}
