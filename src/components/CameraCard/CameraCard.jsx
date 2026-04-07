import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import CameraPlayer from '../CameraPlayer/CameraPlayer.jsx';
import StatusBadge from '../StatusBadge/StatusBadge.jsx';
import { formatDateTime } from '../../utils/formatters.js';
import styles from './CameraCard.module.css';

/**
 * CameraCard — displays a camera preview that lazy-loads when needed.
 * @param {{ id: string, status: string, streamUrl?: string, stream_url?: string, lastSeenAt?: string, last_seen_at?: string, name?: string, fps?: number }} camera
 */
export default function CameraCard({ camera }) {
  const navigate = useNavigate();
  const cardRef = useRef(null);
  const [isHovered, setIsHovered] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const [playerLoading, setPlayerLoading] = useState(false);
  const [playerError, setPlayerError] = useState(null);

  useEffect(() => {
    const node = cardRef.current;
    if (!node || camera.status === 'offline') return undefined;

    const observer = new IntersectionObserver(
      ([entry]) => setIsVisible(entry.isIntersecting),
      { root: null, threshold: 0.2, rootMargin: '40px' },
    );
    observer.observe(node);

    return () => observer.disconnect();
  }, [camera.status]);

  const streamHref = camera.streamUrl ?? camera.stream_url ?? null;
  const lastSeen = camera.lastSeenAt ?? camera.last_seen_at ?? null;
  const isOffline = camera.status === 'offline';
  const shouldLoadVideo = !isOffline && Boolean(streamHref) && (isVisible || isHovered);

  useEffect(() => {
    if (shouldLoadVideo) {
      setPlayerError(null);
    } else {
      setPlayerLoading(false);
    }
  }, [shouldLoadVideo, streamHref]);

  const openCameraView = () => {
    navigate(`/camera/${encodeURIComponent(camera.id)}`, {
      state: {
        id: camera.id,
        name: camera.name,
        streamUrl: streamHref,
        status: camera.status,
        fps: camera.fps,
        lastSeenAt: lastSeen,
      },
    });
  };

  return (
    <article
      ref={cardRef}
      className={styles.card}
      role="button"
      tabIndex={0}
      aria-label={`View ${camera.name ?? camera.id} live stream`}
      onClick={openCameraView}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onFocus={() => setIsHovered(true)}
      onBlur={() => setIsHovered(false)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openCameraView();
        }
      }}
    >
      <div className={styles.imageWrapper}>
        {isOffline && (
          <div className={styles.placeholder}>
            <span className={styles.errorText}>Camera Offline</span>
            {lastSeen && <span className={styles.loadingText}>Last seen: {formatDateTime(lastSeen)}</span>}
          </div>
        )}
        {!isOffline && shouldLoadVideo && (
          <CameraPlayer
            src={streamHref}
            active={shouldLoadVideo}
            muted
            preview
            onLoadingChange={setPlayerLoading}
            onFatalError={setPlayerError}
            videoClassName={styles.frame}
          />
        )}
        {!isOffline && playerLoading && (
          <div className={styles.placeholder}>
            <span className={styles.loadingText}>Loading live preview...</span>
          </div>
        )}
        {!isOffline && !shouldLoadVideo && (
          <div className={styles.placeholder}>
            <span className={styles.loadingText}>Preview paused</span>
          </div>
        )}
        {!isOffline && playerError && !playerLoading && (
          <div className={styles.placeholder}>
            <span className={styles.errorText}>Feed unavailable</span>
          </div>
        )}
        <div className={styles.hoverOverlay}>
          <span className={styles.cta}>View Live</span>
        </div>
      </div>

      <div className={styles.footer}>
        <div className={styles.info}>
          <span className={styles.cameraId}>{camera.id}</span>
          {camera.name && <span className={styles.cameraName}>{camera.name}</span>}
          {lastSeen && <span className={styles.cameraName}>Last seen: {formatDateTime(lastSeen)}</span>}
        </div>
        <div className={styles.meta}>
          <StatusBadge status={camera.status} />
          {camera.status !== 'offline' && camera.fps != null && (
            <span className={styles.fps}>{camera.fps} fps</span>
          )}
        </div>
      </div>
    </article>
  );
}
