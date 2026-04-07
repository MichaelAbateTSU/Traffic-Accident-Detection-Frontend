import { useCallback, useEffect, useRef, useState } from 'react';
import { getJob, getJobDetections, getJobStatus } from '../services/api.js';

const TERMINAL_JOB_STATES = new Set(['complete', 'completed', 'failed', 'cancelled', 'error']);

export function usePollingJob(pollIntervalMs = 3000) {
  const [job, setJob] = useState(null);
  const [detections, setDetections] = useState([]);
  const [statusMeta, setStatusMeta] = useState(null);
  const [detectionsMeta, setDetectionsMeta] = useState(null);
  const [jobMeta, setJobMeta] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const timerRef = useRef(null);
  const statusControllerRef = useRef(null);
  const detailControllerRef = useRef(null);

  const stopPolling = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const clearControllers = useCallback(() => {
    if (statusControllerRef.current) {
      statusControllerRef.current.abort();
      statusControllerRef.current = null;
    }
    if (detailControllerRef.current) {
      detailControllerRef.current.abort();
      detailControllerRef.current = null;
    }
  }, []);

  const fetchComposite = useCallback(async (jobId) => {
    if (!jobId) return { terminal: true };

    const controller = new AbortController();
    if (statusControllerRef.current) statusControllerRef.current.abort();
    statusControllerRef.current = controller;

    const [{ item: statusItem, meta: statusMetaValue }, { item: jobItem, meta: jobMetaValue }] = await Promise.all([
      getJobStatus(jobId, { signal: controller.signal }),
      getJob(jobId, { signal: controller.signal }),
    ]);

    const mergedItem = {
      ...jobItem,
      ...statusItem,
      events: jobItem.events?.length ? jobItem.events : statusItem.events ?? [],
    };

    setJob(mergedItem);
    setStatusMeta(statusMetaValue);
    setJobMeta(jobMetaValue);
    setError(null);

    const normalized = String(mergedItem.status ?? '').toLowerCase();
    const terminal = TERMINAL_JOB_STATES.has(normalized);

    if (terminal && ['complete', 'completed'].includes(normalized)) {
      const detectionController = new AbortController();
      if (detailControllerRef.current) detailControllerRef.current.abort();
      detailControllerRef.current = detectionController;
      const { items, meta: detectionsMetaValue } = await getJobDetections(
        jobId,
        { detail: 'full', page: 1, pageSize: 100 },
        { signal: detectionController.signal },
      );
      setDetections(items);
      setDetectionsMeta(detectionsMetaValue);
    }

    return { terminal };
  }, []);

  const startPolling = useCallback(async (jobId) => {
    stopPolling();
    clearControllers();
    setDetections([]);
    setError(null);
    setLoading(true);

    try {
      const initial = await fetchComposite(jobId);
      if (!initial.terminal) {
        timerRef.current = setInterval(() => {
          fetchComposite(jobId).catch((err) => {
            if (err.name === 'AbortError') return;
            setError(err.message);
            stopPolling();
          });
        }, pollIntervalMs);
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        setError(err.message);
      }
      stopPolling();
    } finally {
      setLoading(false);
    }
  }, [clearControllers, fetchComposite, pollIntervalMs, stopPolling]);

  useEffect(() => {
    return () => {
      stopPolling();
      clearControllers();
    };
  }, [clearControllers, stopPolling]);

  return {
    job,
    detections,
    statusMeta,
    detectionsMeta,
    jobMeta,
    loading,
    error,
    startPolling,
    stopPolling,
    clearControllers,
    setJob,
    setDetections,
  };
}
