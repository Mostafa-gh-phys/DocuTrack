import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import type {PDFDocumentProxy} from 'pdfjs-dist';
import {
  ArrowLeft,
  ArrowRightLeft,
  BookOpen,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Columns2,
  Copy,
  Download,
  ExternalLink,
  FileText,
  GraduationCap,
  Hand,
  Highlighter,
  Languages,
  ListTree,
  Maximize2,
  MessageSquarePlus,
  Minimize2,
  MousePointer,
  MoveHorizontal,
  MoveVertical,
  PenTool,
  ScanLine,
  SlidersHorizontal,
  SquareDashedMousePointer,
  StickyNote,
  Tag,
  Trash2,
  Underline,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type {
  Annotation,
  AnnotationKind,
  AnnotationPosition,
  BookMetadata,
  DocumentTextChunk,
  EpubViewMode,
  HighlightColor,
  OutlineItem,
  PageLayoutMode,
  ReaderPreferences,
  ReaderTheme,
  ReadingDirection,
  ScanEnhanceSettings,
  ScanPreset,
  StudyCourse,
} from '../types/library';
import {BoundedTaskQueue, computeAutofitZoom, globalCanvasGovernor, RESOURCE_LIMITS, type DocumentFitMode} from '../utils/batchYield';
import {renderEpubChapterWithAnnotations} from '../utils/epubHighlighter';
import {translateWithSystemOrWeb, type InlineTranslationOutcome} from '../utils/inlineTranslator';
import {
  calculateProgress,
  exportAnnotationsToMarkdown,
  formatZoteroCitation,
} from '../utils/libraryLogic';
import {getBookBinary, getBookTextChunks} from '../utils/offlineStorage';
import {
  closeDjvuDocument,
  openDjvuDocument,
  type DjvuOutlineItem,
  type UnifiedDjvuDocument,
} from '../utils/parsers/djvuParser';
import {parseEpubDocument, type ParsedEpubDocument} from '../utils/parsers/epubParser';
import {
  closePdfDocument,
  extractPdfOutlineAndMeta,
  loadPdfDocument,
} from '../utils/parsers/pdfParser';
import {
  DEFAULT_SCAN_SETTINGS,
  getScanPresetSettings,
  isScanEnhancementActive,
} from '../utils/scanEnhance';
import {FONT_OPTIONS, getReaderFontClass, READER_THEMES} from '../utils/themeTokens';
import {AnnotationPopover} from './AnnotationPopover';
import {DocumentPageSheet, type PageMetricsInfo} from './DocumentPageSheet';

export type ZoteroTool = 'select' | 'pan' | 'highlight' | 'underline' | 'note' | 'area' | 'ink';

interface ReaderViewProps {
  book: BookMetadata;
  annotations: Annotation[];
  courses: StudyCourse[];
  preferences: ReaderPreferences;
  isOnline: boolean;
  simulatedOffline: boolean;
  allowLocalOffline?: boolean;
  initialRightTab?: 'typography' | 'translate' | 'course' | null;
  onBack: () => void;
  onUpdateProgress: (bookId: string, page: number, pageCount: number) => void;
  onUpdatePreferences: (prefs: ReaderPreferences) => void;
  onAddAnnotation: (ann: Omit<Annotation, 'id' | 'ownerId' | 'createdAtMs' | 'updatedAtMs'>) => void;
  onUpdateAnnotation: (
    id: string,
    patch: Partial<Pick<Annotation, 'note' | 'color' | 'tags'>>,
  ) => void;
  onDeleteAnnotation: (id: string) => void;
  onGenerateCourse: (book: BookMetadata, mode: 'course' | 'summary', textContent: string) => Promise<StudyCourse | null>;
  onRecordReadingSession?: (pagesDelta: number, minutesDelta: number) => void;
}

const HIGHLIGHT_COLORS: Record<
  HighlightColor,
  {label: string; swatch: string; bg: string; hex: string; fillRgba: string}
> = {
  amber: {
    label: 'Amber',
    swatch: 'bg-amber-400',
    bg: 'bg-amber-200/60 dark:bg-amber-900/40',
    hex: '#d97706',
    fillRgba: 'rgba(251, 191, 36, 0.34)',
  },
  sage: {
    label: 'Sage',
    swatch: 'bg-emerald-400',
    bg: 'bg-emerald-200/60 dark:bg-emerald-900/40',
    hex: '#059669',
    fillRgba: 'rgba(52, 211, 153, 0.32)',
  },
  sky: {
    label: 'Sky',
    swatch: 'bg-sky-400',
    bg: 'bg-sky-200/60 dark:bg-sky-900/40',
    hex: '#0284c7',
    fillRgba: 'rgba(56, 189, 248, 0.32)',
  },
  rose: {
    label: 'Rose',
    swatch: 'bg-rose-400',
    bg: 'bg-rose-200/60 dark:bg-rose-900/40',
    hex: '#e11d48',
    fillRgba: 'rgba(251, 113, 133, 0.30)',
  },
  violet: {
    label: 'Violet',
    swatch: 'bg-violet-400',
    bg: 'bg-violet-200/60 dark:bg-violet-900/40',
    hex: '#7c3aed',
    fillRgba: 'rgba(167, 139, 250, 0.32)',
  },
};

const COLOR_ORDER: HighlightColor[] = ['amber', 'sage', 'sky', 'rose', 'violet'];

const KIND_LABELS: Record<AnnotationKind, string> = {
  highlight: 'Highlight',
  underline: 'Underline',
  note: 'Sticky Note',
  area: 'Area Capture',
  ink: 'Ink Draw',
};

const LANGUAGES = ['Spanish', 'French', 'German', 'Persian', 'Japanese', 'Chinese', 'Arabic', 'Portuguese', 'Korean'];

export const ReaderView: React.FC<ReaderViewProps> = ({
  book,
  annotations,
  courses,
  preferences,
  isOnline,
  simulatedOffline,
  allowLocalOffline = false,
  initialRightTab = null,
  onBack,
  onUpdateProgress,
  onUpdatePreferences,
  onAddAnnotation,
  onUpdateAnnotation,
  onDeleteAnnotation,
  onGenerateCourse,
  onRecordReadingSession,
}) => {
  const [currentPage, setCurrentPage] = useState(book.currentPage || 1);
  const [pageInputDraft, setPageInputDraft] = useState(String(book.currentPage || 1));
  const [totalPages, setTotalPages] = useState(book.pageCount || 1);
  const [loadingDoc, setLoadingDoc] = useState(true);
  const [docError, setDocError] = useState<string | null>(null);

  // Left drawer stays CLOSED unless explicitly opened by the user — zero unwanted sidebar popouts!
  const [leftTab, setLeftTab] = useState<'toc' | 'annotations' | null>(null);
  const [rightTab, setRightTab] = useState<'typography' | 'translate' | 'course' | null>(initialRightTab);
  const [distractionFree, setDistractionFree] = useState(false);

  // Format-specific state
  const [epubDoc, setEpubDoc] = useState<ParsedEpubDocument | null>(null);
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [pdfOutline, setPdfOutline] = useState<OutlineItem[]>([]);
  const [djvuDoc, setDjvuDoc] = useState<UnifiedDjvuDocument | null>(null);
  const [djvuOutline, setDjvuOutline] = useState<DjvuOutlineItem[]>([]);
  const [collapsedTocKeys, setCollapsedTocKeys] = useState<Set<number>>(() => new Set());
  const [renderedPageTexts, setRenderedPageTexts] = useState<Record<number, string>>({});
  const [zoomScale, setZoomScale] = useState(1.25);
  const [fitMode, setFitMode] = useState<DocumentFitMode>('page');
  const [viewportSize, setViewportSize] = useState<{width: number; height: number}>({width: 960, height: 720});
  const [pageMetrics, setPageMetrics] = useState<Record<number, PageMetricsInfo>>({});
  const [textChunks, setTextChunks] = useState<DocumentTextChunk[]>([]);
  const renderQueueRef = useRef<BoundedTaskQueue>(new BoundedTaskQueue(2));

  // Scanned PDF & DjVu Enhancement State
  const [scanOpen, setScanOpen] = useState(false);
  const [scanSettings, setScanSettings] = useState<ScanEnhanceSettings>(DEFAULT_SCAN_SETTINGS);

  // Unified Paper/Book Layout Mode & Reading Direction (PDF, DjVu & EPUB)
  const pageLayoutMode: PageLayoutMode =
    preferences.pageLayoutMode ||
    (book.format === 'epub'
      ? preferences.epubViewMode === 'spread'
        ? 'double'
        : preferences.epubViewMode === 'paginated'
          ? 'horizontal'
          : 'vertical'
      : 'single');
  const readingDirection: ReadingDirection = preferences.readingDirection || 'ltr';

  // EPUB Novel Paginated / Spread Sub-Page State (derived smoothly from pageLayoutMode)
  const epubViewMode: EpubViewMode =
    pageLayoutMode === 'double'
      ? 'spread'
      : pageLayoutMode === 'single' || pageLayoutMode === 'horizontal'
        ? 'paginated'
        : 'scroll';
  const novelIndent = preferences.novelIndent ?? true;
  const novelJustify = preferences.novelJustify ?? true;
  const novelDropCap = preferences.novelDropCap ?? true;
  const [epubSubPage, setEpubSubPage] = useState(0);
  const [epubSubPageCount, setEpubSubPageCount] = useState(1);
  const [activeTocKey, setActiveTocKey] = useState<string | null>(null);

  const pageStageRef = useRef<HTMLDivElement | null>(null);
  const readerViewportRef = useRef<HTMLElement | null>(null);
  const epubBodyRef = useRef<HTMLDivElement | null>(null);
  const epubSpreadViewportRef = useRef<HTMLDivElement | null>(null);
  const visitedPagesRef = useRef<Set<number>>(new Set([book.currentPage || 1]));
  const suppressAutoScrollRef = useRef(false);
  const pendingFragmentRef = useRef<string | null>(null);
  const prevEpubChapterRef = useRef<number>(book.currentPage || 1);
  const currentPageRef = useRef(currentPage);
  currentPageRef.current = currentPage;
  const progressFlushTimerRef = useRef<number | null>(null);
  const latestPageToFlushRef = useRef<number | null>(null);
  const scrollRafRef = useRef<number | null>(null);
  const manualZoomRef = useRef(zoomScale);
  manualZoomRef.current = zoomScale;

  // Keep editable footer input synced with live page turns / continuous scroll
  useEffect(() => {
    setPageInputDraft(String(currentPage));
  }, [currentPage]);

  // Evince-style hand pan & drag state
  const [spacePanHeld, setSpacePanHeld] = useState(false);
  const [isDraggingPan, setIsDraggingPan] = useState(false);
  const panStateRef = useRef<{
    active: boolean;
    startX: number;
    startY: number;
    scrollLeft: number;
    scrollTop: number;
  }>({active: false, startX: 0, startY: 0, scrollLeft: 0, scrollTop: 0});

  // Zotero Tooling & Selection Composer state
  const [activeTool, setActiveTool] = useState<ZoteroTool>('select');
  const [selectedColor, setSelectedColor] = useState<HighlightColor>('amber');
  const [selectedText, setSelectedText] = useState('');
  const [selectedRects, setSelectedRects] = useState<AnnotationPosition[] | undefined>(undefined);
  const [noteDraft, setNoteDraft] = useState('');
  const [tagsDraft, setTagsDraft] = useState('');
  const [pendingPosition, setPendingPosition] = useState<AnnotationPosition | undefined>(undefined);
  const [pendingPage, setPendingPage] = useState<number | null>(null);
  const [pendingKind, setPendingKind] = useState<AnnotationKind>('highlight');
  const [composerOpen, setComposerOpen] = useState(false);

  // Interactive Spatial Drawing (Area box & Freehand Ink)
  const [dragBoxStart, setDragBoxStart] = useState<{x: number; y: number} | null>(null);
  const [dragBoxCurrent, setDragBoxCurrent] = useState<{x: number; y: number} | null>(null);
  const [drawingStroke, setDrawingStroke] = useState<{x: number; y: number}[] | null>(null);

  // Inspector Filters & Editing
  const [annKindFilter, setAnnKindFilter] = useState<AnnotationKind | 'all'>('all');
  const [annColorFilter, setAnnColorFilter] = useState<HighlightColor | 'all'>('all');
  const [annSearch, setAnnSearch] = useState('');
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingNoteText, setEditingNoteText] = useState('');
  const [newTagInputId, setNewTagInputId] = useState<string | null>(null);
  const [newTagText, setNewTagText] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [focusedAnnotationId, setFocusedAnnotationId] = useState<string | null>(null);

  // Translation state (System Translator + Direct Web Links)
  const [targetLang, setTargetLang] = useState('Spanish');
  const [translationSource, setTranslationSource] = useState('');
  const [translationOutcome, setTranslationOutcome] = useState<InlineTranslationOutcome | null>(null);
  const [translating, setTranslating] = useState(false);
  const [translateCopied, setTranslateCopied] = useState(false);

  // AI Course state
  const [generatingCourse, setGeneratingCourse] = useState(false);
  const [courseError, setCourseError] = useState<string | null>(null);
  const [revealedQuiz, setRevealedQuiz] = useState<Record<number, boolean>>({});

  useEffect(() => {
    if (!onRecordReadingSession) return;
    const id = window.setInterval(() => {
      if (!document.hidden) onRecordReadingSession(0, 1);
    }, 60000);
    return () => window.clearInterval(id);
  }, [onRecordReadingSession]);

  const bookAnnotations = useMemo(
    () => annotations.filter((a) => a.bookId === book.id).sort((a, b) => a.page - b.page),
    [annotations, book.id],
  );

  const pageAnnotations = useMemo(
    () => bookAnnotations.filter((a) => a.page === currentPage),
    [bookAnnotations, currentPage],
  );

  const focusedAnnotation = useMemo(
    () => (focusedAnnotationId ? bookAnnotations.find((a) => a.id === focusedAnnotationId) || null : null),
    [bookAnnotations, focusedAnnotationId],
  );

  const filteredInspectorAnnotations = useMemo(() => {
    const q = annSearch.trim().toLowerCase();
    return bookAnnotations.filter((ann) => {
      const kind = ann.kind || 'highlight';
      if (annKindFilter !== 'all' && kind !== annKindFilter) return false;
      if (annColorFilter !== 'all' && ann.color !== annColorFilter) return false;
      if (q) {
        const hay = `${ann.quote} ${ann.note} ${(ann.tags || []).join(' ')} ${kind}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [bookAnnotations, annKindFilter, annColorFilter, annSearch]);

  const activeCourse = useMemo(
    () => courses.find((c) => c.bookId === book.id) || null,
    [courses, book.id],
  );

  // Load document binary from IndexedDB (and strictly clean up PDF, DjVu, and EPUB blob URLs)
  useEffect(() => {
    let cancelled = false;
    let loadedPdfDoc: PDFDocumentProxy | null = null;
    let loadedDjvuDoc: UnifiedDjvuDocument | null = null;
    let loadedEpubDoc: ParsedEpubDocument | null = null;

    async function loadDocument() {
      setLoadingDoc(true);
      setDocError(null);
      setPdfDoc(null);
      setEpubDoc(null);
      setDjvuDoc(null);
      setDjvuOutline([]);
      setPageMetrics({});
      setRenderedPageTexts({});

      try {
        const [buffer, storedChunks] = await Promise.all([
          getBookBinary(book.id),
          getBookTextChunks(book.id),
        ]);
        if (cancelled) return;
        setTextChunks(storedChunks);

        if (!buffer) {
          setDocError('Document binary is not cached locally yet. Import or pin this file on this device to view.');
          setLoadingDoc(false);
          return;
        }

        if (book.format === 'epub') {
          const parsed = await parseEpubDocument(buffer);
          if (cancelled) {
            parsed.dispose();
            return;
          }
          loadedEpubDoc = parsed;
          setEpubDoc(parsed);
          setTotalPages(parsed.chapters.length);
        } else if (book.format === 'pdf') {
          const doc = await loadPdfDocument(buffer);
          if (cancelled) {
            await closePdfDocument(doc);
            return;
          }
          loadedPdfDoc = doc;
          const info = await extractPdfOutlineAndMeta(doc);
          if (cancelled) return;
          setPdfDoc(doc);
          setPdfOutline(info.outline);
          setTotalPages(doc.numPages);
        } else if (book.format === 'djvu') {
          const doc = await openDjvuDocument(buffer);
          if (cancelled) {
            closeDjvuDocument(doc);
            return;
          }
          loadedDjvuDoc = doc;
          const outline = await doc.getOutline().catch(() => []);
          if (cancelled) return;
          setDjvuDoc(doc);
          setDjvuOutline(outline);
          setTotalPages(Math.max(1, doc.page_count()));
        }
      } catch (err) {
        if (!cancelled) {
          setDocError(err instanceof Error ? err.message : 'Unable to render this document.');
        }
      } finally {
        if (!cancelled) setLoadingDoc(false);
      }
    }
    void loadDocument();
    return () => {
      cancelled = true;
      void closePdfDocument(loadedPdfDoc);
      closeDjvuDocument(loadedDjvuDoc);
      loadedEpubDoc?.dispose();
      globalCanvasGovernor.clearAll();
    };
  }, [book.id, book.format, book.title]);

  // Observe reader viewport dimensions cleanly for PDF/DjVu autofit & responsive EPUB leaf height
  useEffect(() => {
    const el = readerViewportRef.current;
    if (!el) return;
    const updateSize = () => {
      setViewportSize({
        width: Math.max(320, el.clientWidth),
        height: Math.max(360, el.clientHeight),
      });
    };
    updateSize();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => updateSize());
    ro.observe(el);
    return () => ro.disconnect();
  }, [distractionFree, leftTab, rightTab, scanOpen]);

  // Responsive Fit Width / Fit Page zoom calculation (stabilized against continuous scroll page churn!)
  const continuousScrollMode = pageLayoutMode === 'vertical' || pageLayoutMode === 'horizontal';
  const refFitPage = continuousScrollMode ? 1 : currentPage;
  const refMetrics = pageMetrics[refFitPage];

  useEffect(() => {
    if (fitMode === 'manual' || book.format === 'epub') return;
    let cancelled = false;

    const applyComputedZoom = (pageWidth: number, pageHeight: number) => {
      if (cancelled) return;
      const computed = computeAutofitZoom({
        fitMode,
        manualZoom: manualZoomRef.current,
        pageWidth,
        pageHeight,
        viewportWidth: viewportSize.width,
        viewportHeight: viewportSize.height,
        isDoublePage: pageLayoutMode === 'double',
      });
      setZoomScale((prev) => (Math.abs(prev - computed) < 0.01 ? prev : computed));
    };

    if (refMetrics) {
      applyComputedZoom(refMetrics.nativeWidth, refMetrics.nativeHeight);
      return;
    }

    if (book.format === 'pdf' && pdfDoc) {
      void (async () => {
        try {
          const page = await pdfDoc.getPage(Math.max(1, Math.min(refFitPage, pdfDoc.numPages)));
          if (cancelled) return;
          const baseViewport = page.getViewport({scale: 1});
          applyComputedZoom(baseViewport.width, baseViewport.height);
        } catch {
          // Ignore fit calculation failure
        }
      })();
    } else if (book.format === 'djvu' && djvuDoc) {
      void (async () => {
        try {
          const native = await djvuDoc.getPageNativeSize(refFitPage);
          if (cancelled) return;
          const aspect = native.width / Math.max(1, native.height);
          applyComputedZoom(612, Math.round(612 / Math.max(0.25, aspect)));
        } catch {
          applyComputedZoom(612, 792);
        }
      })();
    }

    return () => {
      cancelled = true;
    };
  }, [
    fitMode,
    book.format,
    pdfDoc,
    djvuDoc,
    refFitPage,
    pageLayoutMode,
    viewportSize.width,
    viewportSize.height,
    refMetrics?.nativeWidth,
    refMetrics?.nativeHeight,
  ]);

  // Evince-style Ctrl+Wheel / pinch zoom on the PDF & DjVu reading viewport
  useEffect(() => {
    const el = readerViewportRef.current;
    if (!el || book.format === 'epub') return;
    const onNativeWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setFitMode('manual');
      setZoomScale((prev) => {
        const factor = Math.exp(-e.deltaY * 0.0022);
        const next = Math.max(0.45, Math.min(2.6, prev * factor));
        return Number(next.toFixed(2));
      });
    };
    el.addEventListener('wheel', onNativeWheel, {passive: false});
    return () => el.removeEventListener('wheel', onNativeWheel);
  }, [book.format, loadingDoc]);

  const epubSpreadHeightPx = useMemo(
    () => Math.max(380, Math.min(780, viewportSize.height - 175)),
    [viewportSize.height],
  );

  // Flush debounced reading progress safely on unmount
  useEffect(() => {
    return () => {
      if (progressFlushTimerRef.current) {
        window.clearTimeout(progressFlushTimerRef.current);
        progressFlushTimerRef.current = null;
      }
      if (scrollRafRef.current) {
        window.cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
      if (latestPageToFlushRef.current !== null) {
        onUpdateProgress(book.id, latestPageToFlushRef.current, totalPages);
      }
    };
  }, [book.id, onUpdateProgress, totalPages]);

  const scheduleDebouncedProgressSave = useCallback(
    (page: number) => {
      latestPageToFlushRef.current = page;
      if (progressFlushTimerRef.current) {
        window.clearTimeout(progressFlushTimerRef.current);
      }
      progressFlushTimerRef.current = window.setTimeout(() => {
        progressFlushTimerRef.current = null;
        if (latestPageToFlushRef.current !== null) {
          const p = latestPageToFlushRef.current;
          latestPageToFlushRef.current = null;
          onUpdateProgress(book.id, p, totalPages);
        }
      }, 650);
    },
    [book.id, onUpdateProgress, totalPages],
  );

  // Populate EPUB chapter DOM + wrap in-page <mark data-ann-id> highlights & underlines cleanly
  useEffect(() => {
    if (book.format !== 'epub' || !epubDoc || !epubBodyRef.current) return;
    const chapterHtml = epubDoc.chapters[currentPage - 1]?.html || '<p>Empty chapter.</p>';
    const bodyEl = epubBodyRef.current;
    renderEpubChapterWithAnnotations(bodyEl, chapterHtml, pageAnnotations, focusedAnnotationId);

    const chapterChanged = prevEpubChapterRef.current !== currentPage;
    prevEpubChapterRef.current = currentPage;
    const pendingFrag = pendingFragmentRef.current;
    pendingFragmentRef.current = null;

    // Recalculate paginated / two-page spread column pages & scroll accurately to fragment/top
    const raf = window.requestAnimationFrame(() => {
      if (epubViewMode !== 'scroll' && epubSpreadViewportRef.current) {
        const el = epubSpreadViewportRef.current;
        const pageW = Math.max(1, el.clientWidth);
        const totalW = el.scrollWidth;
        const count = Math.max(1, Math.round(totalW / pageW));
        setEpubSubPageCount(count);
        if (pendingFrag) {
          const esc = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(pendingFrag) : pendingFrag;
          const anchor = bodyEl.querySelector(`[id="${esc}"], [name="${esc}"]`) as HTMLElement | null;
          if (anchor) {
            const relLeft = Math.max(0, anchor.offsetLeft);
            const targetSub = Math.max(0, Math.min(count - 1, Math.floor(relLeft / pageW)));
            setEpubSubPage(targetSub);
          } else {
            setEpubSubPage(0);
          }
        } else {
          setEpubSubPage((prev) => Math.min(prev, count - 1));
        }
      } else {
        setEpubSubPage(0);
        setEpubSubPageCount(1);
        if (pendingFrag) {
          const esc = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(pendingFrag) : pendingFrag;
          const anchor = bodyEl.querySelector(`[id="${esc}"], [name="${esc}"]`) as HTMLElement | null;
          anchor?.scrollIntoView({behavior: 'smooth', block: 'start'});
        } else if (chapterChanged) {
          readerViewportRef.current?.scrollTo({top: 0, left: 0, behavior: 'auto'});
        }
      }
    });
    return () => {
      window.cancelAnimationFrame(raf);
    };
  }, [
    book.format,
    epubDoc,
    currentPage,
    pageAnnotations,
    focusedAnnotationId,
    epubViewMode,
    pageLayoutMode,
    readingDirection,
    epubSpreadHeightPx,
    viewportSize.width,
    preferences.fontSize,
    preferences.lineHeight,
    preferences.maxWidth,
    preferences.fontFamily,
    novelIndent,
    novelJustify,
    novelDropCap,
  ]);

  const goToPage = useCallback(
    (nextPage: number, fromContinuousScroll = false, fragmentId?: string) => {
      const clamped = Math.max(1, Math.min(nextPage, totalPages));
      pendingFragmentRef.current = fragmentId || null;
      setCurrentPage(clamped);
      setEpubSubPage(0);
      setFocusedAnnotationId(null);

      if (fromContinuousScroll) {
        scheduleDebouncedProgressSave(clamped);
      } else {
        if (progressFlushTimerRef.current) {
          window.clearTimeout(progressFlushTimerRef.current);
          progressFlushTimerRef.current = null;
        }
        latestPageToFlushRef.current = null;
        onUpdateProgress(book.id, clamped, totalPages);
      }

      if (!visitedPagesRef.current.has(clamped)) {
        visitedPagesRef.current.add(clamped);
        onRecordReadingSession?.(1, 0);
      }

      if (fromContinuousScroll) return;

      if (book.format === 'epub') {
        if (!fragmentId) {
          window.requestAnimationFrame(() => {
            readerViewportRef.current?.scrollTo({top: 0, left: 0, behavior: 'auto'});
          });
        }
        return;
      }

      if (pageLayoutMode === 'vertical' || pageLayoutMode === 'horizontal') {
        suppressAutoScrollRef.current = true;
        window.requestAnimationFrame(() => {
          const viewport = readerViewportRef.current;
          const pageEl = viewport?.querySelector(`[data-page-number="${clamped}"]`) as HTMLElement | null;
          if (viewport && pageEl) {
            const vpRect = viewport.getBoundingClientRect();
            const pgRect = pageEl.getBoundingClientRect();
            const targetTop = Math.max(0, viewport.scrollTop + (pgRect.top - vpRect.top) - 16);
            const targetLeft =
              pageLayoutMode === 'horizontal'
                ? viewport.scrollLeft + (pgRect.left - vpRect.left) - 16
                : viewport.scrollLeft;
            viewport.scrollTo({
              top: targetTop,
              left: targetLeft,
              behavior: 'smooth',
            });
          }
        });
        window.setTimeout(() => {
          suppressAutoScrollRef.current = false;
        }, 420);
      } else {
        // Single or Double page view: always jump to the exact top of the new page
        window.requestAnimationFrame(() => {
          readerViewportRef.current?.scrollTo({top: 0, left: 0, behavior: 'auto'});
        });
      }
    },
    [
      book.format,
      book.id,
      onRecordReadingSession,
      onUpdateProgress,
      pageLayoutMode,
      scheduleDebouncedProgressSave,
      totalPages,
    ],
  );

  // Fast RAF-throttled active page tracking for continuous vertical / horizontal scrolling
  const handleViewportScroll = useCallback(() => {
    if (
      suppressAutoScrollRef.current ||
      book.format === 'epub' ||
      (pageLayoutMode !== 'vertical' && pageLayoutMode !== 'horizontal')
    ) {
      return;
    }
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const viewport = readerViewportRef.current;
      if (!viewport || suppressAutoScrollRef.current) return;

      const sheets = viewport.querySelectorAll<HTMLElement>('[data-page-number]');
      if (sheets.length === 0) return;

      const vpRect = viewport.getBoundingClientRect();
      const focusY = vpRect.top + Math.min(180, vpRect.height * 0.28);
      const focusX =
        readingDirection === 'rtl'
          ? vpRect.right - Math.min(200, vpRect.width * 0.3)
          : vpRect.left + Math.min(200, vpRect.width * 0.3);

      let bestPage = currentPageRef.current;
      let bestDistance = Number.POSITIVE_INFINITY;

      for (let i = 0; i < sheets.length; i++) {
        const el = sheets[i];
        const pageNum = Number(el.dataset.pageNumber);
        if (!Number.isFinite(pageNum) || pageNum < 1) continue;
        const rect = el.getBoundingClientRect();

        if (pageLayoutMode === 'horizontal') {
          if (rect.left <= focusX && rect.right >= focusX) {
            bestPage = pageNum;
            break;
          }
          const dist = Math.min(Math.abs(rect.left - focusX), Math.abs(rect.right - focusX));
          if (dist < bestDistance) {
            bestDistance = dist;
            bestPage = pageNum;
          }
        } else {
          if (rect.top <= focusY && rect.bottom >= focusY) {
            bestPage = pageNum;
            break;
          }
          const dist = Math.min(Math.abs(rect.top - focusY), Math.abs(rect.bottom - focusY));
          if (dist < bestDistance) {
            bestDistance = dist;
            bestPage = pageNum;
          }
        }
      }

      if (bestPage !== currentPageRef.current) {
        setCurrentPage(bestPage);
        if (!visitedPagesRef.current.has(bestPage)) {
          visitedPagesRef.current.add(bestPage);
          onRecordReadingSession?.(1, 0);
        }
        scheduleDebouncedProgressSave(bestPage);
      }
    });
  }, [book.format, onRecordReadingSession, pageLayoutMode, readingDirection, scheduleDebouncedProgressSave]);

  const stepPage = useCallback(
    (directionSign: 1 | -1) => {
      if (pageLayoutMode === 'double' && totalPages > 1) {
        const pairBase = currentPage % 2 === 1 ? currentPage : Math.max(1, currentPage - 1);
        const nextTarget = directionSign > 0 ? Math.min(totalPages, pairBase + 2) : Math.max(1, pairBase - 2);
        goToPage(nextTarget);
      } else {
        goToPage(currentPage + directionSign);
      }
    },
    [currentPage, goToPage, pageLayoutMode, totalPages],
  );

  const handleChangePageLayout = useCallback(
    (mode: PageLayoutMode) => {
      if (book.format !== 'epub') {
        if (mode === 'double') {
          setFitMode('page');
        } else if (mode === 'single') {
          setFitMode((prev) => (prev === 'manual' ? 'width' : prev));
        } else if (mode === 'horizontal') {
          setFitMode('page');
        }
      }

      onUpdatePreferences({
        ...preferences,
        pageLayoutMode: mode,
        epubViewMode:
          mode === 'double' ? 'spread' : mode === 'single' || mode === 'horizontal' ? 'paginated' : 'scroll',
        columnCount: mode === 'double' ? 2 : 1,
        updatedAtMs: Date.now(),
      });

      if (book.format !== 'epub' && (mode === 'vertical' || mode === 'horizontal') && currentPage > 1) {
        suppressAutoScrollRef.current = true;
        window.requestAnimationFrame(() => {
          const viewport = readerViewportRef.current;
          const pageEl = viewport?.querySelector(`[data-page-number="${currentPage}"]`) as HTMLElement | null;
          if (viewport && pageEl) {
            const vpRect = viewport.getBoundingClientRect();
            const pgRect = pageEl.getBoundingClientRect();
            viewport.scrollTo({
              top: mode === 'vertical' ? Math.max(0, viewport.scrollTop + (pgRect.top - vpRect.top) - 16) : 0,
              left: mode === 'horizontal' ? viewport.scrollLeft + (pgRect.left - vpRect.left) - 16 : 0,
              behavior: 'auto',
            });
          }
          window.setTimeout(() => {
            suppressAutoScrollRef.current = false;
          }, 120);
        });
      } else {
        suppressAutoScrollRef.current = false;
      }
    },
    [book.format, currentPage, onUpdatePreferences, preferences],
  );

  const handleToggleReadingDirection = useCallback(() => {
    const nextDir: ReadingDirection = readingDirection === 'ltr' ? 'rtl' : 'ltr';
    onUpdatePreferences({
      ...preferences,
      readingDirection: nextDir,
      updatedAtMs: Date.now(),
    });
  }, [onUpdatePreferences, preferences, readingDirection]);

  // Keyboard navigation + Spacebar Hand-Pan + PageUp/PageDown Evince ergonomics
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isEditingText =
        target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT');

      if (e.key === 'Escape') {
        if (distractionFree) setDistractionFree(false);
        if (composerOpen) setComposerOpen(false);
        if (focusedAnnotationId) setFocusedAnnotationId(null);
        setScanOpen(false);
        setActiveTool('select');
        setSpacePanHeld(false);
        return;
      }

      if (isEditingText) return;

      if (e.code === 'Space') {
        e.preventDefault();
        setSpacePanHeld(true);
        return;
      }

      const viewport = readerViewportRef.current;
      if (e.key === 'PageDown' && viewport && book.format !== 'epub' && (pageLayoutMode === 'vertical' || pageLayoutMode === 'horizontal')) {
        e.preventDefault();
        if (pageLayoutMode === 'horizontal') {
          const dir = readingDirection === 'rtl' ? -1 : 1;
          viewport.scrollBy({left: dir * Math.round(viewport.clientWidth * 0.8), behavior: 'smooth'});
        } else {
          viewport.scrollBy({top: Math.round(viewport.clientHeight * 0.85), behavior: 'smooth'});
        }
        return;
      }
      if (e.key === 'PageUp' && viewport && book.format !== 'epub' && (pageLayoutMode === 'vertical' || pageLayoutMode === 'horizontal')) {
        e.preventDefault();
        if (pageLayoutMode === 'horizontal') {
          const dir = readingDirection === 'rtl' ? 1 : -1;
          viewport.scrollBy({left: dir * Math.round(viewport.clientWidth * 0.8), behavior: 'smooth'});
        } else {
          viewport.scrollBy({top: -Math.round(viewport.clientHeight * 0.85), behavior: 'smooth'});
        }
        return;
      }

      const forwardKey = readingDirection === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
      const backKey = readingDirection === 'rtl' ? 'ArrowRight' : 'ArrowLeft';

      if (e.key === forwardKey) {
        e.preventDefault();
        if (book.format === 'epub' && epubViewMode !== 'scroll' && epubSubPage < epubSubPageCount - 1) {
          setEpubSubPage((p) => p + 1);
        } else if (currentPage < totalPages) {
          stepPage(1);
        }
      } else if (e.key === backKey) {
        e.preventDefault();
        if (book.format === 'epub' && epubViewMode !== 'scroll' && epubSubPage > 0) {
          setEpubSubPage((p) => p - 1);
        } else if (currentPage > 1) {
          stepPage(-1);
        }
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        setSpacePanHeld(false);
      }
    };

    const onBlur = () => setSpacePanHeld(false);

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [
    distractionFree,
    composerOpen,
    focusedAnnotationId,
    book.format,
    pageLayoutMode,
    epubViewMode,
    epubSubPage,
    epubSubPageCount,
    currentPage,
    totalPages,
    readingDirection,
    stepPage,
  ]);

  const currentPagePlainText = useMemo(() => {
    if (book.format === 'epub' && epubDoc) {
      return epubDoc.chapters[currentPage - 1]?.plainText || '';
    }
    const rendered = renderedPageTexts[currentPage];
    if (rendered) return rendered;
    const chunkText = textChunks.find((c) => c.page === currentPage)?.text;
    if (chunkText) return chunkText;
    return book.excerpt || '';
  }, [book.format, book.excerpt, epubDoc, currentPage, renderedPageTexts, textChunks]);

  const tocItems = useMemo<OutlineItem[]>(() => {
    if (book.format === 'epub' && epubDoc) {
      if (epubDoc.toc && epubDoc.toc.length > 0) return epubDoc.toc;
      return epubDoc.chapters.map((ch) => ({
        title: ch.title,
        page: ch.index,
        depth: 0,
        href: ch.href,
      }));
    }
    if (book.format === 'pdf' && pdfOutline.length > 0) {
      return pdfOutline;
    }
    if (book.format === 'djvu' && djvuOutline.length > 0) {
      return djvuOutline.map((item) => ({
        title: item.title,
        page: item.page,
        depth: item.depth || 0,
      }));
    }
    return Array.from({length: totalPages}, (_, idx) => ({
      title: `Page ${idx + 1}`,
      page: idx + 1,
      depth: 0,
    }));
  }, [book.format, djvuOutline, epubDoc, pdfOutline, totalPages]);

  const currentChapterTitle = useMemo(() => {
    if (book.format === 'epub' && epubDoc) {
      return epubDoc.chapters[currentPage - 1]?.title || `Chapter ${currentPage}`;
    }
    const matching = [...tocItems].reverse().find((o) => o.page <= currentPage);
    return matching?.title || `Page ${currentPage}`;
  }, [book.format, epubDoc, tocItems, currentPage]);

  const estimatedChapterMinutes = useMemo(() => {
    const words = currentPagePlainText.trim().split(/\s+/).filter(Boolean).length;
    return Math.max(1, Math.round(words / 225));
  }, [currentPagePlainText]);

  const parseTagList = (raw: string): string[] =>
    raw
      .split(/[\s,]+/)
      .map((t) => t.replace(/^#/, '').trim())
      .filter(Boolean)
      .slice(0, 10);

  const handleTextSelectionFromSheet = useCallback(
    (pageNum: number, quote: string, rects: AnnotationPosition[] | undefined) => {
      const selObj = window.getSelection();
      if (activeTool === 'highlight' || activeTool === 'underline') {
        onAddAnnotation({
          bookId: book.id,
          page: pageNum,
          chapterTitle: book.format === 'epub' ? currentChapterTitle : `Page ${pageNum}`,
          kind: activeTool,
          quote,
          note: '',
          color: selectedColor,
          tags: [],
          rects,
          position: rects?.[0],
        });
        selObj?.removeAllRanges();
        setSelectedText('');
        setSelectedRects(undefined);
        setPendingPage(null);
        return;
      }

      setPendingPage(pageNum);
      setSelectedText(quote);
      setSelectedRects(rects);
    },
    [activeTool, book.format, book.id, currentChapterTitle, onAddAnnotation, selectedColor],
  );

  const handlePinNoteFromSheet = useCallback((pageNum: number, pos: AnnotationPosition) => {
    setPendingPage(pageNum);
    setPendingKind('note');
    setPendingPosition(pos);
    setSelectedText(`Pinned note on Page ${pageNum} at (${Math.round(pos.x * 100)}%, ${Math.round(pos.y * 100)}%)`);
    setComposerOpen(true);
  }, []);

  const handleCreateSpatialFromSheet = useCallback(
    (
      pageNum: number,
      kind: Extract<AnnotationKind, 'area' | 'ink'>,
      quote: string,
      tags: string[],
      position: AnnotationPosition,
      inkStrokes?: string[],
    ) => {
      onAddAnnotation({
        bookId: book.id,
        page: pageNum,
        chapterTitle: book.format === 'epub' ? currentChapterTitle : `Page ${pageNum}`,
        kind,
        quote,
        note: '',
        color: selectedColor,
        tags,
        position,
        inkStrokes,
      });
    },
    [book.format, book.id, currentChapterTitle, onAddAnnotation, selectedColor],
  );

  const handleMouseUpSelection = () => {
    if (book.format !== 'epub') return;
    if (activeTool === 'note' || activeTool === 'area' || activeTool === 'ink') return;
    const selObj = window.getSelection();
    const sel = selObj?.toString().trim() || '';
    if (sel.length < 3) return;
    handleTextSelectionFromSheet(currentPage, sel.slice(0, 1800), undefined);
  };

  // Pointer-event normalized coordinate helper (0..1) for EPUB stage
  const getNormalizedPointerCoords = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = pageStageRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return {x: 0.5, y: 0.5};
    return {
      x: Math.max(0, Math.min(1, Number(((e.clientX - rect.left) / rect.width).toFixed(4)))),
      y: Math.max(0, Math.min(1, Number(((e.clientY - rect.top) / rect.height).toFixed(4)))),
    };
  };

  const handleStagePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (activeTool === 'note') {
      const pt = getNormalizedPointerCoords(e);
      setPendingPage(currentPage);
      setPendingKind('note');
      setPendingPosition({x: pt.x, y: pt.y, width: 0.04, height: 0.04});
      setSelectedText(`Pinned note at (${Math.round(pt.x * 100)}%, ${Math.round(pt.y * 100)}%)`);
      setComposerOpen(true);
      return;
    }
    if (activeTool === 'area') {
      e.currentTarget.setPointerCapture?.(e.pointerId);
      const pt = getNormalizedPointerCoords(e);
      setDragBoxStart(pt);
      setDragBoxCurrent(pt);
      return;
    }
    if (activeTool === 'ink') {
      e.currentTarget.setPointerCapture?.(e.pointerId);
      const pt = getNormalizedPointerCoords(e);
      setDrawingStroke([pt]);
    }
  };

  const handleStagePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (activeTool === 'area' && dragBoxStart) {
      setDragBoxCurrent(getNormalizedPointerCoords(e));
    } else if (activeTool === 'ink' && drawingStroke) {
      const pt = getNormalizedPointerCoords(e);
      setDrawingStroke((prev) => {
        if (!prev) return [pt];
        const last = prev[prev.length - 1];
        if (last && Math.hypot(pt.x - last.x, pt.y - last.y) < 0.004) return prev;
        return [...prev, pt];
      });
    }
  };

  const finishSpatialStroke = useCallback(() => {
    if (activeTool === 'area' && dragBoxStart && dragBoxCurrent) {
      const x = Math.min(dragBoxStart.x, dragBoxCurrent.x);
      const y = Math.min(dragBoxStart.y, dragBoxCurrent.y);
      const width = Math.abs(dragBoxCurrent.x - dragBoxStart.x);
      const height = Math.abs(dragBoxCurrent.y - dragBoxStart.y);
      setDragBoxStart(null);
      setDragBoxCurrent(null);

      if (width >= 0.02 && height >= 0.02) {
        onAddAnnotation({
          bookId: book.id,
          page: currentPage,
          chapterTitle: currentChapterTitle,
          kind: 'area',
          quote: `Captured region (${Math.round(width * 100)}% × ${Math.round(height * 100)}%) on Page ${currentPage}`,
          note: '',
          color: selectedColor,
          tags: ['figure'],
          position: {x, y, width, height},
        });
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
        onAddAnnotation({
          bookId: book.id,
          page: currentPage,
          chapterTitle: currentChapterTitle,
          kind: 'ink',
          quote: `Freehand ink annotation on Page ${currentPage}`,
          note: '',
          color: selectedColor,
          tags: ['ink'],
          position: {
            x: minX,
            y: minY,
            width: Math.max(0.02, Math.max(...xs) - minX),
            height: Math.max(0.02, Math.max(...ys) - minY),
          },
          inkStrokes: [d],
        });
      }
    }
  }, [activeTool, book.id, currentChapterTitle, currentPage, dragBoxCurrent, dragBoxStart, drawingStroke, onAddAnnotation, selectedColor]);

  const handleCreateAnnotation = (e: React.FormEvent) => {
    e.preventDefault();
    const targetPage = pendingPage || currentPage;
    const quote = (selectedText || renderedPageTexts[targetPage]?.slice(0, 220) || currentPagePlainText.slice(0, 220)).trim();
    if (!quote) return;
    onAddAnnotation({
      bookId: book.id,
      page: targetPage,
      chapterTitle: book.format === 'epub' ? currentChapterTitle : `Page ${targetPage}`,
      kind: pendingKind,
      quote,
      note: noteDraft.trim(),
      color: selectedColor,
      tags: parseTagList(tagsDraft),
      position: pendingPosition || selectedRects?.[0],
      rects: selectedRects,
    });
    setNoteDraft('');
    setTagsDraft('');
    setSelectedText('');
    setSelectedRects(undefined);
    setPendingPosition(undefined);
    setPendingPage(null);
    setPendingKind('highlight');
    setComposerOpen(false);
  };

  const handleCopyCitation = async (ann: Annotation) => {
    const text = formatZoteroCitation(book, ann);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API may be restricted in headless contexts
    }
    setCopiedId(ann.id);
    window.setTimeout(() => setCopiedId((prev) => (prev === ann.id ? null : prev)), 2000);
  };

  const handleExportMarkdownNotes = () => {
    const md = exportAnnotationsToMarkdown(book, bookAnnotations);
    const blob = new Blob([md], {type: 'text/markdown;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const slug = book.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 48);
    a.href = url;
    a.download = `${slug || 'docutrack'}-notes.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleRunTranslation = async (sourceOverride?: string) => {
    const fallbackText = selectedText || currentPagePlainText.slice(0, 800);
    const textToTranslate = ((sourceOverride ?? translationSource) || fallbackText).trim();

    if (textToTranslate) {
      setTranslationSource(textToTranslate);
    }
    setTranslating(true);
    setRightTab('translate');

    try {
      const outcome = await translateWithSystemOrWeb(textToTranslate, targetLang, book.language || 'en');
      setTranslationOutcome(outcome);
    } finally {
      setTranslating(false);
    }
  };

  const handleCopyTranslationSource = async (textToCopy: string) => {
    if (!textToCopy.trim()) return;
    try {
      await navigator.clipboard.writeText(textToCopy);
      setTranslateCopied(true);
      window.setTimeout(() => setTranslateCopied(false), 1800);
    } catch {
      // Clipboard blocked in restricted context
    }
  };

  const handleTriggerCourse = async (mode: 'course' | 'summary') => {
    if ((!isOnline || simulatedOffline) && !allowLocalOffline) {
      setCourseError('Cloud Gemini requires an active network connection. Switch to Ollama or LM Studio in Study Courses to run locally offline.');
      return;
    }
    const extracted =
      textChunks.map((c) => c.text).join('\n\n') ||
      epubDoc?.chapters.map((c) => `${c.title}\n${c.plainText}`).join('\n\n') ||
      currentPagePlainText;

    const fullText =
      extracted.trim().length >= 40
        ? extracted
        : [
            `Book Title: ${book.title}`,
            `Author: ${book.author}`,
            `Format: ${book.format.toUpperCase()} (${totalPages} pages)`,
            tocItems.length > 0
              ? `Outline: ${tocItems.slice(0, 25).map((o) => o.title).join('; ')}`
              : '',
            book.excerpt ? `Excerpt: ${book.excerpt}` : '',
            extracted.trim(),
          ]
            .filter(Boolean)
            .join('\n\n');

    setGeneratingCourse(true);
    setCourseError(null);
    setRightTab('course');
    try {
      await onGenerateCourse(book, mode, fullText);
    } catch (err) {
      setCourseError(err instanceof Error ? err.message : 'Course generation failed.');
    } finally {
      setGeneratingCourse(false);
    }
  };

  const theme = READER_THEMES[preferences.theme] || READER_THEMES.paper;
  const applyThemeToDocument = preferences.applyThemeToDocument !== false;
  const fontClass = getReaderFontClass(preferences.fontFamily);
  const progressPct = calculateProgress(currentPage, totalPages);
  const spatialToolActive = activeTool === 'note' || activeTool === 'area' || activeTool === 'ink';
  const scanActive = isScanEnhancementActive(scanSettings);

  const renderSpatialOverlays = () => {
    const inkAnns = pageAnnotations.filter((a) => a.kind === 'ink' && a.inkStrokes && a.inkStrokes.length > 0);
    const rectHighlightAnns =
      book.format === 'epub'
        ? []
        : pageAnnotations.filter(
            (a) =>
              (a.kind === 'highlight' || a.kind === 'underline' || !a.kind) &&
              ((a.rects && a.rects.length > 0) || a.position),
          );

    const liveStrokePath =
      drawingStroke && drawingStroke.length >= 2
        ? drawingStroke
            .map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x.toFixed(4)} ${p.y.toFixed(4)}`)
            .join(' ')
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
        onPointerDown={handleStagePointerDown}
        onPointerMove={handleStagePointerMove}
        onPointerUp={finishSpatialStroke}
        className={`absolute inset-0 z-20 ${
          spatialToolActive
            ? activeTool === 'ink'
              ? 'cursor-cell pointer-events-auto touch-none'
              : 'cursor-crosshair pointer-events-auto touch-none'
            : 'pointer-events-none'
        }`}
      >
        {/* Saved In-Page PDF/DjVu Highlights & Underlines */}
        {rectHighlightAnns.map((ann) => {
          const kind = ann.kind || 'highlight';
          const c = HIGHLIGHT_COLORS[ann.color] || HIGHLIGHT_COLORS.amber;
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
                setFocusedAnnotationId(ann.id);
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
                kind === 'highlight' && !theme.isDark ? 'mix-blend-multiply' : ''
              } ${isFocused ? 'ring-2 ring-blue-700' : ''}`}
            />
          ));
        })}

        {/* Saved Ink Strokes & Live Drawing SVG */}
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
                  stroke={HIGHLIGHT_COLORS[ann.color].hex}
                  strokeWidth={focusedAnnotationId === ann.id ? 4 : 2.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                  opacity={0.88}
                  style={{pointerEvents: 'stroke', cursor: 'pointer'}}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    setFocusedAnnotationId(ann.id);
                  }}
                />
              )),
            )}
            {liveStrokePath && (
              <path
                d={liveStrokePath}
                fill="none"
                stroke={HIGHLIGHT_COLORS[selectedColor].hex}
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>
        )}

        {/* Saved Area Capture Boxes */}
        {pageAnnotations
          .filter((a) => a.kind === 'area' && a.position)
          .map((ann) => {
            const pos = ann.position!;
            const c = HIGHLIGHT_COLORS[ann.color];
            const isFocused = focusedAnnotationId === ann.id;
            return (
              <button
                key={ann.id}
                type="button"
                title={ann.note || ann.quote}
                onClick={(ev) => {
                  ev.stopPropagation();
                  setFocusedAnnotationId(ann.id);
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

        {/* Saved Sticky Note Pins */}
        {pageAnnotations
          .filter((a) => a.kind === 'note' && a.position)
          .map((ann) => {
            const pos = ann.position!;
            const c = HIGHLIGHT_COLORS[ann.color];
            const isFocused = focusedAnnotationId === ann.id;
            return (
              <button
                key={ann.id}
                type="button"
                aria-label={`Sticky note on page ${ann.page}`}
                title={ann.note || ann.quote}
                onClick={(ev) => {
                  ev.stopPropagation();
                  setFocusedAnnotationId(ann.id);
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

        {/* Live Area Drag Preview */}
        {liveBox && (
          <div
            style={{
              left: `${liveBox.x * 100}%`,
              top: `${liveBox.y * 100}%`,
              width: `${liveBox.width * 100}%`,
              height: `${liveBox.height * 100}%`,
              borderColor: HIGHLIGHT_COLORS[selectedColor].hex,
              backgroundColor: `${HIGHLIGHT_COLORS[selectedColor].hex}22`,
            }}
            className="absolute border-2 border-dashed rounded-sm pointer-events-none"
          />
        )}
      </div>
    );
  };

  return (
    <div
      data-testid={scanActive ? 'scan-enhance-active' : undefined}
      className={`h-screen overflow-hidden flex flex-col ${theme.bg} ${theme.text} transition-colors duration-200`}
    >
      {/* Distraction-Free Floating Exit Control */}
      {distractionFree && (
        <div className="fixed top-4 right-5 z-40 flex items-center gap-2">
          <span className="px-3 py-1.5 rounded-lg border border-black/10 dark:border-white/15 bg-black/5 dark:bg-white/10 backdrop-blur text-xs tabular-nums">
            {currentPage} / {totalPages}
          </span>
          <button
            type="button"
            onClick={() => setDistractionFree(false)}
            className="px-3 py-1.5 rounded-lg bg-slate-900/85 text-white text-xs font-medium hover:bg-slate-900 flex items-center gap-1.5 backdrop-blur"
          >
            <Minimize2 className="w-3.5 h-3.5" aria-hidden="true" />
            Exit Focus (Esc)
          </button>
        </div>
      )}

      {/* Reader Top Bar */}
      {!distractionFree && (
        <header
          className={`h-14 px-4 border-b ${theme.border} ${theme.surface} flex items-center justify-between gap-4 shrink-0`}
        >
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => {
                if (progressFlushTimerRef.current) {
                  window.clearTimeout(progressFlushTimerRef.current);
                  progressFlushTimerRef.current = null;
                }
                if (latestPageToFlushRef.current !== null) {
                  onUpdateProgress(book.id, latestPageToFlushRef.current, totalPages);
                  latestPageToFlushRef.current = null;
                }
                onBack();
              }}
              className="px-2.5 py-1.5 rounded-lg text-xs font-medium hover:bg-black/5 dark:hover:bg-white/10 flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <ArrowLeft className="w-4 h-4" aria-hidden="true" />
              Library
            </button>
            <span className={`text-sm font-semibold truncate ${theme.text}`}>{book.title}</span>
            <span className={`hidden md:inline text-xs font-mono uppercase ${theme.muted} shrink-0`}>
              {book.format}
            </span>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => setLeftTab(leftTab === 'toc' ? null : 'toc')}
              aria-pressed={leftTab === 'toc'}
              aria-label="Toggle table of contents"
              className={`px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 whitespace-nowrap ${
                leftTab === 'toc' ? 'accent-btn' : 'hover:bg-black/5 dark:hover:bg-white/10'
              }`}
            >
              <ListTree className="w-3.5 h-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">Contents</span>
            </button>

            <button
              type="button"
              onClick={() => setLeftTab(leftTab === 'annotations' ? null : 'annotations')}
              aria-pressed={leftTab === 'annotations'}
              aria-label="Toggle annotations panel"
              className={`px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 whitespace-nowrap ${
                leftTab === 'annotations' ? 'accent-btn' : 'hover:bg-black/5 dark:hover:bg-white/10'
              }`}
            >
              <Highlighter className="w-3.5 h-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">Notes ({bookAnnotations.length})</span>
            </button>

            {book.format !== 'epub' && (
              <button
                type="button"
                onClick={() => setScanOpen((prev) => !prev)}
                aria-pressed={scanOpen || scanActive}
                aria-label="Scanned page enhancement"
                className={`px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 whitespace-nowrap ${
                  scanOpen || scanActive ? 'accent-btn' : 'hover:bg-black/5 dark:hover:bg-white/10'
                }`}
              >
                <ScanLine className="w-3.5 h-3.5" aria-hidden="true" />
                <span className="hidden md:inline">Scan Enhance</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => setRightTab(rightTab === 'translate' ? null : 'translate')}
              aria-pressed={rightTab === 'translate'}
              aria-label="Toggle inline translation"
              className={`px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 whitespace-nowrap ${
                rightTab === 'translate' ? 'accent-btn' : 'hover:bg-black/5 dark:hover:bg-white/10'
              }`}
            >
              <Languages className="w-3.5 h-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">Translate</span>
            </button>

            <button
              type="button"
              onClick={() => setRightTab(rightTab === 'course' ? null : 'course')}
              aria-pressed={rightTab === 'course'}
              aria-label="Toggle AI lecture course"
              className={`px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 whitespace-nowrap ${
                rightTab === 'course' ? 'accent-btn' : 'hover:bg-black/5 dark:hover:bg-white/10'
              }`}
            >
              <GraduationCap className="w-3.5 h-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">AI Course</span>
            </button>

            <button
              type="button"
              onClick={() => setRightTab(rightTab === 'typography' ? null : 'typography')}
              aria-pressed={rightTab === 'typography'}
              aria-label="Toggle typography and theme settings"
              className={`px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 whitespace-nowrap ${
                rightTab === 'typography' ? 'accent-btn' : 'hover:bg-black/5 dark:hover:bg-white/10'
              }`}
            >
              <SlidersHorizontal className="w-3.5 h-3.5" aria-hidden="true" />
              <span className="hidden md:inline">Appearance</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setDistractionFree(true);
                setLeftTab(null);
                setRightTab(null);
                setScanOpen(false);
              }}
              aria-label="Enter distraction-free focus mode"
              className="px-2.5 py-1.5 rounded-lg text-xs font-medium hover:bg-black/5 dark:hover:bg-white/10 flex items-center gap-1.5 whitespace-nowrap"
            >
              <Maximize2 className="w-3.5 h-3.5" aria-hidden="true" />
              <span className="hidden lg:inline">Focus</span>
            </button>
          </div>
        </header>
      )}

      {/* Zotero-Style Annotation Toolbar + Format-Specific Quick Strip */}
      {!distractionFree && (
        <div
          role="toolbar"
          aria-label="Zotero annotation tools"
          className={`px-3 py-1.5 border-b ${theme.border} ${theme.surface} flex flex-wrap items-center justify-between gap-2 shrink-0`}
        >
          <div className="flex items-center gap-0.5 flex-wrap">
            {(
              [
                {id: 'select', label: 'Select', icon: <MousePointer className="w-3.5 h-3.5" />},
                {id: 'pan', label: 'Hand Pan', icon: <Hand className="w-3.5 h-3.5" />},
                {id: 'highlight', label: 'Highlight', icon: <Highlighter className="w-3.5 h-3.5" />},
                {id: 'underline', label: 'Underline', icon: <Underline className="w-3.5 h-3.5" />},
                {id: 'note', label: 'Add Note', icon: <StickyNote className="w-3.5 h-3.5" />},
                {id: 'area', label: 'Select Area', icon: <SquareDashedMousePointer className="w-3.5 h-3.5" />},
                {id: 'ink', label: 'Draw Ink', icon: <PenTool className="w-3.5 h-3.5" />},
              ] as const
            ).map((tool) => {
              const active = activeTool === tool.id;
              return (
                <button
                  key={tool.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setActiveTool(tool.id)}
                  className={`px-2 py-1 rounded-md text-xs font-medium flex items-center gap-1 whitespace-nowrap transition-colors ${
                    active ? 'accent-btn' : 'hover:bg-black/5 dark:hover:bg-white/10 opacity-85 hover:opacity-100'
                  }`}
                >
                  {tool.icon}
                  <span>{tool.label}</span>
                </button>
              );
            })}

            <span className={`mx-1.5 h-4 w-px border-l ${theme.border}`} aria-hidden="true" />

            <div className="flex items-center gap-1" aria-label="Annotation color">
              {COLOR_ORDER.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Color ${HIGHLIGHT_COLORS[c].label}`}
                  aria-pressed={selectedColor === c}
                  onClick={() => setSelectedColor(c)}
                  className={`w-4 h-4 rounded-full ${HIGHLIGHT_COLORS[c].swatch} transition-transform ${
                    selectedColor === c ? 'ring-2 ring-offset-1 ring-current scale-110' : 'opacity-75 hover:opacity-100'
                  }`}
                />
              ))}
            </div>
          </div>

          {/* Always-Visible Zoom + Paper & Book Scroll / Page Layout Modes */}
          <div className="flex items-center gap-1.5 flex-wrap shrink-0">
            {book.format !== 'epub' && (
              <div
                dir="ltr"
                aria-label="Zoom controls"
                className="flex items-center gap-0.5 rounded-lg border border-black/10 dark:border-white/15 px-1 py-0.5 shrink-0"
              >
                <button
                  type="button"
                  onClick={() => {
                    setFitMode('manual');
                    setZoomScale((z) => Math.max(0.45, Number((z - 0.15).toFixed(2))));
                  }}
                  aria-label="Zoom out"
                  className="p-1 rounded hover:bg-black/5 dark:hover:bg-white/10"
                >
                  <ZoomOut className="w-3.5 h-3.5" />
                </button>
                <span
                  data-testid="reader-zoom-percent"
                  className="text-[11px] font-mono tabular-nums min-w-[38px] text-center"
                >
                  {Math.round(zoomScale * 100)}%
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setFitMode('manual');
                    setZoomScale((z) => Math.min(2.6, Number((z + 0.15).toFixed(2))));
                  }}
                  aria-label="Zoom in"
                  className="p-1 rounded hover:bg-black/5 dark:hover:bg-white/10"
                >
                  <ZoomIn className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  aria-pressed={fitMode === 'width'}
                  onClick={() => setFitMode('width')}
                  className={`px-1.5 py-0.5 rounded text-[11px] font-medium whitespace-nowrap ${
                    fitMode === 'width' ? 'accent-btn' : 'hover:bg-black/5 dark:hover:bg-white/10 opacity-85'
                  }`}
                >
                  Fit Width
                </button>
                <button
                  type="button"
                  aria-pressed={fitMode === 'page'}
                  onClick={() => setFitMode('page')}
                  className={`px-1.5 py-0.5 rounded text-[11px] font-medium whitespace-nowrap ${
                    fitMode === 'page' ? 'accent-btn' : 'hover:bg-black/5 dark:hover:bg-white/10 opacity-85'
                  }`}
                >
                  Fit Page
                </button>
              </div>
            )}

            <div className="flex items-center gap-1 shrink-0" aria-label="Paper reading layout">
              <div className="flex items-center gap-0.5 rounded-lg border border-black/10 dark:border-white/15 p-0.5">
                {(
                  [
                    {id: 'single', label: 'Single', icon: <FileText className="w-3 h-3" />},
                    {id: 'vertical', label: 'Vertical', icon: <MoveVertical className="w-3 h-3" />},
                    {id: 'horizontal', label: 'Horizontal', icon: <MoveHorizontal className="w-3 h-3" />},
                    {id: 'double', label: 'Double Page', icon: <Columns2 className="w-3 h-3" />},
                  ] as const
                ).map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    aria-pressed={pageLayoutMode === m.id}
                    onClick={() => handleChangePageLayout(m.id)}
                    className={`px-1.5 py-1 rounded text-[11px] font-medium flex items-center gap-1 whitespace-nowrap transition-colors ${
                      pageLayoutMode === m.id
                        ? 'accent-btn'
                        : 'hover:bg-black/5 dark:hover:bg-white/10 opacity-80'
                    }`}
                  >
                    {m.icon}
                    <span>{m.label}</span>
                  </button>
                ))}
              </div>

              <button
                type="button"
                onClick={handleToggleReadingDirection}
                aria-label={`Reading direction: ${readingDirection === 'ltr' ? 'Left to Right' : 'Right to Left'}`}
                title="Toggle reading direction (L → R or R → L)"
                className={`px-1.5 py-1 rounded-lg border text-[11px] font-mono font-medium flex items-center gap-1 whitespace-nowrap transition-colors ${
                  readingDirection === 'rtl' ? 'accent-btn border-transparent' : `${theme.border} hover:bg-black/5 dark:hover:bg-white/10`
                }`}
              >
                <ArrowRightLeft className="w-3 h-3" aria-hidden="true" />
                <span>{readingDirection === 'ltr' ? 'L→R' : 'R→L'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Scanned PDF & DjVu Enhancement Bar */}
      {!distractionFree && scanOpen && book.format !== 'epub' && (
        <div
          aria-label="Scan enhancement controls"
          className={`px-4 py-3 border-b ${theme.border} ${theme.surface} flex flex-wrap items-center justify-between gap-4 shrink-0`}
        >
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs font-semibold mr-1">Scan Optimization:</span>
            {(
              [
                {id: 'original', label: 'Original'},
                {id: 'clean-scan', label: 'Clean Scan B&W'},
                {id: 'high-contrast', label: 'High Contrast Ink'},
                {id: 'bleed-reduce', label: 'Bleed-Through Clean'},
              ] as {id: ScanPreset; label: string}[]
            ).map((preset) => (
              <button
                key={preset.id}
                type="button"
                aria-pressed={scanSettings.preset === preset.id}
                onClick={() => setScanSettings(getScanPresetSettings(preset.id))}
                className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${
                  scanSettings.preset === preset.id
                    ? 'accent-btn border-transparent'
                    : `${theme.border} hover:bg-black/5 dark:hover:bg-white/10`
                }`}
              >
                {preset.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-4 flex-wrap text-xs">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={scanSettings.cleanBackground}
                onChange={(e) =>
                  setScanSettings((s) => ({...s, cleanBackground: e.target.checked}))
                }
              />
              <span>Whiten Paper</span>
            </label>

            <label className="flex items-center gap-2">
              <span>Contrast {Math.round(scanSettings.contrast * 100)}%</span>
              <input
                type="range"
                min={0.7}
                max={2.4}
                step={0.05}
                value={scanSettings.contrast}
                onChange={(e) =>
                  setScanSettings((s) => ({...s, contrast: Number(e.target.value)}))
                }
                className="w-20"
              />
            </label>

            <label className="flex items-center gap-2">
              <span>Crispness {Math.round(scanSettings.sharpness * 100)}%</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={scanSettings.sharpness}
                onChange={(e) =>
                  setScanSettings((s) => ({...s, sharpness: Number(e.target.value)}))
                }
                className="w-20"
              />
            </label>

            <label className="flex items-center gap-2">
              <span>Bright {scanSettings.brightness > 0 ? `+${scanSettings.brightness}` : scanSettings.brightness}</span>
              <input
                type="range"
                min={-40}
                max={45}
                step={5}
                value={scanSettings.brightness}
                onChange={(e) =>
                  setScanSettings((s) => ({...s, brightness: Number(e.target.value)}))
                }
                className="w-20"
              />
            </label>
          </div>
        </div>
      )}

      {/* Main Split Reading Area */}
      <div className="flex-1 min-h-0 flex overflow-hidden relative">
        {/* Left Drawer: TOC or Zotero Annotations Inspector */}
        {!distractionFree && leftTab && (
          <aside
            aria-label={leftTab === 'toc' ? 'Table of contents' : 'Annotations'}
            className={`w-80 shrink-0 border-r ${theme.border} ${theme.surface} flex flex-col overflow-hidden`}
          >
            <div className={`px-4 py-3 border-b ${theme.border} flex items-center justify-between gap-2`}>
              <h2 className="text-xs font-semibold tracking-wide uppercase">
                {leftTab === 'toc' ? 'Table of Contents' : `Zotero Inspector (${bookAnnotations.length})`}
              </h2>
              <div className="flex items-center gap-1">
                {leftTab === 'annotations' && bookAnnotations.length > 0 && (
                  <button
                    type="button"
                    onClick={handleExportMarkdownNotes}
                    title="Export annotations as Markdown"
                    aria-label="Export annotations as Markdown"
                    className="p-1 opacity-70 hover:opacity-100"
                  >
                    <Download className="w-3.5 h-3.5" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setLeftTab(null)}
                  aria-label="Close left panel"
                  className="p-1 opacity-60 hover:opacity-100"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {leftTab === 'toc' ? (
              <div className="flex-1 overflow-y-auto p-3 space-y-0.5" data-testid="reader-toc-tree">
                {(() => {
                  const rendered: React.ReactNode[] = [];
                  let hiddenBelowDepth: number | null = null;
                  let fallbackActiveIdx = -1;
                  for (let i = 0; i < tocItems.length; i++) {
                    if (tocItems[i].page <= currentPage) {
                      fallbackActiveIdx = i;
                    }
                  }
                  const activeClickedValid =
                    activeTocKey !== null &&
                    tocItems.some(
                      (it, i) => `${it.title}-${it.page}-${i}` === activeTocKey && it.page === currentPage,
                    );

                  for (let idx = 0; idx < tocItems.length; idx++) {
                    const item = tocItems[idx];
                    const itemKey = `${item.title}-${item.page}-${idx}`;
                    const depth = Math.max(0, item.depth || 0);
                    if (hiddenBelowDepth !== null) {
                      if (depth > hiddenBelowDepth) {
                        continue;
                      }
                      hiddenBelowDepth = null;
                    }
                    const nextDepth = tocItems[idx + 1]?.depth || 0;
                    const hasChildren = nextDepth > depth;
                    const isCollapsed = collapsedTocKeys.has(idx);
                    if (hasChildren && isCollapsed) {
                      hiddenBelowDepth = depth;
                    }
                    const isActive = activeClickedValid ? activeTocKey === itemKey : idx === fallbackActiveIdx;

                    rendered.push(
                      <div
                        key={itemKey}
                        style={{paddingLeft: `${6 + Math.min(depth, 5) * 14}px`}}
                        className="flex items-center gap-1"
                      >
                        {hasChildren ? (
                          <button
                            type="button"
                            onClick={() =>
                              setCollapsedTocKeys((prev) => {
                                const next = new Set(prev);
                                if (next.has(idx)) next.delete(idx);
                                else next.add(idx);
                                return next;
                              })
                            }
                            aria-label={isCollapsed ? `Expand ${item.title}` : `Collapse ${item.title}`}
                            className="p-1 rounded hover:bg-black/5 dark:hover:bg-white/10 opacity-70 shrink-0"
                          >
                            {isCollapsed ? (
                              <ChevronRight className="w-3 h-3" />
                            ) : (
                              <ChevronDown className="w-3 h-3" />
                            )}
                          </button>
                        ) : (
                          <span className="w-5 shrink-0 text-center opacity-35 text-[10px]">
                            {depth > 0 ? '·' : ''}
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            setActiveTocKey(itemKey);
                            goToPage(item.page, false, item.fragmentId);
                          }}
                          className={`flex-1 min-w-0 text-left px-2 py-1.5 rounded-lg text-xs transition-colors flex items-center justify-between gap-2 ${
                            isActive
                              ? 'accent-btn font-medium'
                              : depth > 0
                                ? 'hover:bg-black/5 dark:hover:bg-white/10 opacity-85'
                                : 'hover:bg-black/5 dark:hover:bg-white/10 font-medium'
                          }`}
                        >
                          <span className="truncate">{item.title}</span>
                          <span className="tabular-nums opacity-70 shrink-0">p.{item.page}</span>
                        </button>
                      </div>,
                    );
                  }
                  return rendered;
                })()}
              </div>
            ) : (
              <div className="flex-1 flex flex-col min-h-0">
                <div className={`p-3 border-b ${theme.border} space-y-2.5 shrink-0`}>
                  <button
                    type="button"
                    onClick={() => {
                      setPendingKind('highlight');
                      setPendingPosition(undefined);
                      setComposerOpen(true);
                    }}
                    className="w-full py-2 px-3 rounded-lg accent-btn text-xs font-medium flex items-center justify-center gap-1.5"
                  >
                    <MessageSquarePlus className="w-3.5 h-3.5" aria-hidden="true" />
                    Annotate Current Passage
                  </button>

                  <input
                    type="search"
                    value={annSearch}
                    onChange={(e) => setAnnSearch(e.target.value)}
                    placeholder="Filter notes, quotes, or #tags..."
                    aria-label="Filter annotations"
                    className={`w-full px-2.5 py-1.5 rounded-lg border ${theme.border} bg-transparent text-xs`}
                  />

                  <div className="flex items-center justify-between gap-2">
                    <select
                      aria-label="Filter by annotation kind"
                      value={annKindFilter}
                      onChange={(e) => setAnnKindFilter(e.target.value as AnnotationKind | 'all')}
                      className={`px-2 py-1 rounded border ${theme.border} bg-transparent text-[11px] flex-1`}
                    >
                      <option value="all" className="text-slate-900">All Types</option>
                      <option value="highlight" className="text-slate-900">Highlights</option>
                      <option value="underline" className="text-slate-900">Underlines</option>
                      <option value="note" className="text-slate-900">Sticky Notes</option>
                      <option value="area" className="text-slate-900">Area Captures</option>
                      <option value="ink" className="text-slate-900">Ink Drawings</option>
                    </select>

                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setAnnColorFilter('all')}
                        className={`px-1.5 py-0.5 rounded text-[10px] border ${
                          annColorFilter === 'all' ? 'accent-border font-semibold' : theme.border
                        }`}
                      >
                        All
                      </button>
                      {COLOR_ORDER.map((c) => (
                        <button
                          key={c}
                          type="button"
                          aria-label={`Filter ${HIGHLIGHT_COLORS[c].label}`}
                          onClick={() => setAnnColorFilter(annColorFilter === c ? 'all' : c)}
                          className={`w-3.5 h-3.5 rounded-full ${HIGHLIGHT_COLORS[c].swatch} ${
                            annColorFilter === c ? 'ring-2 ring-offset-1 ring-current' : 'opacity-65'
                          }`}
                        />
                      ))}
                    </div>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto p-3 space-y-3">
                  {filteredInspectorAnnotations.length === 0 ? (
                    <p className={`text-xs ${theme.muted} py-4 text-center`}>
                      No matching annotations yet. Highlight, underline, pin a note, capture an area, or draw ink directly on any page.
                    </p>
                  ) : (
                    filteredInspectorAnnotations.map((ann) => {
                      const kind: AnnotationKind = ann.kind || 'highlight';
                      const c = HIGHLIGHT_COLORS[ann.color] || HIGHLIGHT_COLORS.amber;
                      const isFocused = focusedAnnotationId === ann.id;
                      return (
                        <div
                          key={ann.id}
                          className={`rounded-lg border p-3 space-y-2 transition-colors ${
                            isFocused ? 'accent-border ring-1 ring-current' : theme.border
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setFocusedAnnotationId(ann.id);
                                goToPage(ann.page);
                              }}
                              className="text-xs font-medium accent-text hover:underline tabular-nums flex items-center gap-1.5"
                            >
                              <span className={`w-2.5 h-2.5 rounded-xs ${c.swatch}`} />
                              <span>p.{ann.page}</span>
                              <span className={`text-[11px] font-normal ${theme.muted}`}>· {KIND_LABELS[kind]}</span>
                            </button>
                            <div className="flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => void handleCopyCitation(ann)}
                                title="Copy Zotero citation"
                                aria-label="Copy citation"
                                className="p-1 opacity-60 hover:opacity-100"
                              >
                                {copiedId === ann.id ? (
                                  <Check className="w-3.5 h-3.5 text-emerald-600" />
                                ) : (
                                  <Copy className="w-3.5 h-3.5" />
                                )}
                              </button>
                              <button
                                type="button"
                                onClick={() => onDeleteAnnotation(ann.id)}
                                aria-label={`Delete annotation on page ${ann.page}`}
                                className="p-1 opacity-60 hover:opacity-100 hover:text-red-500"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>

                          <blockquote
                            style={
                              kind === 'underline' ? {borderBottom: `2px solid ${c.hex}`} : undefined
                            }
                            className={`text-xs italic leading-relaxed px-2 py-1.5 rounded ${
                              kind === 'underline' ? '' : c.bg
                            }`}
                          >
                            "{ann.quote}"
                          </blockquote>

                          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                            {(ann.tags || []).map((tag) => (
                              <span
                                key={tag}
                                className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border ${theme.border} ${theme.muted}`}
                              >
                                #{tag}
                                <button
                                  type="button"
                                  aria-label={`Remove tag ${tag}`}
                                  onClick={() =>
                                    onUpdateAnnotation(ann.id, {
                                      tags: (ann.tags || []).filter((t) => t !== tag),
                                    })
                                  }
                                  className="hover:text-red-500"
                                >
                                  ×
                                </button>
                              </span>
                            ))}
                            {newTagInputId === ann.id ? (
                              <form
                                onSubmit={(e) => {
                                  e.preventDefault();
                                  const cleaned = newTagText.replace(/^#/, '').trim();
                                  if (cleaned) {
                                    const nextTags = Array.from(new Set([...(ann.tags || []), cleaned])).slice(0, 10);
                                    onUpdateAnnotation(ann.id, {tags: nextTags});
                                  }
                                  setNewTagText('');
                                  setNewTagInputId(null);
                                }}
                                className="inline-flex items-center gap-1"
                              >
                                <input
                                  type="text"
                                  value={newTagText}
                                  onChange={(e) => setNewTagText(e.target.value)}
                                  placeholder="tag..."
                                  autoFocus
                                  className={`w-20 px-1.5 py-0.5 rounded border ${theme.border} bg-transparent text-[11px]`}
                                />
                                <button type="submit" className="accent-text font-medium">Add</button>
                              </form>
                            ) : (
                              <button
                                type="button"
                                onClick={() => {
                                  setNewTagInputId(ann.id);
                                  setNewTagText('');
                                }}
                                className={`inline-flex items-center gap-0.5 text-[11px] ${theme.muted} hover:underline`}
                              >
                                <Tag className="w-3 h-3" aria-hidden="true" />
                                +tag
                              </button>
                            )}
                          </div>

                          {editingNoteId === ann.id ? (
                            <div className="space-y-2">
                              <textarea
                                value={editingNoteText}
                                onChange={(e) => setEditingNoteText(e.target.value)}
                                rows={2}
                                className="w-full text-xs p-2 rounded border border-slate-300 dark:border-slate-700 bg-transparent"
                              />
                              <div className="flex gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => {
                                    onUpdateAnnotation(ann.id, {note: editingNoteText});
                                    setEditingNoteId(null);
                                  }}
                                  className="px-2.5 py-1 rounded accent-btn text-xs"
                                >
                                  Save
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setEditingNoteId(null)}
                                  className="px-2.5 py-1 rounded text-xs opacity-70"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="flex items-start justify-between gap-2">
                              <p className={`text-xs ${ann.note ? theme.text : theme.muted}`}>
                                {ann.note || 'No margin note'}
                              </p>
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingNoteId(ann.id);
                                  setEditingNoteText(ann.note);
                                }}
                                className="text-[11px] accent-text hover:underline shrink-0"
                              >
                                Edit
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </aside>
        )}

        {/* Center Reading Canvas */}
        <main
          ref={readerViewportRef}
          onScroll={handleViewportScroll}
          dir={book.format !== 'epub' && pageLayoutMode === 'horizontal' ? readingDirection : undefined}
          data-layout-mode={pageLayoutMode}
          data-reading-dir={readingDirection}
          onMouseUp={handleMouseUpSelection}
          onPointerDown={(e) => {
            const el = readerViewportRef.current;
            if (!el) return;
            if (activeTool === 'pan' || spacePanHeld || e.button === 1) {
              if (e.button === 1) e.preventDefault();
              panStateRef.current = {
                active: true,
                startX: e.clientX,
                startY: e.clientY,
                scrollLeft: el.scrollLeft,
                scrollTop: el.scrollTop,
              };
              setIsDraggingPan(true);
            }
          }}
          onPointerMove={(e) => {
            const el = readerViewportRef.current;
            if (!el || !panStateRef.current.active) return;
            const dx = e.clientX - panStateRef.current.startX;
            const dy = e.clientY - panStateRef.current.startY;
            el.scrollLeft = panStateRef.current.scrollLeft - dx;
            el.scrollTop = panStateRef.current.scrollTop - dy;
          }}
          onPointerUp={() => {
            if (panStateRef.current.active) {
              panStateRef.current.active = false;
              setIsDraggingPan(false);
            }
          }}
          onPointerCancel={() => {
            panStateRef.current.active = false;
            setIsDraggingPan(false);
          }}
          onWheel={(e) => {
            if (e.ctrlKey || e.metaKey) return;
            if (book.format !== 'epub' && pageLayoutMode === 'horizontal' && readerViewportRef.current) {
              const el = readerViewportRef.current;
              if (el.scrollWidth > el.clientWidth && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
                e.preventDefault();
                const unitPx = e.deltaMode === 1 ? 36 : e.deltaMode === 2 ? el.clientHeight : 1;
                const delta = e.deltaY * unitPx;
                el.scrollLeft += readingDirection === 'rtl' ? -delta : delta;
              }
            }
          }}
          onClick={(ev) => {
            // Inspect any inline EPUB highlight or underline <mark data-ann-id="...">
            const target = ev.target as HTMLElement | null;
            const mark = target?.closest('mark[data-ann-id]') as HTMLElement | null;
            if (mark?.dataset.annId) {
              ev.stopPropagation();
              setFocusedAnnotationId(mark.dataset.annId);
            } else if (focusedAnnotationId && !target?.closest('[data-testid="inline-annotation-popover"]')) {
              setFocusedAnnotationId(null);
            }
          }}
          className={`flex-1 min-w-0 overflow-x-auto overflow-y-auto scroll-smooth-reader px-4 sm:px-8 py-6 flex flex-col relative ${
            spatialToolActive ? 'select-none' : ''
          } ${
            activeTool === 'pan' || spacePanHeld
              ? isDraggingPan
                ? 'cursor-grabbing select-none'
                : 'cursor-grab select-none'
              : ''
          }`}
        >
          {/* Quick Floating Selection Action Bar (when using Select cursor) */}
          {selectedText && !composerOpen && (
            <div className="sticky top-2 z-30 mb-4 px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-lg flex items-center gap-2 flex-wrap">
              <span className="text-xs opacity-65 max-w-[180px] truncate">"{selectedText}"</span>
              {COLOR_ORDER.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Highlight in ${HIGHLIGHT_COLORS[c].label}`}
                  onClick={() => {
                    const targetPage = pendingPage || currentPage;
                    onAddAnnotation({
                      bookId: book.id,
                      page: targetPage,
                      chapterTitle: book.format === 'epub' ? currentChapterTitle : `Page ${targetPage}`,
                      kind: 'highlight',
                      quote: selectedText,
                      note: '',
                      color: c,
                      tags: [],
                      rects: selectedRects,
                      position: selectedRects?.[0],
                    });
                    setSelectedText('');
                    setSelectedRects(undefined);
                    setPendingPage(null);
                  }}
                  className={`w-5 h-5 rounded-full ${HIGHLIGHT_COLORS[c].swatch} hover:scale-110 transition-transform`}
                />
              ))}
              <button
                type="button"
                onClick={() => {
                  const targetPage = pendingPage || currentPage;
                  onAddAnnotation({
                    bookId: book.id,
                    page: targetPage,
                    chapterTitle: book.format === 'epub' ? currentChapterTitle : `Page ${targetPage}`,
                    kind: 'underline',
                    quote: selectedText,
                    note: '',
                    color: selectedColor,
                    tags: [],
                    rects: selectedRects,
                    position: selectedRects?.[0],
                  });
                  setSelectedText('');
                  setSelectedRects(undefined);
                  setPendingPage(null);
                }}
                className="px-2.5 py-1 rounded-md text-xs font-medium bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 flex items-center gap-1"
              >
                <Underline className="w-3 h-3" aria-hidden="true" />
                Underline
              </button>
              <button
                type="button"
                onClick={() => {
                  setPendingKind('highlight');
                  setComposerOpen(true);
                }}
                className="px-2.5 py-1 rounded-md text-xs font-medium bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700"
              >
                Add Note
              </button>
              <button
                type="button"
                onClick={() => void handleRunTranslation(selectedText)}
                className="px-2.5 py-1 rounded-md text-xs font-medium accent-btn"
              >
                Translate
              </button>
              <button
                type="button"
                onClick={() => {
                  setSelectedText('');
                  setSelectedRects(undefined);
                }}
                aria-label="Clear selection"
                className="p-1 opacity-55 hover:opacity-100"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* Annotation Composer Sheet */}
          {composerOpen && (
            <form
              onSubmit={handleCreateAnnotation}
              className={`w-full max-w-xl mb-6 rounded-xl border ${theme.border} ${theme.surface} p-4 space-y-3 z-30 shadow-md`}
            >
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wide">
                  New {KIND_LABELS[pendingKind]} — Page {currentPage}
                </h3>
                <button
                  type="button"
                  onClick={() => setComposerOpen(false)}
                  aria-label="Close note composer"
                  className="p-1 opacity-60 hover:opacity-100"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div>
                <label htmlFor="quote-input" className="block text-xs mb-1 opacity-75">
                  Excerpt / Anchor
                </label>
                <textarea
                  id="quote-input"
                  value={selectedText || currentPagePlainText.slice(0, 220)}
                  onChange={(e) => setSelectedText(e.target.value)}
                  rows={2}
                  className={`w-full text-xs p-2.5 rounded-lg border ${theme.border} bg-transparent`}
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="note-input" className="block text-xs mb-1 opacity-75">
                    Margin Note
                  </label>
                  <textarea
                    id="note-input"
                    value={noteDraft}
                    onChange={(e) => setNoteDraft(e.target.value)}
                    placeholder="Write your reflection or synthesis..."
                    rows={2}
                    className={`w-full text-xs p-2.5 rounded-lg border ${theme.border} bg-transparent`}
                  />
                </div>
                <div>
                  <label htmlFor="tags-input" className="block text-xs mb-1 opacity-75">
                    Zotero Tags (comma or space separated)
                  </label>
                  <input
                    id="tags-input"
                    type="text"
                    value={tagsDraft}
                    onChange={(e) => setTagsDraft(e.target.value)}
                    placeholder="consensus, lemma, exam"
                    className={`w-full text-xs p-2.5 rounded-lg border ${theme.border} bg-transparent`}
                  />
                </div>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {COLOR_ORDER.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setSelectedColor(c)}
                      aria-label={`Select ${HIGHLIGHT_COLORS[c].label} highlight`}
                      className={`w-6 h-6 rounded-full ${HIGHLIGHT_COLORS[c].swatch} ${
                        selectedColor === c ? 'ring-2 ring-offset-2 ring-current' : 'opacity-70'
                      }`}
                    />
                  ))}
                </div>
                <button type="submit" className="px-4 py-1.5 rounded-lg accent-btn text-xs font-medium">
                  Save Annotation
                </button>
              </div>
            </form>
          )}

          {loadingDoc ? (
            <div className="my-auto text-sm opacity-70">Loading {book.format.toUpperCase()} document...</div>
          ) : docError ? (
            <div className={`my-auto max-w-md rounded-xl border ${theme.border} ${theme.surface} p-6 text-center`}>
              <BookOpen className="w-8 h-8 mx-auto opacity-40" />
              <p className="mt-3 text-sm font-medium">{docError}</p>
            </div>
          ) : book.format === 'epub' && epubDoc ? (
            /* EPUB Reflowable & Literary Novel / Spread Reader (respects L->R and R->L & Extend-Theme option) */
            <article
              ref={pageStageRef}
              dir={readingDirection}
              data-epub-mode={epubViewMode}
              data-apply-theme={applyThemeToDocument ? 'true' : 'false'}
              style={{
                maxWidth:
                  epubViewMode === 'spread'
                    ? `${Math.max(preferences.maxWidth, 1020)}px`
                    : `${preferences.maxWidth}px`,
                fontSize: `${preferences.fontSize}px`,
                lineHeight: preferences.lineHeight,
              }}
              className={`relative w-full ${fontClass} transition-all ${
                applyThemeToDocument
                  ? epubViewMode !== 'scroll'
                    ? `rounded-2xl border ${theme.border} ${theme.surface} shadow-md p-8 sm:p-12 ${
                        epubViewMode === 'spread' ? 'epub-spread-surface' : ''
                      }`
                    : ''
                  : `rounded-2xl border border-stone-200 bg-white text-slate-900 shadow-sm p-8 sm:p-12 ${
                      epubViewMode === 'spread' ? 'epub-spread-surface' : ''
                    }`
              }`}
            >
              {renderSpatialOverlays()}

              <div className={`text-xs mb-6 pb-2.5 border-b ${theme.border} ${theme.muted} flex items-center justify-between gap-4`}>
                <span className="truncate font-medium">{currentChapterTitle}</span>
                <span className="tabular-nums whitespace-nowrap shrink-0">
                  ~{estimatedChapterMinutes} min read · Ch. {currentPage}/{totalPages}
                  {epubViewMode !== 'scroll' && epubSubPageCount > 1
                    ? ` · Leaf ${epubSubPage + 1}/${epubSubPageCount}`
                    : ''}
                </span>
              </div>

              {epubViewMode === 'scroll' ? (
                <div
                  key="epub-scroll-view"
                  ref={epubBodyRef}
                  data-testid="epub-prose-container"
                  className={`epub-prose ${novelIndent ? 'epub-novel-indent' : ''} ${
                    novelJustify ? 'epub-novel-justify' : ''
                  } ${novelDropCap ? 'epub-novel-dropcap' : ''} ${
                    preferences.columnCount === 2 ? 'md:columns-2 md:gap-12' : ''
                  }`}
                />
              ) : (
                /* Paginated Book / Horizontal Leaf / Two-Page Open Spread */
                <div key="epub-paginated-view" className="relative">
                  <div
                    ref={epubSpreadViewportRef}
                    className="overflow-hidden"
                    style={{height: `${epubSpreadHeightPx}px`}}
                  >
                    <div
                      key={`epub-cols-${epubViewMode}-${readingDirection}`}
                      ref={epubBodyRef}
                      data-testid="epub-prose-container"
                      style={{
                        height: `${epubSpreadHeightPx}px`,
                        columnWidth: epubViewMode === 'spread' ? 'calc(50% - 2rem)' : '100%',
                        columnCount: epubViewMode === 'spread' ? 2 : 1,
                        columnGap: epubViewMode === 'spread' ? '4rem' : '2rem',
                        columnFill: 'auto',
                        transform: `translateX(calc(${readingDirection === 'rtl' ? '' : '-'}${epubSubPage} * (100% + ${
                          epubViewMode === 'spread' ? '4rem' : '2rem'
                        })))`,
                        transition: 'transform 220ms ease',
                      }}
                      className={`epub-prose ${novelIndent ? 'epub-novel-indent' : ''} ${
                        novelJustify ? 'epub-novel-justify' : ''
                      } ${novelDropCap ? 'epub-novel-dropcap' : ''}`}
                    />
                  </div>

                  {/* Subtle Book Page Turn Controls */}
                  <div className={`mt-6 pt-3 border-t ${theme.border} flex items-center justify-between text-xs`}>
                    <button
                      type="button"
                      onClick={() => {
                        if (epubSubPage > 0) setEpubSubPage((p) => p - 1);
                        else if (currentPage > 1) goToPage(currentPage - 1);
                      }}
                      disabled={currentPage <= 1 && epubSubPage === 0}
                      className="px-3 py-1 rounded-md hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-30 flex items-center gap-1"
                    >
                      <ChevronLeft className="w-3.5 h-3.5" />
                      Turn Back
                    </button>
                    <span className={`tabular-nums ${theme.muted}`}>
                      {epubViewMode === 'spread'
                        ? `Two-Page Book Spread (${readingDirection.toUpperCase()})`
                        : `Horizontal Book Pages (${readingDirection.toUpperCase()})`}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        if (epubSubPage < epubSubPageCount - 1) setEpubSubPage((p) => p + 1);
                        else if (currentPage < totalPages) goToPage(currentPage + 1);
                      }}
                      disabled={currentPage >= totalPages && epubSubPage >= epubSubPageCount - 1}
                      className="px-3 py-1 rounded-md hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-30 flex items-center gap-1"
                    >
                      Turn Page
                      <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )}
            </article>
          ) : (
            /* PDF & DjVu Multi-Mode Sheets (Single, Vertical Continuous, Horizontal L->R / R->L, Double Book Spread) */
            <div
              className={`flex flex-col gap-4 ${
                pageLayoutMode === 'horizontal' ? 'w-max min-w-full items-start' : 'w-fit min-w-full items-center'
              }`}
            >
              {(() => {
                const pagesToRender: number[] =
                  pageLayoutMode === 'single'
                    ? [currentPage]
                    : pageLayoutMode === 'double'
                      ? (() => {
                          if (totalPages <= 1) return [currentPage];
                          const leftStart = currentPage % 2 === 1 ? currentPage : Math.max(1, currentPage - 1);
                          const pair = leftStart + 1 <= totalPages ? [leftStart, leftStart + 1] : [leftStart];
                          return readingDirection === 'rtl' ? [...pair].reverse() : pair;
                        })()
                      : Array.from({length: totalPages}, (_, idx) => idx + 1);

                const stageLayoutClass =
                  pageLayoutMode === 'horizontal'
                    ? 'flex flex-row items-start gap-6 w-max px-4 pb-4'
                    : pageLayoutMode === 'double'
                      ? 'flex flex-row flex-nowrap items-start justify-center gap-2 p-2 rounded-xl bg-black/5 dark:bg-white/5 shadow-inner'
                      : pageLayoutMode === 'vertical'
                        ? 'flex flex-col items-center gap-6'
                        : 'flex flex-col items-center';

                const defaultRatio = pageMetrics[currentPage]?.aspectRatio || pageMetrics[1]?.aspectRatio || 612 / 792;

                return (
                  <div
                    dir={pageLayoutMode === 'horizontal' ? readingDirection : undefined}
                    data-testid="paper-layout-stage"
                    className={stageLayoutClass}
                  >
                    {pagesToRender.map((pageNum) => (
                      <DocumentPageSheet
                        key={pageNum}
                        format={book.format === 'djvu' ? 'djvu' : 'pdf'}
                        bookTitle={book.title}
                        pageNumber={pageNum}
                        totalPages={totalPages}
                        pdfDoc={pdfDoc}
                        djvuDoc={djvuDoc}
                        renderQueue={renderQueueRef.current}
                        defaultAspectRatio={defaultRatio}
                        fallbackText={textChunks.find((c) => c.page === pageNum)?.text || ''}
                        zoomScale={zoomScale}
                        scanSettings={scanSettings}
                        themeBgSurface={theme.surface}
                        themeBorder={theme.border}
                        themeText={theme.text}
                        themeMuted={theme.muted}
                        isDarkTheme={theme.isDark}
                        themeId={preferences.theme}
                        applyThemeToDocument={applyThemeToDocument}
                        fontClass={fontClass}
                        activeTool={spacePanHeld ? 'pan' : activeTool}
                        selectedColor={selectedColor}
                        pageAnnotations={bookAnnotations.filter((a) => a.page === pageNum)}
                        focusedAnnotationId={focusedAnnotationId}
                        lazy={pageLayoutMode === 'vertical' || pageLayoutMode === 'horizontal'}
                        withinWindow={
                          pageLayoutMode === 'vertical' || pageLayoutMode === 'horizontal'
                            ? Math.abs(pageNum - currentPage) <= RESOURCE_LIMITS.continuousPageWindow
                            : true
                        }
                        pageBadgeLabel={pageLayoutMode !== 'single' ? `p.${pageNum}` : undefined}
                        onFocusAnnotation={setFocusedAnnotationId}
                        onTextSelection={handleTextSelectionFromSheet}
                        onPinNoteAt={handlePinNoteFromSheet}
                        onCreateSpatialAnnotation={handleCreateSpatialFromSheet}
                        onRenderedText={(pNum, plainText) => {
                          setRenderedPageTexts((prev) =>
                            prev[pNum] === plainText ? prev : {...prev, [pNum]: plainText},
                          );
                        }}
                        onPageMetrics={(pNum, metrics) => {
                          setPageMetrics((prev) => {
                            const prevEntry = prev[pNum];
                            if (
                              prevEntry &&
                              prevEntry.nativeWidth === metrics.nativeWidth &&
                              prevEntry.nativeHeight === metrics.nativeHeight
                            ) {
                              return prev;
                            }
                            return {...prev, [pNum]: metrics};
                          });
                        }}
                      />
                    ))}
                  </div>
                );
              })()}
            </div>
          )}

          {/* Quiet Floating Inline Annotation Editor Popover (Never pops open sidebar!) */}
          <AnnotationPopover
            annotation={focusedAnnotation}
            copied={copiedId === focusedAnnotation?.id}
            onUpdate={onUpdateAnnotation}
            onDelete={onDeleteAnnotation}
            onCopyCitation={(ann) => void handleCopyCitation(ann)}
            onClose={() => setFocusedAnnotationId(null)}
          />
        </main>

        {/* Right Drawer: Appearance / Translation / AI Course */}
        {!distractionFree && rightTab && (
          <aside
            aria-label="Reader tools"
            className={`w-80 sm:w-96 shrink-0 border-l ${theme.border} ${theme.surface} flex flex-col overflow-hidden`}
          >
            <div className={`px-4 py-3 border-b ${theme.border} flex items-center justify-between`}>
              <h2 className="text-xs font-semibold tracking-wide uppercase">
                {rightTab === 'typography'
                  ? 'Typography & Surface'
                  : rightTab === 'translate'
                    ? 'Inline Document Translation'
                    : 'AI Study Studio'}
              </h2>
              <button
                type="button"
                onClick={() => setRightTab(null)}
                aria-label="Close right panel"
                className="p-1 opacity-60 hover:opacity-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-5">
              {rightTab === 'typography' && (
                <>
                  <div className="space-y-2.5">
                    <span className="text-xs font-medium block">
                      Reading Surface ({Object.keys(READER_THEMES).length} Themes)
                    </span>
                    <div className="grid grid-cols-2 gap-2">
                      {(Object.keys(READER_THEMES) as ReaderTheme[]).map((t) => (
                        <button
                          key={t}
                          type="button"
                          onClick={() =>
                            onUpdatePreferences({...preferences, theme: t, updatedAtMs: Date.now()})
                          }
                          className={`px-2.5 py-2 rounded-lg border text-xs font-medium flex items-center gap-2 transition-colors ${
                            preferences.theme === t ? 'accent-btn border-transparent' : theme.border
                          }`}
                        >
                          <span
                            className="w-3.5 h-3.5 rounded-full border border-black/20 shrink-0"
                            style={{backgroundColor: READER_THEMES[t].swatch}}
                          />
                          <span className="truncate">{READER_THEMES[t].label}</span>
                        </button>
                      ))}
                    </div>

                    <label className={`flex items-center justify-between gap-2 pt-1.5 text-xs cursor-pointer`}>
                      <span>Extend theme to document pages</span>
                      <input
                        type="checkbox"
                        checked={applyThemeToDocument}
                        onChange={(e) =>
                          onUpdatePreferences({
                            ...preferences,
                            applyThemeToDocument: e.target.checked,
                            updatedAtMs: Date.now(),
                          })
                        }
                      />
                    </label>
                  </div>

                  <div className="space-y-2">
                    <span className="text-xs font-medium">Curated Typefaces</span>
                    <div className="grid grid-cols-2 gap-2">
                      {FONT_OPTIONS.map((f) => (
                        <button
                          key={f.id}
                          type="button"
                          onClick={() =>
                            onUpdatePreferences({...preferences, fontFamily: f.id, updatedAtMs: Date.now()})
                          }
                          className={`px-2.5 py-2 rounded-lg border text-left text-xs ${
                            preferences.fontFamily === f.id ? 'accent-btn border-transparent' : theme.border
                          }`}
                        >
                          <div className={`font-medium truncate ${f.cssClass}`}>{f.label}</div>
                          <div className="text-[10px] opacity-70 truncate">{f.category}</div>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex justify-between text-xs">
                      <label htmlFor="font-size-range">Font Size</label>
                      <span className="tabular-nums font-mono">{preferences.fontSize}px</span>
                    </div>
                    <input
                      id="font-size-range"
                      type="range"
                      min={14}
                      max={28}
                      value={preferences.fontSize}
                      onChange={(e) =>
                        onUpdatePreferences({
                          ...preferences,
                          fontSize: Number(e.target.value),
                          updatedAtMs: Date.now(),
                        })
                      }
                      className="w-full"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex justify-between text-xs">
                      <label htmlFor="line-height-range">Line Height</label>
                      <span className="tabular-nums font-mono">{preferences.lineHeight.toFixed(2)}</span>
                    </div>
                    <input
                      id="line-height-range"
                      type="range"
                      min={1.3}
                      max={2.2}
                      step={0.05}
                      value={preferences.lineHeight}
                      onChange={(e) =>
                        onUpdatePreferences({
                          ...preferences,
                          lineHeight: Number(e.target.value),
                          updatedAtMs: Date.now(),
                        })
                      }
                      className="w-full"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex justify-between text-xs">
                      <label htmlFor="measure-range">Column Width</label>
                      <span className="tabular-nums font-mono">{preferences.maxWidth}px</span>
                    </div>
                    <input
                      id="measure-range"
                      type="range"
                      min={540}
                      max={1120}
                      step={20}
                      value={preferences.maxWidth}
                      onChange={(e) =>
                        onUpdatePreferences({
                          ...preferences,
                          maxWidth: Number(e.target.value),
                          updatedAtMs: Date.now(),
                        })
                      }
                      className="w-full"
                    />
                  </div>

                  <div className={`pt-3 border-t ${theme.border} space-y-3`}>
                    <span className="text-xs font-medium block">Paper &amp; Book Page Layout</span>
                    <div className="grid grid-cols-2 gap-1.5">
                      {(
                        [
                          {id: 'single', label: 'Single Page', icon: <FileText className="w-3 h-3" />},
                          {id: 'vertical', label: 'Vertical Scroll', icon: <MoveVertical className="w-3 h-3" />},
                          {id: 'horizontal', label: 'Horizontal Scroll', icon: <MoveHorizontal className="w-3 h-3" />},
                          {id: 'double', label: 'Double Spread', icon: <Columns2 className="w-3 h-3" />},
                        ] as const
                      ).map((mode) => (
                        <button
                          key={mode.id}
                          type="button"
                          onClick={() => handleChangePageLayout(mode.id)}
                          className={`py-1.5 px-2 rounded-lg border text-xs font-medium flex items-center justify-center gap-1 ${
                            pageLayoutMode === mode.id ? 'accent-btn border-transparent' : theme.border
                          }`}
                        >
                          {mode.icon}
                          {mode.label}
                        </button>
                      ))}
                    </div>

                    <div className="grid grid-cols-2 gap-1.5">
                      <button
                        type="button"
                        onClick={() =>
                          onUpdatePreferences({
                            ...preferences,
                            readingDirection: 'ltr',
                            updatedAtMs: Date.now(),
                          })
                        }
                        className={`py-1.5 px-2 rounded-lg border text-xs font-medium ${
                          readingDirection === 'ltr' ? 'accent-btn border-transparent' : theme.border
                        }`}
                      >
                        Left → Right (LTR)
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          onUpdatePreferences({
                            ...preferences,
                            readingDirection: 'rtl',
                            updatedAtMs: Date.now(),
                          })
                        }
                        className={`py-1.5 px-2 rounded-lg border text-xs font-medium ${
                          readingDirection === 'rtl' ? 'accent-btn border-transparent' : theme.border
                        }`}
                      >
                        Right → Left (RTL)
                      </button>
                    </div>

                    {book.format === 'epub' && (
                      <div className="pt-2 space-y-2 text-xs">
                        <span className="font-medium block">Novel Typography</span>
                        <label className="flex items-center justify-between cursor-pointer">
                          <span>Literary Paragraph Indent</span>
                          <input
                            type="checkbox"
                            checked={novelIndent}
                            onChange={(e) =>
                              onUpdatePreferences({
                                ...preferences,
                                novelIndent: e.target.checked,
                                updatedAtMs: Date.now(),
                              })
                            }
                          />
                        </label>
                        <label className="flex items-center justify-between cursor-pointer">
                          <span>Justified Text &amp; Hyphens</span>
                          <input
                            type="checkbox"
                            checked={novelJustify}
                            onChange={(e) =>
                              onUpdatePreferences({
                                ...preferences,
                                novelJustify: e.target.checked,
                                updatedAtMs: Date.now(),
                              })
                            }
                          />
                        </label>
                        <label className="flex items-center justify-between cursor-pointer">
                          <span>Chapter Drop Cap</span>
                          <input
                            type="checkbox"
                            checked={novelDropCap}
                            onChange={(e) =>
                              onUpdatePreferences({
                                ...preferences,
                                novelDropCap: e.target.checked,
                                updatedAtMs: Date.now(),
                              })
                            }
                          />
                        </label>
                      </div>
                    )}
                  </div>
                </>
              )}

              {rightTab === 'translate' && (
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <label htmlFor="target-lang" className="block text-xs font-medium">
                      Target Language
                    </label>
                    <select
                      id="target-lang"
                      value={targetLang}
                      onChange={(e) => setTargetLang(e.target.value)}
                      className={`w-full px-3 py-2 rounded-lg border ${theme.border} bg-transparent text-xs`}
                    >
                      {LANGUAGES.map((lang) => (
                        <option key={lang} value={lang} className="text-slate-900">
                          {lang}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <label htmlFor="translate-source" className="block text-xs font-medium">
                        Passage to Translate
                      </label>
                      <button
                        type="button"
                        onClick={() =>
                          void handleCopyTranslationSource(
                            translationSource || selectedText || currentPagePlainText.slice(0, 600),
                          )
                        }
                        className="text-[11px] accent-text hover:underline flex items-center gap-1"
                      >
                        {translateCopied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                        {translateCopied ? 'Copied' : 'Copy Text'}
                      </button>
                    </div>
                    <textarea
                      id="translate-source"
                      rows={4}
                      value={translationSource || selectedText || currentPagePlainText.slice(0, 600)}
                      onChange={(e) => setTranslationSource(e.target.value)}
                      className={`w-full p-2.5 rounded-lg border ${theme.border} bg-transparent text-xs leading-relaxed`}
                    />
                  </div>

                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={translating}
                      onClick={() => void handleRunTranslation()}
                      className="flex-1 py-2 px-3 rounded-lg accent-btn text-xs font-medium disabled:opacity-50"
                    >
                      {translating ? 'Preparing...' : `Translate to ${targetLang}`}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const pageSlice = currentPagePlainText.slice(0, 1200);
                        setTranslationSource(pageSlice);
                        void handleRunTranslation(pageSlice);
                      }}
                      className={`px-3 py-2 rounded-lg border ${theme.border} text-xs font-medium`}
                    >
                      Full Page
                    </button>
                  </div>

                  {translationOutcome && (
                    <div className={`rounded-xl border ${theme.border} p-3.5 space-y-3`}>
                      <div className={`text-[11px] ${theme.muted} leading-relaxed`}>
                        {translationOutcome.note}
                      </div>

                      {translationOutcome.translatedText && (
                        <div className="space-y-1">
                          <div className="text-[11px] font-semibold">
                            {translationOutcome.sourceLanguage || 'AUTO'} → {translationOutcome.targetLanguageLabel}
                          </div>
                          <p className="text-sm leading-relaxed whitespace-pre-wrap">
                            {translationOutcome.translatedText}
                          </p>
                        </div>
                      )}

                      <div className={`space-y-1.5 ${translationOutcome.translatedText ? `pt-2 border-t ${theme.border}` : ''}`}>
                        <span className="text-[11px] font-semibold block">
                          Direct Web Translators (HTTPS)
                        </span>
                        <div className="grid grid-cols-1 gap-1.5">
                          {translationOutcome.links.map((link) => (
                            <a
                              key={link.id}
                              href={link.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className={`px-3 py-2 rounded-lg border ${theme.border} hover:bg-black/5 dark:hover:bg-white/10 text-xs font-medium flex items-center justify-between gap-2 transition-colors`}
                            >
                              <span>{link.label}</span>
                              <ExternalLink className="w-3.5 h-3.5 opacity-70 shrink-0" aria-hidden="true" />
                            </a>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {rightTab === 'course' && (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      disabled={generatingCourse}
                      onClick={() => void handleTriggerCourse('course')}
                      className="py-2 px-3 rounded-lg accent-btn text-xs font-medium disabled:opacity-50"
                    >
                      {generatingCourse ? 'Synthesizing...' : 'Build Lecture Course'}
                    </button>
                    <button
                      type="button"
                      disabled={generatingCourse}
                      onClick={() => void handleTriggerCourse('summary')}
                      className={`py-2 px-3 rounded-lg border ${theme.border} text-xs font-medium disabled:opacity-50`}
                    >
                      Quick Summary
                    </button>
                  </div>

                  {courseError && (
                    <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 text-xs">
                      {courseError}
                    </div>
                  )}

                  {!activeCourse && !generatingCourse && (
                    <p className={`text-xs ${theme.muted} leading-relaxed`}>
                      Generate an offline-ready lecture course or executive summary directly from this document's extracted text.
                    </p>
                  )}

                  {activeCourse && (
                    <div className="space-y-4">
                      <div>
                        <h3 className="text-sm font-semibold">{activeCourse.title}</h3>
                        <p className="mt-2 text-xs leading-relaxed opacity-90 whitespace-pre-wrap">
                          {activeCourse.summary}
                        </p>
                      </div>

                      {activeCourse.keyConcepts.length > 0 && (
                        <div className={`pt-3 border-t ${theme.border}`}>
                          <h4 className="text-xs font-semibold mb-2">Core Concepts</h4>
                          <ul className="text-xs space-y-1 list-disc pl-4 opacity-90">
                            {activeCourse.keyConcepts.map((kc, idx) => (
                              <li key={idx}>{kc}</li>
                            ))}
                          </ul>
                        </div>
                      )}

                      <div className="space-y-3">
                        <h4 className="text-xs font-semibold">Lecture Modules</h4>
                        {activeCourse.modules.map((mod) => (
                          <div key={mod.moduleNumber} className={`rounded-lg border ${theme.border} p-3 space-y-2`}>
                            <div className="flex items-center justify-between text-xs font-semibold">
                              <span>{mod.moduleNumber}. {mod.title}</span>
                              <span className={`tabular-nums ${theme.muted}`}>{mod.durationMinutes} min</span>
                            </div>
                            <p className="text-xs leading-relaxed opacity-90">{mod.lectureNotes}</p>
                            <div className={`pt-2 border-t ${theme.border} space-y-1.5`}>
                              <p className="text-xs font-medium">Check: {mod.quizQuestion}</p>
                              {revealedQuiz[mod.moduleNumber] ? (
                                <p className="text-xs text-emerald-700 dark:text-emerald-400">
                                  Answer: {mod.quizAnswer}
                                </p>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setRevealedQuiz((prev) => ({...prev, [mod.moduleNumber]: true}))
                                  }
                                  className="text-xs accent-text hover:underline"
                                >
                                  Reveal Answer
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </aside>
        )}
      </div>

      {/* Bottom Progress & Pagination Footer */}
      {!distractionFree && (
        <footer
          className={`h-12 px-4 border-t ${theme.border} ${theme.surface} flex items-center justify-between gap-4 shrink-0`}
        >
          <button
            type="button"
            disabled={currentPage <= 1}
            onClick={() => stepPage(-1)}
            className="px-2.5 py-1 rounded-md text-xs font-medium disabled:opacity-30 hover:bg-black/5 dark:hover:bg-white/10 flex items-center gap-1"
          >
            <ChevronLeft className="w-4 h-4" />
            Prev
          </button>

          <div className="flex-1 max-w-md flex items-center gap-3">
            <input
              type="range"
              min={1}
              max={totalPages}
              value={currentPage}
              onChange={(e) => goToPage(Number(e.target.value))}
              aria-label="Reading progress scrubber"
              className="flex-1"
            />
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const parsed = parseInt(pageInputDraft, 10);
                if (Number.isFinite(parsed)) {
                  const target = Math.max(1, Math.min(totalPages, parsed));
                  setPageInputDraft(String(target));
                  goToPage(target);
                } else {
                  setPageInputDraft(String(currentPage));
                }
              }}
              className="flex items-center gap-1 text-xs font-mono tabular-nums whitespace-nowrap"
            >
              <input
                type="number"
                min={1}
                max={totalPages}
                value={pageInputDraft}
                onChange={(e) => setPageInputDraft(e.target.value)}
                onBlur={() => {
                  const parsed = parseInt(pageInputDraft, 10);
                  if (Number.isFinite(parsed)) {
                    const target = Math.max(1, Math.min(totalPages, parsed));
                    setPageInputDraft(String(target));
                    if (target !== currentPage) goToPage(target);
                  } else {
                    setPageInputDraft(String(currentPage));
                  }
                }}
                aria-label="Jump to page number"
                className={`w-14 px-1.5 py-0.5 rounded border ${theme.border} bg-transparent text-center text-xs font-mono tabular-nums`}
              />
              <span>
                / {totalPages} ({progressPct}%)
              </span>
            </form>
          </div>

          <button
            type="button"
            disabled={currentPage >= totalPages}
            onClick={() => stepPage(1)}
            className="px-2.5 py-1 rounded-md text-xs font-medium disabled:opacity-30 hover:bg-black/5 dark:hover:bg-white/10 flex items-center gap-1"
          >
            Next
            <ChevronRight className="w-4 h-4" />
          </button>
        </footer>
      )}
    </div>
  );
};
