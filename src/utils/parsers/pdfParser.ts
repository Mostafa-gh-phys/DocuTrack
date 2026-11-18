import * as pdfjsLib from 'pdfjs-dist';

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

export async function extractPdfMetadataAndText(buffer: ArrayBuffer): Promise<ParsedPdfInfo> {
  const doc = await loadPdfDocument(buffer);
  const pageTexts: {page: number; text: string}[] = [];

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    pageTexts.push({page: i, text});
  }

  let title: string | undefined;
  let author: string | undefined;
  try {
    const meta = await doc.getMetadata();
    const info = meta.info as Record<string, unknown> | undefined;
    if (info && typeof info.Title === 'string' && info.Title.trim()) title = info.Title.trim();
    if (info && typeof info.Author === 'string' && info.Author.trim()) author = info.Author.trim();
  } catch {
    // Metadata optional
  }

  const outline: {title: string; page: number}[] = [];
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

  if (outline.length === 0) {
    for (let i = 1; i <= doc.numPages; i++) {
      outline.push({title: `Page ${i}`, page: i});
    }
  }

  return {
    pageCount: doc.numPages,
    title,
    author,
    outline,
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
