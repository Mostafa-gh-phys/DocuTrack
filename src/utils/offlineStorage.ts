import {openDB, type DBSchema, type IDBPDatabase} from 'idb';
import type {
  Annotation,
  BackupArchive,
  BackupSnapshotRecord,
  BookMetadata,
  DocumentTextChunk,
  ReaderPreferences,
  ReadingGoal,
  StudyCourse,
} from '../types/library';
import {
  computeBufferSha256,
  createDefaultReadingGoal,
  deriveFolderFromRelativePath,
  detectSupportedBookFormat,
  sanitizeId,
} from './libraryLogic';
import {yieldToMain} from './batchYield';
import {
  closeDjvuDocument,
  extractDjvuCoverThumbnail,
  extractDjvuPageTextRange,
  openDjvuDocument,
} from './parsers/djvuParser';
import {extractEpubInfoFallback, parseEpubForIndex} from './parsers/epubIndexHelper';
import {extractEpubCoverThumbnail} from './parsers/epubParser';
import {
  closePdfDocument,
  extractPdfCoverThumbnail,
  extractPdfOutlineAndMeta,
  extractPdfPageTextRange,
  loadPdfDocument,
} from './parsers/pdfParser';
import {createSeedLibraryBundle} from './sampleDocuments';

interface FolioDB extends DBSchema {
  books: {
    key: string;
    value: BookMetadata;
  };
  binaries: {
    key: string;
    value: ArrayBuffer;
  };
  covers: {
    key: string;
    value: string;
  };
  textChunks: {
    key: string;
    value: DocumentTextChunk[];
  };
  annotations: {
    key: string;
    value: Annotation;
    indexes: {'by-book': string};
  };
  courses: {
    key: string;
    value: StudyCourse;
    indexes: {'by-book': string};
  };
  preferences: {
    key: string;
    value: ReaderPreferences;
  };
  goals: {
    key: string;
    value: ReadingGoal;
  };
  backups: {
    key: string;
    value: {record: BackupSnapshotRecord; archive: BackupArchive};
  };
}

export const DEFAULT_PREFERENCES: ReaderPreferences = {
  theme: 'paper',
  uiTheme: 'light',
  accentColor: 'cobalt',
  fontFamily: 'serif',
  fontSize: 18,
  lineHeight: 1.7,
  maxWidth: 740,
  columnCount: 1,
  epubViewMode: 'scroll',
  pageLayoutMode: 'single',
  readingDirection: 'ltr',
  novelIndent: true,
  novelJustify: true,
  novelDropCap: true,
  applyThemeToDocument: true,
  backupFrequency: 'onChange',
  updatedAtMs: 0,
};

let dbPromise: Promise<IDBPDatabase<FolioDB>> | null = null;

function getDb(): Promise<IDBPDatabase<FolioDB>> {
  if (!dbPromise) {
    dbPromise = openDB<FolioDB>('folio-library-db', 3, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('books')) {
          db.createObjectStore('books', {keyPath: 'id'});
        }
        if (!db.objectStoreNames.contains('binaries')) {
          db.createObjectStore('binaries');
        }
        if (!db.objectStoreNames.contains('covers')) {
          db.createObjectStore('covers');
        }
        if (!db.objectStoreNames.contains('textChunks')) {
          db.createObjectStore('textChunks');
        }
        if (!db.objectStoreNames.contains('annotations')) {
          const annStore = db.createObjectStore('annotations', {keyPath: 'id'});
          annStore.createIndex('by-book', 'bookId');
        }
        if (!db.objectStoreNames.contains('courses')) {
          const courseStore = db.createObjectStore('courses', {keyPath: 'id'});
          courseStore.createIndex('by-book', 'bookId');
        }
        if (!db.objectStoreNames.contains('preferences')) {
          db.createObjectStore('preferences');
        }
        if (!db.objectStoreNames.contains('goals')) {
          db.createObjectStore('goals', {keyPath: 'id'});
        }
        if (!db.objectStoreNames.contains('backups')) {
          db.createObjectStore('backups', {keyPath: 'record.id'});
        }
      },
    });
  }
  return dbPromise;
}

