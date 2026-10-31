import { useState } from 'react';
import AuthenticatedImage from '../AuthenticatedImage/AuthenticatedImage.jsx';
import styles from './FrameGallery.module.css';

const PAGE_SIZE = 3;

export default function FrameGallery({ frames = [], jobId }) {
  const [selection, setSelection] = useState({ jobId, page: 0 });
  const pages = Math.max(1, Math.ceil(frames.length / PAGE_SIZE));
  const page = selection.jobId === jobId ? Math.min(selection.page, pages - 1) : 0;
  const visible = frames.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const goToPage = (value) => setSelection({ jobId, page: value });
  return (
    <section className={styles.gallery} aria-label={`Saved frames for job ${jobId}`}>
      <div role="group" aria-label={`Frame pagination for job ${jobId}`}>
        <button type="button" disabled={page === 0} onClick={() => goToPage(page - 1)}>Previous frames</button>
        <span role="status">Page {page + 1} of {pages}; {frames.length} saved frames</span>
        <button type="button" disabled={page === pages - 1} onClick={() => goToPage(page + 1)}>Next frames</button>
        <label>
          Frame page
          <select aria-label={`Frame page for job ${jobId}`} value={page} onChange={(event) => goToPage(Number(event.target.value))}>
            {Array.from({ length: pages }, (_, index) => (
              <option key={index} value={index}>{index + 1}</option>
            ))}
          </select>
        </label>
      </div>
      {visible.map((frame) => (
        <article key={frame.frameIndex}>
          <h4>Frame {frame.frameIndex}</h4>
          {[
            ['Original', frame.capture],
            ['Annotated', frame.captureAnnotated],
            ['Pipeline output', frame.pipelineOutput],
          ].map(([label, src]) => (
            <figure key={label}>
              <figcaption>{label}</figcaption>
              <AuthenticatedImage src={src} alt={`Frame ${frame.frameIndex} ${label.toLowerCase()}`} loading="lazy" openLink />
            </figure>
          ))}
        </article>
      ))}
    </section>
  );
}
