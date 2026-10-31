import { useEffect, useRef, useState } from 'react';
import { fetchArtifactBlob } from '../../services/api.js';

export default function AuthenticatedImage({ src, alt, openLink = false, loading, ...props }) {
  const [state, setState] = useState({ src: null, url: null, error: null });
  const [visible, setVisible] = useState(loading !== 'lazy' || typeof IntersectionObserver === 'undefined');
  const containerRef = useRef(null);
  const current = state.src === src ? state : { url: null, error: null };

  useEffect(() => {
    if (visible || loading !== 'lazy' || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: '100px' });
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [visible, loading]);

  useEffect(() => {
    if (!src || !visible) return undefined;
    const controller = new AbortController();
    let active = true;
    let objectUrl;
    setState({ src, url: null, error: null });
    fetchArtifactBlob(src, { signal: controller.signal })
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ src, url: objectUrl, error: null });
      })
      .catch((error) => {
        if (active && error.name !== 'AbortError') setState({ src, url: null, error: error.message });
      });
    return () => {
      active = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src, visible]);

  if (!src) return <span ref={containerRef}>No image available</span>;
  if (current.error) return <span ref={containerRef} role="alert">Image unavailable: {current.error}</span>;
  if (!current.url) return <span ref={containerRef} role="status" style={{ display: 'inline-block', minHeight: '100px' }}>Loading image...</span>;
  const image = (
    <img
      {...props}
      src={current.url}
      alt={alt}
      loading={loading}
      onError={() => setState({ src, url: null, error: 'Unable to decode image.' })}
    />
  );
  return openLink
    ? <a href={current.url} target="_blank" rel="noreferrer">{image}</a>
    : image;
}
