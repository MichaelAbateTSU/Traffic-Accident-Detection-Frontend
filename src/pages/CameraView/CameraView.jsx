import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import CameraPlayer from '../../components/CameraPlayer/CameraPlayer.jsx';
import StatusBadge from '../../components/StatusBadge/StatusBadge.jsx';
import { getStreamUrlForCameraId } from '../../constants/cameras.js';
import { getCameraStatus } from '../../services/api.js';
import { formatDateTime } from '../../utils/formatters.js';
import styles from './CameraView.module.css';

function pickCameraById(items, cameraId) {
  return items.find((item) => String(item.id) === String(cameraId)) ?? null;
}

export default function CameraView() {
  const navigate = useNavigate();
  const { id: routeId } = useParams();
  const location = useLocation();
  const state = location.state ?? {};
  const cameraId = String(routeId ?? state.id ?? '');

  const fallbackStreamUrl = useMemo(
    () => (cameraId ? getStreamUrlForCameraId(cameraId) : null),
    [cameraId],
  );

  const [camera, setCamera] = useState({
    id: cameraId,
    name: state.name ?? cameraId,
    streamUrl: state.streamUrl ?? fallbackStreamUrl,
    status: state.status ?? 'online',
    fps: state.fps ?? null,
    lastSeenAt: state.lastSeenAt ?? null,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [playerLoading, setPlayerLoading] = useState(false);
  const [playerError, setPlayerError] = useState(null);

  useEffect(() => {
    if (!cameraId) return undefined;
    let cancelled = false;
    const controller = new AbortController();

    const load = async () => {
      try {
        const { items } = await getCameraStatus({ signal: controller.signal });
        if (cancelled) return;
        const statusItem = pickCameraById(items, cameraId);
        if (!statusItem) {
          setLoading(false);
          return;
        }
        setCamera((prev) => ({
          ...prev,
          id: statusItem.id,
          name: statusItem.name ?? prev.name,
          streamUrl: statusItem.streamUrl ?? prev.streamUrl ?? fallbackStreamUrl,
          status: statusItem.status ?? prev.status,
          fps: statusItem.fps ?? prev.fps,
          lastSeenAt: statusItem.lastSeenAt ?? prev.lastSeenAt,
        }));
        setError(null);
      } catch (err) {
        if (err.name === 'AbortError') return;
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    const interval = setInterval(load, 10000);

    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(interval);
    };
  }, [cameraId, fallbackStreamUrl]);

  useEffect(() => {
    setCamera((prev) => ({
      ...prev,
      id: cameraId,
      name: state.name ?? prev.name ?? cameraId,
      streamUrl: state.streamUrl ?? prev.streamUrl ?? fallbackStreamUrl,
      status: state.status ?? prev.status ?? 'online',
      fps: state.fps ?? prev.fps ?? null,
      lastSeenAt: state.lastSeenAt ?? prev.lastSeenAt ?? null,
    }));
  }, [cameraId, fallbackStreamUrl, state.fps, state.lastSeenAt, state.name, state.status, state.streamUrl]);

  const hasStream = Boolean(camera.streamUrl);
  const isOffline = camera.status === 'offline';
  const canPlay = hasStream && !isOffline;

  const handleBack = () => {
    if (window.history.length > 1) {
      navigate(-1);
      return;
    }
    navigate('/live');
  };

  if (!cameraId) {
    return (
      <main className={styles.page}>
        <div className={styles.notFound}>
          <h1>Camera not found</h1>
          <p>Missing camera ID in the current route.</p>
          <Link to="/live" className={styles.backLink}>Back to Live Feed</Link>
        </div>
      </main>
    );
  }

  if (!hasStream && !loading) {
    return (
      <main className={styles.page}>
        <div className={styles.notFound}>
          <h1>Camera unavailable</h1>
          <p>No stream URL is configured for camera {cameraId}.</p>
          <Link to="/live" className={styles.backLink}>Back to Live Feed</Link>
        </div>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <section className={styles.viewer}>
        {canPlay && (
          <CameraPlayer
            src={camera.streamUrl}
            active={canPlay}
            muted={false}
            preview={false}
            onLoadingChange={setPlayerLoading}
            onFatalError={setPlayerError}
            videoClassName={styles.video}
          />
        )}
        {!canPlay && (
          <div className={styles.offlinePanel}>
            <h2>Camera Offline</h2>
            <p>{camera.lastSeenAt ? `Last seen: ${formatDateTime(camera.lastSeenAt)}` : 'No recent heartbeat available.'}</p>
          </div>
        )}

        <div className={styles.overlay}>
          <button type="button" className={styles.backButton} onClick={handleBack}>
            Back
          </button>
          <div className={styles.titleGroup}>
            <h1>{camera.name ?? camera.id}</h1>
            <StatusBadge status={camera.status} />
          </div>
          <div className={styles.meta}>
            {camera.fps != null && <span>FPS: {camera.fps}</span>}
            {camera.lastSeenAt && <span>Last seen: {formatDateTime(camera.lastSeenAt)}</span>}
            {loading && <span>Refreshing status...</span>}
            {playerLoading && <span>Initializing stream...</span>}
            {playerError && <span className={styles.error}>{playerError}</span>}
            {error && <span className={styles.error}>Status refresh failed</span>}
          </div>
        </div>
      </section>
    </main>
  );
}
