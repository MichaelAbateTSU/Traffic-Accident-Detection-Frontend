import styles from './SectionCard.module.css';

export default function SectionCard({ title, description, action, children, className = '' }) {
  return (
    <section className={[styles.card, className].join(' ')}>
      {(title || description || action) && (
        <header className={styles.header}>
          <div className={styles.heading}>
            {title && <h2 className={styles.title}>{title}</h2>}
            {description && <p className={styles.description}>{description}</p>}
          </div>
          {action && <div className={styles.action}>{action}</div>}
        </header>
      )}
      <div className={styles.content}>{children}</div>
    </section>
  );
}