export async function initializeLibraryStore(): Promise<{
  books: BookMetadata[];
  annotations: Annotation[];
  courses: StudyCourse[];
  preferences: ReaderPreferences;
  readingGoal: ReadingGoal;
  textChunks: DocumentTextChunk[];
  backups: BackupSnapshotRecord[];
  covers: Record<string, string>;
}> {
  const db = await getDb();
  let books = await db.getAll('books');
  let annotations = await db.getAll('annotations');
  const courses = await db.getAll('courses');
  const rawPrefs = await db.get('preferences', 'reader');
  const preferences: ReaderPreferences = rawPrefs ? {...DEFAULT_PREFERENCES, ...rawPrefs} : DEFAULT_PREFERENCES;
  let readingGoal = await db.get('goals', 'default');

  if (!readingGoal) {
    readingGoal = createDefaultReadingGoal('local');
    await db.put('goals', readingGoal);
  }

  if (books.length === 0) {
    const seed = await createSeedLibraryBundle();
    const tx = db.transaction(['books', 'binaries', 'textChunks', 'annotations', 'preferences'], 'readwrite');
    for (const book of seed.books) {
      await tx.objectStore('books').put(book);
      const bin = seed.binaries[book.id];
      if (bin) await tx.objectStore('binaries').put(bin, book.id);
      const chunksForBook = seed.textChunks.filter((c) => c.bookId === book.id);
      await tx.objectStore('textChunks').put(chunksForBook, book.id);
    }
    for (const ann of seed.annotations) {
      await tx.objectStore('annotations').put(ann);
    }
    await tx.objectStore('preferences').put(DEFAULT_PREFERENCES, 'reader');
    await tx.done;

    books = seed.books;
    annotations = seed.annotations;
  }

  const [allChunkArrays, backupRows, coverKeys] = await Promise.all([
    db.getAll('textChunks'),
    db.getAll('backups'),
    db.getAllKeys('covers'),
  ]);
  const textChunks = allChunkArrays.flat();
  const backups = backupRows
    .map((r) => r.record)
    .sort((a, b) => b.createdAtMs - a.createdAtMs);

  const covers: Record<string, string> = {};
  if (coverKeys.length > 0) {
    const coverVals = await Promise.all(coverKeys.map((k) => db.get('covers', String(k))));
    coverKeys.forEach((k, idx) => {
      const v = coverVals[idx];
      if (typeof v === 'string' && v.length > 0) {
        covers[String(k)] = v;
      }
    });
  }

  return {books, annotations, courses, preferences, readingGoal, textChunks, backups, covers};
}

export async function getBooksLocal(): Promise<BookMetadata[]> {
  const db = await getDb();
  return await db.getAll('books');
}

export async function getBookBinary(bookId: string): Promise<ArrayBuffer | undefined> {
  const db = await getDb();
  return await db.get('binaries', bookId);
}

export async function getBookTextChunks(bookId: string): Promise<DocumentTextChunk[]> {
  const db = await getDb();
  return (await db.get('textChunks', bookId)) || [];
}

export async function saveBookCover(bookId: string, dataUrl: string): Promise<void> {
  const db = await getDb();
  await db.put('covers', dataUrl, bookId);
}

export async function saveBookLocal(
  book: BookMetadata,
  binary?: ArrayBuffer,
  chunks?: DocumentTextChunk[],
  coverDataUrl?: string,
): Promise<void> {
  const db = await getDb();
  const stores: Array<'books' | 'binaries' | 'textChunks' | 'covers'> = ['books'];
  if (binary) stores.push('binaries');
  if (chunks) stores.push('textChunks');
  if (coverDataUrl) stores.push('covers');
  const tx = db.transaction(stores, 'readwrite');
  await tx.objectStore('books').put(book);
  if (binary) {
    await tx.objectStore('binaries').put(binary, book.id);
  }
  if (chunks) {
    await tx.objectStore('textChunks').put(chunks, book.id);
  }
  if (coverDataUrl) {
    await tx.objectStore('covers').put(coverDataUrl, book.id);
  }
  await tx.done;
}

export async function deleteBookLocal(bookId: string): Promise<void> {
  const db = await getDb();
  await db.delete('books', bookId);
  await db.delete('binaries', bookId);
  await db.delete('covers', bookId);
  await db.delete('textChunks', bookId);
  const anns = await db.getAllFromIndex('annotations', 'by-book', bookId);
  for (const ann of anns) await db.delete('annotations', ann.id);
  const courses = await db.getAllFromIndex('courses', 'by-book', bookId);
  for (const c of courses) await db.delete('courses', c.id);
}

export async function saveAnnotationLocal(annotation: Annotation): Promise<void> {
  const db = await getDb();
  await db.put('annotations', annotation);
}

export async function deleteAnnotationLocal(annotationId: string): Promise<void> {
  const db = await getDb();
  await db.delete('annotations', annotationId);
}

