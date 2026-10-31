import { useEffect, useRef, useState } from 'react';
import CameraCard from '../../components/CameraCard/CameraCard.jsx';
import DataState from '../../components/DataState/DataState.jsx';
import MetaInfoPanel from '../../components/MetaInfoPanel/MetaInfoPanel.jsx';
import { getCameraStatus } from '../../services/api.js';
import { FIXED_CAMERA_STREAM_URLS, getCameraIdFromStreamUrl } from '../../constants/cameras.js';
import { formatDateTime } from '../../utils/formatters.js';
import { createBoundedRefresh } from '../../utils/boundedRefresh.js';
import styles from './LiveFeed.module.css';

function mapFixedCameras(statusById = new Map(), statusByStreamUrl = new Map()) {
  return FIXED_CAMERA_STREAM_URLS.map((streamUrl) => {
    const id = getCameraIdFromStreamUrl(streamUrl);
    const statusItem = statusById.get(id) ?? statusByStreamUrl.get(streamUrl);
    return {
      id,
      name: id,
      streamUrl: streamUrl,
      status: statusItem?.status ?? 'unknown',
      fps: statusItem?.fps ?? null,
      lastSeenAt: statusItem?.lastSeenAt ?? null,
      lastJobId: statusItem?.lastJobId ?? null,
    };
  });
}

export default function LiveFeed() {
  const [cameras, setCameras] = useState(mapFixedCameras);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [meta, setMeta] = useState(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null);
  const refreshStatus = useRef(() => {});
  const [pollInterval, setPollInterval] = useState(5000);

  useEffect(() => {
    const loader = createBoundedRefresh(signal => getCameraStatus({ signal }), {
      onLoading: setLoading,
      onResult: ({ items, meta: metaValue }) => {
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
      },
      onError: err => {
        setCameras(mapFixedCameras());
        setError(err.message);
      },
    });
    refreshStatus.current = loader.refresh;
    loader.refresh();
    return loader.stop;
  }, []);

  useEffect(() => {
    if (!pollInterval) return undefined;
    const interval = setInterval(() => refreshStatus.current(), pollInterval);
    return () => clearInterval(interval);
  }, [pollInterval]);

  const onlineCount = cameras.filter((camera) => camera.status === 'online').length;
  const warningCount = cameras.filter((camera) => camera.status === 'warning').length;
  const offlineCount = cameras.filter((camera) => camera.status === 'offline').length;
  const unknownCount = cameras.length - onlineCount - warningCount - offlineCount;

  return (
    <main className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Live Feed</h1>
          <span className={styles.subtitle}>Raw camera playback, not YOLO-processed. Status reflects the latest retained detection job, not source health. Untested sources are unknown; playback may fail independently.</span>
        </div>
        <div className={styles.controls}>
          <label htmlFor="poll-interval" className={styles.controlLabel}>Job status refresh</label>
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
          <button type="button" className={styles.refreshBtn} onClick={() => refreshStatus.current()}>
            Refresh job status
          </button>
        </div>
      </div>

      {cameras.length > 0 && (
        <div className={styles.summary}>
          <span className={styles.summaryItem}>
            <span className={styles.dot} data-status="online" />
            {onlineCount} Sources with latest job pending/running
          </span>
          {warningCount > 0 && (
            <span className={styles.summaryItem}>
              <span className={styles.dot} data-status="warning" />
              {warningCount} Sources with latest job failed
            </span>
          )}
          {offlineCount > 0 && (
            <span className={styles.summaryItem}>
              <span className={styles.dot} data-status="offline" />
              {offlineCount} Sources with latest job complete
            </span>
          )}
          <span className={styles.summaryItem}>{unknownCount} Sources with unknown latest job state</span>
          {lastUpdatedAt && <span className={styles.summaryItem}>Updated: {formatDateTime(lastUpdatedAt)}</span>}
        </div>
      )}

      <DataState
        loading={false}
        error={null}
        isEmpty={!cameras.length}
        emptyMessage="No cameras configured."
        onRetry={() => refreshStatus.current()}
        loadingMessage="Loading camera statuses..."
        loadingVariant="skeleton"
        loadingRows={4}
      >
        {loading && <p role="status">Refreshing job metadata; raw playback remains available.</p>}
        {error && <p role="alert">Job status refresh failed: {error}. Raw playback can still be attempted; source health is unknown.</p>}
        <div className={styles.grid}>
          {cameras.map((camera) => (
            <CameraCard key={camera.id} camera={camera} />
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
