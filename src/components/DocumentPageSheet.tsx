import React, {useCallback, useEffect, useRef, useState} from 'react';
import type {PDFDocumentProxy} from 'pdfjs-dist';
import {StickyNote} from 'lucide-react';
import type {
  Annotation,
  AnnotationKind,
  AnnotationPosition,
  HighlightColor,
  ReaderTheme,
  ScanEnhanceSettings,
} from '../types/library';
import {BoundedTaskQueue, releaseCanvasMemory} from '../utils/batchYield';
import {renderDjvuPageToCanvas, type UnifiedDjvuDocument} from '../utils/parsers/djvuParser';
import {renderPdfPageToCanvas, type PdfRenderTextItem} from '../utils/parsers/pdfParser';
import {applyScanEnhancementToCanvas, isScanEnhancementActive} from '../utils/scanEnhance';

export type PageZoteroTool = 'select' | 'highlight' | 'underline' | 'note' | 'area' | 'ink';

interface HighlightColorStyle {
  hex: string;
  fillRgba: string;
}

const HIGHLIGHT_STYLES: Record<HighlightColor, HighlightColorStyle> = {
  amber: {hex: '#d97706', fillRgba: 'rgba(251, 191, 36, 0.34)'},
  sage: {hex: '#059669', fillRgba: 'rgba(52, 211, 153, 0.32)'},
  sky: {hex: '#0284c7', fillRgba: 'rgba(56, 189, 248, 0.32)'},
  rose: {hex: '#e11d48', fillRgba: 'rgba(251, 113, 133, 0.30)'},
  violet: {hex: '#7c3aed', fillRgba: 'rgba(167, 139, 250, 0.32)'},
};

export interface PageMetricsInfo {
  nativeWidth: number;
  nativeHeight: number;
  aspectRatio: number;
}

interface DocumentPageSheetProps {
  format: 'pdf' | 'djvu';
  bookTitle: string;
  pageNumber: number;
  totalPages?: number;
  pdfDoc: PDFDocumentProxy | null;
  djvuDoc: UnifiedDjvuDocument | null;
  renderQueue?: BoundedTaskQueue;
  defaultAspectRatio?: number;
  fallbackText?: string;
  zoomScale: number;
  scanSettings: ScanEnhanceSettings;
  themeBgSurface: string;
  themeBorder: string;
  themeText: string;
  themeMuted: string;
  isDarkTheme: boolean;
  themeId: ReaderTheme;
  fontClass: string;
  activeTool: PageZoteroTool;
  selectedColor: HighlightColor;
  pageAnnotations: Annotation[];
  focusedAnnotationId: string | null;
  lazy?: boolean;
  pageBadgeLabel?: string;
  onFocusAnnotation: (id: string) => void;
  onTextSelection: (pageNumber: number, quote: string, rects: AnnotationPosition[] | undefined) => void;
  onPinNoteAt: (pageNumber: number, pos: AnnotationPosition) => void;
  onCreateSpatialAnnotation: (
    pageNumber: number,
    kind: Extract<AnnotationKind, 'area' | 'ink'>,
    quote: string,
    tags: string[],
    position: AnnotationPosition,
    inkStrokes?: string[],
  ) => void;
  onVisible?: (pageNumber: number) => void;
  onRenderedText?: (pageNumber: number, plainText: string) => void;
  onPageMetrics?: (pageNumber: number, metrics: PageMetricsInfo) => void;
}

