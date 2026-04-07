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
import { FIXED_CAMERA_STREAM_URLS } from '../../constants/cameras.js';
import { formatDateTime, formatPercent } from '../../utils/formatters.js';
import { useDashboardData } from '../../hooks/useDashboardData.js';
import styles from './Dashboard.module.css';

const JOB_POLL_INTERVAL_MS = 1000;

function isCompleteStatus(status) {
  return String(status ?? '').toLowerCase() === 'complete';
}

function isFailedStatus(status) {
  return String(status ?? '').toLowerCase() === 'failed';
}

function isTerminalStatus(status) {
  const normalized = String(status ?? '').toLowerCase();
  return normalized === 'complete' || normalized === 'failed';
}

function isActiveStatus(status) {
  const normalized = String(status ?? '').toLowerCase();
  return normalized === 'pending' || normalized === 'running';
}

function normalizeMonitorJobStatus(status) {
  const normalized = String(status ?? '').toLowerCase();
  if (['pending', 'running', 'complete', 'failed'].includes(normalized)) {
    return normalized;
  }
  return 'pending';
}

function getFrameIndex(frame) {
  if (frame?.frameIndex != null) return frame.frameIndex;
  if (frame?.frame_index != null) return frame.frame_index;
  return null;
}

function normalizeFrameImage(frame = {}) {
  const frameIndex = getFrameIndex(frame);
  return {
    frameIndex,
    capture: frame.capture ?? null,
    captureAnnotated: frame.captureAnnotated ?? frame.capture_annotated ?? null,
    pipelineOutput: frame.pipelineOutput ?? frame.pipeline_output ?? null,
  };
}