export async function scanAndBackfillBookHashes(books: BookMetadata[]): Promise<BookMetadata[]> {
  const db = await getDb();
  const updated: BookMetadata[] = [];
  for (const book of books) {
    if (book.contentHash) {
      updated.push(book);
      continue;
    }
    const bin = await db.get('binaries', book.id);
    if (!bin) {
      updated.push(book);
      continue;
    }
    try {
      const contentHash = await computeBufferSha256(bin);
      const next = {...book, contentHash};
      await db.put('books', next);
      updated.push(next);
    } catch {
      updated.push(book);
    }
    await yieldToMain(8);
  }
  return updated;
}

export async function saveCourseLocal(course: StudyCourse): Promise<void> {
  const db = await getDb();
  await db.put('courses', course);
}

export async function savePreferencesLocal(prefs: ReaderPreferences): Promise<void> {
  const db = await getDb();
  await db.put('preferences', prefs, 'reader');
}

export async function saveReadingGoalLocal(goal: ReadingGoal): Promise<void> {
  const db = await getDb();
  await db.put('goals', goal);
}

export async function estimateOfflineStorageBytes(): Promise<number> {
  const db = await getDb();
  const [books, binaryKeys] = await Promise.all([db.getAll('books'), db.getAllKeys('binaries')]);
  const keySet = new Set(binaryKeys.map((k) => String(k)));
  let total = 0;
  for (const b of books) {
    if (keySet.has(b.id)) {
      total += b.fileSize || 0;
    }
  }
  return total;
}

export async function createLocalBackupSnapshot(
  trigger: 'manual' | 'auto',
  destinationLabel = 'IndexedDB Snapshot Vault',
): Promise<{record: BackupSnapshotRecord; archive: BackupArchive}> {
  const db = await getDb();
  const books = await db.getAll('books');
  const annotations = await db.getAll('annotations');
  const courses = await db.getAll('courses');
  const preferences = (await db.get('preferences', 'reader')) || DEFAULT_PREFERENCES;
  const readingGoal = (await db.get('goals', 'default')) || createDefaultReadingGoal('local');
  // Automatic snapshots omit heavy full-text search chunks so frequent backups stay instantaneous & low-RAM
  const textChunks = trigger === 'manual' ? (await db.getAll('textChunks')).flat() : [];

  const now = Date.now();
  const archive: BackupArchive = {
    version: 1,
    exportedAtMs: now,
    books,
    annotations,
    courses,
    preferences,
    readingGoal,
    textChunks,
  };
  const serialized = JSON.stringify(archive);
  const record: BackupSnapshotRecord = {
    id: `bkp_${now}`,
    createdAtMs: now,
    trigger,
    bookCount: books.length,
    annotationCount: annotations.length,
    courseCount: courses.length,
    sizeBytes: new Blob([serialized]).size,
    destination: destinationLabel,
  };

  await db.put('backups', {record, archive});

  const all = await db.getAll('backups');
  if (all.length > 15) {
    const sorted = all.sort((a, b) => b.record.createdAtMs - a.record.createdAtMs);
    for (const stale of sorted.slice(15)) {
      await db.delete('backups', stale.record.id);
    }
  }

  return {record, archive};
}

export async function getBackupArchiveById(backupId: string): Promise<BackupArchive | undefined> {
  const db = await getDb();
  const row = await db.get('backups', backupId);
  return row?.archive;
}

export async function restoreFromArchive(archive: BackupArchive): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['books', 'annotations', 'courses', 'preferences', 'goals', 'textChunks'], 'readwrite');
  for (const book of archive.books) {
    await tx.objectStore('books').put(book);
  }
  for (const ann of archive.annotations) {
    await tx.objectStore('annotations').put(ann);
  }
  for (const course of archive.courses) {
    await tx.objectStore('courses').put(course);
  }
  if (archive.preferences) {
    await tx.objectStore('preferences').put(archive.preferences, 'reader');
  }
  if (archive.readingGoal) {
    await tx.objectStore('goals').put(archive.readingGoal);
  }
  if (Array.isArray(archive.textChunks)) {
    const byBook = new Map<string, DocumentTextChunk[]>();
    for (const ch of archive.textChunks) {
      const list = byBook.get(ch.bookId) || [];
      list.push(ch);
      byBook.set(ch.bookId, list);
    }
    for (const [bookId, list] of byBook.entries()) {
      await tx.objectStore('textChunks').put(list, bookId);
    }
  }
  await tx.done;
}

