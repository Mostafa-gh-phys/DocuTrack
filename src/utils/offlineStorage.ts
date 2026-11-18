import {openDB, type DBSchema, type IDBPDatabase} from 'idb';
import type {
  Annotation,
  BackupArchive,
  BackupSnapshotRecord,
  BookFormat,
  BookMetadata,
  DocumentTextChunk,
  ReaderPreferences,
  ReadingGoal,
  StudyCourse,
} from '../types/library';
import {createDefaultReadingGoal, deriveFolderFromRelativePath, sanitizeId} from './libraryLogic';
import {extractDjvuMetadataAndText} from './parsers/djvuParser';
import {extractEpubInfoFallback, parseEpubForIndex} from './parsers/epubIndexHelper';
import {extractPdfMetadataAndText} from './parsers/pdfParser';
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
  fontFamily: 'serif',
  fontSize: 18,
  lineHeight: 1.7,
  maxWidth: 740,
  columnCount: 1,
  backupFrequency: 'onChange',
  updatedAtMs: Date.now(),
};

let dbPromise: Promise<IDBPDatabase<FolioDB>> | null = null;

function getDb(): Promise<IDBPDatabase<FolioDB>> {
  if (!dbPromise) {
    dbPromise = openDB<FolioDB>('folio-library-db', 2, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('books')) {
          db.createObjectStore('books', {keyPath: 'id'});
        }
        if (!db.objectStoreNames.contains('binaries')) {
          db.createObjectStore('binaries');
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
}> {
  const db = await getDb();
  let books = await db.getAll('books');
  let annotations = await db.getAll('annotations');
  const courses = await db.getAll('courses');
  const preferences = (await db.get('preferences', 'reader')) || DEFAULT_PREFERENCES;
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

  const allChunkArrays = await db.getAll('textChunks');
  const textChunks = allChunkArrays.flat();
  const backupRows = await db.getAll('backups');
  const backups = backupRows
    .map((r) => r.record)
    .sort((a, b) => b.createdAtMs - a.createdAtMs);

  return {books, annotations, courses, preferences, readingGoal, textChunks, backups};
}

export async function getBookBinary(bookId: string): Promise<ArrayBuffer | undefined> {
  const db = await getDb();
  return await db.get('binaries', bookId);
}

export async function getBookTextChunks(bookId: string): Promise<DocumentTextChunk[]> {
  const db = await getDb();
  return (await db.get('textChunks', bookId)) || [];
}

export async function saveBookLocal(book: BookMetadata, binary?: ArrayBuffer, chunks?: DocumentTextChunk[]): Promise<void> {
  const db = await getDb();
  await db.put('books', book);
  if (binary) {
    await db.put('binaries', binary, book.id);
  }
  if (chunks) {
    await db.put('textChunks', chunks, book.id);
  }
}

export async function deleteBookLocal(bookId: string): Promise<void> {
  const db = await getDb();
  await db.delete('books', bookId);
  await db.delete('binaries', bookId);
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
  const books = await db.getAll('books');
  let total = 0;
  for (const b of books) {
    const bin = await db.get('binaries', b.id);
    if (bin) total += bin.byteLength;
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
  const textChunks = (await db.getAll('textChunks')).flat();

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

  // Retain latest 15 automated snapshots to keep local storage clean
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

export async function ingestImportedFile(
  file: File,
  ownerId: string,
  explicitFolder?: string,
): Promise<{book: BookMetadata; chunks: DocumentTextChunk[]} | null> {
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (ext !== 'pdf' && ext !== 'epub' && ext !== 'djvu') {
    return null;
  }

  const format: BookFormat = ext;
  const buffer = await file.arrayBuffer();
  const baseName = file.name.replace(/\.(pdf|epub|djvu)$/i, '');
  const id = sanitizeId(`doc_${Date.now()}_${baseName.slice(0, 24)}`);
  const relPath = (file as File & {webkitRelativePath?: string}).webkitRelativePath;
  const folderPath = explicitFolder || deriveFolderFromRelativePath(relPath, '/Local Drive');

  let title = baseName.replace(/[_-]+/g, ' ');
  let author = 'Imported Author';
  let pageCount = 1;
  let language = 'English';
  let chunks: DocumentTextChunk[] = [];

  try {
    if (format === 'pdf') {
      const info = await extractPdfMetadataAndText(buffer);
      if (info.title) title = info.title;
      if (info.author) author = info.author;
      pageCount = Math.max(1, info.pageCount);
      chunks = info.pageTexts.map((p) => ({
        bookId: id,
        bookTitle: title,
        page: p.page,
        chapterTitle: `Page ${p.page}`,
        text: p.text,
      }));
    } else if (format === 'epub') {
      const epub = await parseEpubForIndex(buffer);
      if (epub.title) title = epub.title;
      if (epub.author) author = epub.author;
      if (epub.language) language = epub.language;
      pageCount = Math.max(1, epub.chapters.length);
      chunks = epub.chapters.map((ch) => ({
        bookId: id,
        bookTitle: title,
        page: ch.index,
        chapterTitle: ch.title,
        text: ch.plainText,
      }));
    } else if (format === 'djvu') {
      const djvu = await extractDjvuMetadataAndText(buffer);
      pageCount = Math.max(1, djvu.pageCount);
      chunks = djvu.pageTexts.map((p) => ({
        bookId: id,
        bookTitle: title,
        page: p.page,
        chapterTitle: `Page ${p.page}`,
        text: p.text || extractEpubInfoFallback(title, p.page),
      }));
    }
  } catch (err) {
    console.warn(`Metadata extraction partial for ${file.name}:`, err);
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
    addedAt: now,
    lastOpenedAt: now,
    updatedAtMs: now,
  };

  await saveBookLocal(book, buffer, chunks);
  return {book, chunks};
}