function mergeFrameImages(existingFrames = [], incomingFrames = []) {
  const framesByIndex = new Map();

  for (const raw of existingFrames) {
    const frame = normalizeFrameImage(raw);
    if (frame.frameIndex == null) continue;
    framesByIndex.set(frame.frameIndex, frame);
  }

  for (const raw of incomingFrames) {
    const frame = normalizeFrameImage(raw);
    if (frame.frameIndex == null) continue;
    const previous = framesByIndex.get(frame.frameIndex) ?? {};
    framesByIndex.set(frame.frameIndex, { ...previous, ...frame });
  }

  return [...framesByIndex.values()].sort((a, b) => a.frameIndex - b.frameIndex);
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
  const pollingTimerRef = useRef(null);
  const refreshingJobsRef = useRef(false);
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
    if (pollingTimerRef.current) {
      clearInterval(pollingTimerRef.current);
      pollingTimerRef.current = null;
    }
  }, []);

  const refreshPendingJobs = useCallback(async () => {
    if (refreshingJobsRef.current) return;
    refreshingJobsRef.current = true;

    const currentJobs = monitoredJobsRef.current;
    const pendingIds = currentJobs
      .filter((jobItem) => !isTerminalStatus(jobItem.status))
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
              frames: mergeFrameImages(jobItem.frames ?? [], response.item.frames ?? []),
            });
          }
          return {
            ...jobItem,
            error: response.error?.message ?? 'Failed to refresh job status.',
          };
        });
        allCompleteAfterRefresh = next.length > 0 && next.every((jobItem) => isTerminalStatus(jobItem.status));
        return next;
      });

      const firstError = responses.find((response) => response.error);
      setJobError(firstError ? firstError.error.message : null);

      if (allCompleteAfterRefresh) {
        stopBatchPolling();
      }
    } finally {
      refreshingJobsRef.current = false;
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
          save_frames: saveFrames,
        });
        const id = item?.id ?? item?.jobId ?? item?.job_id;
        if (!id) {
          throw new Error('Job started but no job id was returned by the backend.');
        }
        queuedResponses.push(
          normalizeMonitorJob({
            ...item,
            id,
            frames: mergeFrameImages([], item?.frames ?? []),
          }),
        );
      }

      if (!queuedResponses.length) {
        throw new Error('No jobs were started.');
      }

      monitoredJobsRef.current = queuedResponses;
      setMonitoredJobs(queuedResponses);
      refreshPendingJobs();
      pollingTimerRef.current = setInterval(() => {
        refreshPendingJobs();
      }, JOB_POLL_INTERVAL_MS);
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
  const failedJobsCount = monitoredJobs.filter((jobItem) => isFailedStatus(jobItem.status)).length;
  const activeJobsCount = monitoredJobs.filter((jobItem) => isActiveStatus(jobItem.status)).length;
  const allBatchJobsComplete = monitoredJobs.length > 0 && monitoredJobs.every((jobItem) => isTerminalStatus(jobItem.status));
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
  const latestJobWithFrames = useMemo(() => {
    const candidates = monitoredJobs.filter((jobItem) => (jobItem.frames?.length ?? 0) > 0);
    if (!candidates.length) return null;
    return candidates
      .slice()
      .sort(
        (a, b) =>
          new Date(b.completedAt ?? b.createdAt ?? 0).getTime() -
          new Date(a.completedAt ?? a.createdAt ?? 0).getTime(),
      )[0];
  }, [monitoredJobs]);
  const detections = latestCompletedJob?.events ?? [];
  const latestCompletedEventCount = latestCompletedJob?.eventCount ?? detections.length;
  const topSignals = detections[0]?.signalValues ?? null;
  const accidentJobsCount = monitoredJobs.filter((jobItem) => jobItem.accidentDetected === true).length;
  const previewCameras = cameras.slice(0, 6);
  const uptimePercent = stats?.uptimePercent != null ? Number(stats.uptimePercent) : null;
  const apiDebugSnapshot = useMemo(() => {
    const payload = {
      stats: stats?.raw ?? stats ?? null,
      incidents: incidents.map((item) => item?.raw ?? item),
      cameras: cameras.map((item) => item?.raw ?? item),
      health: health?.raw ?? health ?? null,
      jobs: jobs.map((item) => item?.raw ?? item),
      monitoredJobs: monitoredJobs.map((item) => item?.raw ?? item),
      overviewMeta: overviewMeta?.raw ?? overviewMeta ?? null,
      incidentsMeta: incidentsMeta?.raw ?? incidentsMeta ?? null,
      jobsMeta: jobsMeta?.raw ?? jobsMeta ?? null,
      healthMeta: healthMeta?.raw ?? healthMeta ?? null,
      dashboardError: error ?? null,
      monitorError: jobError ?? null,
    };
    return JSON.stringify(payload, null, 2);
  }, [stats, incidents, cameras, health, jobs, monitoredJobs, overviewMeta, incidentsMeta, jobsMeta, healthMeta, error, jobError]);
  const recentJobsApiExample = useMemo(() => {
    if (!jobs.length) return null;
    const sample = jobs
      .slice()
      .sort(
        (a, b) =>
          new Date(b.updatedAt ?? b.completedAt ?? b.createdAt ?? 0).getTime() -
          new Date(a.updatedAt ?? a.completedAt ?? a.createdAt ?? 0).getTime(),
      )[0];
    return sample?.raw ?? sample;
  }, [jobs]);
  const recentJobsApiExampleJson = useMemo(() => {
    return JSON.stringify(recentJobsApiExample, null, 2);
  }, [recentJobsApiExample]);

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
        description={`One detection job is queued for each of ${totalFixedCameras} fixed cameras, then each pending/running job is refreshed every second.`}
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
          Jobs are queued as <strong>pending</strong>, advance to <strong>running</strong> as processing begins, then end as
          <strong>complete</strong> or <strong>failed</strong>. Frame images appear progressively while polling.
        </p>

        {jobError && <AlertBanner type="warning" message="Job monitor error" detail={jobError} />}

        {monitoredJobs.length > 0 && (
          <div className={styles.monitorSummary} role="status" aria-live="polite">
            {!allBatchJobsComplete ? (
              <>
                <strong>{completedJobsCount} complete, {failedJobsCount} failed, out of {monitoredJobs.length} jobs.</strong>
                <span>{activeJobsCount} jobs still pending/running.</span>
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
            {activeJobsCount > 0 && (
              <StatusBadge status="warning" label="in-progress" />
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

        {latestJobWithFrames && (
          <div className={styles.framesPanel}>
            <h3 className={styles.framesTitle}>
              Frame Images - Job {latestJobWithFrames.id} ({latestJobWithFrames.frames.length})
            </h3>
            <div className={styles.framesList}>
              {latestJobWithFrames.frames.map((frame) => (
                <article key={frame.frameIndex} className={styles.frameCard}>
                  <div className={styles.frameHeader}>Frame {frame.frameIndex}</div>
                  <div className={styles.frameGrid}>
                    <figure>
                      <figcaption>Original</figcaption>
                      {frame.capture ? (
                        <img src={frame.capture} alt={`Frame ${frame.frameIndex} original`} loading="lazy" />
                      ) : <div>No image</div>}
                    </figure>
                    <figure>
                      <figcaption>Annotated</figcaption>
                      {frame.captureAnnotated ? (
                        <img src={frame.captureAnnotated} alt={`Frame ${frame.frameIndex} annotated`} loading="lazy" />
                      ) : <div>No image</div>}
                    </figure>
                    <figure>
                      <figcaption>Pipeline Output</figcaption>
                      {frame.pipelineOutput ? (
                        <img src={frame.pipelineOutput} alt={`Frame ${frame.frameIndex} pipeline output`} loading="lazy" />
                      ) : <div>No image</div>}
                    </figure>
                  </div>
                </article>
              ))}
            </div>
          </div>
        )}

        {latestCompletedJob && (
          <p className={styles.sectionMeta}>
            Latest completed job (<strong>{latestCompletedJob.id}</strong>) returned <strong>{latestCompletedEventCount}</strong> events.
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

      <SectionCard
        title="API Debug Output"
        description="Raw API-backed payload snapshot for troubleshooting."
      >
        <p className={styles.sectionMeta}>Recent Jobs API Output (one example)</p>
        <pre className={styles.debugPre}>
          {recentJobsApiExampleJson ?? 'No recent jobs API data yet.'}
        </pre>
        <p className={styles.sectionMeta}>
          Full Dashboard API Snapshot
        </p>
        <pre className={styles.debugPre}>{apiDebugSnapshot}</pre>
      </SectionCard>
    </main>
  );
}
