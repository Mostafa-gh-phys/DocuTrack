import initDjvu, {WasmDocument, wasmSimd128Supported} from 'djvu-rs';
import type DjVuJsDocumentType from 'djvujs-dist/library/src/DjVuDocument.js';
import type {DjVuJsBookmark} from 'djvujs-dist/library/src/DjVuDocument.js';
import {releaseCanvasMemory, yieldToMain} from '../batchYield';

let djvuJsClassPromise: Promise<typeof DjVuJsDocumentType> | null = null;
async function loadDjVuJsDocumentClass(): Promise<typeof DjVuJsDocumentType> {
  if (!djvuJsClassPromise) {
    djvuJsClassPromise = import('djvujs-dist/library/src/DjVuDocument.js').then((mod) => mod.default);
  }
  return await djvuJsClassPromise;
}

let djvuInitPromise: Promise<boolean> | null = null;
let djvuWasmAvailable = false;

export async function ensureDjvuInit(): Promise<boolean> {
  if (djvuWasmAvailable) return true;
  if (!djvuInitPromise) {
    djvuInitPromise = (async () => {
      try {
        const variant = wasmSimd128Supported() ? 'simd128' : 'scalar';
        await initDjvu(`/workers/djvu/${variant}/djvu_rs_bg.wasm`);
        djvuWasmAvailable = true;
        return true;
      } catch (err) {
        console.warn('djvu-rs WASM init unavailable, using pure-JS DjVu.js engine:', err);
        djvuInitPromise = null;
        return false;
      }
    })();
  }
  return await djvuInitPromise;
}

export interface DjvuOutlineItem {
  title: string;
  page: number;
  depth: number;
}

export interface ParsedDjvuInfo {
  pageCount: number;
  outline: DjvuOutlineItem[];
  pageTexts: {page: number; text: string}[];
}

export interface DjvuPageDimensions {
  width: number;
  height: number;
  dpi: number;
}

/**
 * Unified DjVu document adapter combining djvu-rs WASM speed with pure-JS
 * DjVu.js (djvujs-dist, engine of DjVu.js Reader) automatic per-page fallback.
 */
export interface UnifiedDjvuDocument {
  engine: 'wasm+js' | 'djvujs';
  pageCount: number;
  page_count(): number;
  getPageNativeSize(pageNumber: number): Promise<DjvuPageDimensions>;
  getOutline(): Promise<DjvuOutlineItem[]>;
  getPageText(pageNumber: number): Promise<string>;
  renderPageToCanvas(
    pageNumber: number,
    canvas: HTMLCanvasElement,
    targetDpi?: number,
  ): Promise<{width: number; height: number; text: string; isBlankBitmap: boolean; nativeWidth: number; nativeHeight: number; nativeDpi: number}>;
  free(): void;
}

function flattenDjvuJsBookmarks(
  doc: DjVuJsDocumentType,
  items: DjVuJsBookmark[],
  out: DjvuOutlineItem[],
  depth = 0,
): void {
  for (const item of items) {
    if (out.length >= 250) break;
    const rawTitle = (item.description || '').trim();
    const resolvedPage = item.url ? doc.getPageNumberByUrl(item.url) : null;
    if (rawTitle && resolvedPage && resolvedPage >= 1) {
      out.push({
        title: rawTitle,
        page: resolvedPage,
        depth: Math.min(depth, 5),
      });
    }
    if (Array.isArray(item.children) && item.children.length > 0) {
      flattenDjvuJsBookmarks(doc, item.children, out, depth + 1);
    }
  }
}

function isBitmapBlankWhite(pixels: Uint8Array | Uint8ClampedArray): boolean {
  const len = pixels.length;
  if (len === 0) return true;
  // Sample grid across the entire image so pages with white margins still detect ink
  const stride = Math.max(4, Math.floor(len / 8000) & ~3);
  for (let i = 0; i < len - 3; i += stride) {
    if (pixels[i] < 248 || pixels[i + 1] < 248 || pixels[i + 2] < 248) {
      return false;
    }
  }
  return true;
}

class HybridDjvuDocument implements UnifiedDjvuDocument {
  engine: 'wasm+js' | 'djvujs';
  pageCount: number;
  private buffer: ArrayBuffer | null;
  private wasmDoc: WasmDocument | null;
  private jsDoc: DjVuJsDocumentType | null = null;
  private jsSizes: Array<{width: number; height: number; dpi: number}> | null = null;
  private wasmDisabledPages = new Set<number>();

