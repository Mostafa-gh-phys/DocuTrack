import React, {useMemo, useRef, useState} from 'react';
import {
  ArrowRight,
  BookPlus,
  CheckCircle2,
  Download,
  FileText,
  FileUp,
  RefreshCw,
  Sparkles,
  X,
} from 'lucide-react';
import type {BookFormat, BookMetadata} from '../types/library';
import {
  convertDocumentLocally,
  detectAnyConvertibleFormat,
  type ConvertibleSourceFormat,
  type ConvertibleTargetFormat,
  type LocalConversionResult,
} from '../utils/documentConverter';
import {formatBytes} from '../utils/libraryLogic';
import {getBookBinary} from '../utils/offlineStorage';

interface ConverterViewProps {
  books: BookMetadata[];
  initialBookId?: string | null;
  onAddConvertedToLibrary: (
    buffer: ArrayBuffer,
    filename: string,
    targetFolder: string,
  ) => Promise<BookMetadata | null>;
  onOpenBook: (book: BookMetadata) => void;
}

const TARGET_FORMATS: {id: ConvertibleTargetFormat; label: string; desc: string}[] = [
  {id: 'pdf', label: 'PDF', desc: 'Fixed-layout paginated edition with embedded typography'},
  {id: 'epub', label: 'EPUB', desc: 'Reflowable literary e-book with chapter TOC'},
  {id: 'md', label: 'Markdown', desc: 'Structured plain-text notes with headings'},
  {id: 'html', label: 'HTML', desc: 'Self-contained readable web edition'},
  {id: 'txt', label: 'Plain Text', desc: 'Clean UTF-8 text extraction'},
];

