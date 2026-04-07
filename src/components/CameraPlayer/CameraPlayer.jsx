import { useEffect, useRef } from 'react';
import Hls from 'hls.js';
import styles from './CameraPlayer.module.css';

/**
 * CameraPlayer
 * Reusable HLS video player with native Safari fallback.
 */
export default function CameraPlayer({
  src,
  active = true,
  muted = true,
  autoPlay = true,
  playsInline = true,
  preview = false,
  className = '',
  videoClassName = '',
  onLoadingChange,
  onFatalError,
}) {
  const videoRef = useRef(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;

    let hls;
    let cancelled = false;

    const setLoading = (value) => {
      if (!cancelled) onLoadingChange?.(value);
    };

    const cleanup = () => {
      if (hls) {
        hls.destroy();
        hls = null;
      }
      video.pause();
      video.removeAttribute('src');
      video.load();
      setLoading(false);
    };

    if (!src || !active) {
      cleanup();
      return undefined;
    }

    setLoading(true);
    video.muted = muted;
    video.autoplay = autoPlay;
    video.playsInline = playsInline;

    // Safari can play HLS natively, so no hls.js attachment is needed.
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      const handleReady = () => setLoading(false);
      const handleError = () => {
        setLoading(false);
        onFatalError?.('Failed to load camera stream.');
      };

      video.addEventListener('loadeddata', handleReady);
      video.addEventListener('error', handleError);
      video.src = src;
      video.play().catch(() => {});

      return () => {
        cancelled = true;
        video.removeEventListener('loadeddata', handleReady);
        video.removeEventListener('error', handleError);
        cleanup();
      };
    }

    if (!Hls.isSupported()) {
      setLoading(false);
      onFatalError?.('HLS is not supported in this browser.');
      return undefined;
    }

    // Preview mode biases to smaller renditions for lighter grid playback.
    hls = new Hls({
      enableWorker: true,
      lowLatencyMode: true,
      backBufferLength: 30,
      capLevelToPlayerSize: preview,
    });

    hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
      if (preview && data.levels?.length) {
        hls.startLevel = 0;
      }
      video.play().catch(() => {});
    });

    hls.on(Hls.Events.LEVEL_LOADED, () => {
      setLoading(false);
    });

    hls.on(Hls.Events.ERROR, (_, data) => {
      if (data?.fatal) {
        setLoading(false);
        onFatalError?.(data.details || 'Unable to play camera stream.');
      }
    });

    hls.loadSource(src);
    hls.attachMedia(video);

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [active, autoPlay, muted, onFatalError, onLoadingChange, playsInline, preview, src]);

  return (
    <div className={[styles.player, className].join(' ').trim()}>
      <video ref={videoRef} className={[styles.video, videoClassName].join(' ').trim()} />
    </div>
  );
}
