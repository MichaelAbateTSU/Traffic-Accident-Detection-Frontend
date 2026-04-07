import { Link } from 'react-router-dom';
import StatusBadge from '../StatusBadge/StatusBadge.jsx';
import { formatDateTime } from '../../utils/formatters.js';
import styles from './CameraPreviewCard.module.css';

export default function CameraPreviewCard({ camera }) {
  const cameraId = camera?.id ?? 'unknown';
  const cameraName = camera?.name ?? cameraId;
  const status = camera?.status ?? 'offline';
  const lastSeen = camera?.lastSeenAt ?? camera?.last_seen_at ?? null;
  const targetPath = cameraId ? `/camera/${encodeURIComponent(cameraId)}` : '/live';

  return (
    <Link to={targetPath} className={styles.card}>
      <div className={styles.preview}>
        <span className={styles.previewLabel}>Live Preview</span>
        <StatusBadge status={status} />
      </div>
      <div className={styles.meta}>
        <span className={styles.id}>{cameraId}</span>
        <span className={styles.name}>{cameraName}</span>
        {lastSeen && <span className={styles.time}>Last seen: {formatDateTime(lastSeen)}</span>}
      </div>
    </Link>
  );
}
