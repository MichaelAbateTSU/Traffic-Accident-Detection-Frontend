import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import StatCard from '../../components/StatCard/StatCard.jsx';
import IncidentTable from '../../components/IncidentTable/IncidentTable.jsx';
import AlertBanner from '../../components/AlertBanner/AlertBanner.jsx';
import DataState from '../../components/DataState/DataState.jsx';
import MetaInfoPanel from '../../components/MetaInfoPanel/MetaInfoPanel.jsx';
import JobStatusCard from '../../components/JobStatusCard/JobStatusCard.jsx';
import IncidentDetailPanel from '../../components/IncidentDetailPanel/IncidentDetailPanel.jsx';
import ConfidenceTrendChart from '../../components/charts/ConfidenceTrendChart.jsx';
import DetectionSignalsChart from '../../components/charts/DetectionSignalsChart.jsx';
import StatusBadge from '../../components/StatusBadge/StatusBadge.jsx';
import SectionCard from '../../components/SectionCard/SectionCard.jsx';
import CameraPreviewCard from '../../components/CameraPreviewCard/CameraPreviewCard.jsx';
import { getJob, startDetectionJob } from '../../services/api.js';
import { FIXED_CAMERA_STREAM_URLS, FIXED_MAX_FRAMES } from '../../constants/cameras.js';
import { formatDateTime, formatPercent } from '../../utils/formatters.js';
import { useDashboardData } from '../../hooks/useDashboardData.js';
import styles from './Dashboard.module.css';

const INITIAL_POLL_DELAY_MS = 90000;

function isCompleteStatus(status) {
  return String(status ?? '').toLowerCase() === 'complete';
}

function normalizeMonitorJobStatus(status) {
  return isCompleteStatus(status) ? 'complete' : 'pending';
}

function normalizeMonitorJob(jobItem = {}) {
  return {
    ...jobItem,
    status: normalizeMonitorJobStatus(jobItem.status),
  };
}

function getDetectionStatusBadge(status) {
  const normalized = String(status ?? '').toLowerCase();
  if (normalized === 'active') return <StatusBadge status="active" label="Active" />;
  if (normalized === 'degraded') return <StatusBadge status="warning" label="Degraded" />;
  return <StatusBadge status="critical" label={status ?? 'Offline'} />;
}

