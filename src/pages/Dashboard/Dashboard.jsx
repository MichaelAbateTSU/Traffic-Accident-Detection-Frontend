import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import FrameGallery from '../../components/FrameGallery/FrameGallery.jsx';
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
import { getJob, parseMaxFrames, startDetectionJob } from '../../services/api.js';
import { beginJobSubmission, endJobSubmission, recoverJobMonitor, saveJobMonitor } from '../../services/jobMonitor.js';
import { FIXED_CAMERA_STREAM_URLS } from '../../constants/cameras.js';
import { formatDateTime, formatNumber, formatPercent } from '../../utils/formatters.js';
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
  const [maxFrames, setMaxFrames] = useState('120');
  const [videoUrl, setVideoUrl] = useState('');
  const [videoUrlError, setVideoUrlError] = useState(null);
  const [frameCountError, setFrameCountError] = useState(null);
  const [batchStartError, setBatchStartError] = useState(null);
  const [startingJob, setStartingJob] = useState(false);
  const [monitoredJobs, setMonitoredJobs] = useState([]);
  const [jobError, setJobError] = useState(null);
  const [jobSubmissionError, setJobSubmissionError] = useState(null);
  const [selectedIncident, setSelectedIncident] = useState(null);
  const [recoveringMonitor, setRecoveringMonitor] = useState(true);
  const [monitorRecoveryError, setMonitorRecoveryError] = useState(null);
  const [monitorStorageError, setMonitorStorageError] = useState(null);
  const [recoveryKey, setRecoveryKey] = useState(0);
  const totalFixedCameras = FIXED_CAMERA_STREAM_URLS.length;
  const pollingTimerRef = useRef(null);
  const refreshingJobsRef = useRef(false);
  const monitoredJobsRef = useRef([]);
  const startingJobRef = useRef(false);
  const recoveringMonitorRef = useRef(true);
  const monitorMountedRef = useRef(true);

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
      refreshingJobsRef.current = false;
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
      if (!monitorMountedRef.current) return;

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
        monitoredJobsRef.current = next;
        return next;
      });

      const firstError = responses.find((response) => response.error);
      setJobError(firstError ? firstError.error.message : null);

      if (allCompleteAfterRefresh) {
        stopBatchPolling();
        setBatchStartError(null);
      }
    } finally {
      refreshingJobsRef.current = false;
    }
  }, [stopBatchPolling]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    recoveringMonitorRef.current = true;
    setRecoveringMonitor(true);
    setMonitorRecoveryError(null);
    recoverJobMonitor({ signal: controller.signal })
      .then(({ jobs: recovered, warning, error: recoveryError }) => {
        if (!active) return;
        monitoredJobsRef.current = recovered.map(normalizeMonitorJob);
        setMonitoredJobs(monitoredJobsRef.current);
        setJobSubmissionError(warning);
        setJobError(recoveryError);
        persistMonitor(recovered.map((item) => item.id), warning);
        if (recovered.some((item) => !isTerminalStatus(item.status))) {
          stopBatchPolling();
          pollingTimerRef.current = setInterval(refreshPendingJobs, JOB_POLL_INTERVAL_MS);
          refreshPendingJobs();
        }
        recoveringMonitorRef.current = false;
        setRecoveringMonitor(false);
      })
      .catch((error) => {
        if (active && error.name !== 'AbortError') {
          setMonitorRecoveryError(`Cannot restore accepted jobs: ${error.message}. New submissions remain blocked; retry recovery.`);
          setRecoveringMonitor(false);
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [recoveryKey, refreshPendingJobs, stopBatchPolling]);

  function persistMonitor(ids, warning = null) {
    try {
      saveJobMonitor(ids, warning);
      setMonitorStorageError(null);
    } catch (error) {
      setMonitorStorageError(`Cannot save job monitor for reload recovery: ${error.message}. Active jobs will still be recovered from the backend.`);
    }
  }

  useEffect(() => {
    monitorMountedRef.current = true;
    return () => {
      monitorMountedRef.current = false;
      stopBatchPolling();
    };
  }, [stopBatchPolling]);

  async function handleStartJob(event, sources = FIXED_CAMERA_STREAM_URLS) {
    event.preventDefault();
    let frameCount;
    try {
      frameCount = parseMaxFrames(maxFrames);
    } catch (err) {
      setFrameCountError(err.message);
      return;
    }
    setFrameCountError(null);
    if (recoveringMonitorRef.current) {
      setBatchStartError('Accepted job recovery must finish before starting a new submission.');
      return;
    }
    if (startingJobRef.current || monitoredJobsRef.current.some((jobItem) => !isTerminalStatus(jobItem.status))) {
      setBatchStartError('Wait for the accepted detection jobs to finish before starting another submission. Monitoring continues.');
      return;
    }
    setBatchStartError(null);
    startingJobRef.current = true;
    beginJobSubmission();

    setStartingJob(true);
    stopBatchPolling();
    setJobError(null);
    setJobSubmissionError(null);
    monitoredJobsRef.current = [];
    setMonitoredJobs([]);

    const queuedResponses = [];
    try {
      for (const streamUrl of sources) {
        const { item } = await startDetectionJob({
          stream_url: streamUrl,
          save_frames: saveFrames,
          max_frames: frameCount,
        });
        const id = item?.id ?? item?.jobId ?? item?.job_id;
        if (!id) {
          throw new Error('Job started but no job id was returned by the backend.');
        }
        queuedResponses.push(
          normalizeMonitorJob({
            ...item,
            id,
            maxFrames: item.maxFrames ?? frameCount,
            frames: mergeFrameImages([], item?.frames ?? []),
          }),
        );
        persistMonitor(queuedResponses.map((job) => job.id));
      }

      if (!queuedResponses.length) {
        throw new Error('No jobs were started.');
      }
    } catch (err) {
      console.error(err);
      const warning = queuedResponses.length
        ? `${queuedResponses.length} of ${sources.length} jobs started; submission stopped: ${err.message}`
        : err.message;
      setJobSubmissionError(warning);
      persistMonitor(queuedResponses.map((job) => job.id), warning);
    } finally {
      if (queuedResponses.length) {
        monitoredJobsRef.current = queuedResponses;
        setMonitoredJobs(queuedResponses);
        if (monitorMountedRef.current && queuedResponses.some((jobItem) => !isTerminalStatus(jobItem.status))) {
          pollingTimerRef.current = setInterval(() => {
            refreshPendingJobs();
          }, JOB_POLL_INTERVAL_MS);
          refreshPendingJobs();
        }

        if (monitorMountedRef.current) reload();
      }
      setStartingJob(false);
      startingJobRef.current = false;
      endJobSubmission();
    }
  }

  async function handleVideoJob(event) {
    event.preventDefault();
    const source = videoUrl.trim();
    try {
      const url = new URL(source);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
        throw new Error('Use an HTTPS video URL without credentials or a fragment.');
      }
    } catch (error) {
      setVideoUrlError(`Invalid video source: ${error.message}`);
      return;
    }
    setVideoUrlError(null);
    await handleStartJob(event, [source]);
  }

  function selectBenchmark(filename) {
    setVideoUrl(`https://media.githubusercontent.com/media/accidentbench/accidentbench.github.io/main/assets/videos/real-world/${filename}%20(3).mp4`);
    setMaxFrames('200');
    setSaveFrames(true);
    setVideoUrlError(null);
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
      submissionError: jobSubmissionError ?? null,
    };
    return JSON.stringify(payload, null, 2);
  }, [stats, incidents, cameras, health, jobs, monitoredJobs, overviewMeta, incidentsMeta, jobsMeta, healthMeta, error, jobError, jobSubmissionError]);
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
        <span className={styles.subtitle}>Alarm-frame review and heuristic accident scores (0-1), not calibrated probabilities or confirmed accidents</span>
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
          message={`${activeIncidents.length} alarm-frame record${activeIncidents.length > 1 ? 's' : ''} with active record status on this page`}
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
            label="Alarm Frames Today"
            value={stats?.incidentsToday ?? '—'}
            icon="INC"
            trend={(stats?.incidentsToday ?? 0) > 0 ? 'Review records' : 'No alarm frames recorded'}
            variant={stats?.incidentsToday > 0 ? 'danger' : 'good'}
            description="One record per frame with a heuristic alarm; consecutive records may be one episode, not unique or confirmed accidents."
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
            label="Legacy Nonfailed-job Ratio"
            value={uptimePercent == null ? '—' : formatPercent(uptimePercent / 100, 2)}
            icon="JOB"
            variant="good"
            progressPercent={uptimePercent ?? 0}
            description="Last 30 days: nonfailed jobs among at most 10,000 listed jobs (including queued/running), divided by all jobs in the window. Larger restored histories can undercount the numerator. Backend returns 100% for an empty window; not measured system uptime."
          />
        </section>
      </DataState>

      <SectionCard
        title="Recent Alarm Frames"
        description={`Showing latest ${incidents.length} of ${totalRecentIncidents} records with active status. Status is job-derived by default or manually overridden; it does not confirm review, accident resolution or a live alarm.`}
        action={<Link to="/incidents" className={styles.viewAll}>View all</Link>}
      >
        <IncidentTable
          incidents={incidents}
          compact
          onRowClick={setSelectedIncident}
          selectedIncidentId={selectedIncident?.id ?? null}
          emptyMessage="No alarm-frame records with active status in this dashboard window."
        />
        {selectedIncident && (
          <div className={styles.incidentDetailWrap}>
            <IncidentDetailPanel
              incident={selectedIncident}
              onIncidentUpdated={(updated) => {
                setSelectedIncident((selected) => selected?.id === updated.id ? updated : selected);
                reload();
              }}
            />
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Detection Job Monitor"
        description={`Submit a batch across ${totalFixedCameras} fixed cameras or one approved HTTPS video. Each pending/running job is refreshed every second.`}
      >
        <form className={styles.jobForm} onSubmit={(event) => handleStartJob(event)}>
          <label className={styles.checkboxLabel} htmlFor="maxFrames">
            Frames per source (1-300)
            <input
              id="maxFrames"
              type="number"
              min="1"
              max="300"
              step="1"
              required
              value={maxFrames}
              disabled={startingJob}
              aria-invalid={Boolean(frameCountError)}
              aria-describedby="frame-count-hint"
              onChange={(event) => {
                setMaxFrames(event.target.value);
                setFrameCountError(null);
              }}
            />
          </label>
          <label className={styles.checkboxLabel}>
            <input
              type="checkbox"
              checked={saveFrames}
              disabled={startingJob}
              onChange={(event) => setSaveFrames(event.target.checked)}
            />
            Save frames
          </label>
          <button type="submit" className={styles.retryBtn} disabled={startingJob || activeJobsCount > 0 || recoveringMonitor || Boolean(monitorRecoveryError)}>
            {startingJob ? 'Submitting detection jobs...' : `Run detection across ${totalFixedCameras} cameras`}
          </button>
        </form>
        <section aria-label="Single video detection">
          <h3>Run one approved HTTPS video</h3>
          <p>Uses the Frames per source limit above as the frame limit for this video, and the same Save frames setting.
            The operator must explicitly approve the exact source URL on the backend allowlist before running it.
            Backend rejection is shown as a job submission error; this app never bypasses approval.</p>
          <form className={styles.jobForm} onSubmit={handleVideoJob}>
            <label htmlFor="videoSource">Approved HTTPS video URL</label>
            <input id="videoSource" type="url" required value={videoUrl} onChange={(event) => setVideoUrl(event.target.value)} />
            <button type="submit" disabled={startingJob || activeJobsCount > 0 || recoveringMonitor || Boolean(monitorRecoveryError)}>
              {startingJob ? 'Submission in progress...' : 'Run single video'}
            </button>
          </form>
          {videoUrlError && <p role="alert">{videoUrlError}</p>}
          <p>Optional examples from <a href="https://accidentbench.github.io/" target="_blank" rel="noreferrer">ACCIDENT benchmark</a>.
            Reported license: CC BY-NC-SA 4.0, noncommercial use only. Media stays on the source host; no media is bundled.
            Selecting an example sets 200 decoded frames and Save frames, but does not submit or approve it.</p>
          <button type="button" onClick={() => selectBenchmark('tbone')}>Select tbone (3) example</button>
          <a href="https://media.githubusercontent.com/media/accidentbench/accidentbench.github.io/main/assets/videos/real-world/tbone%20(3).mp4" target="_blank" rel="noreferrer">Original tbone (3) source</a>
          <p>CSV onset: frame 18, 0.72 s. The website label differs from the CSV category; index conventions and detector accuracy are not verified.</p>
          <button type="button" onClick={() => selectBenchmark('single')}>Select single (3) example</button>
          <a href="https://media.githubusercontent.com/media/accidentbench/accidentbench.github.io/main/assets/videos/real-world/single%20(3).mp4" target="_blank" rel="noreferrer">Original single (3) source</a>
          <p>CSV onset: frame 148, 6.644433 s. At least 149 decoded frames are needed; the example uses 200.
            CSV source timing is distinct from the processing elapsed time displayed in results. Saved annotated frames and heuristic scores do not establish accuracy.</p>
        </section>
        <p id="frame-count-hint" className={styles.monitorHint}>
          Each source job processes up to the selected frame count (default 120), not continuous monitoring.
          Larger counts take longer; pending and running jobs continue to refresh until they finish.
        </p>
        {frameCountError && <p role="alert">{frameCountError}</p>}
        {activeJobsCount > 0 && (
          <p role="status">Another submission can start after all accepted detection jobs finish. Monitoring continues for pending and running jobs.</p>
        )}
        {batchStartError && <p role="alert">{batchStartError}</p>}
        {recoveringMonitor && <p role="status">Restoring accepted detection jobs before allowing new submissions...</p>}
        {monitorRecoveryError && (
          <div role="alert">
            <p>{monitorRecoveryError}</p>
            <button type="button" onClick={() => setRecoveryKey((key) => key + 1)}>Retry job recovery</button>
          </div>
        )}
        {monitorStorageError && <p role="alert">{monitorStorageError}</p>}

        <p className={styles.monitorHint}>
          Jobs are queued as <strong>pending</strong>, advance to <strong>running</strong> as processing begins, then end as
          <strong>complete</strong> or <strong>failed</strong>. Enable <strong>Save frames</strong> before starting a job
          to see saved frame images here and the latest detection frame in the camera view. With Save frames enabled,
          images appear progressively while polling; unchecked jobs do not save images.
        </p>

        {jobSubmissionError && <AlertBanner type="warning" message="Job submission error" detail={jobSubmissionError} />}
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
                <strong>All {monitoredJobs.length} detection jobs finished: {completedJobsCount} complete, {failedJobsCount} failed.</strong>
                <span>
                  {failedJobsCount > 0
                    ? 'Detection results are incomplete because some detection jobs failed.'
                    : accidentJobsCount === 0
                    ? 'No heuristic alarm frames reported; this does not establish that the sources were accident-free.'
                    : `${accidentJobsCount} detection job${accidentJobsCount > 1 ? 's' : ''} reported heuristic alarm frames, not confirmed accidents.`}
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
            <FrameGallery frames={latestJobWithFrames.frames} jobId={latestJobWithFrames.id} />
          </div>
        )}

        {latestCompletedJob && (
          <p className={styles.sectionMeta}>
            Latest completed job (<strong>{latestCompletedJob.id}</strong>) returned <strong>{latestCompletedEventCount}</strong> alarm-frame records.
            Peak heuristic accident score (0-1): <strong>{formatNumber(latestCompletedJob.peakConfidence, 2)}</strong>.
          </p>
        )}
      </SectionCard>

      <SectionCard title="Detection Analytics" description="Smoothed heuristic accident scores and supporting signals, not calibrated probabilities">
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
