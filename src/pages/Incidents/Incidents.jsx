import { useState, useEffect } from 'react';
import IncidentTable from '../../components/IncidentTable/IncidentTable.jsx';
import AlertBanner   from '../../components/AlertBanner/AlertBanner.jsx';
import { getIncidents } from '../../services/api.js';
import styles from './Incidents.module.css';

const LIMIT_OPTIONS = [10, 20, 50, 100];

export default function Incidents() {
  const [incidents, setIncidents] = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState(null);
  const [limit,     setLimit]     = useState(20);
  const [filter,    setFilter]    = useState('all'); // 'all' | 'active' | 'resolved'
  const [page,      setPage]      = useState(1);
  const [meta,      setMeta]      = useState(null);
  const [sort,      setSort]      = useState('-detected_at');
  const [cameraIdInput, setCameraIdInput] = useState('');
  const [minConfidenceInput, setMinConfidenceInput] = useState('');
  const [debouncedCameraId, setDebouncedCameraId] = useState('');
  const [debouncedMinConfidence, setDebouncedMinConfidence] = useState('');
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    const timeout = setTimeout(() => {
      setDebouncedCameraId(cameraIdInput.trim());
      setDebouncedMinConfidence(minConfidenceInput.trim());
      setPage(1);
    }, 350);
    return () => clearTimeout(timeout);
  }, [cameraIdInput, minConfidenceInput]);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      try {
        const result = await getIncidents({
          page,
          pageSize: limit,
          status: filter === 'all' ? undefined : filter,
          minConfidence: debouncedMinConfidence ? Number(debouncedMinConfidence) : undefined,
          cameraId: debouncedCameraId || undefined,
          sort,
        }, { signal: controller.signal });

        setIncidents(result.items);
        setMeta(result.meta ?? null);
        setError(null);
      } catch (err) {
        if (err.name === 'AbortError') return;
        setError(err.message);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    load();
    return () => {
      controller.abort();
    };
  }, [page, limit, filter, sort, debouncedCameraId, debouncedMinConfidence, retryKey]);

  const pagination = meta?.pagination ?? {};
  const totalItems = pagination.total_items ?? incidents.length;
  const totalPages = pagination.total_pages ?? 1;
  const hasPrev = pagination.has_prev ?? page > 1;
  const hasNext = pagination.has_next ?? page < totalPages;

  return (
    <main className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Incidents</h1>
          <span className={styles.subtitle}>All detected accidents and events</span>
        </div>
        <div className={styles.controls}>
          <div className={styles.filterGroup} role="group" aria-label="Filter incidents">
            {['all', 'active', 'resolved'].map(f => (
              <button
                key={f}
                className={[styles.filterBtn, filter === f ? styles.filterActive : ''].join(' ')}
                onClick={() => {
                  setFilter(f);
                  setPage(1);
                }}
              >
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
          <div className={styles.limitControl}>
            <label htmlFor="limit-select" className={styles.controlLabel}>Show</label>
            <select
              id="limit-select"
              className={styles.select}
              value={limit}
              onChange={(e) => {
                setLimit(Number(e.target.value));
                setPage(1);
              }}
            >
              {LIMIT_OPTIONS.map(n => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </div>
          <div className={styles.limitControl}>
            <label htmlFor="sort-select" className={styles.controlLabel}>Sort</label>
            <select
              id="sort-select"
              className={styles.select}
              value={sort}
              onChange={(e) => {
                setSort(e.target.value);
                setPage(1);
              }}
            >
              <option value="-detected_at">Newest</option>
              <option value="detected_at">Oldest</option>
              <option value="-confidence_score">Confidence (High-Low)</option>
              <option value="confidence_score">Confidence (Low-High)</option>
            </select>
          </div>
          <input
            className={styles.input}
            type="text"
            placeholder="Camera ID"
            value={cameraIdInput}
            onChange={(e) => setCameraIdInput(e.target.value)}
          />
          <input
            className={styles.input}
            type="number"
            min="0"
            max="1"
            step="0.01"
            placeholder="Min confidence (0-1)"
            value={minConfidenceInput}
            onChange={(e) => setMinConfidenceInput(e.target.value)}
          />
        </div>
      </div>

      {error && (
        <div className={styles.errorWrap}>
          <AlertBanner type="warning" message="Failed to load incidents" detail={error} />
          <button type="button" className={styles.actionBtn} onClick={() => setRetryKey((v) => v + 1)}>
            Retry
          </button>
        </div>
      )}

      <div className={styles.countRow}>
        {!loading && (
          <span className={styles.count}>
            Showing page <strong>{page}</strong> of <strong>{totalPages}</strong> ·
            {' '}<strong>{incidents.length}</strong> on this page ·
            {' '}<strong>{totalItems}</strong> total incidents
          </span>
        )}
      </div>

      {loading ? (
        <div className={styles.loading}>Loading incidents…</div>
      ) : (
        <>
          <IncidentTable incidents={incidents} />
          <div className={styles.pagination}>
            <button
              type="button"
              className={styles.actionBtn}
              disabled={!hasPrev}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              Previous
            </button>
            <span className={styles.pageInfo}>
              Page {page} / {totalPages}
            </span>
            <button
              type="button"
              className={styles.actionBtn}
              disabled={!hasNext}
              onClick={() => setPage((current) => current + 1)}
            >
              Next
            </button>
          </div>
        </>
      )}
    </main>
  );
}
