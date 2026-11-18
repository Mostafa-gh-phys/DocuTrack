import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import type {PDFDocumentProxy} from 'pdfjs-dist';
import type {WasmDocument} from 'djvu-rs';
import {
  ArrowLeft,
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  Columns2,
  Copy,
  Download,
  EyeOff,
  GraduationCap,
  Highlighter,
  Languages,
  ListTree,
  Maximize2,
  MessageSquarePlus,
  Minimize2,
  MousePointer,
  PenTool,
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
  HighlightColor,
  ReaderPreferences,
  ReaderTheme,
  StudyCourse,
} from '../types/library';
import {
  calculateProgress,
  exportAnnotationsToMarkdown,
  formatZoteroCitation,
} from '../utils/libraryLogic';
import {getBookBinary, getBookTextChunks} from '../utils/offlineStorage';
import {openDjvuDocument, renderDjvuPageToCanvas} from '../utils/parsers/djvuParser';
import {parseEpubDocument, type ParsedEpubDocument} from '../utils/parsers/epubParser';
import {extractPdfOutlineAndMeta, loadPdfDocument, renderPdfPageToCanvas} from '../utils/parsers/pdfParser';

export type ZoteroTool = 'select' | 'highlight' | 'underline' | 'note' | 'area' | 'ink';

