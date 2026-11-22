import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import {RESOURCE_LIMITS, releaseCanvasMemory, yieldToMain} from '../batchYield';

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

export async function closePdfDocument(doc: pdfjsLib.PDFDocumentProxy | null | undefined): Promise<void> {
  if (!doc) return;
  try {
    await doc.cleanup?.();
  } catch {
    // Ignore cleanup errors on already-closed workers
  }
  try {
    await (doc as unknown as {destroy?: () => Promise<void>}).destroy?.();
  } catch {
    // Ignore destroy errors if already destroyed
  }
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
          for (const item of rawOutline.slice(0, 40)) {
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

  const results: {page: number; text: string}[] = [];
  const batchSize = 4;

  for (let batchStart = start; batchStart <= end; batchStart += batchSize) {
    const batchEnd = Math.min(end, batchStart + batchSize - 1);
    const nums = Array.from({length: batchEnd - batchStart + 1}, (_, i) => batchStart + i);
    const batch = await Promise.all(
      nums.map(async (pageNum) => {
        const page = await doc.getPage(pageNum);
        try {
          const content = await page.getTextContent();
          const text = content.items
            .map((item) => ('str' in item ? item.str : ''))
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
          return {page: pageNum, text};
        } finally {
          page.cleanup?.();
        }
      }),
    );
    results.push(...batch);
    if (batchEnd < end) {
      await yieldToMain(4);
    }
  }

  return results;
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

export interface PdfRenderTextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
  scaleX: number;
  fontFamily: string;
}

let measureCtx: CanvasRenderingContext2D | null = null;
function getMeasureCtx(): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null;
  if (!measureCtx) {
    const c = document.createElement('canvas');
    measureCtx = c.getContext('2d');
  }
  return measureCtx;
}

const activeCanvasRenderTasks = new WeakMap<HTMLCanvasElement, pdfjsLib.RenderTask>();
const canvasRenderSeq = new WeakMap<HTMLCanvasElement, number>();

export async function renderPdfPageToCanvas(
  doc: pdfjsLib.PDFDocumentProxy,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  scale = 1.45,
): Promise<{width: number; height: number; textItems: PdfRenderTextItem[]}> {
  const seq = (canvasRenderSeq.get(canvas) || 0) + 1;
  canvasRenderSeq.set(canvas, seq);

  const prevTask = activeCanvasRenderTasks.get(canvas);
  if (prevTask) {
    try {
      prevTask.cancel();
    } catch {
      // Ignore already settled task
    }
    try {
      await prevTask.promise;
    } catch {
      // Expected RenderingCancelledException
    }
  }

  const page = await doc.getPage(pageNumber);
  if (canvasRenderSeq.get(canvas) !== seq) {
    const cancelledErr = new Error('Rendering cancelled');
    cancelledErr.name = 'RenderingCancelledException';
    throw cancelledErr;
  }

  const rawDpr = Math.min(window.devicePixelRatio || 1, RESOURCE_LIMITS.maxRenderDpr);
  const viewport = page.getViewport({scale});
  const maxDprForWidth = Math.max(
    0.75,
    RESOURCE_LIMITS.maxSheetPixelWidth / Math.max(1, viewport.width),
  );
  const dpr = Math.min(rawDpr, maxDprForWidth);

  const targetPixelW = Math.max(1, Math.floor(viewport.width * dpr));
  const targetPixelH = Math.max(1, Math.floor(viewport.height * dpr));

  // Render onto an offscreen swap canvas so the visible sheet never flashes white during zoom/scroll re-renders
  const swapCanvas = document.createElement('canvas');
  swapCanvas.width = targetPixelW;
  swapCanvas.height = targetPixelH;
  const swapCtx = swapCanvas.getContext('2d');
  if (!swapCtx) {
    releaseCanvasMemory(swapCanvas);
    throw new Error('Canvas 2D context unavailable');
  }
  swapCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const renderTask = page.render({
    canvasContext: swapCtx,
    viewport,
    canvas: swapCanvas,
  });
  activeCanvasRenderTasks.set(canvas, renderTask);

  try {
    await renderTask.promise;
    if (canvasRenderSeq.get(canvas) !== seq) {
      const cancelledErr = new Error('Rendering cancelled');
      cancelledErr.name = 'RenderingCancelledException';
      throw cancelledErr;
    }

    canvas.width = targetPixelW;
    canvas.height = targetPixelH;
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    const visibleCtx = canvas.getContext('2d');
    if (visibleCtx) {
      visibleCtx.setTransform(1, 0, 0, 1, 0, 0);
      visibleCtx.drawImage(swapCanvas, 0, 0);
    }
  } finally {
    releaseCanvasMemory(swapCanvas);
    if (activeCanvasRenderTasks.get(canvas) === renderTask) {
      activeCanvasRenderTasks.delete(canvas);
    }
  }

  const textContent = await page.getTextContent();
  const styles = (textContent.styles || {}) as Record<string, {fontFamily?: string}>;
  const mCtx = getMeasureCtx();
  const textItems: PdfRenderTextItem[] = [];

  for (const item of textContent.items) {
    if ('str' in item && item.str.trim()) {
      const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
      const fontSize = Math.hypot(tx[2], tx[3]) || 12;
      const styleDef = item.fontName ? styles[item.fontName] : undefined;
      const rawFamily = (styleDef?.fontFamily || '').toLowerCase();
      const fontFamily = rawFamily.includes('mono') || rawFamily.includes('courier')
        ? 'ui-monospace, monospace'
        : rawFamily.includes('serif') || rawFamily.includes('times')
          ? 'Georgia, "Times New Roman", serif'
          : 'system-ui, -apple-system, sans-serif';

      const targetWidth = Math.max(1, Math.abs((item.width || 0) * scale));
      let scaleX = 1;
      if (mCtx && targetWidth > 2) {
        mCtx.font = `${fontSize}px ${fontFamily}`;
        const measured = mCtx.measureText(item.str).width;
        if (measured > 1) {
          scaleX = Math.max(0.45, Math.min(2.2, Number((targetWidth / measured).toFixed(4))));
        }
      }

      textItems.push({
        str: item.str,
        x: tx[4],
        y: tx[5] - fontSize * 0.88,
        width: targetWidth,
        fontSize,
        scaleX,
        fontFamily,
      });
    }
  }

  page.cleanup?.();

  return {
    width: Math.floor(viewport.width),
    height: Math.floor(viewport.height),
    textItems,
  };
}

export async function extractPdfCoverThumbnail(doc: pdfjsLib.PDFDocumentProxy): Promise<string | undefined> {
  if (typeof document === 'undefined' || doc.numPages < 1) return undefined;
  const canvas = document.createElement('canvas');
  try {
    const page = await doc.getPage(1);
    try {
      const unscaled = page.getViewport({scale: 1});
      const targetWidth = 220;
      const scale = Math.max(0.2, Math.min(1.4, targetWidth / Math.max(1, unscaled.width)));
      const viewport = page.getViewport({scale});

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

      return canvas.toDataURL('image/jpeg', 0.76);
    } finally {
      page.cleanup?.();
    }
  } catch {
    return undefined;
  } finally {
    releaseCanvasMemory(canvas);
  }
}