export async function extractCoverFromBuffer(
  format: BookMetadata['format'],
  buffer: ArrayBuffer,
  title: string,
  author: string,
): Promise<string | undefined> {
  try {
    if (format === 'pdf') {
      let doc: Awaited<ReturnType<typeof loadPdfDocument>> | null = null;
      try {
        doc = await loadPdfDocument(buffer);
        return await extractPdfCoverThumbnail(doc);
      } finally {
        await closePdfDocument(doc);
      }
    }
    if (format === 'epub') {
      return await extractEpubCoverThumbnail(buffer, title, author);
    }
    if (format === 'djvu') {
      let doc: Awaited<ReturnType<typeof openDjvuDocument>> | null = null;
      try {
        doc = await openDjvuDocument(buffer);
        return await extractDjvuCoverThumbnail(doc, title);
      } finally {
        closeDjvuDocument(doc);
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

const INITIAL_INDEX_PAGE_LIMIT = 6;
const MAX_CHUNK_TEXT_LENGTH = 10000;

export interface IngestOptions {
  samplePageLimit?: number;
}

export async function ingestImportedBuffer(
  buffer: ArrayBuffer,
  filename: string,
  ownerId: string,
  folderPath = '/Local Drive',
  options?: IngestOptions,
): Promise<{
  book: BookMetadata;
  chunks: DocumentTextChunk[];
  coverDataUrl?: string;
  needsFullIndex: boolean;
} | null> {
  const format = detectSupportedBookFormat(filename);
  if (!format) {
    return null;
  }

  const baseName = filename.replace(/\.(pdf|epub|djvu)$/i, '');
  const id = sanitizeId(`doc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}_${baseName.slice(0, 20)}`);
  const targetSampleLimit = Math.max(1, options?.samplePageLimit ?? INITIAL_INDEX_PAGE_LIMIT);

  let title = baseName.replace(/[_-]+/g, ' ');
  let author = 'Imported Author';
  let pageCount = 1;
  let language = 'English';
  let chunks: DocumentTextChunk[] = [];
  let coverDataUrl: string | undefined;

  try {
    if (format === 'pdf') {
      let doc: Awaited<ReturnType<typeof loadPdfDocument>> | null = null;
      try {
        doc = await loadPdfDocument(buffer);
        pageCount = Math.max(1, doc.numPages);
        const sampleLimit = Math.min(pageCount, targetSampleLimit);
        const metaInfo = await extractPdfOutlineAndMeta(doc);
        const pageTexts = await extractPdfPageTextRange(doc, 1, sampleLimit);
        coverDataUrl = await extractPdfCoverThumbnail(doc);
        if (metaInfo.title) title = metaInfo.title;
        if (metaInfo.author) author = metaInfo.author;
        chunks = pageTexts.map((p) => ({
          bookId: id,
          bookTitle: title,
          page: p.page,
          chapterTitle: `Page ${p.page}`,
          text: p.text.slice(0, MAX_CHUNK_TEXT_LENGTH),
        }));
      } finally {
        await closePdfDocument(doc);
      }
    } else if (format === 'epub') {
      const epub = await parseEpubForIndex(buffer, targetSampleLimit, true);
      if (epub.title) title = epub.title;
      if (epub.author) author = epub.author;
      if (epub.language) language = epub.language;
      pageCount = Math.max(1, epub.chapterCount);
      coverDataUrl = epub.coverDataUrl;
      chunks = epub.chapters.map((ch) => ({
        bookId: id,
        bookTitle: title,
        page: ch.index,
        chapterTitle: ch.title,
        text: ch.plainText.slice(0, MAX_CHUNK_TEXT_LENGTH),
      }));
    } else if (format === 'djvu') {
      let doc: Awaited<ReturnType<typeof openDjvuDocument>> | null = null;
      try {
        doc = await openDjvuDocument(buffer);
        pageCount = Math.max(1, doc.page_count());
        const sampleLimit = Math.min(pageCount, targetSampleLimit);
        const pageTexts = await extractDjvuPageTextRange(doc, 1, sampleLimit);
        coverDataUrl = await extractDjvuCoverThumbnail(doc, title);
        chunks = pageTexts.map((p) => ({
          bookId: id,
          bookTitle: title,
          page: p.page,
          chapterTitle: `Page ${p.page}`,
          text: (p.text || extractEpubInfoFallback(title, p.page)).slice(0, MAX_CHUNK_TEXT_LENGTH),
        }));
      } finally {
        closeDjvuDocument(doc);
      }
    }
  } catch (err) {
    console.warn(`Metadata extraction partial for ${filename}:`, err);
    chunks = [
      {
        bookId: id,
        bookTitle: title,
        page: 1,
        chapterTitle: 'Page 1',
        text: `${title} (${format.toUpperCase()}) imported from ${folderPath}`,
      },
    ];
  }

  const now = Date.now();
  const excerpt = chunks.find((c) => c.text.trim().length > 0)?.text.slice(0, 260) || '';
  const contentHash = await computeBufferSha256(buffer).catch(() => undefined);

  const book: BookMetadata = {
    id,
    ownerId,
    title,
    author,
    format,
    folderPath,
    fileSize: buffer.byteLength,
    pageCount,
    currentPage: 1,
    progress: Math.round((1 / pageCount) * 100),
    isFavorite: false,
    offlinePinned: true,
    tags: [format],
    excerpt,
    language,
    contentHash,
    addedAt: now,
    lastOpenedAt: now,
    updatedAtMs: now,
  };

  await saveBookLocal(book, buffer, chunks, coverDataUrl);
  const needsFullIndex = pageCount > targetSampleLimit;
  return {book, chunks, coverDataUrl, needsFullIndex};
}

export async function ingestImportedFile(
  file: File,
  ownerId: string,
  explicitFolder?: string,
  options?: IngestOptions,
): Promise<{
  book: BookMetadata;
  chunks: DocumentTextChunk[];
  coverDataUrl?: string;
  needsFullIndex: boolean;
} | null> {
  const format = detectSupportedBookFormat(file.name);
  if (!format) {
    return null;
  }

  const buffer = await file.arrayBuffer();
  const relPath = (file as File & {webkitRelativePath?: string}).webkitRelativePath;
  const folderPath = explicitFolder || deriveFolderFromRelativePath(relPath, '/Local Drive');
  return await ingestImportedBuffer(buffer, file.name, ownerId, folderPath, options);
}

export async function indexRemainingBookChunks(
  book: BookMetadata,
  initialChunks: DocumentTextChunk[],
): Promise<DocumentTextChunk[]> {
  if (book.pageCount <= initialChunks.length) return initialChunks;
  const buffer = await getBookBinary(book.id);
  if (!buffer) return initialChunks;

  let fullChunks: DocumentTextChunk[] = [...initialChunks];
  const indexedPages = new Set(initialChunks.map((c) => c.page));
  const startFrom = Math.max(1, initialChunks.length + 1);

  try {
    if (book.format === 'pdf') {
      let doc: Awaited<ReturnType<typeof loadPdfDocument>> | null = null;
      try {
        doc = await loadPdfDocument(buffer);
        const batchSize = 16;
        for (let start = startFrom; start <= doc.numPages; start += batchSize) {
          const end = Math.min(doc.numPages, start + batchSize - 1);
          const batch = await extractPdfPageTextRange(doc, start, end);
          for (const p of batch) {
            if (!indexedPages.has(p.page)) {
              indexedPages.add(p.page);
              fullChunks.push({
                bookId: book.id,
                bookTitle: book.title,
                page: p.page,
                chapterTitle: `Page ${p.page}`,
                text: p.text.slice(0, MAX_CHUNK_TEXT_LENGTH),
              });
            }
          }
          await new Promise((r) => window.setTimeout(r, 25));
        }
      } finally {
        await closePdfDocument(doc);
      }
    } else if (book.format === 'epub') {
      const epub = await parseEpubForIndex(buffer, 0, false);
      fullChunks = epub.chapters.map((ch) => ({
        bookId: book.id,
        bookTitle: book.title,
        page: ch.index,
        chapterTitle: ch.title,
        text: ch.plainText.slice(0, MAX_CHUNK_TEXT_LENGTH),
      }));
    } else if (book.format === 'djvu') {
      let doc: Awaited<ReturnType<typeof openDjvuDocument>> | null = null;
      try {
        doc = await openDjvuDocument(buffer);
        const batch = await extractDjvuPageTextRange(doc, startFrom, doc.page_count());
        for (const p of batch) {
          if (!indexedPages.has(p.page)) {
            indexedPages.add(p.page);
            fullChunks.push({
              bookId: book.id,
              bookTitle: book.title,
              page: p.page,
              chapterTitle: `Page ${p.page}`,
              text: (p.text || extractEpubInfoFallback(book.title, p.page)).slice(0, MAX_CHUNK_TEXT_LENGTH),
            });
          }
        }
      } finally {
        closeDjvuDocument(doc);
      }
    }

    const db = await getDb();
    await db.put('textChunks', fullChunks, book.id);
  } catch (err) {
    console.warn(`Background full-text indexing skipped for ${book.title}:`, err);
  }

  return fullChunks;
}
