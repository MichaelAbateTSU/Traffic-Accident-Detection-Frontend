import { useEffect, useState } from 'react';
import CameraCard from '../../components/CameraCard/CameraCard.jsx';
import DataState from '../../components/DataState/DataState.jsx';
import MetaInfoPanel from '../../components/MetaInfoPanel/MetaInfoPanel.jsx';
import { getCameraStatus } from '../../services/api.js';
import { FIXED_CAMERA_STREAM_URLS, getCameraIdFromStreamUrl } from '../../constants/cameras.js';
import { formatDateTime } from '../../utils/formatters.js';
import styles from './LiveFeed.module.css';

function mapFixedCameras(statusById = new Map(), statusByStreamUrl = new Map()) {
  return FIXED_CAMERA_STREAM_URLS.map((streamUrl) => {
    const id = getCameraIdFromStreamUrl(streamUrl);
    const statusItem = statusById.get(id) ?? statusByStreamUrl.get(streamUrl);
    return {
      id,
      name: id,
      streamUrl: streamUrl,
      status: statusItem?.status ?? 'online',
      fps: statusItem?.fps ?? null,
      lastSeenAt: statusItem?.lastSeenAt ?? null,
      lastJobId: statusItem?.lastJobId ?? null,
    };
  });
}

export default function LiveFeed() {
  const [cameras, setCameras] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [meta, setMeta] = useState(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [pollInterval, setPollInterval] = useState(5000);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const { items, meta: metaValue } = await getCameraStatus({ signal: controller.signal });
        const statusById = new Map(
          items.map((item) => [String(item.id), item]),
        );
        const statusByStreamUrl = new Map(
          items
            .filter((item) => item.streamUrl)
            .map((item) => [String(item.streamUrl), item]),
        );
        setCameras(mapFixedCameras(statusById, statusByStreamUrl));
        setMeta(metaValue);
        setLastUpdatedAt(new Date().toISOString());
        setError(null);
      } catch (err) {
        if (err.name === 'AbortError') return;
        setCameras(mapFixedCameras());
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    load();
    return () => controller.abort();
  }, [refreshKey]);

  const onlineCount = cameras.filter((camera) => camera.status === 'online').length;
  const warningCount = cameras.filter((camera) => camera.status === 'warning').length;
  const offlineCount = cameras.filter((camera) => camera.status === 'offline').length;

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
            onChange={(event) => setPollInterval(Number(event.target.value))}
          >
            <option value={2000}>2s</option>
            <option value={5000}>5s</option>
            <option value={10000}>10s</option>
            <option value={30000}>30s</option>
            <option value={0}>Manual</option>
          </select>
          <button type="button" className={styles.refreshBtn} onClick={() => setRefreshKey((value) => value + 1)}>
            Refresh status
          </button>
        </div>
      </div>

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
          {lastUpdatedAt && <span className={styles.summaryItem}>Updated: {formatDateTime(lastUpdatedAt)}</span>}
        </div>
      )}

      <DataState
        loading={loading}
        error={error}
        isEmpty={!cameras.length}
        emptyMessage="No cameras configured."
        onRetry={() => setRefreshKey((value) => value + 1)}
        loadingMessage="Loading camera statuses..."
        loadingVariant="skeleton"
        loadingRows={4}
      >
        <div className={styles.grid}>
          {cameras.map((camera) => (
            <CameraCard key={camera.id} camera={camera} pollInterval={pollInterval} />
          ))}
        </div>
      </DataState>
      <details className={styles.advancedDetails}>
        <summary>Advanced Details</summary>
        <MetaInfoPanel meta={meta} title="Camera status meta" />
      </details>
    </main>
  );
}
