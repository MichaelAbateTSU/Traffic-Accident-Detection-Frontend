import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import StatCard     from '../../components/StatCard/StatCard.jsx';
import IncidentTable from '../../components/IncidentTable/IncidentTable.jsx';
import AlertBanner  from '../../components/AlertBanner/AlertBanner.jsx';
import { getStats, getIncidents } from '../../services/api.js';
import styles from './Dashboard.module.css';

export default function Dashboard() {
  const [stats,     setStats]     = useState(null);
  const [incidents, setIncidents] = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState(null);

  useEffect(() => {
    async function load() {
      try {
        const [s, i] = await Promise.all([getStats(), getIncidents(5)]);
        setStats(s);
        setIncidents(i);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const activeIncidents = incidents.filter(i => !i.resolved);

  return (
    <main className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Dashboard</h1>
        <span className={styles.subtitle}>Real-time overview of highway monitoring</span>
      </div>

      {activeIncidents.length > 0 && (
        <AlertBanner
          type="danger"
          message={`${activeIncidents.length} active incident${activeIncidents.length > 1 ? 's' : ''} detected`}
          detail={activeIncidents.map(i => `${i.cameraId} — ${i.type}`).join(' · ')}
        />
      )}

      {error && (
        <AlertBanner type="warning" message="Could not load dashboard data" detail={error} />
      )}

      {loading ? (
        <div className={styles.loading}>Loading stats…</div>
      ) : (
        <section className={styles.statsGrid} aria-label="Statistics">
          <StatCard
            label="Active Cameras"
            value={stats ? `${stats.activeCameras}/${stats.totalCameras}` : '—'}
            icon="📷"
            variant={stats?.activeCameras === stats?.totalCameras ? 'good' : 'warn'}
            description="Cameras currently online"
          />
          <StatCard
            label="Incidents Today"
            value={stats?.incidentsToday ?? '—'}
            icon="🚨"
            variant={stats?.incidentsToday > 0 ? 'danger' : 'good'}
            description="Accidents or events detected"
          />
          <StatCard
            label="Detection Status"
            value={stats?.detectionStatus ?? '—'}
            icon="🔍"
            variant={
              stats?.detectionStatus === 'active'   ? 'good'   :
              stats?.detectionStatus === 'degraded' ? 'warn'   : 'danger'
            }
            description="YOLO inference engine"
          />
          <StatCard
            label="System Uptime"
            value={stats?.uptimePercent ?? '—'}
            unit="%"
            icon="⏱"
            variant="good"
            description="Last 30 days"
          />
        </section>
      )}

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Recent Incidents</h2>
          <Link to="/incidents" className={styles.viewAll}>View all →</Link>
        </div>
        <IncidentTable incidents={incidents} compact />
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Live Cameras</h2>
          <Link to="/live" className={styles.viewAll}>Open feed →</Link>
        </div>
        <p className={styles.hint}>
          Go to <Link to="/live">Live Feed</Link> to monitor all camera streams in real time.
        </p>
      </section>
    </main>
  );
}
