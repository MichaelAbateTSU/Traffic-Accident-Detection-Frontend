import { useState } from 'react';
import { formatDateTime, formatPercent } from '../../utils/formatters.js';
import StatusBadge from '../StatusBadge/StatusBadge.jsx';
import styles from './JobStatusCard.module.css';

function getBadgeStatus(status) {
  const normalized = String(status ?? '').toLowerCase();
  if (normalized === 'complete') return 'resolved';
  if (normalized === 'running') return 'active';
  if (normalized === 'pending') return 'warning';
  if (normalized) return 'critical';
  return 'offline';
}

function getDisplayStatus(status) {
  const normalized = String(status ?? '').toLowerCase();
  if (normalized === 'complete') return 'done';
  if (normalized === 'running') return 'in-progress';
  if (normalized === 'pending') return 'pending';
  return status ?? '—';
}

function FrameImageTile({ label, src, alt }) {
  const [failed, setFailed] = useState(false);
  const hasImage = Boolean(src) && !failed;

  return (
    <div className={styles.frameTile}>
      <div className={styles.frameTileLabelRow}>
        <span className={styles.frameTileLabel}>{label}</span>
        {src && (
          <a href={src} target="_blank" rel="noreferrer" className={styles.frameTileLink}>
            Open
          </a>
        )}
      </div>
      {hasImage ? (
        <img
          src={src}
          alt={alt}
          className={styles.frameTileImage}
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : (
        <div className={styles.frameTileFallback}>Unavailable</div>
      )}
    </div>
  );
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
      {job.artifactsBaseUrl && (
        <a href={job.artifactsBaseUrl} target="_blank" rel="noreferrer" className={styles.link}>
          Open artifacts
        </a>
      )}
      <section className={styles.framesSection} aria-label="Job frame images">
        <div className={styles.sectionTitle}>Frame Images</div>
        {frames.length > 0 ? (
          frames.map((frame) => (
            <div key={frame.frameIndex} className={styles.frameRow}>
              <div className={styles.frameIndex}>Frame #{frame.frameIndex}</div>
              <div className={styles.frameTriplet}>
                <FrameImageTile
                  label="Original"
                  src={frame.capture}
                  alt={`Frame ${frame.frameIndex} original`}
                />
                <FrameImageTile
                  label="Annotated"
                  src={frame.captureAnnotated}
                  alt={`Frame ${frame.frameIndex} annotated`}
                />
                <FrameImageTile
                  label="Pipeline Output"
                  src={frame.pipelineOutput}
                  alt={`Frame ${frame.frameIndex} pipeline output`}
                />
              </div>
            </div>
          ))
        ) : (
          <div className={styles.emptyState}>No frame images returned yet.</div>
        )}
      </section>
      <section className={styles.eventsSection} aria-label="Job events">
        <div className={styles.sectionTitle}>Events ({eventsCount})</div>
        {eventsCount > 0 ? (
          <div className={styles.eventList}>
            {job.events.map((eventItem, index) => (
              <div key={`${eventItem.incidentId ?? 'event'}-${eventItem.frameIdx ?? index}`} className={styles.eventCard}>
                <span><strong>Frame:</strong> {eventItem.frameIdx ?? '—'}</span>
                <span><strong>Timestamp:</strong> {eventItem.timestampSec ?? '—'}s</span>
                <span><strong>Detected:</strong> {eventItem.accidentDetected == null ? '—' : eventItem.accidentDetected ? 'Yes' : 'No'}</span>
                <span><strong>Confidence:</strong> {formatPercent(eventItem.confidenceScore, 2)}</span>
                <span><strong>Raw score:</strong> {formatPercent(eventItem.rawScore, 2)}</span>
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
          <div className={styles.emptyState}>No events returned.</div>
        )}
      </section>
      {job.message && <div className={styles.message}>{job.message}</div>}
      {job.error && <div className={styles.error}>{String(job.error)}</div>}
    </article>
  );
}
