import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';

/** Canvas-only PDF output works without a browser PDF plug-in. No links, forms or scripts. */
export function PresentationPdf({ src }: { src: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false, loading: PDFDocumentLoadingTask | undefined;
    setDocument(null); setPage(1); setError('');
    void (async () => {
      try {
        if (!src.startsWith('blob:')) throw new Error('Only the captured presentation PDF may be rendered.');
        const pdf = await import('pdfjs-dist/legacy/build/pdf.mjs');
        if (disposed) return;
        pdf.GlobalWorkerOptions.workerSrc = '/presentation/pdf.worker.js';
        loading = pdf.getDocument({ url: src, enableXfa: false,
          cMapUrl: '/presentation/', cMapPacked: true, standardFontDataUrl: '/presentation/', wasmUrl: '/presentation/' });
        const loaded = await loading.promise;
        if (!disposed) setDocument(loaded);
      } catch { if (!disposed) setError('This PDF could not be rendered on this display. Its selected revision has not changed.'); }
    })();
    return () => { disposed = true; void loading?.destroy(); };
  }, [src]);

  useEffect(() => {
    if (!document || !canvas.current) return;
    let disposed = false, rendering: RenderTask | undefined;
    const surface = canvas.current;
    void (async () => {
      try {
        const selected = await document.getPage(page);
        if (disposed) return;
        const natural = selected.getViewport({ scale: 1 });
        const viewport = selected.getViewport({ scale: Math.min(2, 1600 / natural.width, 2200 / natural.height) });
        surface.width = Math.ceil(viewport.width); surface.height = Math.ceil(viewport.height);
        rendering = selected.render({ canvas: surface, viewport });
        await rendering.promise;
      } catch { if (!disposed) setError('This PDF page could not be rendered. Try another page on the controller.'); }
    })();
    return () => { disposed = true; rendering?.cancel(); surface.width = 0; surface.height = 0; };
  }, [document, page]);

  return <section data-pdf-viewer="primary" aria-label="PDF presentation">
    <div className="flex items-center gap-3 py-3">
      <button type="button" disabled={!document || page <= 1} onClick={() => { setError(''); setPage(value => value - 1); }}>Previous page</button>
      <span>Page {page}{document ? ` of ${document.numPages}` : ''}</span>
      <button type="button" disabled={!document || page >= document.numPages} onClick={() => { setError(''); setPage(value => value + 1); }}>Next page</button>
    </div>
    {error ? <p role="alert">{error}</p> : !document && <p role="status">Loading the selected PDF…</p>}
    <canvas ref={canvas} role="img" aria-label={`PDF page ${page}`} style={{ maxWidth: '100%', height: 'auto', display: error ? 'none' : 'block', background: 'white' }} />
  </section>;
}