interface ReaderViewProps {
  book: BookMetadata;
  annotations: Annotation[];
  courses: StudyCourse[];
  preferences: ReaderPreferences;
  isOnline: boolean;
  simulatedOffline: boolean;
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

const THEME_STYLES: Record<ReaderTheme, {bg: string; surface: string; text: string; muted: string; border: string}> = {
  paper: {
    bg: 'bg-[#FDFCF8]',
    surface: 'bg-white',
    text: 'text-[#1F2937]',
    muted: 'text-slate-500',
    border: 'border-stone-200',
  },
  sepia: {
    bg: 'bg-[#F4ECD8]',
    surface: 'bg-[#FAF5E8]',
    text: 'text-[#433422]',
    muted: 'text-[#7A664D]',
    border: 'border-[#E2D5B9]',
  },
  dusk: {
    bg: 'bg-[#1E2430]',
    surface: 'bg-[#262D3B]',
    text: 'text-[#D8DEE9]',
    muted: 'text-[#94A3B8]',
    border: 'border-[#353E50]',
  },
  night: {
    bg: 'bg-[#0B0F17]',
    surface: 'bg-[#111827]',
    text: 'text-[#E2E8F0]',
    muted: 'text-slate-400',
    border: 'border-slate-800',
  },
};

const HIGHLIGHT_COLORS: Record<
  HighlightColor,
  {label: string; swatch: string; bg: string; hex: string; borderClass: string}
> = {
  amber: {
    label: 'Amber',
    swatch: 'bg-amber-400',
    bg: 'bg-amber-200/60 dark:bg-amber-900/40',
    hex: '#d97706',
    borderClass: 'border-amber-500',
  },
  sage: {
    label: 'Sage',
    swatch: 'bg-emerald-400',
    bg: 'bg-emerald-200/60 dark:bg-emerald-900/40',
    hex: '#059669',
    borderClass: 'border-emerald-500',
  },
  sky: {
    label: 'Sky',
    swatch: 'bg-sky-400',
    bg: 'bg-sky-200/60 dark:bg-sky-900/40',
    hex: '#0284c7',
    borderClass: 'border-sky-500',
  },
  rose: {
    label: 'Rose',
    swatch: 'bg-rose-400',
    bg: 'bg-rose-200/60 dark:bg-rose-900/40',
    hex: '#e11d48',
    borderClass: 'border-rose-500',
  },
  violet: {
    label: 'Violet',
    swatch: 'bg-violet-400',
    bg: 'bg-violet-200/60 dark:bg-violet-900/40',
    hex: '#7c3aed',
    borderClass: 'border-violet-500',
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
  const [totalPages, setTotalPages] = useState(book.pageCount || 1);
  const [loadingDoc, setLoadingDoc] = useState(true);
  const [docError, setDocError] = useState<string | null>(null);

  const [leftTab, setLeftTab] = useState<'toc' | 'annotations' | null>('toc');
  const [rightTab, setRightTab] = useState<'typography' | 'translate' | 'course' | null>(initialRightTab);
  const [distractionFree, setDistractionFree] = useState(false);

  // Format-specific state
  const [epubDoc, setEpubDoc] = useState<ParsedEpubDocument | null>(null);
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [pdfOutline, setPdfOutline] = useState<{title: string; page: number}[]>([]);
  const [pdfTextItems, setPdfTextItems] = useState<{str: string; x: number; y: number; fontSize: number}[]>([]);
  const [pdfCanvasSize, setPdfCanvasSize] = useState<{width: number; height: number}>({width: 680, height: 880});
  const [djvuDoc, setDjvuDoc] = useState<WasmDocument | null>(null);
  const [djvuBlankBitmap, setDjvuBlankBitmap] = useState(false);
  const [djvuPageText, setDjvuPageText] = useState('');
  const [zoomScale, setZoomScale] = useState(1.35);
  const [textChunks, setTextChunks] = useState<DocumentTextChunk[]>([]);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pageStageRef = useRef<HTMLDivElement | null>(null);
  const visitedPagesRef = useRef<Set<number>>(new Set([book.currentPage || 1]));

  // Zotero Tooling & Selection Composer state
  const [activeTool, setActiveTool] = useState<ZoteroTool>('select');
  const [selectedColor, setSelectedColor] = useState<HighlightColor>('amber');
  const [selectedText, setSelectedText] = useState('');
  const [noteDraft, setNoteDraft] = useState('');
  const [tagsDraft, setTagsDraft] = useState('');
  const [pendingPosition, setPendingPosition] = useState<AnnotationPosition | undefined>(undefined);
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

  // Translation state
  const [targetLang, setTargetLang] = useState('Spanish');
  const [translationSource, setTranslationSource] = useState('');
  const [translationResult, setTranslationResult] = useState<{
    detectedLanguage: string;
    translatedText: string;
    glossaryNotes: string[];
  } | null>(null);
  const [translating, setTranslating] = useState(false);
  const [translateError, setTranslateError] = useState<string | null>(null);

  // AI Course state
  const [generatingCourse, setGeneratingCourse] = useState(false);
  const [courseError, setCourseError] = useState<string | null>(null);
  const [revealedQuiz, setRevealedQuiz] = useState<Record<number, boolean>>({});

  // Track active reading minutes every 60s
  useEffect(() => {
    if (!onRecordReadingSession) return;
    const id = window.setInterval(() => {
      if (!document.hidden) {
        onRecordReadingSession(0, 1);
      }
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

  // Load document binary from IndexedDB
  useEffect(() => {
    let cancelled = false;
    async function loadDocument() {
      setLoadingDoc(true);
      setDocError(null);
      setPdfDoc(null);
      setEpubDoc(null);
      setDjvuDoc(null);

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
          if (cancelled) return;
          setEpubDoc(parsed);
          setTotalPages(parsed.chapters.length);
        } else if (book.format === 'pdf') {
          const doc = await loadPdfDocument(buffer);
          const info = await extractPdfOutlineAndMeta(doc);
          if (cancelled) return;
          setPdfDoc(doc);
          setPdfOutline(info.outline);
          setTotalPages(doc.numPages);
        } else if (book.format === 'djvu') {
          const doc = await openDjvuDocument(buffer);
          if (cancelled) return;
          setDjvuDoc(doc);
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
    };
  }, [book.id, book.format, book.title]);

  // Render PDF or DjVu page onto canvas
  useEffect(() => {
    let cancelled = false;
    async function renderCanvasPage() {
      const canvas = canvasRef.current;
      if (!canvas) return;

      if (book.format === 'pdf' && pdfDoc) {
        try {
          const clampedPage = Math.max(1, Math.min(currentPage, pdfDoc.numPages));
          const res = await renderPdfPageToCanvas(pdfDoc, clampedPage, canvas, zoomScale);
          if (!cancelled) {
            setPdfCanvasSize({width: res.width, height: res.height});
            setPdfTextItems(res.textItems);
          }
        } catch (err) {
          console.error('PDF page render error:', err);
        }
      } else if (book.format === 'djvu' && djvuDoc) {
        try {
          const dpi = Math.round(110 * zoomScale);
          const res = renderDjvuPageToCanvas(djvuDoc, currentPage, canvas, dpi);
          if (!cancelled) {
            setDjvuBlankBitmap(res.isBlankBitmap);
            const fallbackChunk = textChunks.find((c) => c.page === currentPage)?.text || '';
            setDjvuPageText(res.text || fallbackChunk);
          }
        } catch (err) {
          console.error('DjVu page render error:', err);
        }
      }
    }
    void renderCanvasPage();
    return () => {
      cancelled = true;
    };
  }, [book.format, pdfDoc, djvuDoc, currentPage, zoomScale, textChunks]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (distractionFree) setDistractionFree(false);
        if (composerOpen) setComposerOpen(false);
        setActiveTool('select');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [distractionFree, composerOpen]);

  const goToPage = useCallback(
    (nextPage: number) => {
      const clamped = Math.max(1, Math.min(nextPage, totalPages));
      setCurrentPage(clamped);
      onUpdateProgress(book.id, clamped, totalPages);
      if (!visitedPagesRef.current.has(clamped)) {
        visitedPagesRef.current.add(clamped);
        onRecordReadingSession?.(1, 0);
      }
    },
    [book.id, onRecordReadingSession, onUpdateProgress, totalPages],
  );

  const currentPagePlainText = useMemo(() => {
    if (book.format === 'epub' && epubDoc) {
      return epubDoc.chapters[currentPage - 1]?.plainText || '';
    }
    if (book.format === 'djvu' && djvuPageText) {
      return djvuPageText;
    }
    const chunkText = textChunks.find((c) => c.page === currentPage)?.text;
    if (chunkText) return chunkText;
    if (book.format === 'pdf' && pdfTextItems.length > 0) {
      return pdfTextItems.map((item) => item.str).join(' ').replace(/\s+/g, ' ').trim();
    }
    return book.excerpt || '';
  }, [book.format, book.excerpt, epubDoc, currentPage, djvuPageText, textChunks, pdfTextItems]);

  const currentChapterTitle = useMemo(() => {
    if (book.format === 'epub' && epubDoc) {
      return epubDoc.chapters[currentPage - 1]?.title || `Chapter ${currentPage}`;
    }
    if (book.format === 'pdf') {
      return pdfOutline.find((o) => o.page === currentPage)?.title || `Page ${currentPage}`;
    }
    return `Page ${currentPage}`;
  }, [book.format, epubDoc, pdfOutline, currentPage]);

  const parseTagList = (raw: string): string[] =>
    raw
      .split(/[\s,]+/)
      .map((t) => t.replace(/^#/, '').trim())
      .filter(Boolean)
      .slice(0, 10);

  const handleMouseUpSelection = () => {
    if (activeTool === 'note' || activeTool === 'area' || activeTool === 'ink') return;
    const sel = window.getSelection()?.toString().trim() || '';
    if (sel.length < 3) return;
    const clipped = sel.slice(0, 1800);

    // Zotero-style instant highlight or underline when those tools are toggled on!
    if (activeTool === 'highlight' || activeTool === 'underline') {
      onAddAnnotation({
        bookId: book.id,
        page: currentPage,
        chapterTitle: currentChapterTitle,
        kind: activeTool,
        quote: clipped,
        note: '',
        color: selectedColor,
        tags: [],
      });
      window.getSelection()?.removeAllRanges();
      setLeftTab('annotations');
      return;
    }

    setSelectedText(clipped);
  };

  // Spatial coordinate helper (0..1)
  const getNormalizedCoords = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = pageStageRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return {x: 0.5, y: 0.5};
    return {
      x: Math.max(0, Math.min(1, Number(((e.clientX - rect.left) / rect.width).toFixed(4)))),
      y: Math.max(0, Math.min(1, Number(((e.clientY - rect.top) / rect.height).toFixed(4)))),
    };
  };

  const handleStageMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (activeTool === 'note') {
      const pt = getNormalizedCoords(e);
      setPendingKind('note');
      setPendingPosition({x: pt.x, y: pt.y, width: 0.04, height: 0.04});
      setSelectedText(`Pinned note at (${Math.round(pt.x * 100)}%, ${Math.round(pt.y * 100)}%)`);
      setComposerOpen(true);
      return;
    }
    if (activeTool === 'area') {
      const pt = getNormalizedCoords(e);
      setDragBoxStart(pt);
      setDragBoxCurrent(pt);
      return;
    }
    if (activeTool === 'ink') {
      const pt = getNormalizedCoords(e);
      setDrawingStroke([pt]);
    }
  };

  const handleStageMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (activeTool === 'area' && dragBoxStart) {
      setDragBoxCurrent(getNormalizedCoords(e));
    } else if (activeTool === 'ink' && drawingStroke) {
      const pt = getNormalizedCoords(e);
      setDrawingStroke((prev) => {
        if (!prev) return [pt];
        const last = prev[prev.length - 1];
        if (last && Math.hypot(pt.x - last.x, pt.y - last.y) < 0.005) return prev;
        return [...prev, pt];
      });
    }
  };

  const handleStageMouseUp = useCallback(() => {
    if (activeTool === 'area' && dragBoxStart && dragBoxCurrent) {
      const x = Math.min(dragBoxStart.x, dragBoxCurrent.x);
      const y = Math.min(dragBoxStart.y, dragBoxCurrent.y);
      const width = Math.abs(dragBoxCurrent.x - dragBoxStart.x);
      const height = Math.abs(dragBoxCurrent.y - dragBoxStart.y);
      setDragBoxStart(null);
      setDragBoxCurrent(null);

      if (width >= 0.025 && height >= 0.025) {
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
        setLeftTab('annotations');
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
        setLeftTab('annotations');
      }
    }
  }, [activeTool, book.id, currentChapterTitle, currentPage, dragBoxCurrent, dragBoxStart, drawingStroke, onAddAnnotation, selectedColor]);

  useEffect(() => {
    if (!dragBoxStart && !drawingStroke) return;
    const onWinUp = () => handleStageMouseUp();
    window.addEventListener('mouseup', onWinUp);
    return () => window.removeEventListener('mouseup', onWinUp);
  }, [dragBoxStart, drawingStroke, handleStageMouseUp]);

  const handleCreateAnnotation = (e: React.FormEvent) => {
    e.preventDefault();
    const quote = (selectedText || currentPagePlainText.slice(0, 220)).trim();
    if (!quote) return;
    onAddAnnotation({
      bookId: book.id,
      page: currentPage,
      chapterTitle: currentChapterTitle,
      kind: pendingKind,
      quote,
      note: noteDraft.trim(),
      color: selectedColor,
      tags: parseTagList(tagsDraft),
      position: pendingPosition,
    });
    setNoteDraft('');
    setTagsDraft('');
    setSelectedText('');
    setPendingPosition(undefined);
    setPendingKind('highlight');
    setComposerOpen(false);
    setLeftTab('annotations');
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
    const textToTranslate = (sourceOverride ?? translationSource) || selectedText || currentPagePlainText;
    if (!textToTranslate.trim()) return;
    if (!isOnline || simulatedOffline) {
      setTranslateError('Online translation requires an active network connection. Disable Offline Reading Mode to translate.');
      return;
    }
    setTranslationSource(textToTranslate);
    setTranslating(true);
    setTranslateError(null);
    setRightTab('translate');

    try {
      const res = await fetch('/api/ai/translate', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          text: textToTranslate,
          targetLanguage: targetLang,
          contextTitle: book.title,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Translation request failed');
      setTranslationResult(data);
    } catch (err) {
      setTranslateError(err instanceof Error ? err.message : 'Translation failed.');
    } finally {
      setTranslating(false);
    }
  };

  const handleTriggerCourse = async (mode: 'course' | 'summary') => {
    if (!isOnline || simulatedOffline) {
      setCourseError('AI course generation requires an active network connection.');
      return;
    }
    const fullText =
      textChunks.map((c) => c.text).join('\n\n') ||
      epubDoc?.chapters.map((c) => `${c.title}\n${c.plainText}`).join('\n\n') ||
      currentPagePlainText;

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

  const theme = THEME_STYLES[preferences.theme];
  const fontClass =
    preferences.fontFamily === 'serif'
      ? 'font-serif-reader'
      : preferences.fontFamily === 'mono'
        ? 'font-mono-reader'
        : 'font-sans-reader';

  const progressPct = calculateProgress(currentPage, totalPages);
  const spatialToolActive = activeTool === 'note' || activeTool === 'area' || activeTool === 'ink';

  const renderSpatialOverlays = () => {
    const inkAnns = pageAnnotations.filter((a) => a.kind === 'ink' && a.inkStrokes && a.inkStrokes.length > 0);
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
        onMouseDown={handleStageMouseDown}
        onMouseMove={handleStageMouseMove}
        onMouseUp={handleStageMouseUp}
        className={`absolute inset-0 z-20 ${
          spatialToolActive
            ? activeTool === 'note'
              ? 'cursor-crosshair pointer-events-auto'
              : activeTool === 'area'
                ? 'cursor-crosshair pointer-events-auto'
                : 'cursor-cell pointer-events-auto'
            : 'pointer-events-none'
        }`}
      >
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
                  opacity={0.85}
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
                  setLeftTab('annotations');
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
                title={ann.note || ann.quote}
                onClick={(ev) => {
                  ev.stopPropagation();
                  setFocusedAnnotationId(ann.id);
                  setLeftTab('annotations');
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
    <div className={`h-screen overflow-hidden flex flex-col ${theme.bg} ${theme.text} transition-colors duration-200`}>
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
              onClick={onBack}
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
                leftTab === 'toc' ? 'bg-blue-800 text-white' : 'hover:bg-black/5 dark:hover:bg-white/10'
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
                leftTab === 'annotations' ? 'bg-blue-800 text-white' : 'hover:bg-black/5 dark:hover:bg-white/10'
              }`}
            >
              <Highlighter className="w-3.5 h-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">Notes ({bookAnnotations.length})</span>
            </button>

            <button
              type="button"
              onClick={() => setRightTab(rightTab === 'translate' ? null : 'translate')}
              aria-pressed={rightTab === 'translate'}
              aria-label="Toggle inline translation"
              className={`px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 whitespace-nowrap ${
                rightTab === 'translate' ? 'bg-blue-800 text-white' : 'hover:bg-black/5 dark:hover:bg-white/10'
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
                rightTab === 'course' ? 'bg-blue-800 text-white' : 'hover:bg-black/5 dark:hover:bg-white/10'
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
                rightTab === 'typography' ? 'bg-blue-800 text-white' : 'hover:bg-black/5 dark:hover:bg-white/10'
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

      {/* Zotero-Style Annotation Toolbar */}
      {!distractionFree && (
        <div
          role="toolbar"
          aria-label="Zotero annotation tools"
          className={`px-4 py-1.5 border-b ${theme.border} ${theme.surface} flex items-center justify-between gap-4 overflow-x-auto shrink-0`}
        >
          <div className="flex items-center gap-1 shrink-0">
            {(
              [
                {id: 'select', label: 'Select', icon: <MousePointer className="w-3.5 h-3.5" />},
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
                  className={`px-2.5 py-1 rounded-md text-xs font-medium flex items-center gap-1.5 whitespace-nowrap transition-colors ${
                    active
                      ? 'bg-blue-800 text-white'
                      : 'hover:bg-black/5 dark:hover:bg-white/10 opacity-85 hover:opacity-100'
                  }`}
                >
                  {tool.icon}
                  <span>{tool.label}</span>
                </button>
              );
            })}

            <span className={`mx-2 h-4 w-px border-l ${theme.border}`} aria-hidden="true" />

            {/* 5 Zotero Annotation Color Swatches */}
            <div className="flex items-center gap-1.5" aria-label="Annotation color">
              {COLOR_ORDER.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Color ${HIGHLIGHT_COLORS[c].label}`}
                  aria-pressed={selectedColor === c}
                  onClick={() => setSelectedColor(c)}
                  className={`w-4 h-4 rounded-full ${HIGHLIGHT_COLORS[c].swatch} transition-transform ${
                    selectedColor === c ? 'ring-2 ring-offset-1 ring-blue-700 scale-110' : 'opacity-75 hover:opacity-100'
                  }`}
                />
              ))}
            </div>
          </div>

          <div className={`text-[11px] ${theme.muted} whitespace-nowrap hidden md:block`}>
            {activeTool === 'select' && 'Select text to quote, highlight, or translate'}
            {activeTool === 'highlight' && 'Highlight tool active — drag across text to save'}
            {activeTool === 'underline' && 'Underline tool active — drag across text to save'}
            {activeTool === 'note' && 'Sticky Note tool active — click anywhere on page to pin'}
            {activeTool === 'area' && 'Area Capture active — drag a box around any diagram or equation'}
            {activeTool === 'ink' && 'Ink Draw active — draw freehand strokes on the page'}
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
              <div className="flex-1 overflow-y-auto p-3 space-y-1">
                {book.format === 'epub' && epubDoc ? (
                  epubDoc.chapters.map((ch) => (
                    <button
                      key={ch.id}
                      type="button"
                      onClick={() => goToPage(ch.index)}
                      className={`w-full text-left px-3 py-2 rounded-lg text-xs transition-colors flex items-center justify-between gap-2 ${
                        currentPage === ch.index
                          ? 'bg-blue-800 text-white font-medium'
                          : 'hover:bg-black/5 dark:hover:bg-white/10'
                      }`}
                    >
                      <span className="truncate">{ch.title}</span>
                      <span className="tabular-nums opacity-70 shrink-0">{ch.index}</span>
                    </button>
                  ))
                ) : book.format === 'pdf' && pdfOutline.length > 0 ? (
                  pdfOutline.map((item, i) => (
                    <button
                      key={`${item.title}-${i}`}
                      type="button"
                      onClick={() => goToPage(item.page)}
                      className={`w-full text-left px-3 py-2 rounded-lg text-xs transition-colors flex items-center justify-between gap-2 ${
                        currentPage === item.page
                          ? 'bg-blue-800 text-white font-medium'
                          : 'hover:bg-black/5 dark:hover:bg-white/10'
                      }`}
                    >
                      <span className="truncate">{item.title}</span>
                      <span className="tabular-nums opacity-70 shrink-0">p.{item.page}</span>
                    </button>
                  ))
                ) : (
                  Array.from({length: totalPages}, (_, idx) => idx + 1).map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => goToPage(p)}
                      className={`w-full text-left px-3 py-2 rounded-lg text-xs transition-colors ${
                        currentPage === p
                          ? 'bg-blue-800 text-white font-medium'
                          : 'hover:bg-black/5 dark:hover:bg-white/10'
                      }`}
                    >
                      Page {p}
                    </button>
                  ))
                )}
              </div>
            ) : (
              <div className="flex-1 flex flex-col min-h-0">
                {/* Zotero Inspector Filter Controls */}
                <div className={`p-3 border-b ${theme.border} space-y-2.5 shrink-0`}>
                  <button
                    type="button"
                    onClick={() => {
                      setPendingKind('highlight');
                      setPendingPosition(undefined);
                      setComposerOpen(true);
                    }}
                    className="w-full py-2 px-3 rounded-lg bg-blue-800 text-white text-xs font-medium hover:bg-blue-900 flex items-center justify-center gap-1.5"
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
                          annColorFilter === 'all' ? 'border-blue-700 font-semibold' : theme.border
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
                            annColorFilter === c ? 'ring-2 ring-offset-1 ring-blue-700' : 'opacity-65'
                          }`}
                        />
                      ))}
                    </div>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto p-3 space-y-3">
                  {filteredInspectorAnnotations.length === 0 ? (
                    <p className={`text-xs ${theme.muted} py-4 text-center`}>
                      No matching annotations yet. Use the toolbar above to highlight, underline, pin a sticky note, capture an area, or draw ink.
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
                            isFocused ? 'border-blue-700 ring-1 ring-blue-700' : theme.border
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setFocusedAnnotationId(ann.id);
                                goToPage(ann.page);
                              }}
                              className="text-xs font-medium text-blue-700 dark:text-blue-400 hover:underline tabular-nums flex items-center gap-1.5"
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
                              kind === 'underline'
                                ? {borderBottom: `2px solid ${c.hex}`}
                                : undefined
                            }
                            className={`text-xs italic leading-relaxed px-2 py-1.5 rounded ${
                              kind === 'underline' ? '' : c.bg
                            }`}
                          >
                            "{ann.quote}"
                          </blockquote>

                          {/* Tags row */}
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
                                <button type="submit" className="text-blue-700 dark:text-blue-400 font-medium">
                                  Add
                                </button>
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
                                  className="px-2.5 py-1 rounded bg-blue-800 text-white text-xs"
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
                                className="text-[11px] text-blue-700 dark:text-blue-400 hover:underline shrink-0"
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
          onMouseUp={handleMouseUpSelection}
          className={`flex-1 overflow-y-auto px-4 sm:px-8 py-8 flex flex-col items-center relative ${
            spatialToolActive ? 'select-none' : ''
          }`}
        >
          {/* Quick Floating Selection Action Bar */}
          {selectedText && !composerOpen && (
            <div className="sticky top-2 z-30 mb-4 px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-lg flex items-center gap-2 flex-wrap">
              <span className="text-xs text-slate-500 max-w-[180px] truncate">"{selectedText}"</span>
              {COLOR_ORDER.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Highlight in ${HIGHLIGHT_COLORS[c].label}`}
                  onClick={() => {
                    onAddAnnotation({
                      bookId: book.id,
                      page: currentPage,
                      chapterTitle: currentChapterTitle,
                      kind: 'highlight',
                      quote: selectedText,
                      note: '',
                      color: c,
                      tags: [],
                    });
                    setSelectedText('');
                    setLeftTab('annotations');
                  }}
                  className={`w-5 h-5 rounded-full ${HIGHLIGHT_COLORS[c].swatch} hover:scale-110 transition-transform`}
                />
              ))}
              <button
                type="button"
                onClick={() => {
                  onAddAnnotation({
                    bookId: book.id,
                    page: currentPage,
                    chapterTitle: currentChapterTitle,
                    kind: 'underline',
                    quote: selectedText,
                    note: '',
                    color: selectedColor,
                    tags: [],
                  });
                  setSelectedText('');
                  setLeftTab('annotations');
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
                className="px-2.5 py-1 rounded-md text-xs font-medium bg-blue-800 text-white hover:bg-blue-900"
              >
                Translate
              </button>
              <button
                type="button"
                onClick={() => setSelectedText('')}
                aria-label="Clear selection"
                className="p-1 text-slate-400 hover:text-slate-700"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* Annotation Composer Sheet */}
          {composerOpen && (
            <form
              onSubmit={handleCreateAnnotation}
              className={`w-full max-w-xl mb-6 rounded-xl border ${theme.border} ${theme.surface} p-4 space-y-3 z-30`}
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
                        selectedColor === c ? 'ring-2 ring-offset-2 ring-blue-700' : 'opacity-70'
                      }`}
                    />
                  ))}
                </div>
                <button
                  type="submit"
                  className="px-4 py-1.5 rounded-lg bg-blue-800 text-white text-xs font-medium hover:bg-blue-900"
                >
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
            /* EPUB Reflowable Reader + Spatial Zotero Overlay */
            <article
              ref={pageStageRef}
              style={{
                maxWidth: `${preferences.columnCount === 2 ? Math.max(preferences.maxWidth, 940) : preferences.maxWidth}px`,
                fontSize: `${preferences.fontSize}px`,
                lineHeight: preferences.lineHeight,
              }}
              className={`relative w-full ${fontClass} ${
                preferences.columnCount === 2 ? 'md:columns-2 md:gap-12' : ''
              } transition-all`}
            >
              {renderSpatialOverlays()}
              <div className={`text-xs mb-6 pb-2 border-b ${theme.border} ${theme.muted} flex items-center justify-between`}>
                <span>{currentChapterTitle}</span>
                <span className="tabular-nums">
                  Chapter {currentPage} of {totalPages}
                </span>
              </div>
              <div
                className="epub-prose"
                dangerouslySetInnerHTML={{
                  __html: epubDoc.chapters[currentPage - 1]?.html || '<p>Empty chapter.</p>',
                }}
              />
            </article>
          ) : (
            /* PDF & DjVu Canvas + Selectable Text Layer + Zotero Spatial Overlay */
            <div className="flex flex-col items-center gap-4 w-full">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setZoomScale((z) => Math.max(0.8, Number((z - 0.15).toFixed(2))))}
                  aria-label="Zoom out"
                  className={`p-1.5 rounded-lg border ${theme.border} ${theme.surface}`}
                >
                  <ZoomOut className="w-4 h-4" />
                </button>
                <span className="text-xs font-mono tabular-nums min-w-[48px] text-center">
                  {Math.round(zoomScale * 100)}%
                </span>
                <button
                  type="button"
                  onClick={() => setZoomScale((z) => Math.min(2.4, Number((z + 0.15).toFixed(2))))}
                  aria-label="Zoom in"
                  className={`p-1.5 rounded-lg border ${theme.border} ${theme.surface}`}
                >
                  <ZoomIn className="w-4 h-4" />
                </button>
              </div>

              <div
                ref={pageStageRef}
                className={`relative border ${theme.border} shadow-sm bg-white overflow-hidden`}
                style={
                  book.format === 'pdf'
                    ? {width: `${pdfCanvasSize.width}px`, height: `${pdfCanvasSize.height}px`}
                    : undefined
                }
              >
                <canvas
                  ref={canvasRef}
                  data-testid="document-canvas"
                  className={`block ${
                    preferences.theme === 'night' || preferences.theme === 'dusk' ? 'invert-[0.88] hue-rotate-180' : ''
                  }`}
                />

                {/* PDF Selectable Text Overlay */}
                {book.format === 'pdf' && pdfTextItems.length > 0 && (
                  <div className="absolute inset-0 select-text overflow-hidden pointer-events-auto z-10">
                    {pdfTextItems.map((item, idx) => (
                      <span
                        key={idx}
                        style={{
                          position: 'absolute',
                          left: `${item.x}px`,
                          top: `${item.y}px`,
                          fontSize: `${item.fontSize}px`,
                          lineHeight: 1,
                          color: 'transparent',
                          whiteSpace: 'pre',
                        }}
                      >
                        {item.str}
                      </span>
                    ))}
                  </div>
                )}

                {/* DjVu Text Layer Overlay when bitmap is text-only or archival */}
                {book.format === 'djvu' && djvuPageText && (
                  <div
                    className={`${
                      djvuBlankBitmap
                        ? 'absolute inset-0 p-10 overflow-y-auto text-slate-900 bg-[#FDFCF8] z-10'
                        : 'p-4 border-t border-slate-200 bg-slate-50 text-slate-800'
                    }`}
                  >
                    {djvuBlankBitmap && (
                      <div className="text-[11px] font-mono uppercase tracking-wider text-slate-400 mb-4">
                        DjVu Text Layer (TXTa) · {book.title}
                      </div>
                    )}
                    <div className={`${fontClass} text-base leading-relaxed whitespace-pre-wrap select-text`}>
                      {djvuPageText}
                    </div>
                  </div>
                )}

                {/* Zotero Spatial Annotation Overlay (Notes, Areas, Ink) */}
                {renderSpatialOverlays()}
              </div>
            </div>
          )}
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
                  ? 'Typography & Theme'
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
                  <div className="space-y-2">
                    <span className="text-xs font-medium">Reading Surface</span>
                    <div className="grid grid-cols-2 gap-2">
                      {(['paper', 'sepia', 'dusk', 'night'] as ReaderTheme[]).map((t) => (
                        <button
                          key={t}
                          type="button"
                          onClick={() =>
                            onUpdatePreferences({...preferences, theme: t, updatedAtMs: Date.now()})
                          }
                          className={`px-3 py-2 rounded-lg border text-xs font-medium capitalize transition-colors ${
                            preferences.theme === t
                              ? 'border-blue-700 ring-1 ring-blue-700'
                              : theme.border
                          }`}
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <span className="text-xs font-medium">Typeface</span>
                    <div className="grid grid-cols-3 gap-2">
                      {(
                        [
                          {id: 'serif', label: 'Serif'},
                          {id: 'sans', label: 'Sans'},
                          {id: 'mono', label: 'Mono'},
                        ] as const
                      ).map((f) => (
                        <button
                          key={f.id}
                          type="button"
                          onClick={() =>
                            onUpdatePreferences({...preferences, fontFamily: f.id, updatedAtMs: Date.now()})
                          }
                          className={`px-3 py-2 rounded-lg border text-xs font-medium ${
                            preferences.fontFamily === f.id
                              ? 'bg-blue-800 text-white border-blue-800'
                              : theme.border
                          }`}
                        >
                          {f.label}
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
                      max={1020}
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

                  {book.format === 'epub' && (
                    <div className="space-y-2">
                      <span className="text-xs font-medium">Page Layout</span>
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            onUpdatePreferences({...preferences, columnCount: 1, updatedAtMs: Date.now()})
                          }
                          className={`px-3 py-2 rounded-lg border text-xs font-medium ${
                            preferences.columnCount === 1
                              ? 'bg-blue-800 text-white border-blue-800'
                              : theme.border
                          }`}
                        >
                          Single Column
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            onUpdatePreferences({...preferences, columnCount: 2, updatedAtMs: Date.now()})
                          }
                          className={`px-3 py-2 rounded-lg border text-xs font-medium flex items-center justify-center gap-1.5 ${
                            preferences.columnCount === 2
                              ? 'bg-blue-800 text-white border-blue-800'
                              : theme.border
                          }`}
                        >
                          <Columns2 className="w-3.5 h-3.5" />
                          Two Columns
                        </button>
                      </div>
                    </div>
                  )}
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
                    <label htmlFor="translate-source" className="block text-xs font-medium">
                      Passage to Translate
                    </label>
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
                      className="flex-1 py-2 px-3 rounded-lg bg-blue-800 text-white text-xs font-medium hover:bg-blue-900 disabled:opacity-50"
                    >
                      {translating ? 'Translating...' : `Translate to ${targetLang}`}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setTranslationSource(currentPagePlainText.slice(0, 1200));
                        void handleRunTranslation(currentPagePlainText.slice(0, 1200));
                      }}
                      className={`px-3 py-2 rounded-lg border ${theme.border} text-xs font-medium`}
                    >
                      Full Page
                    </button>
                  </div>

                  {translateError && (
                    <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 text-xs">
                      {translateError}
                    </div>
                  )}

                  {translationResult && (
                    <div className={`rounded-xl border ${theme.border} p-3.5 space-y-3`}>
                      <div className={`text-[11px] ${theme.muted}`}>
                        Detected: {translationResult.detectedLanguage} → {targetLang}
                      </div>
                      <p className="text-sm leading-relaxed whitespace-pre-wrap">
                        {translationResult.translatedText}
                      </p>
                      {translationResult.glossaryNotes.length > 0 && (
                        <div className={`pt-2 border-t ${theme.border} space-y-1`}>
                          <div className="text-xs font-medium">Terminology Notes</div>
                          <ul className="text-xs space-y-1 opacity-85 list-disc pl-4">
                            {translationResult.glossaryNotes.map((note, idx) => (
                              <li key={idx}>{note}</li>
                            ))}
                          </ul>
                        </div>
                      )}
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
                      className="py-2 px-3 rounded-lg bg-blue-800 text-white text-xs font-medium hover:bg-blue-900 disabled:opacity-50"
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
                              <span>
                                {mod.moduleNumber}. {mod.title}
                              </span>
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
                                  className="text-xs text-blue-700 dark:text-blue-400 hover:underline"
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
            onClick={() => goToPage(currentPage - 1)}
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
              aria-label="Page scrubber"
              onChange={(e) => goToPage(Number(e.target.value))}
              className="flex-1"
            />
            <span className="text-xs font-mono tabular-nums whitespace-nowrap">
              {currentPage} / {totalPages} ({progressPct}%)
            </span>
          </div>

          <button
            type="button"
            disabled={currentPage >= totalPages}
            onClick={() => goToPage(currentPage + 1)}
            className="px-2.5 py-1 rounded-md text-xs font-medium disabled:opacity-30 hover:bg-black/5 dark:hover:bg-white/10 flex items-center gap-1"
          >
            Next
            <ChevronRight className="w-4 h-4" />
          </button>
        </footer>
      )}

      {distractionFree && simulatedOffline && (
        <div className="fixed bottom-4 left-4 text-xs opacity-60 flex items-center gap-1.5">
          <EyeOff className="w-3.5 h-3.5" />
          Offline Focus Mode
        </div>
      )}
    </div>
  );
};
