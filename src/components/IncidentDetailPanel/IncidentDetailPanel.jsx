import { useEffect, useState } from 'react';
import DetectionSignalsChart from '../charts/DetectionSignalsChart.jsx';
import StatusBadge from '../StatusBadge/StatusBadge.jsx';
import { updateIncidentStatus } from '../../services/api.js';
import { formatDateTime, formatPercent } from '../../utils/formatters.js';
import styles from './IncidentDetailPanel.module.css';

const NOTE_MAX_LENGTH = 500;

function boxText(box) {
  if (!box) return '—';
  return `x1:${box.x1.toFixed(1)}, y1:${box.y1.toFixed(1)}, x2:${box.x2.toFixed(1)}, y2:${box.y2.toFixed(1)} | w:${box.width.toFixed(1)} h:${box.height.toFixed(1)} area:${box.area.toFixed(1)}`;
}

/**
 * @param {{ incident: object | null, onIncidentUpdated?: (incident: object) => void }} props
 */
export default function IncidentDetailPanel({ incident, onIncidentUpdated }) {
  const [current, setCurrent] = useState(incident);
  const [note, setNote] = useState(incident?.note ?? '');
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState(null);

  useEffect(() => {
    setCurrent(incident);
    setNote(incident?.note ?? '');
    setActionError(null);
  }, [incident]);

  if (!current) return null;

  const isResolved = Boolean(current.resolved);
  const noteChanged = note !== (current.note ?? '');

  const submit = async (nextStatus) => {
    setSaving(true);
    setActionError(null);
    try {
      const { item } = await updateIncidentStatus(current.id, { status: nextStatus, note });
      setCurrent(item);
      setNote(item.note ?? '');
      onIncidentUpdated?.(item);
    } catch (err) {
      setActionError(err.message ?? 'Failed to update incident');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className={styles.panel}>
      <h3 className={styles.title}>Incident Detail</h3>
      <div className={styles.grid}>
        <span><strong>ID:</strong> {current.id}</span>
        <span><strong>Job:</strong> {current.jobId ?? '—'}</span>
        <span><strong>Camera:</strong> {current.cameraId}</span>
        <span><strong>Type:</strong> {current.type}</span>
        <span><strong>Status:</strong> <StatusBadge status={isResolved ? 'resolved' : 'critical'} label={isResolved ? 'Resolved' : 'Active'} /></span>
        <span><strong>Detected:</strong> {formatDateTime(current.detectedAt)}</span>
        <span><strong>Resolved at:</strong> {current.resolvedAt ? formatDateTime(current.resolvedAt) : '—'}</span>
        <span><strong>Frame index:</strong> {current.frameIdx ?? '—'}</span>
        <span><strong>Timestamp sec:</strong> {current.timestampSec ?? '—'}</span>
        <span><strong>Confidence:</strong> {formatPercent(current.confidenceScore, 2)}</span>
        <span><strong>Raw score:</strong> {formatPercent(current.rawScore, 2)}</span>
        <span><strong>Tracks:</strong> {current.involvedTrackIds?.join(', ') || '—'}</span>
        <span><strong>Job status:</strong> <StatusBadge status={current.jobStatus ?? 'idle'} label={current.jobStatus ?? 'idle'} /></span>
        <span><strong>Created at:</strong> {formatDateTime(current.createdAt)}</span>
        <span><strong>Completed at:</strong> {formatDateTime(current.completedAt)}</span>
      </div>
      <p className={styles.box}><strong>Bounding box:</strong> {boxText(current.boundingBox)}</p>
      {current.streamUrl && (
        <a href={current.streamUrl} target="_blank" rel="noreferrer" className={styles.link}>
          Open source stream
        </a>
      )}

      <div className={styles.actions}>
        <label htmlFor={`incident-note-${current.id}`} className={styles.noteLabel}>
          Operator note {current.manuallyUpdated && <span className={styles.manualTag}>manually updated</span>}
        </label>
        <textarea
          id={`incident-note-${current.id}`}
          className={styles.note}
          value={note}
          maxLength={NOTE_MAX_LENGTH}
          rows={3}
          placeholder="Add context for other operators (optional)"
          onChange={(event) => setNote(event.target.value)}
          disabled={saving}
        />
        <div className={styles.actionRow}>
          <span className={styles.counter}>{note.length}/{NOTE_MAX_LENGTH}</span>
          {noteChanged && (
            <button
              type="button"
              className={styles.secondaryBtn}
              disabled={saving}
              onClick={() => submit(isResolved ? 'resolved' : 'active')}
            >
              Save note
            </button>
          )}
          <button
            type="button"
            className={isResolved ? styles.secondaryBtn : styles.primaryBtn}
            disabled={saving}
            onClick={() => submit(isResolved ? 'active' : 'resolved')}
          >
            {saving ? 'Saving…' : isResolved ? 'Reopen incident' : 'Mark resolved'}
          </button>
        </div>
        {actionError && <p className={styles.error} role="alert">{actionError}</p>}
      </div>

      <DetectionSignalsChart signalValues={current.signalValues} />
    </section>
  );
}
