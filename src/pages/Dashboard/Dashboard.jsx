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
import { API_CONFIGURATION, parseMaxFrames } from '../../services/api.js';
import { beginJobSubmission, endJobSubmission, getMonitoredJob, recoverJobMonitor, saveJobMonitor, submitMonitoredDetection } from '../../services/jobMonitor.js';
import { createSubmissionJournal, hasUncertainSubmissions, submissionWarnings } from '../../services/submissionJournal.js';
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

function needsMonitoring(status) {
  return !isTerminalStatus(status) && String(status ?? '').toLowerCase() !== 'unavailable';
}

function isActiveStatus(status) {
  const normalized = String(status ?? '').toLowerCase();
  return normalized === 'pending' || normalized === 'running';
}

function normalizeMonitorJobStatus(status) {
  const normalized = String(status ?? '').toLowerCase();
  if (['pending', 'running', 'complete', 'failed', 'unavailable'].includes(normalized)) {
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
  const [submissionIntents, setSubmissionIntents] = useState({ version: 1, batches: [] });
  const [submissionRecoveryError, setSubmissionRecoveryError] = useState(null);
  const [replayUrls, setReplayUrls] = useState({});
  const submissionPayloadsRef = useRef(new Map());
  const journalRef = useRef(null);
  if (!journalRef.current) journalRef.current = createSubmissionJournal();
  const totalFixedCameras = FIXED_CAMERA_STREAM_URLS.length;
  const pollingTimerRef = useRef(null);
  const pollingRequestsRef = useRef(new Map());
  const lastPolledIdRef = useRef(null);
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
    for (const controller of pollingRequestsRef.current.values()) controller.abort();
    pollingRequestsRef.current.clear();
  }, []);

  const refreshPendingJobs = useCallback(async () => {
    if (!monitorMountedRef.current) return;

    const currentJobs = monitoredJobsRef.current;
    const pendingIds = currentJobs
      .filter((jobItem) => !jobItem.recoveringRead && !jobItem.recoveryDeferred && needsMonitoring(jobItem.status))
      .map((jobItem) => jobItem.id)
      .filter(Boolean);

    if (!pendingIds.length) {
      stopBatchPolling();
      return;
    }

    const nextIndex = (pendingIds.indexOf(lastPolledIdRef.current) + 1) % pendingIds.length;
    const orderedIds = [...pendingIds.slice(nextIndex), ...pendingIds.slice(0, nextIndex)];
    await Promise.all(
      orderedIds.map(async (jobId) => {
        if (pollingRequestsRef.current.has(jobId)) return;
        if (pollingRequestsRef.current.size >= 2) return;
        lastPolledIdRef.current = jobId;
        const controller = new AbortController();
        pollingRequestsRef.current.set(jobId, controller);
        try {
          let item;
          let readError;
          try {
            ({ item } = await getMonitoredJob(jobId, { signal: controller.signal }));
          } catch (error) {
            if (error.name === 'AbortError') return;
            readError = error;
          }
          if (!monitorMountedRef.current || pollingRequestsRef.current.get(jobId) !== controller || controller.signal.aborted) return;

          const next = monitoredJobsRef.current.map((jobItem) => {
            if (jobItem.id !== jobId) return jobItem;
            if (readError) {
              return {
                ...jobItem,
                status: readError.status === 404 ? 'unavailable' : jobItem.status,
                monitorError: readError.status === 404
                  ? `Job ${jobId} is unavailable (expired or unknown); its inference outcome is unknown. ${readError.message}`
                  : `Cannot refresh job ${jobId}: ${readError.message}`,
              };
            }
            return normalizeMonitorJob({
              ...jobItem,
              ...item,
              admissionStatusUnknown: false,
              monitorError: null,
              events: item.events?.length ? item.events : jobItem.events ?? [],
              frames: mergeFrameImages(jobItem.frames ?? [], item.frames ?? []),
            });
          });
          monitoredJobsRef.current = next;
          setMonitoredJobs(next);
          setJobError(next.map((jobItem) => jobItem.monitorError).filter(Boolean).join(' ') || null);
          if (next.length > 0 && next.every((jobItem) => !needsMonitoring(jobItem.status))) {
            stopBatchPolling();
            setBatchStartError(null);
          }
        } finally {
          if (pollingRequestsRef.current.get(jobId) === controller) pollingRequestsRef.current.delete(jobId);
        }
      }),
    );
  }, [stopBatchPolling]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let sawProgress = false;
    stopBatchPolling();
    monitoredJobsRef.current = monitoredJobsRef.current.map((item) => ({ ...item, recoveringRead: true }));
    setMonitoredJobs(monitoredJobsRef.current);
    recoveringMonitorRef.current = true;
    setRecoveringMonitor(true);
    setMonitorRecoveryError(null);
    try {
      setSubmissionIntents(journalRef.current.read());
    } catch (error) {
      setMonitorRecoveryError(error.message);
      setRecoveringMonitor(false);
      return () => controller.abort();
    }
    const mergeRecovery = (recovered) => {
      const merged = new Map(monitoredJobsRef.current.map((item) => [item.id, item]));
      for (const item of recovered) {
        const previous = merged.get(item.id);
        // Polling can finish while older recovery listings are still in flight.
        if (previous && !previous.recoveringRead && ['complete', 'failed'].includes(previous.status) && needsMonitoring(item.status)) continue;
        merged.set(item.id, normalizeMonitorJob({
          ...(item.recoveringRead && previous && !['complete', 'failed'].includes(item.status) ? { ...item, ...previous, recoveringRead: true } : { ...previous, ...item }),
          monitorError: item.monitorError,
          events: item.events?.length ? item.events : previous?.events ?? [],
          frames: mergeFrameImages(previous?.frames, item.frames),
        }));
      }
      monitoredJobsRef.current = [...merged.values()];
      setMonitoredJobs(monitoredJobsRef.current);
      if (monitoredJobsRef.current.some((item) => !item.recoveringRead && !item.recoveryDeferred && needsMonitoring(item.status))) {
        if (!pollingTimerRef.current) pollingTimerRef.current = setInterval(refreshPendingJobs, JOB_POLL_INTERVAL_MS);
        refreshPendingJobs();
      } else {
        stopBatchPolling();
      }
    };
    recoverJobMonitor({ signal: controller.signal, journal: journalRef.current, knownIds: monitoredJobsRef.current.map((item) => item.id), onJobs: ({ jobs: recovered }) => {
      if (!active) return;
      sawProgress = true;
      mergeRecovery(recovered);
      setJobError(monitoredJobsRef.current.map((item) => item.monitorError).filter(Boolean).join(' ') || null);
    } })
      .then(({ jobs: recovered, warning, error: recoveryError, intents, submissionError }) => {
        if (!active) return;
        if (!sawProgress) mergeRecovery(recovered.map((item) => ({ ...item, recoveringRead: false })));
        setJobSubmissionError(warning);
        setJobError(sawProgress ? monitoredJobsRef.current.map((item) => item.monitorError).filter(Boolean).join(' ') || null : recoveryError);
        setSubmissionIntents(intents ?? journalRef.current.read());
        setSubmissionRecoveryError(submissionError ?? null);
        persistMonitor(monitoredJobsRef.current.map((item) => item.id), warning);
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
      saveJobMonitor(ids, warning, journalRef.current.backendIdentity);
      if (monitorMountedRef.current) setMonitorStorageError(null);
    } catch (error) {
      if (monitorMountedRef.current) {
        setMonitorStorageError(`Cannot save job monitor for reload recovery: ${error.message}. Retain the submission journal; accepted outcomes may require key lookup.`);
      } else {
        console.error('Cannot persist accepted detection recovery after navigation. Keep existing browser recovery storage; outcome may remain unknown.');
      }
    }
  }

  function reportJournalFailure(error) {
    if (monitorMountedRef.current) setMonitorStorageError(error.message);
    else console.error('Cannot persist accepted detection recovery after navigation. Keep existing browser recovery storage; outcome may remain unknown.');
  }

  function trackAcceptedJob(acceptedJob) {
    if (!monitorMountedRef.current) return;
    const previous = monitoredJobsRef.current.find((item) => item.id === acceptedJob.id);
    monitoredJobsRef.current = previous
      ? monitoredJobsRef.current.map((item) => item.id === acceptedJob.id ? {
        ...item, ...acceptedJob,
        monitorError: acceptedJob.monitorError,
        frames: mergeFrameImages(item.frames, acceptedJob.frames),
        events: acceptedJob.events?.length ? acceptedJob.events : item.events ?? [],
      } : item)
      : [...monitoredJobsRef.current, acceptedJob];
    setMonitoredJobs(monitoredJobsRef.current);
    if (monitoredJobsRef.current.some((item) => needsMonitoring(item.status))) {
      if (!pollingTimerRef.current) pollingTimerRef.current = setInterval(refreshPendingJobs, JOB_POLL_INTERVAL_MS);
      refreshPendingJobs();
    }
  }

  function recordSubmissionExpiry(key, error) {
    if (error.status === 410 && ['idempotency_key_expired', 'idempotency_result_expired'].includes(error.code)) {
      journalRef.current.recordLookup(key, 'expired');
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
    const submissionSources = [...sources];
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
    if (startingJobRef.current || monitoredJobsRef.current.some((jobItem) => needsMonitoring(jobItem.status))) {
      setBatchStartError('Wait for the accepted detection jobs to finish before starting another submission. Monitoring continues.');
      return;
    }
    let batch;
    startingJobRef.current = true;
    setStartingJob(true);
    try {
      if (API_CONFIGURATION.error) throw new Error(API_CONFIGURATION.error);
      batch = await journalRef.current.prepareBatch(submissionSources, {
        maxFrames: frameCount, saveFrames,
        sourceKind: sources === FIXED_CAMERA_STREAM_URLS ? 'fixed-camera' : 'arbitrary',
        protocol: 'keyed-v1',
      });
      if (!monitorMountedRef.current) {
        journalRef.current.warn(batch.id, 'navigation');
        startingJobRef.current = false;
        return;
      }
      setSubmissionIntents(journalRef.current.read());
    } catch (error) {
      if (monitorMountedRef.current) {
        setJobSubmissionError(error.message);
        setStartingJob(false);
      } else reportJournalFailure(error);
      startingJobRef.current = false;
      return;
    }
    setBatchStartError(null);
    beginJobSubmission({ keyed: true });

    setStartingJob(true);
    stopBatchPolling();
    setJobError(null);
    setJobSubmissionError(null);
    const queuedResponses = [];
    const previousIds = monitoredJobsRef.current.map((item) => item.id);
    const recoveryIds = () => [...new Set([...previousIds, ...queuedResponses.map((job) => job.id)])];
    let attemptedKey;
    try {
      for (const [sourceIndex, streamUrl] of submissionSources.entries()) {
        if (!monitorMountedRef.current) {
          journalRef.current.warn(batch.id, 'navigation');
          break;
        }
        const intent = batch.entries[sourceIndex];
        const payload = { stream_url: streamUrl, save_frames: saveFrames, max_frames: frameCount };
        submissionPayloadsRef.current.set(intent.key, payload);
        attemptedKey = intent.key;
        setSubmissionIntents(journalRef.current.markSending(intent.key));
        if (sourceIndex === 0) {
          monitoredJobsRef.current = [];
          setMonitoredJobs([]);
        }
        const { item, admissionFailed } = await submitMonitoredDetection(payload, intent.key);
        const id = item?.id ?? item?.jobId ?? item?.job_id;
        if (!id) {
          throw new Error('Job started but no job id was returned by the backend.');
        }
        const acceptedJob = normalizeMonitorJob({
          ...item,
          id,
          maxFrames: item.maxFrames ?? frameCount,
          frames: mergeFrameImages([], item?.frames ?? []),
        });
        queuedResponses.push(acceptedJob);
        let journalSaveError;
        try {
          journalRef.current.accept(intent.key, id);
        } catch (error) {
          reportJournalFailure(error);
          persistMonitor(recoveryIds(), 'Confirmed acceptance could not be saved in the submission journal. Retain accepted job IDs; do not replay.');
          journalSaveError = error;
        }
        // Keep known acceptance for recovery, but do not continue a batch after navigation.
        if (!monitorMountedRef.current) {
          const remaining = submissionSources.length - queuedResponses.length;
          persistMonitor(recoveryIds(), journalSaveError
            ? 'Confirmed acceptance could not be saved in the submission journal. Retain accepted job IDs; do not replay.'
            : remaining > 0
            ? `${queuedResponses.length} of ${submissionSources.length} jobs started; submission stopped after navigation: ${remaining} sources were not submitted.`
            : null);
          if (remaining > 0) journalRef.current.warn(batch.id, 'navigation');
          break;
        }
        persistMonitor(recoveryIds());
        trackAcceptedJob(acceptedJob);
        if (journalSaveError) throw journalSaveError;
        setSubmissionIntents(journalRef.current.read());
        if (admissionFailed) throw new Error('The original job was reserved but inference admission failed. Its durable status must be monitored; no replacement inference was started.');
      }

      if (!queuedResponses.length) {
        throw new Error('No jobs were started.');
      }
    } catch (err) {
      const warning = queuedResponses.length
        ? `${queuedResponses.length} of ${submissionSources.length} jobs started; submission stopped: ${err.message}`
        : err.message;
      if (monitorMountedRef.current) setJobSubmissionError(warning);
      else reportJournalFailure(err);
      // Do not store arbitrary backend error text: it may echo a signed source URL.
      let durableWarning = `${queuedResponses.length} of ${submissionSources.length} jobs started; submission stopped. An unconfirmed outcome must not be retried.`;
      try {
        if (attemptedKey) recordSubmissionExpiry(attemptedKey, err);
        const document = journalRef.current.warn(batch.id, 'submission');
        durableWarning = submissionWarnings(document).join(' ');
        if (monitorMountedRef.current) setSubmissionIntents(document);
      } catch (error) {
        reportJournalFailure(error);
      }
      persistMonitor([...new Set([...previousIds, ...queuedResponses.map((job) => job.id)])], durableWarning);
    } finally {
      if (queuedResponses.length && monitorMountedRef.current) reload();
      if (monitorMountedRef.current) setStartingJob(false);
      startingJobRef.current = false;
      endJobSubmission();
    }
  }

  async function handleReplay(key) {
    if (startingJobRef.current || recoveringMonitorRef.current) return;
    startingJobRef.current = true;
    setStartingJob(true);
    let acceptedId;
    let began = false;
    try {
      if (API_CONFIGURATION.error) throw new Error(API_CONFIGURATION.error);
      const document = journalRef.current.read();
      const entry = document.batches.flatMap((batch) => batch.entries).find((item) => item.key === key);
      if (!entry) throw new Error('Submission recovery reference is missing. No job was sent.');
      const source = replayUrls[key]?.trim() || submissionPayloadsRef.current.get(key)?.stream_url
        || (entry.sourceKind === 'fixed-camera' ? FIXED_CAMERA_STREAM_URLS[entry.sourceIndex] : '');
      if (!source) throw new Error('Re-enter the exact original source URL to replay this request. No URL was saved.');
      const { payload } = await journalRef.current.verifyReplay(key, {
        stream_url: source, max_frames: entry.maxFrames, save_frames: entry.saveFrames,
      });
      if (!monitorMountedRef.current) return;
      setSubmissionIntents(journalRef.current.markReplaySending(key));
      submissionPayloadsRef.current.set(key, payload);
      beginJobSubmission({ keyed: true });
      began = true;
      const { item, admissionFailed } = await submitMonitoredDetection(payload, key);
      acceptedId = item.id;
      let storageError;
      try {
        journalRef.current.accept(key, acceptedId);
      } catch (error) {
        reportJournalFailure(error);
        storageError = error;
      }
      const accepted = normalizeMonitorJob({ ...item, maxFrames: entry.maxFrames });
      trackAcceptedJob(accepted);
      const ids = [...new Set([...monitoredJobsRef.current.map((job) => job.id), acceptedId])];
      const updated = journalRef.current.read();
      const warning = submissionWarnings(updated).join(' ') || null;
      persistMonitor(ids, warning);
      if (storageError) throw storageError;
      if (monitorMountedRef.current) {
        setSubmissionIntents(updated);
        setJobSubmissionError(admissionFailed ? 'Original inference admission failed; its accepted job ID is retained.' : warning);
        setSubmissionRecoveryError(null);
        reload();
      }
    } catch (error) {
      if (acceptedId) persistMonitor([...new Set([...monitoredJobsRef.current.map((job) => job.id), acceptedId])], 'Confirmed acceptance retained; do not replay.');
      try {
        recordSubmissionExpiry(key, error);
        if (monitorMountedRef.current) setSubmissionIntents(journalRef.current.read());
      } catch (storageError) {
        reportJournalFailure(storageError);
      }
      if (monitorMountedRef.current) setJobSubmissionError(error.message);
      else reportJournalFailure(error);
    } finally {
      startingJobRef.current = false;
      if (began) endJobSubmission();
      if (monitorMountedRef.current) setStartingJob(false);
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
  const unavailableJobsCount = monitoredJobs.filter((jobItem) => jobItem.status === 'unavailable').length;
  const uncertainSubmissions = hasUncertainSubmissions(submissionIntents);
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
        <span className={styles.subtitle}>Traffic incident monitoring and heuristic accident scores (0-1), not calibrated probabilities</span>
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
          <button type="submit" className={styles.retryBtn} disabled={startingJob || uncertainSubmissions || activeJobsCount > 0 || recoveringMonitor || Boolean(monitorRecoveryError)}>
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
            <button type="submit" disabled={startingJob || uncertainSubmissions || activeJobsCount > 0 || recoveringMonitor || Boolean(monitorRecoveryError)}>
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
        {uncertainSubmissions && (
          <div role="alert">
            <p>A submission may already have been accepted. New submissions are blocked; reload does not start inference or make retry safe.</p>
            <p>Reconcile uses a read-only key lookup. Explicit same-key replay may admit the original job if it was not previously accepted; it requires the exact original URL and saved frame options, not the current form settings.</p>
            <p>Requires one API owner, the same intact durable backend store, and one active operator tab. Replaced stores or switched deployments are not covered.</p>
            <button type="button" disabled={recoveringMonitor}
              onClick={() => {
                recoveringMonitorRef.current = true;
                setRecoveringMonitor(true);
                setRecoveryKey((key) => key + 1);
              }}>Reconcile submissions (read only)</button>
            {submissionIntents.batches.flatMap((batch) => batch.entries).filter((entry) => ['uncertain', 'not-recorded', 'expired'].includes(entry.state)).map((entry) => (
              <div key={entry.key}>
                <p>Request {entry.key}: {entry.state === 'expired' ? 'identity expired; outcome unknown' : entry.state === 'not-recorded' ? 'no receipt found yet; the original request may still arrive' : 'acceptance uncertain'}.</p>
                {entry.protocol === 'legacy'
                  ? <p>This legacy intent was never sent with a backend request key. It cannot safely be looked up or replayed.</p>
                  : entry.state !== 'expired' && (
                    <>
                      <label htmlFor={`replay-${entry.key}`}>Exact original source URL (needed if unavailable in memory or fixed camera configuration)</label>
                      <input id={`replay-${entry.key}`} type="url" value={replayUrls[entry.key] ?? ''}
                        onChange={(event) => setReplayUrls((urls) => ({ ...urls, [entry.key]: event.target.value }))} />
                      <button type="button" disabled={startingJob || recoveringMonitor}
                        onClick={() => handleReplay(entry.key)}>Submit original request with same key</button>
                    </>
                  )}
              </div>
            ))}
          </div>
        )}
        {submissionRecoveryError && <p role="alert">{submissionRecoveryError}</p>}
        {unavailableJobsCount > 0 && (
          <div role="alert">
            <p>{unavailableJobsCount} jobs unavailable; inference outcomes are unknown, not failed. Missing records may have expired or never existed.</p>
            <button type="button" disabled={recoveringMonitor || startingJob}
              onClick={() => {
                recoveringMonitorRef.current = true;
                setRecoveringMonitor(true);
                setRecoveryKey((key) => key + 1);
              }}>Retry unavailable job recovery</button>
          </div>
        )}

        <p className={styles.monitorHint}>
          Jobs are queued as <strong>pending</strong>, advance to <strong>running</strong> as processing begins, then end as
          <strong>complete</strong> or <strong>failed</strong>. Enable <strong>Save frames</strong> before starting a job
          to see saved frame images here and the latest detection frame in the camera view. With Save frames enabled,
          images appear progressively while polling; unchecked jobs do not save images.
        </p>

        {jobSubmissionError && <AlertBanner type="warning" message="Job submission error" detail={jobSubmissionError} />}
        {jobError && <AlertBanner type="warning" message="Job monitor error" detail={jobError} />}
        {monitoredJobs.some((item) => item.recoveryDeferred) && (
          <button type="button" disabled={recoveringMonitor} onClick={() => {
            monitoredJobsRef.current = [...monitoredJobsRef.current].sort((a, b) => Number(Boolean(b.recoveryDeferred)) - Number(Boolean(a.recoveryDeferred)));
            setRecoveryKey((key) => key + 1);
          }}>Retry deferred historical recovery (read only)</button>
        )}

        {monitoredJobs.length > 0 && (
          <div className={styles.monitorSummary} role="status" aria-live="polite">
            {!allBatchJobsComplete ? (
              <>
                <strong>{completedJobsCount} complete, {failedJobsCount} failed, out of {monitoredJobs.length} jobs.</strong>
                <span>{activeJobsCount} jobs still pending/running.</span>
                {unavailableJobsCount > 0 && <span>{unavailableJobsCount} unavailable; outcomes unknown.</span>}
              </>
            ) : (
              <>
                <strong>All {monitoredJobs.length} detection jobs finished: {completedJobsCount} complete, {failedJobsCount} failed.</strong>
                <span>
                  {failedJobsCount > 0
                    ? 'Detection results are incomplete because some detection jobs failed.'
                    : accidentJobsCount === 0
                    ? '0 accidents detected.'
                    : `${accidentJobsCount} detection job${accidentJobsCount > 1 ? 's' : ''} reported accident events.`}
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
            Latest completed job (<strong>{latestCompletedJob.id}</strong>) returned <strong>{latestCompletedEventCount}</strong> events.
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
