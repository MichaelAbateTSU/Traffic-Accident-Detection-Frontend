import FrameGallery from '../FrameGallery/FrameGallery.jsx';
import { formatDateTime, formatNumber } from '../../utils/formatters.js';
import StatusBadge from '../StatusBadge/StatusBadge.jsx';
import styles from './JobStatusCard.module.css';

function getBadgeStatus(status) {
  const normalized = String(status ?? '').toLowerCase();
  if (normalized === 'complete') return 'resolved';
  if (normalized === 'running') return 'active';
  if (normalized === 'pending') return 'warning';
  if (normalized === 'unavailable') return 'offline';
  if (normalized) return 'critical';
  return 'offline';
}

function getDisplayStatus(status) {
  const normalized = String(status ?? '').toLowerCase();
  if (normalized === 'complete') return 'done';
  if (normalized === 'running') return 'in-progress';
  if (normalized === 'pending') return 'pending';
  if (normalized === 'unavailable') return 'unavailable (outcome unknown)';
  return status ?? '—';
}

function formatBoundingBox(boundingBox) {
  if (!boundingBox?.values || boundingBox.values.length !== 4) return '—';
  return `[${boundingBox.values.map((value) => Number(value).toFixed(1)).join(', ')}]`;
}

export default function JobStatusCard({ job }) {
  if (!job) return null;
  const displayStatus = getDisplayStatus(job.status);
  const eventsCount = job.eventCount ?? (Array.isArray(job.events) ? job.events.length : 0);
  const frames = Array.isArray(job.frames) ? job.frames : [];
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
        <span><strong>Camera:</strong> {job.cameraId ?? '—'}</span>
        <span><strong>Frames processed:</strong> {job.framesProcessed ?? '—'}</span>
        <span><strong>Frames received:</strong> {frames.length}</span>
        <span><strong>Max frames:</strong> {job.maxFrames ?? '—'}</span>
        <span><strong>Save frames:</strong> {job.saveFrames == null ? '—' : job.saveFrames ? 'Yes' : 'No'}</span>
        <span className={accidentClassName}><strong>Heuristic alarm reported:</strong> {accidentLabel}</span>
        <span><strong>Peak heuristic accident score (0-1):</strong> {formatNumber(job.peakConfidence, 2)}</span>
        <span><strong>Alarm-frame records:</strong> {eventsCount}</span>
        <span><strong>Created:</strong> {formatDateTime(job.createdAt)}</span>
        <span><strong>Completed:</strong> {formatDateTime(job.completedAt)}</span>
      </div>
      <p>Accident scores are smoothed weighted heuristics, not calibrated probabilities or YOLO object-detection confidence.</p>
      <p>One record is emitted for each processed frame with an active heuristic alarm. Consecutive records may belong to one alarm episode; they are not unique or confirmed accidents.</p>
      {job.streamUrl && (
        <a href={job.streamUrl} target="_blank" rel="noreferrer" className={styles.link}>
          Open stream
        </a>
      )}
      <section className={styles.framesSection} aria-label="Job frame images">
        <div className={styles.sectionTitle}>Frame Images</div>
        {frames.length > 0 ? (
          <FrameGallery frames={frames} jobId={job.id} />
        ) : (
          <div className={styles.emptyState}>No frame images returned yet.</div>
        )}
      </section>
      <section className={styles.eventsSection} aria-label="Job alarm-frame records">
        <div className={styles.sectionTitle}>Alarm frames ({eventsCount})</div>
        {eventsCount > 0 ? (
          <div className={styles.eventList}>
            {job.events.map((eventItem, index) => (
              <div key={`${eventItem.incidentId ?? 'event'}-${eventItem.frameIdx ?? index}`} className={styles.eventCard}>
                <span><strong>Frame:</strong> {eventItem.frameIdx ?? '—'}</span>
                <span><strong>Processing elapsed time:</strong> {eventItem.timestampSec ?? '—'}s (wall-clock since job start, not source-video time)</span>
                <span><strong>Heuristic alarm:</strong> {eventItem.accidentDetected == null ? '—' : eventItem.accidentDetected ? 'Yes' : 'No'}</span>
                <span><strong>Heuristic accident score (0-1):</strong> {formatNumber(eventItem.confidenceScore, 2)}</span>
                <span><strong>Raw heuristic score (0-1):</strong> {formatNumber(eventItem.rawScore, 2)}</span>
                <span><strong>Bounding box:</strong> {formatBoundingBox(eventItem.boundingBox)}</span>
                <span>
                  <strong>Tracks:</strong>{' '}
                  {Array.isArray(eventItem.involvedTrackIds) && eventItem.involvedTrackIds.length
                    ? eventItem.involvedTrackIds.join(', ')
                    : '—'}
                </span>
                <span>
                  <strong>Signals:</strong>{' '}
                  {eventItem.signalValues?.entries?.length
                    ? eventItem.signalValues.entries.map((entry) => `${entry.key}: ${entry.value}`).join(' | ')
                    : '—'}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className={styles.emptyState}>No alarm-frame records returned.</div>
        )}
      </section>
      {job.message && <div className={styles.message}>{job.message}</div>}
      {job.error && <div className={styles.error}>{String(job.error)}</div>}
      {job.monitorError && <div className={styles.error} role="alert">{job.monitorError}</div>}
    </article>
  );
}
