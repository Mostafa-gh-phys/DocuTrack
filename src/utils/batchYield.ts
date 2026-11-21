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
  const padX = isDoublePage ? 76 : 56;
  const padY = 88;
  const usableW = Math.max(240, viewportWidth - padX);
  const usableH = Math.max(240, viewportHeight - padY);
  const singleColW = isDoublePage ? Math.max(180, (usableW - 18) / 2) : usableW;

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
