import DetectionSignalsChart from '../charts/DetectionSignalsChart.jsx';
import StatusBadge from '../StatusBadge/StatusBadge.jsx';
import { formatDateTime, formatPercent } from '../../utils/formatters.js';
import styles from './IncidentDetailPanel.module.css';

function boxText(box) {
  if (!box) return '—';
  return `x1:${box.x1.toFixed(1)}, y1:${box.y1.toFixed(1)}, x2:${box.x2.toFixed(1)}, y2:${box.y2.toFixed(1)} | w:${box.width.toFixed(1)} h:${box.height.toFixed(1)} area:${box.area.toFixed(1)}`;
}

export default function IncidentDetailPanel({ incident }) {
  if (!incident) return null;

  return (
    <section className={styles.panel}>
      <h3 className={styles.title}>Incident Detail</h3>
      <div className={styles.grid}>
        <span><strong>ID:</strong> {incident.id}</span>
        <span><strong>Job:</strong> {incident.jobId ?? '—'}</span>
        <span><strong>Camera:</strong> {incident.cameraId}</span>
        <span><strong>Type:</strong> {incident.type}</span>
        <span><strong>Status:</strong> <StatusBadge status={incident.resolved ? 'resolved' : 'critical'} label={incident.resolved ? 'Resolved' : 'Active'} /></span>
        <span><strong>Detected:</strong> {formatDateTime(incident.detectedAt)}</span>
        <span><strong>Frame index:</strong> {incident.frameIdx ?? '—'}</span>
        <span><strong>Timestamp sec:</strong> {incident.timestampSec ?? '—'}</span>
        <span><strong>Confidence:</strong> {formatPercent(incident.confidenceScore, 2)}</span>
        <span><strong>Raw score:</strong> {formatPercent(incident.rawScore, 2)}</span>
        <span><strong>Tracks:</strong> {incident.involvedTrackIds?.join(', ') || '—'}</span>
        <span><strong>Job status:</strong> <StatusBadge status={incident.jobStatus ?? 'idle'} label={incident.jobStatus ?? 'idle'} /></span>
        <span><strong>Created at:</strong> {formatDateTime(incident.createdAt)}</span>
        <span><strong>Completed at:</strong> {formatDateTime(incident.completedAt)}</span>
      </div>
      <p className={styles.box}><strong>Bounding box:</strong> {boxText(incident.boundingBox)}</p>
      {incident.streamUrl && (
        <a href={incident.streamUrl} target="_blank" rel="noreferrer" className={styles.link}>
          Open source stream
        </a>
      )}
      <DetectionSignalsChart signalValues={incident.signalValues} />
    </section>
  );
}
