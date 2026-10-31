import { useEffect, useState } from 'react';
import { fetchArtifactBlob } from '../../services/api.js';

export default function AuthenticatedImage({ src, alt, openLink = false, ...props }) {
  const [state, setState] = useState({ src: null, url: null, error: null });
  const current = state.src === src ? state : { url: null, error: null };

  useEffect(() => {
    if (!src) return undefined;
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
  }, [src]);

  if (!src) return <span>No image available</span>;
  if (current.error) return <span role="alert">Image unavailable: {current.error}</span>;
  if (!current.url) return <span role="status">Loading image...</span>;
  const image = (
    <img
      {...props}
      src={current.url}
      alt={alt}
      onError={() => setState({ src, url: null, error: 'Unable to decode image.' })}
    />
  );
  return openLink
    ? <a href={current.url} target="_blank" rel="noreferrer">{image}</a>
    : image;
}
