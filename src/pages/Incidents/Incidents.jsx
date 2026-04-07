import { useEffect, useMemo, useState } from 'react';
import IncidentTable from '../../components/IncidentTable/IncidentTable.jsx';
import DataState from '../../components/DataState/DataState.jsx';
import MetaInfoPanel from '../../components/MetaInfoPanel/MetaInfoPanel.jsx';
import IncidentDetailPanel from '../../components/IncidentDetailPanel/IncidentDetailPanel.jsx';
import { getIncidentById, getIncidents } from '../../services/api.js';
import { useIncidentsTableState } from '../../hooks/useIncidentsTableState.js';
import styles from './Incidents.module.css';

const LIMIT_OPTIONS = [10, 20, 50, 100];

export default function Incidents() {
  const [incidents, setIncidents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [meta, setMeta] = useState(null);
  const [selectedIncidentId, setSelectedIncidentId] = useState(null);
  const [selectedIncident, setSelectedIncident] = useState(null);
  const [detailMeta, setDetailMeta] = useState(null);
  const [detailError, setDetailError] = useState(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const tableState = useIncidentsTableState();
  const {
    page,
    pageSize,
    status,
    sort,
    cameraId,
    jobId,
    detectionType,
    minConfidence,
    startTime,
    endTime,
    query,
    setPage,
    setPageSize,
    setStatus,
    setSort,
    setCameraId,
    setJobId,
    setDetectionType,
    setMinConfidence,
    setStartTime,
    setEndTime,
  } = tableState;

  const debouncedQuery = useMemo(() => query, [query]);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      try {
        // Fully expose list filters/sort/pagination from /incidents.
        const result = await getIncidents(debouncedQuery, { signal: controller.signal });

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
  }, [debouncedQuery, retryKey]);

  useEffect(() => {
    if (!selectedIncidentId) {
      setSelectedIncident(null);
      setDetailMeta(null);
      setDetailError(null);
      return;
    }
    const controller = new AbortController();
    async function loadDetail() {
      setLoadingDetail(true);
      try {
        // On-demand detail fetch avoids unnecessary N+1 calls.
        const { item, meta: metaValue } = await getIncidentById(selectedIncidentId, { signal: controller.signal });
        setSelectedIncident(item);
        setDetailMeta(metaValue);
        setDetailError(null);
      } catch (err) {
        if (err.name === 'AbortError') return;
        setDetailError(err.message);
      } finally {
        if (!controller.signal.aborted) setLoadingDetail(false);
      }
    }
    loadDetail();
    return () => controller.abort();
  }, [selectedIncidentId]);

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
            {['all', 'active', 'resolved'].map((filterOption) => (
              <button
                key={filterOption}
                className={[styles.filterBtn, status === filterOption ? styles.filterActive : ''].join(' ')}
                onClick={() => {
                  setStatus(filterOption);
                  setPage(1);
                }}
              >
                {filterOption.charAt(0).toUpperCase() + filterOption.slice(1)}
              </button>
            ))}
          </div>
          <div className={styles.limitControl}>
            <label htmlFor="limit-select" className={styles.controlLabel}>Show</label>
            <select
              id="limit-select"
              className={styles.select}
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
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
            value={cameraId}
            onChange={(e) => {
              setCameraId(e.target.value);
              setPage(1);
            }}
          />
          <input
            className={styles.input}
            type="text"
            placeholder="Job ID"
            value={jobId}
            onChange={(e) => {
              setJobId(e.target.value);
              setPage(1);
            }}
          />
          <input
            className={styles.input}
            type="text"
            placeholder="Detection Type"
            value={detectionType}
            onChange={(e) => {
              setDetectionType(e.target.value);
              setPage(1);
            }}
          />
          <input
            className={styles.input}
            type="number"
            min="0"
            max="1"
            step="0.01"
            placeholder="Min confidence (0-1)"
            value={minConfidence}
            onChange={(e) => {
              setMinConfidence(e.target.value);
              setPage(1);
            }}
          />
          <input
            className={styles.input}
            type="datetime-local"
            value={startTime}
            onChange={(e) => {
              setStartTime(e.target.value);
              setPage(1);
            }}
          />
          <input
            className={styles.input}
            type="datetime-local"
            value={endTime}
            onChange={(e) => {
              setEndTime(e.target.value);
              setPage(1);
            }}
          />
        </div>
      </div>

      <div className={styles.countRow}>
        {!loading && (
          <span className={styles.count}>
            Showing page <strong>{page}</strong> of <strong>{totalPages}</strong> ·
            {' '}<strong>{incidents.length}</strong> on this page ·
            {' '}<strong>{totalItems}</strong> total incidents
          </span>
        )}
      </div>

      <DataState loading={loading} error={error} onRetry={() => setRetryKey((v) => v + 1)} loadingMessage="Loading incidents...">
        <div className={styles.tableWrap}>
          <IncidentTable
            incidents={incidents}
            onRowClick={(incident) => setSelectedIncidentId(incident.id)}
            selectedIncidentId={selectedIncidentId}
            emptyMessage="No incidents match current filters."
          />
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
        </div>
      </DataState>

      <MetaInfoPanel meta={meta} title="Incidents list meta" />
      <section className={styles.detailSection}>
        <h2 className={styles.detailTitle}>Selected Incident</h2>
        <DataState
          loading={loadingDetail}
          error={detailError}
          isEmpty={!selectedIncidentId}
          emptyMessage="Click an incident row to load detailed data."
          loadingMessage="Loading incident detail..."
        >
          <IncidentDetailPanel incident={selectedIncident} />
          <MetaInfoPanel meta={detailMeta} title="Incident detail meta" />
        </DataState>
      </section>
    </main>
  );
}
