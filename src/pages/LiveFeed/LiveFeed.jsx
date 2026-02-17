import { useState, useEffect } from 'react';
import CameraCard  from '../../components/CameraCard/CameraCard.jsx';
import AlertBanner from '../../components/AlertBanner/AlertBanner.jsx';
import { getCameraStatus } from '../../services/api.js';
import styles from './LiveFeed.module.css';

export default function LiveFeed() {
  const [cameras,     setCameras]     = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState(null);
  const [pollInterval, setPollInterval] = useState(5000);

  useEffect(() => {
    async function load() {
      try {
        const data = await getCameraStatus();
        setCameras(data);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const onlineCount  = cameras.filter(c => c.status === 'online').length;
  const warningCount = cameras.filter(c => c.status === 'warning').length;
  const offlineCount = cameras.filter(c => c.status === 'offline').length;

  return (
    <main className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Live Feed</h1>
          <span className={styles.subtitle}>Real-time YOLO-processed camera streams</span>
        </div>
        <div className={styles.controls}>
          <label htmlFor="poll-interval" className={styles.controlLabel}>Refresh</label>
          <select
            id="poll-interval"
            className={styles.select}
            value={pollInterval}
            onChange={e => setPollInterval(Number(e.target.value))}
          >
            <option value={2000}>2s</option>
            <option value={5000}>5s</option>
            <option value={10000}>10s</option>
            <option value={30000}>30s</option>
            <option value={0}>Manual</option>
          </select>
        </div>
      </div>

      {error && (
        <AlertBanner type="warning" message="Could not load camera list" detail={error} />
      )}

      {!loading && cameras.length > 0 && (
        <div className={styles.summary}>
          <span className={styles.summaryItem}>
            <span className={styles.dot} data-status="online" />
            {onlineCount} Online
          </span>
          {warningCount > 0 && (
            <span className={styles.summaryItem}>
              <span className={styles.dot} data-status="warning" />
              {warningCount} Warning
            </span>
          )}
          {offlineCount > 0 && (
            <span className={styles.summaryItem}>
              <span className={styles.dot} data-status="offline" />
              {offlineCount} Offline
            </span>
          )}
        </div>
      )}

      {loading ? (
        <div className={styles.loading}>Loading cameras…</div>
      ) : cameras.length === 0 ? (
        <div className={styles.empty}>No cameras configured.</div>
      ) : (
        <div className={styles.grid}>
          {cameras.map(camera => (
            <CameraCard key={camera.id} camera={camera} pollInterval={pollInterval} />
          ))}
        </div>
      )}
    </main>
  );
}
