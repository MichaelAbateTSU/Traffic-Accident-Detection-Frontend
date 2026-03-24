import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import StatCard     from '../../components/StatCard/StatCard.jsx';
import IncidentTable from '../../components/IncidentTable/IncidentTable.jsx';
import AlertBanner  from '../../components/AlertBanner/AlertBanner.jsx';
import {
  getDashboard,
  getJobDetections,
  getJobStatus,
  startDetectionJob,
} from '../../services/api.js';
import { FIXED_CAMERA_STREAM_URLS, FIXED_MAX_FRAMES } from '../../constants/cameras.js';
import styles from './Dashboard.module.css';

const JOB_POLL_INTERVAL_MS = 3000;
const TERMINAL_JOB_STATES = new Set(['complete', 'completed', 'failed', 'cancelled', 'error']);

export default function Dashboard() {
  const totalFixedCameras = FIXED_CAMERA_STREAM_URLS.length;
  const [stats,     setStats]     = useState(null);
  const [incidents, setIncidents] = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState(null);
  const [totalRecentIncidents, setTotalRecentIncidents] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);

  const [saveFrames, setSaveFrames] = useState(false);
  const [startingJob, setStartingJob] = useState(false);
  const [jobStatus, setJobStatus] = useState(null);
  const [jobDetections, setJobDetections] = useState([]);
  const [jobError, setJobError] = useState(null);

  const pollTimerRef = useRef(null);
  const jobStatusControllerRef = useRef(null);
  const jobDetectionsControllerRef = useRef(null);

  function stopPolling() {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }

  function clearJobRequests() {
    if (jobStatusControllerRef.current) {
      jobStatusControllerRef.current.abort();
      jobStatusControllerRef.current = null;
    }
    if (jobDetectionsControllerRef.current) {
      jobDetectionsControllerRef.current.abort();
      jobDetectionsControllerRef.current = null;
    }
  }

  async function loadDashboardData(signal) {
    setLoading(true);
    try {
      const dashboard = await getDashboard(
        { incidentsPageSize: 5, incidentsStatus: 'active' },
        { signal },
      );

      setStats(dashboard.stats);
      setIncidents(dashboard.incidents?.items ?? []);
      setTotalRecentIncidents(
        dashboard.incidents?.meta?.pagination?.total_items
        ?? dashboard.incidents?.items?.length
        ?? 0,
      );
      setError(null);
    } catch (err) {
      if (err.name === 'AbortError') return;
      setError(err.message);
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }

  async function fetchJobStatus(jobId) {
    if (!jobId) return;
    const controller = new AbortController();
    if (jobStatusControllerRef.current) jobStatusControllerRef.current.abort();
    jobStatusControllerRef.current = controller;

    try {
      const { item } = await getJobStatus(jobId, { signal: controller.signal });
      setJobStatus(item);
      setJobError(null);
      const isTerminal = TERMINAL_JOB_STATES.has(String(item.status).toLowerCase());

      if (isTerminal) {
        stopPolling();
        const normalizedStatus = String(item.status).toLowerCase();
        if (normalizedStatus === 'complete' || normalizedStatus === 'completed') {
          const detectionController = new AbortController();
          if (jobDetectionsControllerRef.current) jobDetectionsControllerRef.current.abort();
          jobDetectionsControllerRef.current = detectionController;
          const detections = await getJobDetections(jobId, { detail: 'full', page: 1, pageSize: 50 }, { signal: detectionController.signal });
          setJobDetections(detections.items);
        }
      }
      return { item, isTerminal };
    } catch (err) {
      if (err.name === 'AbortError') return { item: null, isTerminal: true };
      setJobError(err.message);
      stopPolling();
      return { item: null, isTerminal: true };
    }
  }

  async function handleStartJob(event) {
    event.preventDefault();

    setStartingJob(true);
    setJobError(null);
    setJobStatus(null);
    setJobDetections([]);
    stopPolling();
    clearJobRequests();

    try {
      let latestJob = null;
      for (const streamUrl of FIXED_CAMERA_STREAM_URLS) {
        const { item } = await startDetectionJob({
          stream_url: streamUrl,
          max_frames: FIXED_MAX_FRAMES,
          save_frames: saveFrames,
        });
        latestJob = item;
      }

      if (!latestJob) {
        throw new Error('No jobs were started.');
      }
      setJobStatus(latestJob);
      if (!latestJob.id) {
        throw new Error('Job started but no job id was returned by the backend.');
      }

      const statusResult = await fetchJobStatus(latestJob.id);
      if (!statusResult?.isTerminal) {
        pollTimerRef.current = setInterval(() => {
          fetchJobStatus(latestJob.id);
        }, JOB_POLL_INTERVAL_MS);
      }
    } catch (err) {
      setJobError(err.message);
    } finally {
      setStartingJob(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    loadDashboardData(controller.signal);
    return () => {
      controller.abort();
    };
  }, [refreshKey]);

  useEffect(() => {
    return () => {
      stopPolling();
      clearJobRequests();
    };
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
        <div className={styles.inlineNotice}>
          <AlertBanner type="warning" message="Could not load dashboard data" detail={error} />
          <button type="button" className={styles.retryBtn} onClick={() => setRefreshKey((v) => v + 1)}>
            Retry
          </button>
        </div>
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
        {!loading && (
          <p className={styles.sectionMeta}>
            Showing latest <strong>{incidents.length}</strong> of <strong>{totalRecentIncidents}</strong> active incidents
          </p>
        )}
        <IncidentTable incidents={incidents} compact />
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Detection Job Monitor</h2>
        </div>
        <form className={styles.jobForm} onSubmit={handleStartJob}>
          <label className={styles.checkboxLabel}>
            <input
              type="checkbox"
              checked={saveFrames}
              onChange={(event) => setSaveFrames(event.target.checked)}
            />
            Save frames
          </label>
          <button type="submit" className={styles.retryBtn} disabled={startingJob}>
            {startingJob ? 'Starting...' : `Start Jobs for ${totalFixedCameras} Cameras`}
          </button>
        </form>
        <p className={styles.hint}>
          Uses {totalFixedCameras} fixed camera stream URLs with <strong>{FIXED_MAX_FRAMES}</strong> max frames per job.
        </p>

        {jobError && (
          <AlertBanner type="warning" message="Job monitor error" detail={jobError} />
        )}

        {jobStatus && (
          <div className={styles.jobStatus}>
            <span><strong>Job:</strong> {jobStatus.id}</span>
            <span><strong>Status:</strong> {jobStatus.status}</span>
            {jobStatus.progress != null && <span><strong>Progress:</strong> {jobStatus.progress}</span>}
            {jobStatus.totalDetections != null && <span><strong>Detections:</strong> {jobStatus.totalDetections}</span>}
          </div>
        )}

        {jobDetections.length > 0 && (
          <p className={styles.sectionMeta}>
            Last completed job returned <strong>{jobDetections.length}</strong> detections.
          </p>
        )}
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