  constructor(buffer: ArrayBuffer, wasmDoc: WasmDocument | null, jsDoc: DjVuJsDocumentType | null) {
    this.buffer = buffer;
    this.wasmDoc = wasmDoc;
    this.jsDoc = jsDoc;
    this.engine = wasmDoc ? 'wasm+js' : 'djvujs';

    let count = 1;
    if (wasmDoc) {
      try {
        count = Math.max(1, wasmDoc.page_count());
      } catch {
        count = 0;
      }
    }
    if (jsDoc && count <= 0) {
      count = Math.max(1, jsDoc.getPagesQuantity());
    }
    if (!wasmDoc && jsDoc) {
      count = Math.max(1, jsDoc.getPagesQuantity());
    }
    this.pageCount = Math.max(1, count);
  }

  page_count(): number {
    return this.pageCount;
  }

  private async getOrCreateJsDoc(): Promise<DjVuJsDocumentType | null> {
    if (this.jsDoc) return this.jsDoc;
    if (!this.buffer) return null;
    try {
      const DjVuJsDocument = await loadDjVuJsDocumentClass();
      this.jsDoc = new DjVuJsDocument(this.buffer);
      this.pageCount = Math.max(1, this.jsDoc.getPagesQuantity());
      return this.jsDoc;
    } catch {
      return null;
    }
  }

  async getPageNativeSize(pageNumber: number): Promise<DjvuPageDimensions> {
    const clamped = Math.max(1, Math.min(pageNumber, this.pageCount));

    if (this.wasmDoc && !this.wasmDisabledPages.has(clamped)) {
      let wasmPage: ReturnType<WasmDocument['page']> | null = null;
      try {
        wasmPage = this.wasmDoc.page(clamped - 1);
        const dpi = Math.max(72, Math.min(600, wasmPage.dpi() || 150));
        const width = Math.max(120, wasmPage.width_at(dpi));
        const height = Math.max(160, wasmPage.height_at(dpi));
        return {width, height, dpi};
      } catch {
        this.wasmDisabledPages.add(clamped);
      } finally {
        try {
          wasmPage?.free?.();
        } catch {
          // Ignore already freed handle
        }
      }
    }

    const jsDoc = await this.getOrCreateJsDoc();
    if (jsDoc) {
      try {
        if (!this.jsSizes) {
          this.jsSizes = jsDoc.getPagesSizes();
        }
        const entry = this.jsSizes[clamped - 1];
        if (entry && entry.width > 0 && entry.height > 0) {
          return {
            width: entry.width,
            height: entry.height,
            dpi: Math.max(72, Math.min(600, entry.dpi || 150)),
          };
        }
      } catch {
        // Ignore fallback error
      }
    }

    return {width: 680, height: 920, dpi: 150};
  }

  async getOutline(): Promise<DjvuOutlineItem[]> {
    const jsDoc = await this.getOrCreateJsDoc();
    if (!jsDoc) return [];
    try {
      const contents = jsDoc.getContents();
      if (!Array.isArray(contents) || contents.length === 0) return [];
      const out: DjvuOutlineItem[] = [];
      flattenDjvuJsBookmarks(jsDoc, contents, out);
      return out;
    } catch {
      return [];
    }
  }

  async getPageText(pageNumber: number): Promise<string> {
    const clamped = Math.max(1, Math.min(pageNumber, this.pageCount));

    if (this.wasmDoc && !this.wasmDisabledPages.has(clamped)) {
      let wasmPage: ReturnType<WasmDocument['page']> | null = null;
      try {
        wasmPage = this.wasmDoc.page(clamped - 1);
        const text = (wasmPage.text() || '').trim();
        if (text) return text;
      } catch {
        this.wasmDisabledPages.add(clamped);
      } finally {
        try {
          wasmPage?.free?.();
        } catch {
          // Ignore
        }
      }
    }

    const jsDoc = await this.getOrCreateJsDoc();
    if (jsDoc) {
      try {
        const jsPage = await jsDoc.getPage(clamped);
        return (jsPage.getText() || '').trim();
      } catch {
        return '';
      }
    }
    return '';
  }