export default function Dashboard() {
  const [saveFrames, setSaveFrames] = useState(false);
  const [startingJob, setStartingJob] = useState(false);
  const [monitoredJobs, setMonitoredJobs] = useState([]);
  const [jobError, setJobError] = useState(null);
  const [selectedIncident, setSelectedIncident] = useState(null);
  const totalFixedCameras = FIXED_CAMERA_STREAM_URLS.length;
  const pollingStartDelayRef = useRef(null);
  const monitoredJobsRef = useRef([]);

  const {
    stats,
    overviewMeta,
    incidents,
    incidentsMeta,
    cameras,
    health,
    healthMeta,
    jobs,
    jobsMeta,
    loading,
    error,
    reload,
  } = useDashboardData({ incidentsPageSize: 5, incidentsStatus: 'active' });
  useEffect(() => {
    monitoredJobsRef.current = monitoredJobs;
  }, [monitoredJobs]);

  const stopBatchPolling = useCallback(() => {
    if (pollingStartDelayRef.current) {
      clearTimeout(pollingStartDelayRef.current);
      pollingStartDelayRef.current = null;
    }
  }, []);

  const refreshPendingJobs = useCallback(async () => {
    const currentJobs = monitoredJobsRef.current;
    const pendingIds = currentJobs
      .filter((jobItem) => !isCompleteStatus(jobItem.status))
      .map((jobItem) => jobItem.id)
      .filter(Boolean);

    if (!pendingIds.length) {
      stopBatchPolling();
      return;
    }

    try {
      const responses = await Promise.all(
        pendingIds.map(async (jobId) => {
          try {
            const { item } = await getJob(jobId);
            return { jobId, item };
          } catch (error) {
            return { jobId, error };
          }
        }),
      );

      let allCompleteAfterRefresh = false;
      setMonitoredJobs((current) => {
        const responseById = new Map(responses.map((response) => [response.jobId, response]));
        const next = current.map((jobItem) => {
          const response = responseById.get(jobItem.id);
          if (!response) return jobItem;
          if (response.item) {
            return normalizeMonitorJob({
              ...jobItem,
              ...response.item,
              events: response.item.events?.length ? response.item.events : jobItem.events ?? [],
            });
          }
          return {
            ...jobItem,
            error: response.error?.message ?? 'Failed to refresh job status.',
          };
        });
        allCompleteAfterRefresh = next.length > 0 && next.every((jobItem) => isCompleteStatus(jobItem.status));
        return next;
      });

      const firstError = responses.find((response) => response.error);
      setJobError(firstError ? firstError.error.message : null);

      if (allCompleteAfterRefresh) {
        stopBatchPolling();
      }
    } finally {
      pollingStartDelayRef.current = null;
    }
  }, [stopBatchPolling]);

  useEffect(() => {
    return () => {
      stopBatchPolling();
    };
  }, [stopBatchPolling]);

  async function handleStartJob(event) {
    event.preventDefault();

    setStartingJob(true);
    stopBatchPolling();
    setJobError(null);
    setMonitoredJobs([]);

    try {
      const queuedResponses = [];

      for (const streamUrl of FIXED_CAMERA_STREAM_URLS) {
        const { item } = await startDetectionJob({
          stream_url: streamUrl,
          max_frames: FIXED_MAX_FRAMES,
          save_frames: saveFrames,
        });
        if (!item?.id) {
          throw new Error('Job started but no job id was returned by the backend.');
        }
        queuedResponses.push(normalizeMonitorJob(item));
      }

      if (!queuedResponses.length) {
        throw new Error('No jobs were started.');
      }

      monitoredJobsRef.current = queuedResponses;
      setMonitoredJobs(queuedResponses);
      pollingStartDelayRef.current = setTimeout(() => {
        refreshPendingJobs();
      }, INITIAL_POLL_DELAY_MS);
      reload();
    } catch (err) {
      console.error(err);
      setJobError(err.message);
    } finally {
      setStartingJob(false);
    }
  }

  const activeIncidents = useMemo(() => incidents.filter((incident) => !incident.resolved), [incidents]);
  const totalRecentIncidents = incidentsMeta?.pagination?.total_items ?? incidents.length;
  const completedJobsCount = monitoredJobs.filter((jobItem) => isCompleteStatus(jobItem.status)).length;
  const pendingJobsCount = Math.max(0, monitoredJobs.length - completedJobsCount);
  const allBatchJobsComplete = monitoredJobs.length > 0 && completedJobsCount === monitoredJobs.length;
  const latestCompletedJob = useMemo(() => {
    const completed = monitoredJobs.filter((jobItem) => isCompleteStatus(jobItem.status));
    if (!completed.length) return null;
    return completed
      .slice()
      .sort(
        (a, b) =>
          new Date(b.completedAt ?? b.createdAt ?? 0).getTime() -
          new Date(a.completedAt ?? a.createdAt ?? 0).getTime(),
      )[0];
  }, [monitoredJobs]);
  const detections = latestCompletedJob?.events ?? [];
  const topSignals = detections[0]?.signalValues ?? null;
  const accidentJobsCount = monitoredJobs.filter((jobItem) => jobItem.accidentDetected === true).length;
  const previewCameras = cameras.slice(0, 6);
  const uptimePercent = stats?.uptimePercent != null ? Number(stats.uptimePercent) : null;

  return (
    <main className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Operations Dashboard</h1>
        <span className={styles.subtitle}>Real-time traffic incident monitoring and detection confidence overview</span>
      </div>

      {health && (
        <section className={styles.healthStrip}>
          <span className={styles.healthItem}><strong>Service</strong><StatusBadge status={health.status} label={health.status} /></span>
          <span className={styles.healthItem}><strong>Model</strong><StatusBadge status={health.modelLoaded ? 'healthy' : 'critical'} label={health.modelLoaded ? 'Loaded' : 'Not Loaded'} /></span>
          <span className={styles.healthItem}><strong>Jobs</strong>{health.activeJobs}/{health.totalJobs}</span>
          <span className={styles.healthItem}><strong>Last refresh</strong>{formatDateTime(stats?.refreshedAt)}</span>
        </section>
      )}

      {activeIncidents.length > 0 && (
        <AlertBanner
          type="danger"
          message={`${activeIncidents.length} active incident${activeIncidents.length > 1 ? 's' : ''} detected`}
          detail={activeIncidents.map((incident) => `${incident.cameraId} — ${incident.type}`).join(' · ')}
        />
      )}

      <DataState
        loading={loading}
        error={error}
        onRetry={reload}
        loadingMessage="Loading dashboard modules..."
        loadingVariant="skeleton"
        loadingRows={4}
      >
        <section className={styles.statsGrid} aria-label="Statistics">
          <StatCard
            label="Active Cameras"
            value={stats ? `${stats.activeCameras}/${stats.totalCameras}` : '—'}
            icon="CAM"
            trend={stats?.activeCameras === stats?.totalCameras ? 'All online' : 'Degraded'}
            variant={stats?.activeCameras === stats?.totalCameras ? 'good' : 'warn'}
            description="Cameras currently online"
          />
          <StatCard
            label="Incidents Today"
            value={stats?.incidentsToday ?? '—'}
            icon="INC"
            trend={(stats?.incidentsToday ?? 0) > 0 ? 'Needs attention' : 'Normal'}
            variant={stats?.incidentsToday > 0 ? 'danger' : 'good'}
            description="Accidents or events detected"
          />
          <StatCard
            label="Detection Status"
            value={stats?.detectionStatus ? stats.detectionStatus.toUpperCase() : '—'}
            icon="DET"
            variant={
              stats?.detectionStatus === 'active' ? 'good' :
              stats?.detectionStatus === 'degraded' ? 'warn' : 'danger'
            }
            badge={getDetectionStatusBadge(stats?.detectionStatus)}
            description="YOLO inference service state"
          />
          <StatCard
            label="System Uptime"
            value={uptimePercent == null ? '—' : formatPercent(uptimePercent / 100, 2)}
            icon="UPT"
            variant="good"
            progressPercent={uptimePercent ?? 0}
            description="Measured over the last 30 days"
          />
        </section>
      </DataState>

      <SectionCard
        title="Recent Incidents"
        description={`Showing latest ${incidents.length} of ${totalRecentIncidents} active incidents`}
        action={<Link to="/incidents" className={styles.viewAll}>View all</Link>}
      >
        <IncidentTable
          incidents={incidents}
          compact
          onRowClick={setSelectedIncident}
          selectedIncidentId={selectedIncident?.id ?? null}
          emptyMessage="No incidents in this dashboard window."
        />
        {selectedIncident && (
          <div className={styles.incidentDetailWrap}>
            <IncidentDetailPanel incident={selectedIncident} />
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Detection Job Monitor"
        description={`One detection job is queued for each of ${totalFixedCameras} fixed cameras, waits 90 seconds, then each pending job is refreshed once.`}
      >
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
            {startingJob ? `Queueing ${totalFixedCameras} detection jobs...` : `Run detection across ${totalFixedCameras} cameras`}
          </button>
        </form>

        <p className={styles.monitorHint}>
          Jobs are queued as <strong>pending</strong>. After exactly 90 seconds, each job status is fetched once from the backend and
          updates to <strong>complete</strong> when reported.
        </p>

        {jobError && <AlertBanner type="warning" message="Job monitor error" detail={jobError} />}

        {monitoredJobs.length > 0 && (
          <div className={styles.monitorSummary} role="status" aria-live="polite">
            {!allBatchJobsComplete ? (
              <>
                <strong>{completedJobsCount} of {monitoredJobs.length} jobs complete.</strong>
                <span>{pendingJobsCount} jobs still pending.</span>
              </>
            ) : (
              <>
                <strong>All {monitoredJobs.length} detection jobs completed.</strong>
                <span>
                  {accidentJobsCount === 0
                    ? '0 accidents detected.'
                    : `${accidentJobsCount} camera${accidentJobsCount > 1 ? 's' : ''} reported accident events.`}
                </span>
              </>
            )}
            {pendingJobsCount > 0 && (
              <StatusBadge status="warning" label="pending" />
            )}
          </div>
        )}

        {monitoredJobs.length > 0 && (
          <div className={styles.queueList}>
            {monitoredJobs.map((jobItem) => (
              <JobStatusCard key={jobItem.id} job={jobItem} />
            ))}
          </div>
        )}

        {latestCompletedJob && detections.length > 0 && (
          <p className={styles.sectionMeta}>
            Latest completed job (<strong>{latestCompletedJob.id}</strong>) returned <strong>{detections.length}</strong> events.
            Peak confidence: <strong>{formatPercent(latestCompletedJob.peakConfidence, 2)}</strong>.
          </p>
        )}
      </SectionCard>

      <SectionCard title="Detection Analytics" description="Confidence evolution and supporting signal strengths from the latest completed run">
        <div className={styles.chartsGrid}>
          <ConfidenceTrendChart events={detections} />
          <DetectionSignalsChart signalValues={topSignals} />
        </div>
      </SectionCard>

      <SectionCard title="Recent Jobs" description="Latest background detection jobs and outcomes">
        <DataState
          loading={loading}
          error={null}
          isEmpty={!jobs.length}
          emptyMessage="No jobs available."
          loadingMessage="Loading recent jobs..."
          loadingVariant="skeleton"
          loadingRows={3}
        >
          <div className={styles.jobsList}>
            {jobs.map((jobItem) => (
              <JobStatusCard key={jobItem.id} job={jobItem} />
            ))}
          </div>
        </DataState>
      </SectionCard>

      <SectionCard
        title="Live Cameras"
        description={`Top ${previewCameras.length} cameras from the current dashboard health snapshot`}
        action={<Link to="/live" className={styles.viewAll}>Open full feed</Link>}
      >
        <div className={styles.cameraGrid}>
          {previewCameras.map((camera) => (
            <CameraPreviewCard key={camera.id} camera={camera} />
          ))}
        </div>
      </SectionCard>

      <details className={styles.advancedDetails}>
        <summary>Advanced Details</summary>
        <div className={styles.metaGrid}>
          <MetaInfoPanel meta={overviewMeta} title="Stats meta" />
          <MetaInfoPanel meta={incidentsMeta} title="Recent incidents meta" />
          <MetaInfoPanel meta={jobsMeta} title="Jobs list meta" />
          <MetaInfoPanel meta={healthMeta} title="Health meta" />
        </div>
      </details>
    </main>
  );
}
