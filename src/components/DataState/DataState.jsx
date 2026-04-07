import AlertBanner from '../AlertBanner/AlertBanner.jsx';
import styles from './DataState.module.css';

export default function DataState({
  loading = false,
  error = null,
  isEmpty = false,
  emptyMessage = 'No data available.',
  loadingMessage = 'Loading...',
  loadingVariant = 'text',
  loadingRows = 3,
  onRetry,
  children,
}) {
  if (loading) {
    if (loadingVariant === 'skeleton') {
      return (
        <div className={styles.skeletonWrap} aria-live="polite" aria-busy="true">
          {Array.from({ length: loadingRows }).map((_, index) => (
            <div
              key={`skeleton-${index}`}
              className={styles.skeletonLine}
              style={{ width: `${Math.max(45, 100 - index * 12)}%` }}
            />
          ))}
        </div>
      );
    }
    return <div className={styles.loading}>{loadingMessage}</div>;
  }

  if (error) {
    return (
      <div className={styles.stateWrap}>
        <AlertBanner type="warning" message="Request failed" detail={error} />
        {onRetry && (
          <button type="button" className={styles.retryBtn} onClick={onRetry}>
            Retry
          </button>
        )}
      </div>
    );
  }

  if (isEmpty) {
    return <div className={styles.empty}>{emptyMessage}</div>;
  }

  return children;
}
