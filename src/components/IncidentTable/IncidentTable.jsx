import { useState } from 'react';
import styles from './IncidentTable.module.css';

const CONFIDENCE_THRESHOLD_HIGH = 0.9;
const CONFIDENCE_THRESHOLD_MED  = 0.75;

function confidenceClass(confidence) {
  if (confidence >= CONFIDENCE_THRESHOLD_HIGH) return styles.confHigh;
  if (confidence >= CONFIDENCE_THRESHOLD_MED)  return styles.confMed;
  return styles.confLow;
}

function getIncidentTimestamp(incident) {
  return incident.timestamp ?? incident.detectedAt ?? null;
}

function getIncidentConfidence(incident) {
  return Number(incident.confidence ?? incident.confidenceScore ?? 0);
}

function formatTimestamp(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
}

/**
 * IncidentTable
 * @param {Array}   incidents   — array of incident objects from api.getIncidents()
 * @param {boolean} [compact]   — show fewer columns (for dashboard mini-view)
 */
export default function IncidentTable({ incidents = [], compact = false }) {
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

  const sorted = [...incidents].sort((a, b) => {
    let va = a[sortKey];
    let vb = b[sortKey];
    if (sortKey === 'timestamp') { va = new Date(getIncidentTimestamp(a)); vb = new Date(getIncidentTimestamp(b)); }
    if (sortKey === 'confidence') { va = getIncidentConfidence(a); vb = getIncidentConfidence(b); }
    if (va < vb) return sortDir === 'asc' ? -1 :  1;
    if (va > vb) return sortDir === 'asc' ?  1 : -1;
    return 0;
  });

  function SortIcon({ col }) {
    if (sortKey !== col) return <span className={styles.sortIcon}>⇅</span>;
    return <span className={styles.sortIcon}>{sortDir === 'asc' ? '↑' : '↓'}</span>;
  }

  if (incidents.length === 0) {
    return (
      <div className={styles.empty}>
        <span>No incidents recorded.</span>
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
            <th className={[styles.th, styles.sortable].join(' ')} onClick={() => handleSort('type')}>
              Type <SortIcon col="type" />
            </th>
            <th className={[styles.th, styles.sortable].join(' ')} onClick={() => handleSort('confidence')}>
              Confidence <SortIcon col="confidence" />
            </th>
            <th className={styles.th}>Status</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map(incident => (
            <tr key={incident.id} className={styles.row}>
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
                {formatTimestamp(getIncidentTimestamp(incident))}
              </td>
              <td className={styles.td}>
                <span className={styles.cameraId}>{incident.cameraId}</span>
                {!compact && (
                  <span className={styles.cameraName}>{incident.cameraName}</span>
                )}
              </td>
              <td className={styles.td}>{incident.type}</td>
              <td className={styles.td}>
                <span className={[styles.confidence, confidenceClass(getIncidentConfidence(incident))].join(' ')}>
                  {(getIncidentConfidence(incident) * 100).toFixed(0)}%
                </span>
              </td>
              <td className={styles.td}>
                <span className={incident.resolved ? styles.resolved : styles.active}>
                  {incident.resolved ? 'Resolved' : 'Active'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
