import { useMemo, useState } from 'react';

export function useIncidentsTableState() {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [status, setStatus] = useState('all');
  const [sort, setSort] = useState('-detected_at');
  const [cameraId, setCameraId] = useState('');
  const [jobId, setJobId] = useState('');
  const [detectionType, setDetectionType] = useState('');
  const [minConfidence, setMinConfidence] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');

  const query = useMemo(() => ({
    page,
    pageSize,
    status: status === 'all' ? undefined : status,
    sort,
    cameraId: cameraId.trim() || undefined,
    jobId: jobId.trim() || undefined,
    detectionType: detectionType.trim() || undefined,
    minConfidence: minConfidence.trim() ? Number(minConfidence) : undefined,
    startTime: startTime || undefined,
    endTime: endTime || undefined,
  }), [cameraId, detectionType, endTime, jobId, minConfidence, page, pageSize, sort, startTime, status]);

  return {
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
  };
}