export const ConverterView: React.FC<ConverterViewProps> = ({
  books,
  initialBookId = null,
  onAddConvertedToLibrary,
  onOpenBook,
}) => {
  const [sourceMode, setSourceMode] = useState<'library' | 'upload'>('library');
  const [selectedBookId, setSelectedBookId] = useState<string>(initialBookId || books[0]?.id || '');
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);

  const [targetFormat, setTargetFormat] = useState<ConvertibleTargetFormat>(() => {
    const first = books.find((b) => b.id === (initialBookId || books[0]?.id));
    return first?.format === 'pdf' ? 'epub' : 'pdf';
  });
  const [cleanScannedImages, setCleanScannedImages] = useState(true);

  const [converting, setConverting] = useState(false);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [result, setResult] = useState<LocalConversionResult | null>(null);
  const [savedBook, setSavedBook] = useState<BookMetadata | null>(null);

  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const selectedBook = useMemo(
    () => books.find((b) => b.id === selectedBookId) || null,
    [books, selectedBookId],
  );

  const activeSourceFormat: ConvertibleSourceFormat | null = useMemo(() => {
    if (sourceMode === 'upload') {
      return uploadedFile ? detectAnyConvertibleFormat(uploadedFile.name) : null;
    }
    return selectedBook ? selectedBook.format : null;
  }, [sourceMode, uploadedFile, selectedBook]);

  const handleSelectLibraryBook = (id: string) => {
    setSelectedBookId(id);
    setResult(null);
    setSavedBook(null);
    setErrorText(null);
    const b = books.find((item) => item.id === id);
    if (b && b.format === targetFormat) {
      setTargetFormat(b.format === 'pdf' ? 'epub' : 'pdf');
    }
  };

  const handleUploadPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const fmt = detectAnyConvertibleFormat(file.name);
    if (!fmt) {
      setErrorText('Unsupported format. Please select a PDF, EPUB, DjVu, Markdown, HTML, or TXT file.');
      return;
    }
    setUploadedFile(file);
    setSourceMode('upload');
    setResult(null);
    setSavedBook(null);
    setErrorText(null);
    if (fmt === targetFormat) {
      setTargetFormat(fmt === 'pdf' ? 'epub' : 'pdf');
    }
  };

  const handleConvert = async () => {
    setErrorText(null);
    setResult(null);
    setSavedBook(null);

    if (!activeSourceFormat) {
      setErrorText('Select a library document or upload a file first.');
      return;
    }
    if (activeSourceFormat === targetFormat) {
      setErrorText('Choose a different target format than the source document.');
      return;
    }

    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setConverting(true);
    setStatusText('Preparing local conversion engine...');
    try {
      let buffer: ArrayBuffer | null = null;
      let title = 'Converted Document';
      let author = 'DocuTrack Converter';
      let baseFilename = 'document';

      if (sourceMode === 'upload' && uploadedFile) {
        buffer = await uploadedFile.arrayBuffer();
        baseFilename = uploadedFile.name;
        title = uploadedFile.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
      } else if (selectedBook) {
        const bin = await getBookBinary(selectedBook.id);
        if (!bin) {
          throw new Error('Document binary is not stored offline on this device.');
        }
        buffer = bin;
        title = selectedBook.title;
        author = selectedBook.author;
        baseFilename = selectedBook.title.replace(/[^a-zA-Z0-9_-]+/g, '_');
      } else {
        throw new Error('No source document selected.');
      }

      const conv = await convertDocumentLocally({
        sourceBuffer: buffer,
        sourceFormat: activeSourceFormat,
        targetFormat,
        title,
        author,
        baseFilename,
        cleanScannedImages,
        signal: controller.signal,
        onProgress: (msg) => setStatusText(msg),
      });
      buffer = null;

      setResult(conv);
      setStatusText(null);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setErrorText('Conversion cancelled.');
      } else {
        setErrorText(err instanceof Error ? err.message : 'Local document conversion failed.');
      }
      setStatusText(null);
    } finally {
      abortControllerRef.current = null;
      setConverting(false);
    }
  };

  const handleDownloadResult = () => {
    if (!result) return;
    const copy = new Uint8Array(result.bytes.byteLength);
    copy.set(result.bytes);
    const blob = new Blob([copy], {type: result.mimeType});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = result.filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleSaveToLibrary = async () => {
    if (!result || (result.targetFormat !== 'pdf' && result.targetFormat !== 'epub')) return;
    const copy = new Uint8Array(result.bytes.byteLength);
    copy.set(result.bytes);
    const folder = selectedBook?.folderPath ? `${selectedBook.folderPath}` : '/Converted';
    const created = await onAddConvertedToLibrary(copy.buffer, result.filename, folder);
    if (created) setSavedBook(created);
  };

  const canImportBack: boolean = Boolean(
    result && (result.targetFormat === ('pdf' as BookFormat) || result.targetFormat === ('epub' as BookFormat)),
  );

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-4xl mx-auto space-y-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Local Document Format Converter</h1>
          <p className="mt-1 text-sm opacity-70">
            Transform PDF, EPUB, DjVu, Markdown, HTML, and TXT directly in your browser—100% offline with zero server uploads.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Source Selector */}
          <section className="lg:col-span-6 rounded-xl border app-border app-surface p-5 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">1. Source Document</h2>
              <div className="flex items-center gap-1 p-0.5 rounded-lg app-surface-muted border app-border">
                <button
                  type="button"
                  onClick={() => setSourceMode('library')}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium ${
                    sourceMode === 'library' ? 'app-surface shadow-xs' : 'opacity-65'
                  }`}
                >
                  From Library
                </button>
                <button
                  type="button"
                  onClick={() => setSourceMode('upload')}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium ${
                    sourceMode === 'upload' ? 'app-surface shadow-xs' : 'opacity-65'
                  }`}
                >
                  Upload File
                </button>
              </div>
            </div>

            {sourceMode === 'library' ? (
              <div className="space-y-3">
                <label htmlFor="converter-book-select" className="block text-xs opacity-75">
                  Choose a book from your library
                </label>
                <select
                  id="converter-book-select"
                  value={selectedBookId}
                  onChange={(e) => handleSelectLibraryBook(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border app-border bg-transparent text-sm"
                >
                  {books.map((b) => (
                    <option key={b.id} value={b.id} className="text-slate-900">
                      [{b.format.toUpperCase()}] {b.title}
                    </option>
                  ))}
                </select>
                {selectedBook && (
                  <div className="rounded-lg border app-border app-surface-muted p-3 text-xs space-y-1">
                    <div className="font-medium">{selectedBook.title}</div>
                    <div className="opacity-70">
                      {selectedBook.author} · {selectedBook.format.toUpperCase()} · {selectedBook.pageCount} pages ·{' '}
                      {formatBytes(selectedBook.fileSize)}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <input
                  ref={uploadInputRef}
                  type="file"
                  accept=".pdf,.epub,.djvu,.md,.markdown,.html,.htm,.txt"
                  onChange={handleUploadPick}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => uploadInputRef.current?.click()}
                  className="w-full py-6 px-4 rounded-xl border-2 border-dashed app-border app-surface-muted hover:opacity-90 flex flex-col items-center gap-2 text-xs"
                >
                  <FileUp className="w-6 h-6 opacity-60" aria-hidden="true" />
                  <span className="font-medium">
                    {uploadedFile ? uploadedFile.name : 'Choose PDF, EPUB, DjVu, Markdown, HTML, or TXT'}
                  </span>
                  {uploadedFile && <span className="opacity-65">{formatBytes(uploadedFile.size)}</span>}
                </button>
              </div>
            )}

            {(activeSourceFormat === 'djvu' || activeSourceFormat === 'pdf') && (
              <label className="flex items-center gap-2.5 pt-2 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={cleanScannedImages}
                  onChange={(e) => setCleanScannedImages(e.target.checked)}
                  className="rounded"
                />
                <span>Apply Clean Scan paper-whitening to DjVu raster pages when building PDF</span>
              </label>
            )}
          </section>

          {/* Target Format & Execute */}
          <section className="lg:col-span-6 rounded-xl border app-border app-surface p-5 space-y-4">
            <h2 className="text-sm font-semibold">2. Target Format</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {TARGET_FORMATS.map((tf) => {
                const disabled = activeSourceFormat === tf.id;
                const active = targetFormat === tf.id;
                return (
                  <button
                    key={tf.id}
                    type="button"
                    disabled={disabled}
                    aria-pressed={active}
                    onClick={() => {
                      setTargetFormat(tf.id);
                      setResult(null);
                      setSavedBook(null);
                    }}
                    className={`p-3 rounded-xl border text-left transition-colors disabled:opacity-35 ${
                      active ? 'accent-border accent-soft' : 'app-border hover:bg-black/5 dark:hover:bg-white/5'
                    }`}
                  >
                    <div className="text-xs font-semibold flex items-center justify-between">
                      <span>{tf.label}</span>
                      <span className="font-mono text-[10px] opacity-70">.{tf.id}</span>
                    </div>
                    <p className="mt-1 text-[11px] opacity-70 leading-snug">{tf.desc}</p>
                  </button>
                );
              })}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={converting || !activeSourceFormat || activeSourceFormat === targetFormat}
                onClick={() => void handleConvert()}
                className="flex-1 py-2.5 px-4 rounded-xl accent-btn text-xs font-medium disabled:opacity-45 flex items-center justify-center gap-2"
              >
                <RefreshCw className={`w-4 h-4 ${converting ? 'animate-spin' : ''}`} aria-hidden="true" />
                {converting
                  ? statusText || 'Converting locally...'
                  : `Convert ${activeSourceFormat ? activeSourceFormat.toUpperCase() : 'Source'} to ${targetFormat.toUpperCase()}`}
                {!converting && <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />}
              </button>
              {converting && (
                <button
                  type="button"
                  onClick={() => abortControllerRef.current?.abort()}
                  aria-label="Cancel conversion"
                  className="py-2.5 px-3 rounded-xl border app-border hover:bg-black/5 dark:hover:bg-white/10 text-xs font-medium flex items-center gap-1 whitespace-nowrap"
                >
                  <X className="w-3.5 h-3.5" aria-hidden="true" />
                  Cancel
                </button>
              )}
            </div>

            {errorText && (
              <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 text-xs">
                {errorText}
              </div>
            )}
          </section>
        </div>

        {/* Result Output Card */}
        {result && (
          <section
            aria-label="Conversion result"
            className="rounded-xl border app-border app-surface p-5 flex flex-wrap items-center justify-between gap-4"
          >
            <div className="flex items-start gap-3">
              <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" aria-hidden="true" />
              <div className="space-y-1">
                <div className="text-sm font-semibold flex items-center gap-2">
                  <FileText className="w-4 h-4 opacity-65" aria-hidden="true" />
                  <span>{result.filename}</span>
                </div>
                <p className="text-xs opacity-75">
                  {result.summaryNote} · Size: {formatBytes(result.bytes.byteLength)}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2.5 flex-wrap">
              <button
                type="button"
                onClick={handleDownloadResult}
                className="px-3.5 py-2 rounded-lg border app-border hover:bg-black/5 dark:hover:bg-white/10 text-xs font-medium flex items-center gap-1.5"
              >
                <Download className="w-3.5 h-3.5" aria-hidden="true" />
                Download .{result.targetFormat}
              </button>

              {canImportBack && !savedBook && (
                <button
                  type="button"
                  onClick={() => void handleSaveToLibrary()}
                  className="px-3.5 py-2 rounded-lg accent-btn text-xs font-medium flex items-center gap-1.5"
                >
                  <BookPlus className="w-3.5 h-3.5" aria-hidden="true" />
                  Add to Library
                </button>
              )}

              {savedBook && (
                <button
                  type="button"
                  onClick={() => onOpenBook(savedBook)}
                  className="px-3.5 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-medium flex items-center gap-1.5"
                >
                  <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                  Open in Reader
                </button>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
};