  async renderPageToCanvas(
    pageNumber: number,
    canvas: HTMLCanvasElement,
    targetDpi = 135,
  ): Promise<{
    width: number;
    height: number;
    text: string;
    isBlankBitmap: boolean;
    nativeWidth: number;
    nativeHeight: number;
    nativeDpi: number;
  }> {
    const clamped = Math.max(1, Math.min(pageNumber, this.pageCount));
    const safeTargetDpi = Math.max(55, Math.min(240, Math.round(targetDpi)));

    // 1. Fast native WASM path (with clamped pixel budget + strict handle cleanup)
    if (this.wasmDoc && !this.wasmDisabledPages.has(clamped)) {
      let wasmPage: ReturnType<WasmDocument['page']> | null = null;
      try {
        wasmPage = this.wasmDoc.page(clamped - 1);
        const nativeDpi = Math.max(72, Math.min(600, wasmPage.dpi() || 150));
        const nativeWidth = Math.max(1, wasmPage.width_at(nativeDpi));
        const nativeHeight = Math.max(1, wasmPage.height_at(nativeDpi));

        let width = Math.max(1, wasmPage.width_at(safeTargetDpi));
        let height = Math.max(1, wasmPage.height_at(safeTargetDpi));
        let effectiveDpi = safeTargetDpi;

        // Bound decoded RGBA raster to <= 1700px wide so WASM/canvas memory never spikes
        if (width > 1700) {
          effectiveDpi = Math.max(50, Math.floor((safeTargetDpi * 1700) / width));
          width = Math.max(1, wasmPage.width_at(effectiveDpi));
          height = Math.max(1, wasmPage.height_at(effectiveDpi));
        }

        const pixels = wasmPage.render(effectiveDpi);
        const text = (wasmPage.text() || '').trim();
        const isBlank = isBitmapBlankWhite(pixels);

        // If WASM returned blank pixels on a file that has text, verify against DjVu.js unless it's truly text-only TXTa
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas 2D context unavailable');

        const copied = new Uint8ClampedArray(pixels.length);
        copied.set(pixels);
        ctx.putImageData(new ImageData(copied, width, height), 0, 0);

        return {
          width,
          height,
          text,
          isBlankBitmap: isBlank,
          nativeWidth,
          nativeHeight,
          nativeDpi,
        };
      } catch (wasmErr) {
        console.warn(`djvu-rs failed on page ${clamped}, falling back to DjVu.js:`, wasmErr);
        this.wasmDisabledPages.add(clamped);
      } finally {
        try {
          wasmPage?.free?.();
        } catch {
          // Ignore
        }
      }
    }

    // 2. Pure-JS DjVu.js fallback engine (handles indirect/complex dictionaries & FGbz/BG44 chunks)
    const jsDoc = await this.getOrCreateJsDoc();
    if (!jsDoc) {
      throw new Error('Unable to decode DjVu page using either WASM or DjVu.js.');
    }

    const jsPage = await jsDoc.getPage(clamped);
    const nativeDpi = Math.max(72, Math.min(600, jsPage.getDpi() || 150));
    const imageData = jsPage.getImageData(true);
    const nativeWidth = Math.max(1, imageData.width);
    const nativeHeight = Math.max(1, imageData.height);

    const scaleRatio = Math.min(1.8, Math.max(0.2, safeTargetDpi / nativeDpi));
    let outW = Math.max(1, Math.round(nativeWidth * scaleRatio));
    let outH = Math.max(1, Math.round(nativeHeight * scaleRatio));
    if (outW > 1700) {
      const capScale = 1700 / outW;
      outW = 1700;
      outH = Math.max(1, Math.round(outH * capScale));
    }

    const isBlank = isBitmapBlankWhite(imageData.data);
    const text = (jsPage.getText() || '').trim();

    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');

    if (outW === nativeWidth && outH === nativeHeight) {
      ctx.putImageData(imageData, 0, 0);
    } else {
      const tmp = document.createElement('canvas');
      tmp.width = nativeWidth;
      tmp.height = nativeHeight;
      const tmpCtx = tmp.getContext('2d');
      if (tmpCtx) {
        tmpCtx.putImageData(imageData, 0, 0);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, outW, outH);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(tmp, 0, 0, outW, outH);
      }
      releaseCanvasMemory(tmp);
    }

    return {
      width: outW,
      height: outH,
      text,
      isBlankBitmap: isBlank,
      nativeWidth,
      nativeHeight,
      nativeDpi,
    };
  }

  free(): void {
    try {
      this.wasmDoc?.free?.();
    } catch {
      // Ignore double free
    }
    this.wasmDoc = null;
    this.jsDoc = null;
    this.jsSizes = null;
    this.buffer = null;
    this.wasmDisabledPages.clear();
  }
}

