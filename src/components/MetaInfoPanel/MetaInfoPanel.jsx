import { formatDateTime, formatNumber } from '../../utils/formatters.js';
import styles from './MetaInfoPanel.module.css';

export default function MetaInfoPanel({ meta, title = 'API metadata' }) {
  if (!meta) return null;

  return (
    <section className={styles.panel} aria-label={title}>
      <h3 className={styles.title}>{title}</h3>
      <div className={styles.grid}>
        <span><strong>Request ID:</strong> {meta.requestId ?? '—'}</span>
        <span><strong>Timestamp:</strong> {formatDateTime(meta.timestamp)}</span>
        <span><strong>Duration:</strong> {meta.durationMs != null ? `${formatNumber(meta.durationMs, 2)} ms` : '—'}</span>
      </div>
      {meta.filters && (
        <pre className={styles.block}>{JSON.stringify(meta.filters, null, 2)}</pre>
      )}
      {meta.pagination && (
        <pre className={styles.block}>{JSON.stringify(meta.pagination, null, 2)}</pre>
      )}
    </section>
  );
}