export const DocumentPageSheet: React.FC<DocumentPageSheetProps> = ({
  format,
  bookTitle,
  pageNumber,
  totalPages = 1,
  pdfDoc,
  djvuDoc,
  renderQueue,
  defaultAspectRatio = 612 / 792,
  fallbackText = '',
  zoomScale,
  scanSettings,
  themeBgSurface,
  themeBorder,
  themeText,
  themeMuted,
  isDarkTheme,
  themeId,
  fontClass,
  activeTool,
  selectedColor,
  pageAnnotations,
  focusedAnnotationId,
  lazy = false,
  pageBadgeLabel,
  onFocusAnnotation,
  onTextSelection,
  onPinNoteAt,
  onCreateSpatialAnnotation,
  onVisible,
  onRenderedText,
  onPageMetrics,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const onVisibleRef = useRef(onVisible);
  const onRenderedTextRef = useRef(onRenderedText);
  const onPageMetricsRef = useRef(onPageMetrics);
  onVisibleRef.current = onVisible;
  onRenderedTextRef.current = onRenderedText;
  onPageMetricsRef.current = onPageMetrics;

  const [inViewport, setInViewport] = useState(!lazy);
  const [pdfTextItems, setPdfTextItems] = useState<PdfRenderTextItem[]>([]);
  const [nativeMetrics, setNativeMetrics] = useState<PageMetricsInfo | null>(null);
  const [renderedSize, setRenderedSize] = useState<{width: number; height: number} | null>(null);
  const [djvuBlankBitmap, setDjvuBlankBitmap] = useState(false);
  const [djvuPageText, setDjvuPageText] = useState('');

  // Spatial drag state scoped cleanly to this sheet
  const [dragBoxStart, setDragBoxStart] = useState<{x: number; y: number} | null>(null);
  const [dragBoxCurrent, setDragBoxCurrent] = useState<{x: number; y: number} | null>(null);
  const [drawingStroke, setDrawingStroke] = useState<{x: number; y: number}[] | null>(null);

  useEffect(() => {
    if (!lazy) {
      setInViewport(true);
      return;
    }
    const el = containerRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setInViewport(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setInViewport(true);
            if (entry.intersectionRatio >= 0.55) {
              onVisibleRef.current?.(pageNumber);
            }
          } else if (totalPages > 8) {
            setInViewport(false);
            releaseCanvasMemory(canvasRef.current);
          }
        }
      },
      {rootMargin: '520px', threshold: [0.02, 0.55]},
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [lazy, pageNumber, totalPages]);

  useEffect(() => {
    if (!inViewport) {
      if (lazy && totalPages > 8) {
        releaseCanvasMemory(canvasRef.current);
      }
      return;
    }
    let cancelled = false;

    const executeRender = async () => {
      if (cancelled) return;
      const canvas = canvasRef.current;
      if (!canvas) return;

      if (format === 'pdf' && pdfDoc) {
        try {
          const clampedPage = Math.max(1, Math.min(pageNumber, pdfDoc.numPages));
          const res = await renderPdfPageToCanvas(pdfDoc, clampedPage, canvas, zoomScale);
          if (cancelled) return;
          applyScanEnhancementToCanvas(canvas, scanSettings);
          const safeW = Math.max(1, res.width);
          const safeH = Math.max(1, res.height);
          const baseW = Math.max(120, Math.round(safeW / Math.max(0.1, zoomScale)));
          const baseH = Math.max(120, Math.round(safeH / Math.max(0.1, zoomScale)));
          const metrics: PageMetricsInfo = {
            nativeWidth: baseW,
            nativeHeight: baseH,
            aspectRatio: baseW / baseH,
          };
          setNativeMetrics(metrics);
          setRenderedSize({width: safeW, height: safeH});
          onPageMetricsRef.current?.(pageNumber, metrics);
          setPdfTextItems(res.textItems);
          const text = res.textItems.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim();
          if (text) onRenderedTextRef.current?.(pageNumber, text);
        } catch (err) {
          if (err instanceof Error && err.name === 'RenderingCancelledException') return;
          console.error(`PDF render error on page ${pageNumber}:`, err);
        }
      } else if (format === 'djvu' && djvuDoc) {
        try {
          const native = await djvuDoc.getPageNativeSize(pageNumber);
          if (cancelled) return;
          const displayW = Math.max(120, Math.round(612 * zoomScale));
          const aspect = native.width / Math.max(1, native.height);
          const displayH = Math.max(160, Math.round(displayW / aspect));

          const baseDpi = isScanEnhancementActive(scanSettings) ? 132 : 112;
          const dpi = Math.min(190, Math.max(65, Math.round(baseDpi * zoomScale)));
          const res = await renderDjvuPageToCanvas(djvuDoc, pageNumber, canvas, dpi);
          if (cancelled) return;

          if (!res.isBlankBitmap) {
            applyScanEnhancementToCanvas(canvas, scanSettings);
          }

          const finalAspect = res.width / Math.max(1, res.height);
          const metrics: PageMetricsInfo = {
            nativeWidth: 612,
            nativeHeight: Math.round(612 / Math.max(0.25, finalAspect)),
            aspectRatio: finalAspect,
          };
          // Keep canvas CSS size aligned cleanly with zoomScale while preserving native crispness inside backing buffer
          canvas.style.width = `${displayW}px`;
          canvas.style.height = `${Math.max(160, Math.round(displayW / finalAspect))}px`;
          setNativeMetrics(metrics);
          setRenderedSize({
            width: displayW,
            height: res.isBlankBitmap ? displayH : Math.max(160, Math.round(displayW / finalAspect)),
          });
          onPageMetricsRef.current?.(pageNumber, metrics);
          setDjvuBlankBitmap(res.isBlankBitmap);
          const resolvedText = res.text || fallbackText;
          setDjvuPageText(resolvedText);
          if (resolvedText) onRenderedTextRef.current?.(pageNumber, resolvedText);
        } catch (err) {
          console.error(`DjVu render error on page ${pageNumber}:`, err);
        }
      }
    };

    const schedule = renderQueue ? renderQueue.run(executeRender) : executeRender();
    void schedule;

    return () => {
      cancelled = true;
    };
  }, [
    inViewport,
    lazy,
    totalPages,
    format,
    pdfDoc,
    djvuDoc,
    renderQueue,
    pageNumber,
    zoomScale,
    scanSettings,
    fallbackText,
  ]);

  // Deterministic sheet sizing eliminates vertical/horizontal scroll jump even before page decodes
  const activeAspect = nativeMetrics?.aspectRatio || defaultAspectRatio;
  const predictedWidth = Math.max(180, Math.round((nativeMetrics?.nativeWidth || 612) * zoomScale));
  const predictedHeight = Math.max(220, Math.round(predictedWidth / Math.max(0.25, activeAspect)));
  const stageWidth = renderedSize && Math.abs(renderedSize.width - predictedWidth) < 24 ? renderedSize.width : predictedWidth;
  const stageHeight = renderedSize && Math.abs(renderedSize.width - predictedWidth) < 24 ? renderedSize.height : predictedHeight;

  const captureSelectionRects = (): AnnotationPosition[] | undefined => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !containerRef.current) return undefined;
    const stageRect = containerRef.current.getBoundingClientRect();
    if (stageRect.width < 10 || stageRect.height < 10) return undefined;

    const rawRects = Array.from(sel.getRangeAt(0).getClientRects());
    const normalized: AnnotationPosition[] = [];
    for (const r of rawRects) {
      if (r.width < 2 || r.height < 2) continue;
      const x = Math.max(0, Math.min(1, Number(((r.left - stageRect.left) / stageRect.width).toFixed(4))));
      const y = Math.max(0, Math.min(1, Number(((r.top - stageRect.top) / stageRect.height).toFixed(4))));
      const width = Math.max(0, Math.min(1 - x, Number((r.width / stageRect.width).toFixed(4))));
      const height = Math.max(0, Math.min(1 - y, Number((r.height / stageRect.height).toFixed(4))));
      if (width > 0.002 && height > 0.002) normalized.push({x, y, width, height});
      if (normalized.length >= 24) break;
    }
    return normalized.length > 0 ? normalized : undefined;
  };

  const handleMouseUpOnSheet = (e: React.MouseEvent<HTMLDivElement>) => {
    if (activeTool === 'note' || activeTool === 'area' || activeTool === 'ink') return;
    const selObj = window.getSelection();
    const sel = selObj?.toString().trim() || '';
    if (sel.length < 3) return;
    e.stopPropagation();
    const rects = captureSelectionRects();
    onTextSelection(pageNumber, sel.slice(0, 1800), rects);
  };

  const getNormalizedCoords = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return {x: 0.5, y: 0.5};
    return {
      x: Math.max(0, Math.min(1, Number(((e.clientX - rect.left) / rect.width).toFixed(4)))),
      y: Math.max(0, Math.min(1, Number(((e.clientY - rect.top) / rect.height).toFixed(4)))),
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (activeTool === 'note') {
      const pt = getNormalizedCoords(e);
      onPinNoteAt(pageNumber, {x: pt.x, y: pt.y, width: 0.04, height: 0.04});
      return;
    }
    if (activeTool === 'area') {
      e.currentTarget.setPointerCapture?.(e.pointerId);
      const pt = getNormalizedCoords(e);
      setDragBoxStart(pt);
      setDragBoxCurrent(pt);
      return;
    }
    if (activeTool === 'ink') {
      e.currentTarget.setPointerCapture?.(e.pointerId);
      setDrawingStroke([getNormalizedCoords(e)]);
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (activeTool === 'area' && dragBoxStart) {
      setDragBoxCurrent(getNormalizedCoords(e));
    } else if (activeTool === 'ink' && drawingStroke) {
      const pt = getNormalizedCoords(e);
      setDrawingStroke((prev) => {
        if (!prev) return [pt];
        const last = prev[prev.length - 1];
        if (last && Math.hypot(pt.x - last.x, pt.y - last.y) < 0.004) return prev;
        return [...prev, pt];
      });
    }
  };

  const finishStroke = useCallback(() => {
    if (activeTool === 'area' && dragBoxStart && dragBoxCurrent) {
      const x = Math.min(dragBoxStart.x, dragBoxCurrent.x);
      const y = Math.min(dragBoxStart.y, dragBoxCurrent.y);
      const width = Math.abs(dragBoxCurrent.x - dragBoxStart.x);
      const height = Math.abs(dragBoxCurrent.y - dragBoxStart.y);
      setDragBoxStart(null);
      setDragBoxCurrent(null);

      if (width >= 0.02 && height >= 0.02) {
        onCreateSpatialAnnotation(
          pageNumber,
          'area',
          `Captured region (${Math.round(width * 100)}% × ${Math.round(height * 100)}%) on Page ${pageNumber}`,
          ['figure'],
          {x, y, width, height},
        );
      }
      return;
    }

    if (activeTool === 'ink' && drawingStroke) {
      const pts = drawingStroke;
      setDrawingStroke(null);
      if (pts.length >= 2) {
        const d = pts
          .map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x.toFixed(4)} ${p.y.toFixed(4)}`)
          .join(' ');
        const xs = pts.map((p) => p.x);
        const ys = pts.map((p) => p.y);
        const minX = Math.min(...xs);
        const minY = Math.min(...ys);
        onCreateSpatialAnnotation(
          pageNumber,
          'ink',
          `Freehand ink annotation on Page ${pageNumber}`,
          ['ink'],
          {
            x: minX,
            y: minY,
            width: Math.max(0.02, Math.max(...xs) - minX),
            height: Math.max(0.02, Math.max(...ys) - minY),
          },
          [d],
        );
      }
    }
  }, [activeTool, dragBoxCurrent, dragBoxStart, drawingStroke, onCreateSpatialAnnotation, pageNumber]);

  const spatialToolActive = activeTool === 'note' || activeTool === 'area' || activeTool === 'ink';
  const inkAnns = pageAnnotations.filter((a) => a.kind === 'ink' && a.inkStrokes && a.inkStrokes.length > 0);
  const rectHighlightAnns = pageAnnotations.filter(
    (a) =>
      (a.kind === 'highlight' || a.kind === 'underline' || !a.kind) &&
      ((a.rects && a.rects.length > 0) || a.position),
  );
  const liveStrokePath =
    drawingStroke && drawingStroke.length >= 2
      ? drawingStroke.map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x.toFixed(4)} ${p.y.toFixed(4)}`).join(' ')
      : null;
  const liveBox =
    dragBoxStart && dragBoxCurrent
      ? {
          x: Math.min(dragBoxStart.x, dragBoxCurrent.x),
          y: Math.min(dragBoxStart.y, dragBoxCurrent.y),
          width: Math.abs(dragBoxCurrent.x - dragBoxStart.x),
          height: Math.abs(dragBoxCurrent.y - dragBoxStart.y),
        }
      : null;

  return (
    <div
      className={`shrink-0 border ${themeBorder} shadow-sm ${
        !isDarkTheme ? themeBgSurface : 'bg-white'
      } flex flex-col`}
      style={{width: `${stageWidth}px`}}
    >
      <div
        ref={containerRef}
        data-page-number={pageNumber}
        onMouseUp={handleMouseUpOnSheet}
        className="relative w-full overflow-hidden"
        style={{width: `${stageWidth}px`, height: `${stageHeight}px`}}
      >
        {pageBadgeLabel && (
          <div className="absolute top-2 right-2 z-30 px-1.5 py-0.5 rounded bg-black/55 text-white text-[10px] font-mono tabular-nums pointer-events-none">
            {pageBadgeLabel}
          </div>
        )}

        <canvas
          ref={canvasRef}
          data-testid="document-canvas"
          className={`block max-w-full ${
            isDarkTheme
              ? 'invert-[0.88] hue-rotate-180'
              : themeId !== 'paper'
                ? 'mix-blend-multiply'
                : ''
          }`}
        />

        {format === 'pdf' && pdfTextItems.length > 0 && (
          <div className="pdf-text-layer absolute inset-0 select-text overflow-hidden pointer-events-auto z-10">
            {pdfTextItems.map((item, idx) => (
              <span
                key={idx}
                style={{
                  position: 'absolute',
                  left: `${item.x}px`,
                  top: `${item.y}px`,
                  fontSize: `${item.fontSize}px`,
                  fontFamily: item.fontFamily,
                  transform: `scaleX(${item.scaleX})`,
                  transformOrigin: '0 0',
                  lineHeight: 1.05,
                  color: 'transparent',
                  whiteSpace: 'pre',
                }}
              >
                {item.str}
              </span>
            ))}
          </div>
        )}

        {format === 'djvu' && djvuBlankBitmap && djvuPageText && (
          <div className={`absolute inset-0 p-8 sm:p-10 overflow-y-auto ${themeBgSurface} ${themeText} z-10`}>
            <div className={`text-[11px] font-mono uppercase tracking-wider ${themeMuted} mb-4`}>
              DjVu Text Layer (TXTa) · {bookTitle}
            </div>
            <div className={`${fontClass} text-base leading-relaxed whitespace-pre-wrap select-text`}>
              {djvuPageText}
            </div>
          </div>
        )}

        {/* Spatial Overlays for this specific page */}
        <div
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishStroke}
          className={`absolute inset-0 z-20 ${
            spatialToolActive
              ? activeTool === 'ink'
                ? 'cursor-cell pointer-events-auto touch-none'
                : 'cursor-crosshair pointer-events-auto touch-none'
              : 'pointer-events-none'
          }`}
        >
          {rectHighlightAnns.map((ann) => {
            const kind = ann.kind || 'highlight';
            const c = HIGHLIGHT_STYLES[ann.color] || HIGHLIGHT_STYLES.amber;
            const rects = ann.rects && ann.rects.length > 0 ? ann.rects : ann.position ? [ann.position] : [];
            const isFocused = focusedAnnotationId === ann.id;
            return rects.map((r, rIdx) => (
              <button
                key={`${ann.id}-r-${rIdx}`}
                type="button"
                data-testid={kind === 'underline' ? 'pdf-underline-rect' : 'pdf-highlight-rect'}
                aria-label={`Inspect ${kind} annotation on page ${ann.page}`}
                onClick={(ev) => {
                  ev.stopPropagation();
                  onFocusAnnotation(ann.id);
                }}
                style={{
                  left: `${r.x * 100}%`,
                  top: `${r.y * 100}%`,
                  width: `${r.width * 100}%`,
                  height: `${r.height * 100}%`,
                  backgroundColor: kind === 'highlight' ? c.fillRgba : 'transparent',
                  borderBottom: kind === 'underline' ? `2.5px solid ${c.hex}` : undefined,
                }}
                className={`absolute pointer-events-auto rounded-[2px] transition-shadow ${
                  kind === 'highlight' && !isDarkTheme ? 'mix-blend-multiply' : ''
                } ${isFocused ? 'ring-2 ring-blue-700' : ''}`}
              />
            ));
          })}

          {(inkAnns.length > 0 || liveStrokePath) && (
            <svg
              viewBox="0 0 1 1"
              preserveAspectRatio="none"
              className="absolute inset-0 w-full h-full pointer-events-none"
            >
              {inkAnns.map((ann) =>
                (ann.inkStrokes || []).map((d, i) => (
                  <path
                    key={`${ann.id}-${i}`}
                    d={d}
                    fill="none"
                    stroke={HIGHLIGHT_STYLES[ann.color].hex}
                    strokeWidth={focusedAnnotationId === ann.id ? 4 : 2.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                    opacity={0.88}
                    style={{pointerEvents: 'stroke', cursor: 'pointer'}}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      onFocusAnnotation(ann.id);
                    }}
                  />
                )),
              )}
              {liveStrokePath && (
                <path
                  d={liveStrokePath}
                  fill="none"
                  stroke={HIGHLIGHT_STYLES[selectedColor].hex}
                  strokeWidth={2.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
              )}
            </svg>
          )}

          {pageAnnotations
            .filter((a) => a.kind === 'area' && a.position)
            .map((ann) => {
              const pos = ann.position!;
              const c = HIGHLIGHT_STYLES[ann.color];
              const isFocused = focusedAnnotationId === ann.id;
              return (
                <button
                  key={ann.id}
                  type="button"
                  title={ann.note || ann.quote}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onFocusAnnotation(ann.id);
                  }}
                  style={{
                    left: `${pos.x * 100}%`,
                    top: `${pos.y * 100}%`,
                    width: `${pos.width * 100}%`,
                    height: `${pos.height * 100}%`,
                    borderColor: c.hex,
                    backgroundColor: `${c.hex}18`,
                  }}
                  className={`absolute pointer-events-auto border-2 rounded-sm transition-shadow ${
                    isFocused ? 'ring-2 ring-blue-700' : ''
                  }`}
                >
                  <span
                    style={{backgroundColor: c.hex}}
                    className="absolute -top-4 left-0 px-1 text-[10px] font-medium text-white rounded-t-xs whitespace-nowrap"
                  >
                    Area
                  </span>
                </button>
              );
            })}

          {pageAnnotations
            .filter((a) => a.kind === 'note' && a.position)
            .map((ann) => {
              const pos = ann.position!;
              const c = HIGHLIGHT_STYLES[ann.color];
              const isFocused = focusedAnnotationId === ann.id;
              return (
                <button
                  key={ann.id}
                  type="button"
                  aria-label={`Sticky note on page ${ann.page}`}
                  title={ann.note || ann.quote}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onFocusAnnotation(ann.id);
                  }}
                  style={{
                    left: `${pos.x * 100}%`,
                    top: `${pos.y * 100}%`,
                    backgroundColor: c.hex,
                  }}
                  className={`absolute -translate-x-1/2 -translate-y-1/2 pointer-events-auto w-6 h-6 rounded-md text-white shadow-md flex items-center justify-center hover:scale-110 transition-transform ${
                    isFocused ? 'ring-2 ring-offset-1 ring-slate-900' : ''
                  }`}
                >
                  <StickyNote className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              );
            })}

          {liveBox && (
            <div
              style={{
                left: `${liveBox.x * 100}%`,
                top: `${liveBox.y * 100}%`,
                width: `${liveBox.width * 100}%`,
                height: `${liveBox.height * 100}%`,
                borderColor: HIGHLIGHT_STYLES[selectedColor].hex,
                backgroundColor: `${HIGHLIGHT_STYLES[selectedColor].hex}22`,
              }}
              className="absolute border-2 border-dashed rounded-sm pointer-events-none"
            />
          )}
        </div>
      </div>

      {format === 'djvu' && !djvuBlankBitmap && djvuPageText && (
        <details className={`border-t ${themeBorder} ${themeBgSurface} ${themeText} text-xs`}>
          <summary className={`px-3 py-1.5 cursor-pointer select-none ${themeMuted} hover:opacity-100`}>
            Selectable OCR Text Layer (Page {pageNumber})
          </summary>
          <div className={`px-4 pb-3 pt-1 max-h-40 overflow-y-auto ${fontClass} leading-relaxed whitespace-pre-wrap select-text`}>
            {djvuPageText}
          </div>
        </details>
      )}
    </div>
  );
};
