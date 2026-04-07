import styles from './StatusBadge.module.css';

/**
 * StatusBadge
 * @param {string} status
 * @param {string} [label] — overrides the default label derived from status
 */
export default function StatusBadge({ status = 'offline', label }) {
  const normalized = String(status ?? '').toLowerCase();
  const mappedStatus = mapStatus(normalized);
  const defaultLabels = {
    online:   'Online',
    warning:  'Warning',
    offline:  'Offline',
    active:   'Active',
    degraded: 'Degraded',
    resolved: 'Resolved',
    idle: 'Idle',
    healthy: 'Healthy',
    critical: 'Critical',
  };

  const displayLabel = label ?? defaultLabels[mappedStatus] ?? status;

  return (
    <span className={[styles.badge, styles[mappedStatus]].join(' ')}>
      <span className={styles.dot} aria-hidden="true" />
      {displayLabel}
    </span>
  );
}

function mapStatus(status) {
  if (['online', 'healthy', 'ok', 'up'].includes(status)) return 'online';
  if (['active', 'running', 'processing', 'started'].includes(status)) return 'active';
  if (['completed', 'complete'].includes(status)) return 'resolved';
  if (['warning', 'queued', 'pending', 'starting'].includes(status)) return 'warning';
  if (['degraded'].includes(status)) return 'degraded';
  if (['resolved', 'closed'].includes(status)) return 'resolved';
  if (['idle'].includes(status)) return 'idle';
  if (['critical', 'failed', 'error'].includes(status)) return 'critical';
  return 'offline';
}
