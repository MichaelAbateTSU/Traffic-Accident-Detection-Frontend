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

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const data = await getIncidents(limit);
        setIncidents(data);
        setError(null);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [limit]);

  const filtered = incidents.filter(i => {
    if (filter === 'active')   return !i.resolved;
    if (filter === 'resolved') return  i.resolved;
    return true;
  });

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
                onClick={() => setFilter(f)}
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
              onChange={e => setLimit(Number(e.target.value))}
            >
              {LIMIT_OPTIONS.map(n => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {error && (
        <AlertBanner type="warning" message="Failed to load incidents" detail={error} />
      )}

      <div className={styles.countRow}>
        {!loading && (
          <span className={styles.count}>
            Showing <strong>{filtered.length}</strong> of <strong>{incidents.length}</strong> incidents
          </span>
        )}
      </div>

      {loading ? (
        <div className={styles.loading}>Loading incidents…</div>
      ) : (
        <IncidentTable incidents={filtered} />
      )}
    </main>
  );
}
