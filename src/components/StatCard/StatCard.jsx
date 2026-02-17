import styles from './StatCard.module.css';

/**
 * StatCard
 * @param {string}  label
 * @param {string|number} value
 * @param {string}  [unit]         — small unit text after value (e.g. "%")
 * @param {string}  [icon]         — emoji or short text icon
 * @param {'neutral'|'good'|'warn'|'danger'} [variant='neutral']
 * @param {string}  [description]  — optional subtitle
 */
export default function StatCard({ label, value, unit, icon, variant = 'neutral', description }) {
  return (
    <article className={[styles.card, styles[variant]].join(' ')}>
      <div className={styles.top}>
        {icon && <span className={styles.icon} aria-hidden="true">{icon}</span>}
        <span className={styles.label}>{label}</span>
      </div>
      <div className={styles.valueRow}>
        <span className={styles.value}>{value}</span>
        {unit && <span className={styles.unit}>{unit}</span>}
      </div>
      {description && <p className={styles.description}>{description}</p>}
    </article>
  );
}
