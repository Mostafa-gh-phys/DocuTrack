export function yieldToMain(ms = 0): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function releaseCanvasMemory(canvas: HTMLCanvasElement | null | undefined): void {
  if (!canvas) return;
  try {
    canvas.width = 0;
    canvas.height = 0;
  } catch {
    // Ignore detached or restricted canvas contexts
  }
}

export type DocumentFitMode = 'manual' | 'width' | 'page';

export interface AutofitZoomParams {
  fitMode: DocumentFitMode;
  manualZoom: number;
  pageWidth: number;
  pageHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  isDoublePage: boolean;
  minZoom?: number;
  maxZoom?: number;
}

/**
 * Deterministic zoom factor calculation shared by PDF and DjVu viewers.
 * Supports Manual, Fit Width (single or side-by-side 2-up spread), and Fit Page.
 */
export function computeAutofitZoom(params: AutofitZoomParams): number {
  const {
    fitMode,
    manualZoom,
    pageWidth,
    pageHeight,
    viewportWidth,
    viewportHeight,
    isDoublePage,
    minZoom = 0.45,
    maxZoom = 2.6,
  } = params;

  if (fitMode === 'manual') {
    return Number(Math.min(maxZoom, Math.max(minZoom, manualZoom)).toFixed(2));
  }

  const safePageW = Math.max(120, pageWidth);
  const safePageH = Math.max(120, pageHeight);
  const sideGutters = viewportWidth >= 640 ? 84 : 44;
  const padX = isDoublePage ? sideGutters + 30 : sideGutters;
  const padY = 64;
  const usableW = Math.max(200, viewportWidth - padX);
  const usableH = Math.max(220, viewportHeight - padY);
  const singleColW = isDoublePage ? Math.max(160, (usableW - 14) / 2) : usableW;

  const widthScale = singleColW / safePageW;
  const heightScale = usableH / safePageH;
  const raw = fitMode === 'page' ? Math.min(widthScale, heightScale) : widthScale;
  return Number(Math.min(maxZoom, Math.max(minZoom, raw)).toFixed(2));
}

/**
 * Lightweight concurrency-bounded task runner to prevent simultaneous heavy PDF/DjVu decodes.
 */
export class BoundedTaskQueue {
  private concurrency: number;
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(concurrency = 2) {
    this.concurrency = Math.max(1, concurrency);
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const execute = async () => {
        this.active++;
        try {
          const result = await task();
          resolve(result);
        } catch (err) {
          reject(err);
        } finally {
          this.active--;
          const next = this.queue.shift();
          if (next) next();
        }
      };

      if (this.active < this.concurrency) {
        void execute();
      } else {
        this.queue.push(() => void execute());
      }
    });
  }
}

export const RESOURCE_LIMITS = {
  maxRenderDpr: 1.5,
  maxCanvasCount: 10,
  maxCanvasBytes: 48 * 1024 * 1024, // 48 MB total decoded bitmap ceiling
  maxSheetPixelWidth: 1600,
  continuousPageWindow: 12,
} as const;

/**
 * Global LRU canvas memory governor: ensures decoded page bitmaps never exhaust system RAM
 * when browsing or fast-scrolling multi-hundred-page PDF/DjVu documents.
 */
export class CanvasMemoryGovernor {
  private entries = new Map<string, {canvas: HTMLCanvasElement; bytes: number}>();
  private maxEntries: number;
  private maxBytes: number;

  constructor(maxEntries: number = RESOURCE_LIMITS.maxCanvasCount, maxBytes: number = RESOURCE_LIMITS.maxCanvasBytes) {
    this.maxEntries = Math.max(2, maxEntries);
    this.maxBytes = Math.max(4 * 1024 * 1024, maxBytes);
  }

  getTotalBytes(): number {
    let total = 0;
    for (const item of this.entries.values()) total += item.bytes;
    return total;
  }

  getEntryCount(): number {
    return this.entries.size;
  }

  register(key: string, canvas: HTMLCanvasElement, protectedKeys?: Set<string>): void {
    const bytes = Math.max(0, canvas.width * canvas.height * 4);
    if (this.entries.has(key)) {
      this.entries.delete(key);
    }
    this.entries.set(key, {canvas, bytes});
    this.evictIfOverBudget(key, protectedKeys);
  }

  release(key: string): void {
    const item = this.entries.get(key);
    if (!item) return;
    this.entries.delete(key);
    releaseCanvasMemory(item.canvas);
  }

  clearAll(): void {
    for (const item of this.entries.values()) {
      releaseCanvasMemory(item.canvas);
    }
    this.entries.clear();
  }

  private evictIfOverBudget(keepKey: string, protectedKeys?: Set<string>): void {
    for (const [k, item] of this.entries) {
      if (this.entries.size <= this.maxEntries && this.getTotalBytes() <= this.maxBytes) break;
      if (k === keepKey || protectedKeys?.has(k)) continue;
      this.entries.delete(k);
      releaseCanvasMemory(item.canvas);
    }
  }
}

export const globalCanvasGovernor = new CanvasMemoryGovernor();