export async function openDjvuDocument(buffer: ArrayBuffer): Promise<UnifiedDjvuDocument> {
  const wasmReady = await ensureDjvuInit();
  let wasmDoc: WasmDocument | null = null;
  let jsDoc: DjVuJsDocumentType | null = null;

  if (wasmReady) {
    try {
      const bytes = new Uint8Array(buffer.slice(0));
      wasmDoc = WasmDocument.from_bytes(bytes);
      if (wasmDoc.page_count() <= 0) {
        wasmDoc.free();
        wasmDoc = null;
      }
    } catch {
      wasmDoc = null;
    }
  }

  if (!wasmDoc) {
    // Pure-JS DjVu.js fallback directly on buffer
    const DjVuJsDocument = await loadDjVuJsDocumentClass();
    jsDoc = new DjVuJsDocument(buffer);
  }

  return new HybridDjvuDocument(buffer, wasmDoc, jsDoc);
}

export function closeDjvuDocument(doc: UnifiedDjvuDocument | null | undefined): void {
  if (!doc) return;
  try {
    doc.free();
  } catch {
    // Ignore cleanup errors
  }
}

export async function extractDjvuPageTextRange(
  doc: UnifiedDjvuDocument,
  startPage: number,
  endPage: number,
): Promise<{page: number; text: string}[]> {
  const pageCount = doc.page_count();
  const start = Math.max(1, startPage);
  const end = Math.min(pageCount, endPage);
  const pageTexts: {page: number; text: string}[] = [];

  for (let p = start; p <= end; p++) {
    const text = await doc.getPageText(p);
    pageTexts.push({page: p, text});
    if ((p - start) % 6 === 5) {
      await yieldToMain(4);
    }
  }
  return pageTexts;
}

export async function extractDjvuMetadataAndText(
  buffer: ArrayBuffer,
  maxPagesToIndex = 10,
): Promise<ParsedDjvuInfo> {
  const doc = await openDjvuDocument(buffer);
  try {
    const pageCount = doc.page_count();
    const sampleLimit = maxPagesToIndex > 0 ? Math.min(pageCount, maxPagesToIndex) : pageCount;
    const [outline, pageTexts] = await Promise.all([
      doc.getOutline(),
      extractDjvuPageTextRange(doc, 1, sampleLimit),
    ]);
    return {pageCount, outline, pageTexts};
  } finally {
    closeDjvuDocument(doc);
  }
}

export async function renderDjvuPageToCanvas(
  doc: UnifiedDjvuDocument,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  dpi = 135,
): Promise<{
  width: number;
  height: number;
  text: string;
  isBlankBitmap: boolean;
  nativeWidth: number;
  nativeHeight: number;
  nativeDpi: number;
}> {
  return await doc.renderPageToCanvas(pageNumber, canvas, dpi);
}

export async function extractDjvuCoverThumbnail(
  doc: UnifiedDjvuDocument,
  fallbackTitle?: string,
): Promise<string | undefined> {
  if (typeof document === 'undefined' || doc.page_count() < 1) return undefined;
  const srcCanvas = document.createElement('canvas');
  const outCanvas = document.createElement('canvas');
  try {
    const rendered = await doc.renderPageToCanvas(1, srcCanvas, 65);
    const targetWidth = 220;
    const scale = targetWidth / Math.max(1, rendered.width);
    outCanvas.width = targetWidth;
    outCanvas.height = Math.max(160, Math.round(rendered.height * scale));
    const ctx = outCanvas.getContext('2d');
    if (!ctx) return undefined;

    if (!rendered.isBlankBitmap) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, outCanvas.width, outCanvas.height);
      ctx.drawImage(srcCanvas, 0, 0, outCanvas.width, outCanvas.height);
    } else {
      ctx.fillStyle = '#F8F7F4';
      ctx.fillRect(0, 0, outCanvas.width, outCanvas.height);
      ctx.strokeStyle = '#CBD5E1';
      ctx.lineWidth = 2;
      ctx.strokeRect(12, 12, outCanvas.width - 24, outCanvas.height - 24);
      ctx.fillStyle = '#475569';
      ctx.font = '600 10px monospace';
      ctx.fillText('DJVU ARCHIVE', 24, 38);
      ctx.fillStyle = '#0F172A';
      ctx.font = 'bold 17px Georgia, serif';
      ctx.fillText((fallbackTitle || 'DjVu Manuscript').slice(0, 22), 24, 80);
      ctx.fillStyle = '#64748B';
      ctx.font = '11px Georgia, serif';
      const snippet = (rendered.text || '').slice(0, 120);
      ctx.fillText(snippet.slice(0, 32), 24, 120);
      ctx.fillText(snippet.slice(32, 64), 24, 138);
    }
    return outCanvas.toDataURL('image/jpeg', 0.78);
  } catch {
    return undefined;
  } finally {
    releaseCanvasMemory(srcCanvas);
    releaseCanvasMemory(outCanvas);
  }
}
