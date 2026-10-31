import { useEffect, useMemo, useState } from 'react';
import IncidentTable from '../../components/IncidentTable/IncidentTable.jsx';
import DataState from '../../components/DataState/DataState.jsx';
import MetaInfoPanel from '../../components/MetaInfoPanel/MetaInfoPanel.jsx';
import IncidentDetailPanel from '../../components/IncidentDetailPanel/IncidentDetailPanel.jsx';
import { exportIncidentsCsv, getIncidentById, getIncidents } from '../../services/api.js';
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
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(null);
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
    setSelectedIncident(null);
    setDetailMeta(null);
    setDetailError(null);
    if (!selectedIncidentId) {
      return;
    }
    const controller = new AbortController();
    async function loadDetail() {
      setLoadingDetail(true);
      try {
        // On-demand detail fetch avoids unnecessary N+1 calls.
        const { item, meta: metaValue } = await getIncidentById(selectedIncidentId, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setSelectedIncident(item);
        setDetailMeta(metaValue);
        setDetailError(null);
      } catch (err) {
        if (err.name === 'AbortError' || controller.signal.aborted) return;
        setDetailError(err.message);
      } finally {
        if (!controller.signal.aborted) setLoadingDetail(false);
      }
    }
    loadDetail();
    return () => controller.abort();
  }, [selectedIncidentId]);

  const handleExport = async () => {
    setExporting(true);
    setExportError(null);
    try {
      await exportIncidentsCsv(debouncedQuery);
    } catch (err) {
      setExportError(err.message ?? 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  const handleIncidentUpdated = (updated) => {
    setSelectedIncident((selected) => selected?.id === updated.id ? updated : selected);
    const filteredOut = status !== 'all' && updated.status !== status;
    if (filteredOut) {
      setRetryKey((value) => value + 1);
      return;
    }
    setIncidents((items) => items.map((item) => (item.id === updated.id ? { ...item, ...updated } : item)));
  };

  const pagination = meta?.pagination ?? {};
  const totalItems = pagination.total_items ?? incidents.length;
  const totalPages = pagination.total_pages ?? 1;
  const hasPrev = pagination.has_prev ?? page > 1;
  const hasNext = pagination.has_next ?? page < totalPages;

  return (
    <main className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Alarm-frame Records</h1>
          <span className={styles.subtitle}>One record per processed frame with a heuristic alarm; consecutive frames may be one episode, not unique or confirmed accidents. Scores (0-1) are not calibrated probabilities.</span>
        </div>
        <div className={styles.controls}>
          <div className={styles.filterGroup} role="group" aria-label="Filter record status">
            {['all', 'active', 'resolved'].map((filterOption) => (
              <button
                key={filterOption}
                className={[styles.filterBtn, status === filterOption ? styles.filterActive : ''].join(' ')}
                onClick={() => {
                  setStatus(filterOption);
                  setPage(1);
                }}
              >
                {filterOption === 'all' ? 'All records' : filterOption === 'active' ? 'Record active' : 'Record resolved'}
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
              <option value="-confidence_score">Heuristic score (High-Low)</option>
              <option value="confidence_score">Heuristic score (Low-High)</option>
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
            placeholder="Min heuristic accident score (0-1)"
            aria-label="Minimum heuristic accident score (0-1), not a probability"
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
          <button
            type="button"
            className={styles.actionBtn}
            onClick={handleExport}
            disabled={exporting}
            title="Download all alarm-frame records matching the current filters as CSV"
          >
            {exporting ? 'Exporting…' : 'Export CSV'}
          </button>
        </div>
      </div>
      {exportError && <p className={styles.exportError} role="alert">CSV export failed: {exportError}</p>}

      <div className={styles.countRow}>
        {!loading && (
          <span className={styles.count}>
            Showing page <strong>{page}</strong> of <strong>{totalPages}</strong> ·
            {' '}<strong>{incidents.length}</strong> on this page ·
            {' '}<strong>{totalItems}</strong> total alarm-frame records
          </span>
        )}
      </div>

      <p>Record status defaults to active while the job is pending/running and resolved when it finishes, unless manually overridden. Neither status confirms review, accident resolution or a live alarm.</p>
      <DataState loading={loading} error={error} onRetry={() => setRetryKey((v) => v + 1)} loadingMessage="Loading alarm-frame records...">
        <div className={styles.tableWrap}>
          <IncidentTable
            incidents={incidents}
            onRowClick={(incident) => setSelectedIncidentId(incident.id)}
            selectedIncidentId={selectedIncidentId}
            emptyMessage="No alarm-frame records match current filters."
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
        <h2 className={styles.detailTitle}>Selected Alarm Frame</h2>
        <DataState
          loading={loadingDetail}
          error={detailError}
          isEmpty={!selectedIncidentId}
          emptyMessage="Click an alarm-frame row to load detailed data."
          loadingMessage="Loading alarm-frame detail..."
        >
          <IncidentDetailPanel incident={selectedIncident} onIncidentUpdated={handleIncidentUpdated} />
          <MetaInfoPanel meta={detailMeta} title="Incident detail meta" />
        </DataState>
      </section>
    </main>
  );
}
