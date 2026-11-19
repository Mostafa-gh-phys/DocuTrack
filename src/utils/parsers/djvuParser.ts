import initDjvu, {WasmDocument, wasmSimd128Supported} from 'djvu-rs';

let djvuInitialized = false;

export async function ensureDjvuInit(): Promise<void> {
  if (djvuInitialized) return;
  const variant = wasmSimd128Supported() ? 'simd128' : 'scalar';
  await initDjvu(`/workers/djvu/${variant}/djvu_rs_bg.wasm`);
  djvuInitialized = true;
}

export interface ParsedDjvuInfo {
  pageCount: number;
  pageTexts: {page: number; text: string}[];
}

export async function openDjvuDocument(buffer: ArrayBuffer): Promise<WasmDocument> {
  await ensureDjvuInit();
  const bytes = new Uint8Array(buffer.slice(0));
  return WasmDocument.from_bytes(bytes);
}

export function extractDjvuPageTextRange(
  doc: WasmDocument,
  startPage: number,
  endPage: number,
): {page: number; text: string}[] {
  const pageCount = doc.page_count();
  const start = Math.max(1, startPage);
  const end = Math.min(pageCount, endPage);
  const pageTexts: {page: number; text: string}[] = [];

  for (let p = start; p <= end; p++) {
    const page = doc.page(p - 1);
    const text = page.text() || '';
    pageTexts.push({page: p, text: text.trim()});
  }
  return pageTexts;
}

export async function extractDjvuMetadataAndText(
  buffer: ArrayBuffer,
  maxPagesToIndex = 10,
): Promise<ParsedDjvuInfo> {
  const doc = await openDjvuDocument(buffer);
  const pageCount = doc.page_count();
  const sampleLimit = maxPagesToIndex > 0 ? Math.min(pageCount, maxPagesToIndex) : pageCount;
  const pageTexts = extractDjvuPageTextRange(doc, 1, sampleLimit);

  return {pageCount, pageTexts};
}

export function renderDjvuPageToCanvas(
  doc: WasmDocument,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  dpi = 150,
): {width: number; height: number; text: string; isBlankBitmap: boolean} {
  const page = doc.page(Math.max(0, pageNumber - 1));
  const width = page.width_at(dpi);
  const height = page.height_at(dpi);
  const pixels = page.render(dpi);

  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');

  // Check if rendered DjVu bitmap is completely blank white (e.g. text-only INFO+TXTa archival layer)
  let isBlankBitmap = true;
  for (let i = 0; i < Math.min(pixels.length, 40000); i += 4) {
    if (pixels[i] < 250 || pixels[i + 1] < 250 || pixels[i + 2] < 250) {
      isBlankBitmap = false;
      break;
    }
  }

  const copied = new Uint8ClampedArray(pixels.length);
  copied.set(pixels);
  ctx.putImageData(new ImageData(copied, width, height), 0, 0);

  return {
    width,
    height,
    text: (page.text() || '').trim(),
    isBlankBitmap,
  };
}

export function extractDjvuCoverThumbnail(doc: WasmDocument, fallbackTitle?: string): string | undefined {
  if (typeof document === 'undefined' || doc.page_count() < 1) return undefined;
  try {
    const srcCanvas = document.createElement('canvas');
    const rendered = renderDjvuPageToCanvas(doc, 1, srcCanvas, 65);
    const targetWidth = 240;
    const scale = targetWidth / Math.max(1, rendered.width);
    const outCanvas = document.createElement('canvas');
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
    return outCanvas.toDataURL('image/jpeg', 0.82);
  } catch {
    return undefined;
  }
}

