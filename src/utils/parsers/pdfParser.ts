import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/workers/pdf.worker.min.mjs';

export interface ParsedPdfInfo {
  pageCount: number;
  title?: string;
  author?: string;
  outline: {title: string; page: number}[];
  pageTexts: {page: number; text: string}[];
}

export async function loadPdfDocument(buffer: ArrayBuffer): Promise<pdfjsLib.PDFDocumentProxy> {
  const copy = new Uint8Array(buffer.slice(0));
  const loadingTask = pdfjsLib.getDocument({data: copy});
  return await loadingTask.promise;
}

export async function extractPdfOutlineAndMeta(doc: pdfjsLib.PDFDocumentProxy): Promise<{
  title?: string;
  author?: string;
  outline: {title: string; page: number}[];
}> {
  let title: string | undefined;
  let author: string | undefined;
  const outline: {title: string; page: number}[] = [];

  await Promise.all([
    (async () => {
      try {
        const meta = await doc.getMetadata();
        const info = meta.info as Record<string, unknown> | undefined;
        if (info && typeof info.Title === 'string' && info.Title.trim()) title = info.Title.trim();
        if (info && typeof info.Author === 'string' && info.Author.trim()) author = info.Author.trim();
      } catch {
        // Metadata optional
      }
    })(),
    (async () => {
      try {
        const rawOutline = await doc.getOutline();
        if (rawOutline) {
          for (const item of rawOutline.slice(0, 30)) {
            let pageNum = 1;
            if (Array.isArray(item.dest) && item.dest[0]) {
              try {
                const idx = await doc.getPageIndex(item.dest[0]);
                pageNum = idx + 1;
              } catch {
                pageNum = 1;
              }
            }
            outline.push({title: item.title, page: pageNum});
          }
        }
      } catch {
        // Outline optional
      }
    })(),
  ]);

  if (outline.length === 0) {
    const cap = Math.min(doc.numPages, 200);
    for (let i = 1; i <= cap; i++) {
      outline.push({title: `Page ${i}`, page: i});
    }
  }

  return {title, author, outline};
}

export async function extractPdfPageTextRange(
  doc: pdfjsLib.PDFDocumentProxy,
  startPage: number,
  endPage: number,
): Promise<{page: number; text: string}[]> {
  const start = Math.max(1, startPage);
  const end = Math.min(doc.numPages, endPage);
  if (end < start) return [];

  const pageNumbers = Array.from({length: end - start + 1}, (_, i) => start + i);
  return await Promise.all(
    pageNumbers.map(async (pageNum) => {
      const page = await doc.getPage(pageNum);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      return {page: pageNum, text};
    }),
  );
}

export async function extractPdfMetadataAndText(
  buffer: ArrayBuffer,
  maxPagesToIndex = 10,
): Promise<ParsedPdfInfo> {
  const doc = await loadPdfDocument(buffer);
  const sampleLimit = maxPagesToIndex > 0 ? Math.min(doc.numPages, maxPagesToIndex) : doc.numPages;

  const [metaAndOutline, pageTexts] = await Promise.all([
    extractPdfOutlineAndMeta(doc),
    extractPdfPageTextRange(doc, 1, sampleLimit),
  ]);

  return {
    pageCount: doc.numPages,
    title: metaAndOutline.title,
    author: metaAndOutline.author,
    outline: metaAndOutline.outline,
    pageTexts,
  };
}

export async function renderPdfPageToCanvas(
  doc: pdfjsLib.PDFDocumentProxy,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  scale = 1.45,
): Promise<{width: number; height: number; textItems: {str: string; x: number; y: number; fontSize: number}[]}> {
  const page = await doc.getPage(pageNumber);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const viewport = page.getViewport({scale});

  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  await page.render({
    canvasContext: ctx,
    viewport,
    canvas,
  }).promise;

  const textContent = await page.getTextContent();
  const textItems: {str: string; x: number; y: number; fontSize: number}[] = [];
  for (const item of textContent.items) {
    if ('str' in item && item.str.trim()) {
      const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
      const fontSize = Math.hypot(tx[2], tx[3]) || 12;
      textItems.push({
        str: item.str,
        x: tx[4],
        y: tx[5] - fontSize,
        fontSize,
      });
    }
  }

  return {
    width: Math.floor(viewport.width),
    height: Math.floor(viewport.height),
    textItems,
  };
}

export async function extractPdfCoverThumbnail(doc: pdfjsLib.PDFDocumentProxy): Promise<string | undefined> {
  if (typeof document === 'undefined' || doc.numPages < 1) return undefined;
  try {
    const page = await doc.getPage(1);
    const unscaled = page.getViewport({scale: 1});
    const targetWidth = 260;
    const scale = Math.max(0.2, Math.min(1.5, targetWidth / Math.max(1, unscaled.width)));
    const viewport = page.getViewport({scale});

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({
      canvasContext: ctx,
      viewport,
      canvas,
    }).promise;

    return canvas.toDataURL('image/jpeg', 0.82);
  } catch {
    return undefined;
  }
}

