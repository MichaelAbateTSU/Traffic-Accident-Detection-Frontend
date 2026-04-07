import styles from './StatCard.module.css';

/**
 * StatCard
 * @param {string}  label
 * @param {string|number} value
 * @param {string}  [unit]         — small unit text after value (e.g. "%")
 * @param {string}  [icon]         — emoji or short text icon
 * @param {'neutral'|'good'|'warn'|'danger'} [variant='neutral']
 * @param {string}  [description]  — optional subtitle
 * @param {React.ReactNode} [badge]
 * @param {number} [progressPercent]
 * @param {string} [trend]
 */
export default function StatCard({
  label,
  value,
  unit,
  icon,
  variant = 'neutral',
  description,
  badge,
  progressPercent,
  trend,
}) {
  const clampedProgress = progressPercent == null ? null : Math.min(100, Math.max(0, Number(progressPercent)));

  return (
    <article className={[styles.card, styles[variant]].join(' ')}>
      <div className={styles.top}>
        {icon && <span className={styles.icon} aria-hidden="true">{icon}</span>}
        <span className={styles.label}>{label}</span>
        {trend && <span className={styles.trend}>{trend}</span>}
      </div>
      <div className={styles.valueRow}>
        <span className={styles.value}>{value}</span>
        {unit && <span className={styles.unit}>{unit}</span>}
      </div>
      {badge && <div className={styles.badgeWrap}>{badge}</div>}
      {clampedProgress != null && (
        <div className={styles.progressWrap} aria-label={`${label} progress`}>
          <div className={styles.progressTrack}>
            <div className={styles.progressFill} style={{ width: `${clampedProgress}%` }} />
          </div>
          <span className={styles.progressText}>{clampedProgress.toFixed(1)}%</span>
        </div>
      )}
      {description && <p className={styles.description}>{description}</p>}
    </article>
  );
}
