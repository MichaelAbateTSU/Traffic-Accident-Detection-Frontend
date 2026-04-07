import { formatDateTime, formatPercent } from '../../utils/formatters.js';
import StatusBadge from '../StatusBadge/StatusBadge.jsx';
import styles from './JobStatusCard.module.css';

function getBadgeStatus(status) {
  const normalized = String(status ?? '').toLowerCase();
  if (normalized === 'complete') return 'resolved';
  if (normalized === 'pending') return 'warning';
  if (normalized) return 'critical';
  return 'offline';
}

function getDisplayStatus(status) {
  const normalized = String(status ?? '').toLowerCase();
  if (normalized === 'running') return 'done';
  if (normalized === 'pending') return 'complete';
  return status ?? '—';
}

export default function JobStatusCard({ job }) {
  if (!job) return null;
  const displayStatus = getDisplayStatus(job.status);
  const eventsCount = Array.isArray(job.events) ? job.events.length : 0;
  const accidentLabel =
    job.accidentDetected == null
      ? '—'
      : job.accidentDetected
        ? 'Yes'
        : 'No';
  const accidentClassName =
    job.accidentDetected == null
      ? ''
      : job.accidentDetected
        ? styles.accidentYes
        : styles.accidentNo;

  return (
    <article className={styles.card}>
      <div className={styles.row}>
        <span className={styles.id}>Job ID: {job.id}</span>
        <StatusBadge status={getBadgeStatus(job.status)} label={displayStatus} />
      </div>

      <div className={styles.grid}>
        <span><strong>Status:</strong> {displayStatus}</span>
        <span><strong>Frames processed:</strong> {job.framesProcessed ?? '—'}</span>
        <span><strong>Max frames:</strong> {job.maxFrames ?? '—'}</span>
        <span><strong>Save frames:</strong> {job.saveFrames == null ? '—' : job.saveFrames ? 'Yes' : 'No'}</span>
        <span className={accidentClassName}><strong>Accident detected:</strong> {accidentLabel}</span>
        <span><strong>Peak confidence:</strong> {formatPercent(job.peakConfidence, 2)}</span>
        <span><strong>Events:</strong> {eventsCount}</span>
        <span><strong>Created:</strong> {formatDateTime(job.createdAt)}</span>
        <span><strong>Completed:</strong> {formatDateTime(job.completedAt)}</span>
      </div>
      {job.streamUrl && (
        <a href={job.streamUrl} target="_blank" rel="noreferrer" className={styles.link}>
          Open stream
        </a>
      )}
      {job.message && <div className={styles.message}>{job.message}</div>}
      {job.error && <div className={styles.error}>{String(job.error)}</div>}
    </article>
  );
}
