import styles from './StatusBadge.module.css';

/**
 * StatusBadge
 * @param {'online'|'warning'|'offline'|'active'|'degraded'} status
 * @param {string} [label] — overrides the default label derived from status
 */
export default function StatusBadge({ status = 'offline', label }) {
  const defaultLabels = {
    online:   'Online',
    warning:  'Warning',
    offline:  'Offline',
    active:   'Active',
    degraded: 'Degraded',
  };

  const displayLabel = label ?? defaultLabels[status] ?? status;

  return (
    <span className={[styles.badge, styles[status]].join(' ')}>
      <span className={styles.dot} aria-hidden="true" />
      {displayLabel}
    </span>
  );
}
