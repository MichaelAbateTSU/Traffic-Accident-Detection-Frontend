import { useCallback, useEffect, useState } from 'react';
import { getDashboard, getHealth, getJobs, getStats } from '../services/api.js';

export function useDashboardData({ incidentsPageSize = 5, incidentsStatus = 'active', historyDays = 30 } = {}) {
  const [stats, setStats] = useState(null);
  const [overviewMeta, setOverviewMeta] = useState(null);
  const [incidents, setIncidents] = useState([]);
  const [incidentsMeta, setIncidentsMeta] = useState(null);
  const [cameras, setCameras] = useState([]);
  const [health, setHealth] = useState(null);
  const [healthMeta, setHealthMeta] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [jobsMeta, setJobsMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const reload = useCallback(() => setRefreshKey((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    let mounted = true;

    async function load() {
      setLoading(true);
      try {
        // Use /dashboard as bootstrap aggregator to minimize initial round trips.
        const [dashboard, statsResp, healthResp, jobsResp] = await Promise.all([
          getDashboard({ incidentsPageSize, incidentsStatus, historyDays }, { signal: controller.signal }),
          getStats({ historyDays }, { signal: controller.signal }),
          getHealth({ signal: controller.signal }),
          getJobs({ page: 1, pageSize: 8, sort: '-created_at' }, { signal: controller.signal }),
        ]);
        if (!mounted) return;

        setStats(dashboard.stats);
        setIncidents(dashboard.incidents.items);
        setIncidentsMeta(dashboard.incidents.meta);
        setCameras(dashboard.cameras);
        setOverviewMeta(statsResp.meta);
        setHealth(healthResp.item);
        setHealthMeta(healthResp.meta);
        setJobs(jobsResp.items);
        setJobsMeta(jobsResp.meta);
        setError(null);
      } catch (err) {
        if (err.name === 'AbortError') return;
        if (mounted) setError(err.message);
      } finally {
        if (mounted) setLoading(false);
      }
    }

    load();
    return () => {
      mounted = false;
      controller.abort();
    };
  }, [historyDays, incidentsPageSize, incidentsStatus, refreshKey]);

  return {
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
  };
}
