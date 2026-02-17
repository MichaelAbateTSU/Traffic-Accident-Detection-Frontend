import { useState } from 'react';
import styles from './AlertBanner.module.css';

/**
 * AlertBanner — dismissable notification strip
 * @param {'danger'|'warning'|'info'} [type='danger']
 * @param {string} message
 * @param {string} [detail]
 * @param {Function} [onDismiss]  — called after the banner is dismissed
 */
export default function AlertBanner({ type = 'danger', message, detail, onDismiss }) {
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  const icons = { danger: '🚨', warning: '⚠️', info: 'ℹ️' };

  function handleDismiss() {
    setDismissed(true);
    onDismiss?.();
  }

  return (
    <div className={[styles.banner, styles[type]].join(' ')} role="alert">
      <span className={styles.icon} aria-hidden="true">{icons[type]}</span>
      <div className={styles.body}>
        <strong className={styles.message}>{message}</strong>
        {detail && <span className={styles.detail}>{detail}</span>}
      </div>
      <button
        className={styles.dismiss}
        onClick={handleDismiss}
        aria-label="Dismiss alert"
      >
        ✕
      </button>
    </div>
  );
}
