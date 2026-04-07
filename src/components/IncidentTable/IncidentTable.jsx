import { useMemo, useState } from 'react';
import { formatDateTime, formatPercent } from '../../utils/formatters.js';
import StatusBadge from '../StatusBadge/StatusBadge.jsx';
import styles from './IncidentTable.module.css';

const CONFIDENCE_THRESHOLD_HIGH = 0.9;
const CONFIDENCE_THRESHOLD_MED  = 0.75;

function confidenceClass(confidence) {
  if (confidence >= CONFIDENCE_THRESHOLD_HIGH) return styles.confHigh;
  if (confidence >= CONFIDENCE_THRESHOLD_MED)  return styles.confMed;
  return styles.confLow;
}

function confidenceLabel(confidence) {
  if (confidence >= CONFIDENCE_THRESHOLD_HIGH) return 'Critical';
  if (confidence >= CONFIDENCE_THRESHOLD_MED) return 'Warning';
  return 'Low';
}

function getIncidentTimestamp(incident) {
  return incident.timestamp ?? incident.detectedAt ?? null;
}

function getIncidentConfidence(incident) {
  return Number(incident.confidence ?? incident.confidenceScore ?? 0);
}

/**
 * IncidentTable
 * @param {Array}   incidents   — array of incident objects from api.getIncidents()
 * @param {boolean} [compact]   — show fewer columns (for dashboard mini-view)
 */
export default function IncidentTable({
  incidents = [],
  compact = false,
  onRowClick,
  selectedIncidentId = null,
  emptyMessage = 'No incidents recorded.',
}) {
  const [sortKey,  setSortKey]  = useState('timestamp');
  const [sortDir,  setSortDir]  = useState('desc');
  const [hoveredThumb, setHoveredThumb] = useState(null);

  function handleSort(key) {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  }

  const sorted = useMemo(() => {
    return [...incidents].sort((a, b) => {
      let va = a[sortKey];
      let vb = b[sortKey];
      if (sortKey === 'timestamp') {
        va = new Date(getIncidentTimestamp(a));
        vb = new Date(getIncidentTimestamp(b));
      }
      if (sortKey === 'confidence') {
        va = getIncidentConfidence(a);
        vb = getIncidentConfidence(b);
      }
      if (va < vb) return sortDir === 'asc' ? -1 : 1;
      if (va > vb) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
  }, [incidents, sortDir, sortKey]);

  function SortIcon({ col }) {
    if (sortKey !== col) return <span className={styles.sortIcon}>⇅</span>;
    return <span className={styles.sortIcon}>{sortDir === 'asc' ? '↑' : '↓'}</span>;
  }

  if (incidents.length === 0) {
    return (
      <div className={styles.empty}>
        <span>{emptyMessage}</span>
      </div>
    );
  }

  return (
    <div className={styles.wrapper}>
      <table className={styles.table}>
        <thead>
          <tr>
            {!compact && <th className={styles.th}>Thumbnail</th>}
            <th className={[styles.th, styles.sortable].join(' ')} onClick={() => handleSort('timestamp')}>
              Time <SortIcon col="timestamp" />
            </th>
            <th className={styles.th}>Camera</th>
            {!compact && <th className={styles.th}>Incident / Job</th>}
            <th className={[styles.th, styles.sortable].join(' ')} onClick={() => handleSort('type')}>
              Type <SortIcon col="type" />
            </th>
            <th className={[styles.th, styles.sortable].join(' ')} onClick={() => handleSort('confidence')}>
              Confidence <SortIcon col="confidence" />
            </th>
            {!compact && <th className={styles.th}>Raw Score</th>}
            <th className={styles.th}>Status</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map(incident => (
            <tr
              key={incident.id}
              className={styles.row}
              data-selected={selectedIncidentId === incident.id ? 'true' : 'false'}
              data-active={incident.resolved ? 'false' : 'true'}
              onClick={() => onRowClick?.(incident)}
            >
              {!compact && (
                <td className={styles.td}>
                  <div
                    className={styles.thumbWrapper}
                    onMouseEnter={() => setHoveredThumb(incident.id)}
                    onMouseLeave={() => setHoveredThumb(null)}
                  >
                    <img
                      src={incident.thumbnailUrl}
                      alt={`Thumbnail for ${incident.id}`}
                      className={styles.thumb}
                    />
                    {hoveredThumb === incident.id && (
                      <img
                        src={incident.thumbnailUrl}
                        alt={`Preview for ${incident.id}`}
                        className={styles.thumbPreview}
                      />
                    )}
                  </div>
                </td>
              )}
              <td className={[styles.td, styles.mono].join(' ')}>
                {formatDateTime(getIncidentTimestamp(incident))}
              </td>
              <td className={styles.td}>
                <span className={styles.cameraId}>{incident.cameraId}</span>
                {!compact && (
                  <span className={styles.cameraName}>{incident.cameraName}</span>
                )}
              </td>
              {!compact && (
                <td className={[styles.td, styles.mono].join(' ')}>
                  <span>{incident.id}</span>
                  <span className={styles.cameraName}>{incident.jobId ?? '—'}</span>
                </td>
              )}
              <td className={styles.td}>{incident.type}</td>
              <td className={styles.td}>
                <div className={styles.confWrap}>
                  <span className={[styles.confidence, confidenceClass(getIncidentConfidence(incident))].join(' ')}>
                    {formatPercent(getIncidentConfidence(incident), 1)}
                  </span>
                  <StatusBadge
                    status={getIncidentConfidence(incident) >= CONFIDENCE_THRESHOLD_MED ? 'warning' : 'resolved'}
                    label={confidenceLabel(getIncidentConfidence(incident))}
                  />
                </div>
              </td>
              {!compact && (
                <td className={styles.td}>
                  {formatPercent(incident.rawScore, 1)}
                </td>
              )}
              <td className={styles.td}>
                <StatusBadge
                  status={incident.resolved ? 'resolved' : 'critical'}
                  label={incident.resolved ? 'Resolved' : 'Active'}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
