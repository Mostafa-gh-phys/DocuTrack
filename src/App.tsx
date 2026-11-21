import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {onAuthStateChanged, type User} from 'firebase/auth';
import {FolderUp, Moon, Palette, Sun, WifiOff} from 'lucide-react';
import {AppearanceDialog} from './components/AppearanceDialog';
import {ConverterView} from './components/ConverterView';
import {CoursesHubView} from './components/CoursesHubView';
import {DocuTrackLogo} from './components/DocuTrackLogo';
import {DuplicatesModal} from './components/DuplicatesModal';
import {ImportModal} from './components/ImportModal';
import {LibrarySidebar} from './components/LibrarySidebar';
import {LibraryView} from './components/LibraryView';
import {ReaderView} from './components/ReaderView';
import {ReadingGoalsView} from './components/ReadingGoalsView';
import {SyncBackupView} from './components/SyncBackupView';
import {
  auth,
  deleteAnnotationFromCloud,
  deleteBookFromCloud,
  disableCloudNetwork,
  enableCloudNetwork,
  ensureUserProfile,
  signInWithGoogle,
  signOutUser,
  subscribeToCloudLibrary,
  syncAnnotationToCloud,
  syncBookToCloud,
  syncCourseToCloud,
  syncPreferencesToCloud,
  syncReadingGoalToCloud,
  testConnection,
} from './firebase';
import {useOnlineStatus} from './hooks/useOnlineStatus';
import type {
  Annotation,
  BackupFrequency,
  BackupSnapshotRecord,
  BookFormat,
  BookMetadata,
  DocumentTextChunk,
  LibraryCollection,
  ReaderPreferences,
  ReadingGoal,
  SemanticSearchResult,
  SortDirection,
  SortField,
  StudyCourse,
} from './types/library';
import {
  buildFolderTree,
  calculateProgress,
  createDefaultReadingGoal,
  detectSupportedBookFormat,
  findDuplicateBookGroups,
  recordReadingActivity,
  sanitizeId,
  searchLocalSemanticChunks,
  sortAndFilterBooks,
  validateBackupArchive,
} from './utils/libraryLogic';
import {
  loadCustomCloudConfig,
  mergeLibraryArchives,
  pullFromCustomCloud,
  pushToCustomCloud,
  saveCustomCloudConfig,
  testCustomCloudConnection,
  type CustomCloudConfig,
} from './utils/customCloudSync';
import {
  createLocalBackupSnapshot,
  DEFAULT_PREFERENCES,
  deleteAnnotationLocal,
  deleteBookLocal,
  estimateOfflineStorageBytes,
  extractCoverFromBuffer,
  getBackupArchiveById,
  getBookBinary,
  indexRemainingBookChunks,
  ingestImportedBuffer,
  ingestImportedFile,
  initializeLibraryStore,
  restoreFromArchive,
  saveAnnotationLocal,
  saveBookCover,
  saveBookLocal,
  saveCourseLocal,
  savePreferencesLocal,
  saveReadingGoalLocal,
  scanAndBackfillBookHashes,
} from './utils/offlineStorage';
import {isDarkUiTheme} from './utils/themeTokens';

type WorkspaceTab = 'library' | 'goals' | 'courses' | 'convert' | 'sync';

interface DirectoryHandleLike {
  name: string;
  getFileHandle: (name: string, opts?: {create?: boolean}) => Promise<{
    createWritable: () => Promise<{write: (data: string) => Promise<void>; close: () => Promise<void>}>;
  }>;
  values?: () => AsyncIterable<FileSystemHandleLike>;
}

interface FileSystemHandleLike {
  kind: 'file' | 'directory';
  name: string;
  getFile?: () => Promise<File>;
  values?: () => AsyncIterable<FileSystemHandleLike>;
}

export default function App() {
  const isOnline = useOnlineStatus();
  const [simulatedOffline, setSimulatedOffline] = useState(false);

  const [initialized, setInitialized] = useState(false);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('library');
  const [openBookId, setOpenBookId] = useState<string | null>(null);
  const [readerInitialRightTab, setReaderInitialRightTab] = useState<'typography' | 'translate' | 'course' | null>(null);

  const [books, setBooks] = useState<BookMetadata[]>([]);
  const [bookCovers, setBookCovers] = useState<Record<string, string>>({});
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [courses, setCourses] = useState<StudyCourse[]>([]);
  const [textChunks, setTextChunks] = useState<DocumentTextChunk[]>([]);
  const [preferences, setPreferences] = useState<ReaderPreferences>(DEFAULT_PREFERENCES);
  const [readingGoal, setReadingGoal] = useState<ReadingGoal>(() => createDefaultReadingGoal('local'));
  const [backups, setBackups] = useState<BackupSnapshotRecord[]>([]);
  const [offlineBytes, setOfflineBytes] = useState(0);

  // Unified modals & converter selection
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [duplicatesOpen, setDuplicatesOpen] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [converterBookId, setConverterBookId] = useState<string | null>(null);
  const pendingUploadFolderRef = useRef<string | undefined>(undefined);

  // Library filters & sort state
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [activeCollection, setActiveCollection] = useState<LibraryCollection>('all');
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  const [activeFormat, setActiveFormat] = useState<BookFormat | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [semanticMode, setSemanticMode] = useState(false);
  const [semanticResults, setSemanticResults] = useState<SemanticSearchResult[]>([]);
  const [semanticLoading, setSemanticLoading] = useState(false);
  const [semanticSourceLabel, setSemanticSourceLabel] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortField>('lastOpenedAt');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');

  // Firebase Cloud Auth & Sync
  const [user, setUser] = useState<User | null>(null);
  const [cloudReachable, setCloudReachable] = useState(false);
  const [syncStatus, setSyncStatus] = useState('Local library ready');
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const [importProgress, setImportProgress] = useState<{done: number; total: number; currentName: string} | null>(null);
  const cancelImportRef = useRef(false);
  const importNoticeTimerRef = useRef<number | null>(null);

  // Automated local disk backup handle & Custom Cloud Sync
  const backupDirHandleRef = useRef<DirectoryHandleLike | null>(null);
  const [linkedBackupDirName, setLinkedBackupDirName] = useState<string | null>(null);
  const autoBackupTimerRef = useRef<number | null>(null);
  const [customCloudConfig, setCustomCloudConfig] = useState<CustomCloudConfig>(() => loadCustomCloudConfig());
  const [customCloudStatus, setCustomCloudStatus] = useState<string | null>(null);
  const [customCloudBusy, setCustomCloudBusy] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  // Sync UI theme, accent color, and Tailwind dark class on <html>
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.uiTheme = preferences.uiTheme || 'light';
    root.dataset.accent = preferences.accentColor || 'cobalt';
    if (isDarkUiTheme(preferences.uiTheme)) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [preferences.uiTheme, preferences.accentColor]);

  // Initial IndexedDB Hydration + lazy cover thumbnail backfill
  useEffect(() => {
    let cancelled = false;
    async function boot() {
      const store = await initializeLibraryStore();
      if (cancelled) return;
      setBooks(store.books);
      setBookCovers(store.covers);
      setAnnotations(store.annotations);
      setCourses(store.courses);
      setPreferences(store.preferences);
      setReadingGoal(store.readingGoal);
      setTextChunks(store.textChunks);
      setBackups(store.backups);
      setOfflineBytes(await estimateOfflineStorageBytes());
      setInitialized(true);

      // Generate cover thumbnails locally for any books missing cached covers
      const missingCovers = store.books.filter((b) => !store.covers[b.id] && !b.coverUrl);
      if (missingCovers.length > 0) {
        for (const book of missingCovers) {
          if (cancelled) break;
          try {
            const bin = await getBookBinary(book.id);
            if (!bin) continue;
            const thumb = await extractCoverFromBuffer(book.format, bin, book.title, book.author);
            if (thumb && !cancelled) {
              await saveBookCover(book.id, thumb);
              setBookCovers((prev) => ({...prev, [book.id]: thumb}));
            }
          } catch {
            // Keep clean typographic cover fallback if extraction fails
          }
        }
      }
    }
    void boot();
    return () => {
      cancelled = true;
    };
  }, []);

  // Firebase Auth Listener & Cross-Device Cloud Subscription
  useEffect(() => {
    let unsubCloud: (() => void) | null = null;
    let activeAuthGeneration = 0;

    const unsubAuth = onAuthStateChanged(auth, async (nextUser) => {
      const generation = ++activeAuthGeneration;
      setUser(nextUser);
      if (unsubCloud) {
        unsubCloud();
        unsubCloud = null;
      }

      if (nextUser) {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
          setCloudReachable(false);
          await disableCloudNetwork();
          setSyncStatus('Offline — changes saved locally in IndexedDB');
          return;
        }

        const reachable = await testConnection();
        if (generation !== activeAuthGeneration) return;

        if (!reachable) {
          setCloudReachable(false);
          await disableCloudNetwork();
          setSyncStatus('Cloud Firestore unreachable — operating in local-first mode');
          return;
        }

        setCloudReachable(true);
        setSyncStatus('Connected to Cloud Sync');
        try {
          await ensureUserProfile(nextUser);
          if (generation !== activeAuthGeneration) return;
          unsubCloud = subscribeToCloudLibrary(nextUser.uid, {
            onBooks: (cloudBooks) => {
              if (cloudBooks.length > 0) {
                setBooks((prev) => {
                  const merged = new Map<string, BookMetadata>();
                  for (const local of prev) merged.set(local.id, local);
                  for (const cloud of cloudBooks) {
                    const existing = merged.get(cloud.id);
                    merged.set(cloud.id, existing ? {...existing, ...cloud} : cloud);
                  }
                  const list = Array.from(merged.values());
                  list.forEach((b) => void saveBookLocal(b));
                  return list;
                });
              }
            },
            onAnnotations: (cloudAnns) => {
              if (cloudAnns.length > 0) {
                setAnnotations((prev) => {
                  const merged = new Map<string, Annotation>();
                  for (const a of prev) merged.set(a.id, a);
                  for (const a of cloudAnns) merged.set(a.id, a);
                  const list = Array.from(merged.values());
                  list.forEach((a) => void saveAnnotationLocal(a));
                  return list;
                });
              }
            },
            onCourses: (cloudCourses) => {
              if (cloudCourses.length > 0) {
                setCourses((prev) => {
                  const merged = new Map<string, StudyCourse>();
                  for (const c of prev) merged.set(c.id, c);
                  for (const c of cloudCourses) merged.set(c.id, c);
                  const list = Array.from(merged.values());
                  list.forEach((c) => void saveCourseLocal(c));
                  return list;
                });
              }
            },
            onGoal: (cloudGoal) => {
              setReadingGoal(cloudGoal);
              void saveReadingGoalLocal(cloudGoal);
            },
            onError: (err) => {
              if (err.message.includes('unavailable') || err.message.includes('offline')) {
                setCloudReachable(false);
                void disableCloudNetwork();
                setSyncStatus('Cloud Firestore temporarily unreachable — local-first mode active');
              } else {
                setSyncStatus(`Sync warning: ${err.message}`);
              }
            },
          });
        } catch (err) {
          setSyncStatus(err instanceof Error ? err.message : 'Cloud initialization warning');
        }
      } else {
        setCloudReachable(false);
        void disableCloudNetwork();
        setSyncStatus('Local-first mode (sign in for cross-device sync)');
      }
    });

    return () => {
      activeAuthGeneration++;
      unsubAuth();
      if (unsubCloud) unsubCloud();
    };
  }, []);

  // Keep Firestore network aligned with browser online/offline & simulated-offline state
  useEffect(() => {
    let cancelled = false;
    if (!user) {
      setCloudReachable(false);
      void disableCloudNetwork();
      return;
    }
    if (!isOnline || simulatedOffline) {
      setCloudReachable(false);
      void disableCloudNetwork();
      setSyncStatus('Offline mode — changes saved locally in IndexedDB');
      return;
    }
    void (async () => {
      await enableCloudNetwork();
      const reachable = await testConnection();
      if (cancelled) return;
      setCloudReachable(reachable);
      if (!reachable) {
        await disableCloudNetwork();
        setSyncStatus('Cloud Firestore unreachable — operating in local-first mode');
      } else {
        setSyncStatus('Connected to Cloud Sync');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, isOnline, simulatedOffline]);

  // Automated Local Storage Backup Runner
  const runBackupSnapshot = useCallback(
    async (trigger: 'manual' | 'auto') => {
      const destLabel = linkedBackupDirName
        ? `Local Disk (${linkedBackupDirName}) + IndexedDB`
        : 'IndexedDB Snapshot Vault';
      const {record, archive} = await createLocalBackupSnapshot(trigger, destLabel);
      setBackups((prev) => [record, ...prev].slice(0, 15));

      if (backupDirHandleRef.current) {
        try {
          const handle = await backupDirHandleRef.current.getFileHandle('docutrack-latest-backup.json', {
            create: true,
          });
          const writable = await handle.createWritable();
          await writable.write(JSON.stringify(archive, null, 2));
          await writable.close();
        } catch (err) {
          console.warn('Could not write to linked backup directory:', err);
        }
      }
    },
    [linkedBackupDirName],
  );

  const scheduleAutoBackup = useCallback(() => {
    if (preferences.backupFrequency !== 'onChange') return;
    if (autoBackupTimerRef.current) {
      window.clearTimeout(autoBackupTimerRef.current);
    }
    autoBackupTimerRef.current = window.setTimeout(() => {
      void runBackupSnapshot('auto');
    }, 4000);
  }, [preferences.backupFrequency, runBackupSnapshot]);

  // Scheduled Hourly / Daily Backup Interval
  useEffect(() => {
    if (preferences.backupFrequency !== 'hourly' && preferences.backupFrequency !== 'daily') {
      return;
    }
    const ms = preferences.backupFrequency === 'hourly' ? 3600000 : 86400000;
    const id = window.setInterval(() => {
      void runBackupSnapshot('auto');
    }, ms);
    return () => window.clearInterval(id);
  }, [preferences.backupFrequency, runBackupSnapshot]);

  const folderTree = useMemo(() => buildFolderTree(books), [books]);
  const visibleBooks = useMemo(
    () =>
      sortAndFilterBooks(books, {
        collection: activeCollection,
        folderPath: activeFolder,
        format: activeFormat,
        query: semanticMode ? '' : searchQuery,
        sortBy,
        sortDirection,
      }),
    [books, activeCollection, activeFolder, activeFormat, semanticMode, searchQuery, sortBy, sortDirection],
  );

  const openBook = useMemo(
    () => (openBookId ? books.find((b) => b.id === openBookId) || null : null),
    [books, openBookId],
  );

  const duplicateRemovableCount = useMemo(() => {
    const groups = findDuplicateBookGroups(books, annotations);
    return groups.reduce((acc, g) => acc + Math.max(0, g.books.length - 1), 0);
  }, [books, annotations]);

  const handleImportFileList = async (files: FileList | File[], fallbackFolder?: string) => {
    const supportedFiles = Array.from(files).filter((f) => detectSupportedBookFormat(f.name) !== null);
    if (importNoticeTimerRef.current) {
      window.clearTimeout(importNoticeTimerRef.current);
      importNoticeTimerRef.current = null;
    }

    if (supportedFiles.length === 0) {
      setImportNotice('No supported PDF, EPUB, or DjVu files were found in the selection.');
      importNoticeTimerRef.current = window.setTimeout(() => setImportNotice(null), 4500);
      return;
    }

    const ownerId = user?.uid || 'local';
    const isBulkBatch = supportedFiles.length > 4;
    const samplePageLimit = isBulkBatch ? 2 : 6;
    cancelImportRef.current = false;

    const allSuccessful: NonNullable<Awaited<ReturnType<typeof ingestImportedFile>>>[] = [];
    let pendingBooks: BookMetadata[] = [];
    let pendingChunks: DocumentTextChunk[] = [];
    let pendingCovers: Record<string, string> = {};

    const flushBatchToState = () => {
      if (pendingBooks.length === 0) return;
      const booksBatch = pendingBooks;
      const chunksBatch = pendingChunks;
      const coversBatch = pendingCovers;
      pendingBooks = [];
      pendingChunks = [];
      pendingCovers = {};

      setBooks((prev) => [...booksBatch, ...prev]);
      if (Object.keys(coversBatch).length > 0) {
        setBookCovers((prev) => ({...prev, ...coversBatch}));
      }
      if (chunksBatch.length > 0) {
        setTextChunks((prev) => [...chunksBatch, ...prev]);
      }
    };

    try {
      for (let i = 0; i < supportedFiles.length; i++) {
        if (cancelImportRef.current) break;

        const file = supportedFiles[i];
        setImportProgress({done: i, total: supportedFiles.length, currentName: file.name});
        setImportNotice(
          `Importing ${i + 1} of ${supportedFiles.length}: ${file.name}`,
        );

        const rel = (file as File & {webkitRelativePath?: string}).webkitRelativePath;
        const explicitFolder = rel && rel.includes('/') ? undefined : fallbackFolder;

        try {
          const res = await ingestImportedFile(file, ownerId, explicitFolder, {samplePageLimit});
          if (res) {
            allSuccessful.push(res);
            pendingBooks.unshift(res.book);
            pendingChunks.push(...res.chunks);
            if (res.coverDataUrl) pendingCovers[res.book.id] = res.coverDataUrl;
            if (user?.emailVerified && isOnline && !simulatedOffline && cloudReachable) {
              void syncBookToCloud(user.uid, res.book);
            }
          }
        } catch (err) {
          console.warn(`Skipped ${file.name} during import:`, err);
        }

        if (pendingBooks.length >= 4) {
          flushBatchToState();
        }

        // Yield to UI event loop & GC between files so CPU/RAM stay bounded
        if (i < supportedFiles.length - 1) {
          await new Promise((r) => window.setTimeout(r, isBulkBatch ? 24 : 8));
        }
      }

      flushBatchToState();
    } finally {
      setImportProgress(null);
    }

    if (allSuccessful.length > 0) {
      setOfflineBytes(await estimateOfflineStorageBytes());
      const wasCancelled = cancelImportRef.current;
      setImportNotice(
        wasCancelled
          ? `Import stopped early — saved ${allSuccessful.length} of ${supportedFiles.length} documents.`
          : `Imported ${allSuccessful.length} document${allSuccessful.length > 1 ? 's' : ''} into your library.`,
      );
      scheduleAutoBackup();

      // Only auto-run deep background text indexing for small imports (1..6 docs) so bulk imports stay lightweight
      const pendingIndex = allSuccessful.filter((r) => r.needsFullIndex);
      if (pendingIndex.length > 0 && allSuccessful.length <= 6) {
        window.setTimeout(() => {
          void (async () => {
            for (const item of pendingIndex) {
              const fullChunks = await indexRemainingBookChunks(item.book, item.chunks);
              if (fullChunks.length > item.chunks.length) {
                setTextChunks((prev) => [
                  ...prev.filter((c) => c.bookId !== item.book.id),
                  ...fullChunks,
                ]);
              }
              await new Promise((r) => window.setTimeout(r, 250));
            }
          })();
        }, 300);
      }
    } else {
      setImportNotice(
        cancelImportRef.current
          ? 'Import cancelled.'
          : 'No supported PDF, EPUB, or DjVu files could be imported.',
      );
    }
    importNoticeTimerRef.current = window.setTimeout(() => setImportNotice(null), 4500);
  };

  const handleImportDirectory = async () => {
    const win = window as unknown as {
      showDirectoryPicker?: () => Promise<DirectoryHandleLike>;
    };
    if (typeof win.showDirectoryPicker === 'function') {
      try {
        const dirHandle = await win.showDirectoryPicker();
        const collected: File[] = [];
        const walk = async (handle: DirectoryHandleLike | FileSystemHandleLike, prefix: string) => {
          if (!handle.values) return;
          for await (const entry of handle.values()) {
            if (entry.kind === 'file' && entry.getFile) {
              if (!detectSupportedBookFormat(entry.name)) continue;
              const f = await entry.getFile();
              Object.defineProperty(f, 'webkitRelativePath', {
                value: `${prefix}/${f.name}`,
                configurable: true,
              });
              collected.push(f);
            } else if (entry.kind === 'directory') {
              await walk(entry, `${prefix}/${entry.name}`);
            }
          }
        };
        await walk(dirHandle, dirHandle.name);
        await handleImportFileList(collected);
        return;
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
      }
    }
    folderInputRef.current?.click();
  };

  const handleAddConvertedToLibrary = async (
    buffer: ArrayBuffer,
    filename: string,
    targetFolder: string,
  ): Promise<BookMetadata | null> => {
    const ownerId = user?.uid || 'local';
    const res = await ingestImportedBuffer(buffer, filename, ownerId, targetFolder);
    if (!res) return null;

    setBooks((prev) => [res.book, ...prev]);
    if (res.coverDataUrl) {
      setBookCovers((prev) => ({...prev, [res.book.id]: res.coverDataUrl!}));
    }
    setTextChunks((prev) => [...res.chunks, ...prev]);
    setOfflineBytes(await estimateOfflineStorageBytes());
    if (user?.emailVerified && isOnline && !simulatedOffline && cloudReachable) {
      void syncBookToCloud(user.uid, res.book);
    }
    scheduleAutoBackup();
    setImportNotice(`Added converted "${res.book.title}" to your library.`);
    window.setTimeout(() => setImportNotice(null), 4000);
    return res.book;
  };

  const handleOpenBook = (
    book: BookMetadata,
    targetPage?: number,
    rightTab: 'typography' | 'translate' | 'course' | null = null,
  ) => {
    const pageToOpen = targetPage || book.currentPage || 1;
    const updated: BookMetadata = {
      ...book,
      currentPage: pageToOpen,
      progress: calculateProgress(pageToOpen, book.pageCount),
      lastOpenedAt: Date.now(),
      updatedAtMs: Date.now(),
    };
    setBooks((prev) => prev.map((b) => (b.id === book.id ? updated : b)));
    void saveBookLocal(updated);
    setReaderInitialRightTab(rightTab);
    setOpenBookId(book.id);
  };

  const handleUpdateProgress = useCallback(
    (bookId: string, page: number, pageCount: number) => {
      setBooks((prev) =>
        prev.map((b) => {
          if (b.id !== bookId) return b;
          const updated: BookMetadata = {
            ...b,
            pageCount: Math.max(1, pageCount),
            currentPage: Math.max(1, Math.min(page, pageCount)),
            progress: calculateProgress(page, pageCount),
            lastOpenedAt: Date.now(),
            updatedAtMs: Date.now(),
          };
          void saveBookLocal(updated);
          if (user?.emailVerified && isOnline && !simulatedOffline && cloudReachable) {
            void syncBookToCloud(user.uid, updated);
          }
          return updated;
        }),
      );
      scheduleAutoBackup();
    },
    [cloudReachable, isOnline, scheduleAutoBackup, simulatedOffline, user],
  );

  const handleToggleFavorite = (book: BookMetadata) => {
    const updated = {...book, isFavorite: !book.isFavorite, updatedAtMs: Date.now()};
    setBooks((prev) => prev.map((b) => (b.id === book.id ? updated : b)));
    void saveBookLocal(updated);
    if (user?.emailVerified && isOnline && !simulatedOffline && cloudReachable) {
      void syncBookToCloud(user.uid, updated);
    }
    scheduleAutoBackup();
  };

  const handleToggleOfflinePin = async (book: BookMetadata) => {
    const updated = {...book, offlinePinned: !book.offlinePinned, updatedAtMs: Date.now()};
    setBooks((prev) => prev.map((b) => (b.id === book.id ? updated : b)));
    await saveBookLocal(updated);
    setOfflineBytes(await estimateOfflineStorageBytes());
    if (user?.emailVerified && isOnline && !simulatedOffline && cloudReachable) {
      void syncBookToCloud(user.uid, updated);
    }
    scheduleAutoBackup();
  };

  const handleDeleteBook = async (book: BookMetadata) => {
    setBooks((prev) => prev.filter((b) => b.id !== book.id));
    setBookCovers((prev) => {
      const next = {...prev};
      delete next[book.id];
      return next;
    });
    setAnnotations((prev) => prev.filter((a) => a.bookId !== book.id));
    setCourses((prev) => prev.filter((c) => c.bookId !== book.id));
    setTextChunks((prev) => prev.filter((t) => t.bookId !== book.id));
    await deleteBookLocal(book.id);
    setOfflineBytes(await estimateOfflineStorageBytes());
    if (user?.emailVerified && isOnline && !simulatedOffline && cloudReachable) {
      void deleteBookFromCloud(user.uid, book.id);
    }
    scheduleAutoBackup();
  };

  const handleScanBookHashes = useCallback(async (): Promise<BookMetadata[]> => {
    const enriched = await scanAndBackfillBookHashes(books);
    setBooks(enriched);
    return enriched;
  }, [books]);

  const handleDeleteDuplicates = async (
    removals: {removeBook: BookMetadata; keepBookId: string}[],
    preserveAnnotations: boolean,
  ) => {
    if (removals.length === 0) return;
    const removeIds = new Set(removals.map((r) => r.removeBook.id));
    const keepMap = new Map(removals.map((r) => [r.removeBook.id, r.keepBookId]));
    const bookById = new Map(books.map((b) => [b.id, b]));

    if (preserveAnnotations) {
      const toMigrate = annotations.filter((a) => removeIds.has(a.bookId));
      const migrated: Annotation[] = [];
      for (const oldAnn of toMigrate) {
        const targetBookId = keepMap.get(oldAnn.bookId);
        if (!targetBookId || !bookById.has(targetBookId)) continue;
        const now = Date.now();
        const nextAnn: Annotation = {
          ...oldAnn,
          id: sanitizeId(`ann_${now}_${Math.random().toString(36).slice(2, 6)}`),
          bookId: targetBookId,
          createdAtMs: oldAnn.createdAtMs || now,
          updatedAtMs: now,
        };
        migrated.push(nextAnn);
        await saveAnnotationLocal(nextAnn);
        await deleteAnnotationLocal(oldAnn.id);
        if (user?.emailVerified && isOnline && !simulatedOffline && cloudReachable) {
          void syncAnnotationToCloud(user.uid, nextAnn);
          void deleteAnnotationFromCloud(user.uid, oldAnn.id);
        }
      }
      if (migrated.length > 0) {
        setAnnotations((prev) => [
          ...migrated,
          ...prev.filter((a) => !removeIds.has(a.bookId)),
        ]);
      }
    }

    for (const item of removals) {
      if (openBookId === item.removeBook.id) {
        setOpenBookId(item.keepBookId);
      }
      await handleDeleteBook(item.removeBook);
    }

    if (importNoticeTimerRef.current) {
      window.clearTimeout(importNoticeTimerRef.current);
      importNoticeTimerRef.current = null;
    }
    setImportNotice(
      `Removed ${removals.length} duplicate ${removals.length === 1 ? 'entry' : 'entries'} from your DocuTrack library.`,
    );
    importNoticeTimerRef.current = window.setTimeout(() => setImportNotice(null), 4500);
  };

  const handleAddAnnotation = (
    draft: Omit<Annotation, 'id' | 'ownerId' | 'createdAtMs' | 'updatedAtMs'>,
  ) => {
    const now = Date.now();
    const ann: Annotation = {
      ...draft,
      id: sanitizeId(`ann_${now}`),
      ownerId: user?.uid || 'local',
      createdAtMs: now,
      updatedAtMs: now,
    };
    setAnnotations((prev) => [ann, ...prev]);
    void saveAnnotationLocal(ann);
    if (user?.emailVerified && isOnline && !simulatedOffline && cloudReachable) {
      void syncAnnotationToCloud(user.uid, ann);
    }
    scheduleAutoBackup();
  };

  const handleUpdateAnnotation = (
    id: string,
    patch: Partial<Pick<Annotation, 'note' | 'color' | 'tags'>>,
  ) => {
    setAnnotations((prev) =>
      prev.map((a) => {
        if (a.id !== id) return a;
        const updated: Annotation = {...a, ...patch, updatedAtMs: Date.now()};
        void saveAnnotationLocal(updated);
        if (user?.emailVerified && isOnline && !simulatedOffline && cloudReachable) {
          void syncAnnotationToCloud(user.uid, updated);
        }
        return updated;
      }),
    );
    scheduleAutoBackup();
  };

  const handleDeleteAnnotation = (id: string) => {
    setAnnotations((prev) => prev.filter((a) => a.id !== id));
    void deleteAnnotationLocal(id);
    if (user?.emailVerified && isOnline && !simulatedOffline && cloudReachable) {
      void deleteAnnotationFromCloud(user.uid, id);
    }
    scheduleAutoBackup();
  };

  const handleUpdatePreferences = (nextPrefs: ReaderPreferences) => {
    setPreferences(nextPrefs);
    void savePreferencesLocal(nextPrefs);
    if (user?.emailVerified && isOnline && !simulatedOffline && cloudReachable) {
      void syncPreferencesToCloud(user.uid, nextPrefs);
    }
  };

  const handleRecordReadingActivity = useCallback(
    (pagesDelta: number, minutesDelta: number) => {
      setReadingGoal((prev) => {
        const next = recordReadingActivity(prev, pagesDelta, minutesDelta);
        void saveReadingGoalLocal(next);
        if (user?.emailVerified && isOnline && !simulatedOffline && cloudReachable) {
          void syncReadingGoalToCloud(user.uid, next);
        }
        return next;
      });
      scheduleAutoBackup();
    },
    [cloudReachable, isOnline, scheduleAutoBackup, simulatedOffline, user],
  );

  const handleUpdateGoalTargets = (targets: {
    dailyPagesTarget: number;
    weeklyMinutesTarget: number;
    yearlyBooksTarget: number;
  }) => {
    setReadingGoal((prev) => {
      const next: ReadingGoal = {
        ...prev,
        ...targets,
        updatedAtMs: Date.now(),
      };
      void saveReadingGoalLocal(next);
      if (user?.emailVerified && isOnline && !simulatedOffline && cloudReachable) {
        void syncReadingGoalToCloud(user.uid, next);
      }
      return next;
    });
    scheduleAutoBackup();
  };

  const handleRunSemanticSearch = async (query: string) => {
    setSemanticLoading(true);
    if (!isOnline || simulatedOffline) {
      const localHits = searchLocalSemanticChunks(query, textChunks);
      setSemanticResults(localHits);
      setSemanticSourceLabel('Offline Local Semantic Index');
      setSemanticLoading(false);
      return;
    }

    try {
      const res = await fetch('/api/ai/semantic-search', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({query, chunks: textChunks}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Semantic search error');
      setSemanticResults(data.results || []);
      setSemanticSourceLabel('Gemini Semantic Embedding Index');
    } catch {
      const localHits = searchLocalSemanticChunks(query, textChunks);
      setSemanticResults(localHits);
      setSemanticSourceLabel('Local Semantic Fallback (API unavailable)');
    } finally {
      setSemanticLoading(false);
    }
  };

  const handleGenerateCourse = async (
    book: BookMetadata,
    mode: 'course' | 'summary',
    textContent: string,
  ): Promise<StudyCourse | null> => {
    const res = await fetch('/api/ai/course', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        title: book.title,
        author: book.author,
        content: textContent,
        mode,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to generate AI course.');

    const now = Date.now();
    const course: StudyCourse = {
      id: sanitizeId(`course_${book.id}_${now}`),
      ownerId: user?.uid || 'local',
      bookId: book.id,
      title: data.title || `${book.title} — Study Course`,
      summary: data.summary || '',
      keyConcepts: Array.isArray(data.keyConcepts) ? data.keyConcepts : [],
      modules: Array.isArray(data.modules) ? data.modules : [],
      createdAtMs: now,
      updatedAtMs: now,
    };
    setCourses((prev) => [course, ...prev.filter((c) => c.bookId !== book.id)]);
    await saveCourseLocal(course);
    if (user?.emailVerified && isOnline && !simulatedOffline && cloudReachable) {
      void syncCourseToCloud(user.uid, course);
    }
    scheduleAutoBackup();
    return course;
  };

  const handleSyncAllToCloud = async () => {
    if (!user) return;
    if (!isOnline || simulatedOffline) {
      setSyncStatus('Offline mode — library is saved locally and will sync when online.');
      return;
    }
    setSyncStatus('Checking Firestore connection...');
    const reachable = await testConnection();
    if (!reachable) {
      setCloudReachable(false);
      await disableCloudNetwork();
      setSyncStatus('Cloud Firestore unreachable — changes remain safely stored locally in IndexedDB.');
      return;
    }
    setCloudReachable(true);
    setSyncStatus('Synchronizing library to Firestore...');
    try {
      await ensureUserProfile(user);
      for (const b of books) await syncBookToCloud(user.uid, b);
      for (const a of annotations) await syncAnnotationToCloud(user.uid, a);
      for (const c of courses) await syncCourseToCloud(user.uid, c);
      await syncPreferencesToCloud(user.uid, preferences);
      await syncReadingGoalToCloud(user.uid, readingGoal);
      setSyncStatus(`Synchronized ${books.length} books & ${annotations.length} notes at ${new Date().toLocaleTimeString()}`);
    } catch (err) {
      setSyncStatus(err instanceof Error ? err.message : 'Cloud sync failed');
    }
  };

  const handleDownloadBackupFile = async (backupId?: string) => {
    const archive = backupId
      ? await getBackupArchiveById(backupId)
      : (await createLocalBackupSnapshot('manual', 'Exported Archive File')).archive;
    if (!archive) return;

    const blob = new Blob([JSON.stringify(archive, null, 2)], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `docutrack-library-${new Date(archive.exportedAtMs).toISOString().slice(0, 10)}.docutrack-backup.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleRestoreBackupFile = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text());
      if (!validateBackupArchive(parsed)) {
        setImportNotice('Invalid backup archive format.');
        return;
      }
      await restoreFromArchive(parsed);
      const refreshed = await initializeLibraryStore();
      setBooks(refreshed.books);
      setAnnotations(refreshed.annotations);
      setCourses(refreshed.courses);
      setPreferences(refreshed.preferences);
      setReadingGoal(refreshed.readingGoal);
      setTextChunks(refreshed.textChunks);
      setImportNotice(`Restored ${refreshed.books.length} books from backup archive.`);
    } catch {
      setImportNotice('Failed to parse backup JSON file.');
    }
    window.setTimeout(() => setImportNotice(null), 4000);
  };

  const handleRestoreSnapshot = async (backupId: string) => {
    const archive = await getBackupArchiveById(backupId);
    if (!archive) return;
    await restoreFromArchive(archive);
    const refreshed = await initializeLibraryStore();
    setBooks(refreshed.books);
    setAnnotations(refreshed.annotations);
    setCourses(refreshed.courses);
    setPreferences(refreshed.preferences);
    setReadingGoal(refreshed.readingGoal);
    setImportNotice('Restored library state from local snapshot.');
    window.setTimeout(() => setImportNotice(null), 4000);
  };

  const handleLinkLocalBackupFolder = async () => {
    const win = window as unknown as {
      showDirectoryPicker?: (opts?: {mode?: string}) => Promise<DirectoryHandleLike>;
    };
    if (!win.showDirectoryPicker) return;
    try {
      const handle = await win.showDirectoryPicker({mode: 'readwrite'});
      backupDirHandleRef.current = handle;
      setLinkedBackupDirName(handle.name);
      await runBackupSnapshot('manual');
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        console.warn('Directory link cancelled or unavailable:', err);
      }
    }
  };

  const handleUpdateCustomCloudConfig = (next: CustomCloudConfig, persistSecret: boolean) => {
    setCustomCloudConfig(next);
    saveCustomCloudConfig(next, persistSecret);
  };

  const handleTestCustomCloud = async (): Promise<{ok: boolean; message: string}> => {
    if (!isOnline || simulatedOffline) {
      return {ok: false, message: 'Disable Offline Reading Mode to test your remote storage endpoint.'};
    }
    setCustomCloudBusy(true);
    try {
      return await testCustomCloudConnection(customCloudConfig);
    } catch (err) {
      return {ok: false, message: err instanceof Error ? err.message : 'Connection test failed.'};
    } finally {
      setCustomCloudBusy(false);
    }
  };

  const handlePullCustomCloud = async () => {
    if (!isOnline || simulatedOffline) {
      setCustomCloudStatus('Offline mode active — reconnect to pull from custom cloud storage.');
      return;
    }
    setCustomCloudBusy(true);
    setCustomCloudStatus('Pulling remote library archive...');
    try {
      const remote = await pullFromCustomCloud(customCloudConfig);
      if (!remote.found || !remote.archive) {
        setCustomCloudStatus('No remote DocuTrack archive found at this endpoint yet.');
        return;
      }
      const {archive: localArchive} = await createLocalBackupSnapshot('auto', 'Pre-Pull Local State');
      const merged = mergeLibraryArchives(localArchive, remote.archive);
      await restoreFromArchive(merged);
      const refreshed = await initializeLibraryStore();
      setBooks(refreshed.books);
      setBookCovers(refreshed.covers);
      setAnnotations(refreshed.annotations);
      setCourses(refreshed.courses);
      setPreferences(refreshed.preferences);
      setReadingGoal(refreshed.readingGoal);
      setTextChunks(refreshed.textChunks);
      const nextCfg: CustomCloudConfig = {...customCloudConfig, lastSyncedAtMs: Date.now()};
      setCustomCloudConfig(nextCfg);
      saveCustomCloudConfig(nextCfg, Boolean(nextCfg.secret));
      setCustomCloudStatus(
        `Merged ${merged.books.length} books & ${merged.annotations.length} annotations from remote storage.`,
      );
    } catch (err) {
      setCustomCloudStatus(err instanceof Error ? err.message : 'Pull from custom cloud failed.');
    } finally {
      setCustomCloudBusy(false);
    }
  };

  const handleSyncCustomCloud = async () => {
    if (!isOnline || simulatedOffline) {
      setCustomCloudStatus('Offline mode active — changes remain safely in IndexedDB.');
      return;
    }
    setCustomCloudBusy(true);
    setCustomCloudStatus('Synchronizing with custom cloud storage...');
    try {
      const {archive: localArchive} = await createLocalBackupSnapshot('manual', 'Custom Cloud Sync Snapshot');
      let payloadToPush = localArchive;

      try {
        const remote = await pullFromCustomCloud(customCloudConfig);
        if (remote.found && remote.archive) {
          payloadToPush = mergeLibraryArchives(localArchive, remote.archive);
          await restoreFromArchive(payloadToPush);
          const refreshed = await initializeLibraryStore();
          setBooks(refreshed.books);
          setBookCovers(refreshed.covers);
          setAnnotations(refreshed.annotations);
          setCourses(refreshed.courses);
          setPreferences(refreshed.preferences);
          setReadingGoal(refreshed.readingGoal);
          setTextChunks(refreshed.textChunks);
        }
      } catch (pullErr) {
        // Proceed with push if file does not exist yet (404 handled cleanly inside pullFromCustomCloud)
        throw pullErr;
      }

      const pushRes = await pushToCustomCloud(customCloudConfig, payloadToPush);
      const nextCfg: CustomCloudConfig = {...customCloudConfig, lastSyncedAtMs: Date.now()};
      setCustomCloudConfig(nextCfg);
      saveCustomCloudConfig(nextCfg, Boolean(nextCfg.secret));
      setCustomCloudStatus(
        `Synced ${payloadToPush.books.length} books & ${payloadToPush.annotations.length} notes (${Math.round(
          pushRes.uploadedBytes / 1024,
        )} KB) to custom cloud.`,
      );
    } catch (err) {
      setCustomCloudStatus(err instanceof Error ? err.message : 'Custom cloud sync failed.');
    } finally {
      setCustomCloudBusy(false);
    }
  };

  if (!initialized) {
    return (
      <div className="min-h-screen flex items-center justify-center app-shell-bg text-sm opacity-75">
        Opening DocuTrack Library...
      </div>
    );
  }

  // Full-Viewport Distraction-Free Document Reader
  if (openBook) {
    return (
      <ReaderView
        book={openBook}
        annotations={annotations}
        courses={courses}
        preferences={preferences}
        isOnline={isOnline}
        simulatedOffline={simulatedOffline}
        initialRightTab={readerInitialRightTab}
        onBack={() => setOpenBookId(null)}
        onUpdateProgress={handleUpdateProgress}
        onUpdatePreferences={handleUpdatePreferences}
        onAddAnnotation={handleAddAnnotation}
        onUpdateAnnotation={handleUpdateAnnotation}
        onDeleteAnnotation={handleDeleteAnnotation}
        onGenerateCourse={handleGenerateCourse}
        onRecordReadingSession={handleRecordReadingActivity}
      />
    );
  }

  const effectiveOffline = !isOnline || simulatedOffline;
  const darkActive = isDarkUiTheme(preferences.uiTheme);

  return (
    <div className="min-h-screen flex flex-col app-shell-bg">
      {/* Hidden File & Directory Inputs */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.epub,.djvu"
        multiple
        onChange={(e) => {
          if (e.target.files) {
            const folder = pendingUploadFolderRef.current;
            pendingUploadFolderRef.current = undefined;
            void handleImportFileList(e.target.files, folder);
          }
          e.target.value = '';
        }}
        className="hidden"
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        // @ts-expect-error webkitdirectory is standard in Chromium/WebKit for local folder traversal
        webkitdirectory=""
        onChange={(e) => {
          if (e.target.files) void handleImportFileList(e.target.files);
          e.target.value = '';
        }}
        className="hidden"
      />

      {/* Unified Import & Appearance Modals */}
      <ImportModal
        open={importModalOpen}
        onClose={() => setImportModalOpen(false)}
        onPickFiles={(targetFolder) => {
          pendingUploadFolderRef.current = targetFolder;
          fileInputRef.current?.click();
        }}
        onPickFolder={() => void handleImportDirectory()}
        onDropFiles={async (files, fallbackFolder) => {
          await handleImportFileList(files, fallbackFolder);
        }}
      />

      <AppearanceDialog
        open={appearanceOpen}
        preferences={preferences}
        onUpdatePreferences={handleUpdatePreferences}
        onClose={() => setAppearanceOpen(false)}
      />

      <DuplicatesModal
        open={duplicatesOpen}
        books={books}
        annotations={annotations}
        onClose={() => setDuplicatesOpen(false)}
        onScanHashes={handleScanBookHashes}
        onDeleteDuplicates={handleDeleteDuplicates}
      />

      {/* Strict 3-Zone Top Bar Contract */}
      <header className="h-16 px-6 app-surface border-b app-border flex items-center justify-between gap-8 shrink-0">
        {/* Zone 1: Single-element Brand Wordmark */}
        <a
          href="/"
          aria-label="DocuTrack Home"
          onClick={(e) => {
            e.preventDefault();
            setActiveTab('library');
          }}
          className="whitespace-nowrap shrink-0"
        >
          <DocuTrackLogo />
        </a>

        {/* Zone 2: Clean Single-Line Navigation Links */}
        <nav aria-label="Primary workspace" className="hidden md:flex items-center gap-6 text-sm font-medium">
          {(
            [
              {id: 'library', label: 'Library'},
              {id: 'goals', label: 'Goals'},
              {id: 'courses', label: 'Study Courses'},
              {id: 'convert', label: 'Convert'},
              {id: 'sync', label: 'Sync & Backups'},
            ] as const
          ).map((item) => {
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`whitespace-nowrap shrink-0 py-1 border-b-2 transition-colors ${
                  active
                    ? 'accent-border font-semibold'
                    : 'border-transparent opacity-65 hover:opacity-100'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </nav>

        {/* Zone 3: Single Primary Import Action */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setImportModalOpen(true)}
            className="px-4 py-2 rounded-lg accent-btn text-xs font-medium transition-colors flex items-center gap-2 whitespace-nowrap shrink-0"
          >
            <FolderUp className="w-3.5 h-3.5" aria-hidden="true" />
            Import
          </button>
        </div>
      </header>

      {/* Mobile Secondary Navigation Strip */}
      <div className="md:hidden flex items-center justify-between gap-1 px-3 py-2 app-surface border-b app-border overflow-x-auto">
        {(
          [
            {id: 'library', label: 'Library'},
            {id: 'goals', label: 'Goals'},
            {id: 'courses', label: 'Courses'},
            {id: 'convert', label: 'Convert'},
            {id: 'sync', label: 'Sync'},
          ] as const
        ).map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setActiveTab(item.id)}
            className={`px-2.5 py-1.5 rounded-md text-xs font-medium whitespace-nowrap ${
              activeTab === item.id ? 'accent-soft font-semibold' : 'opacity-65'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {/* Offline Status or Import Feedback Bar */}
      {(effectiveOffline || importNotice) && (
        <div className="px-6 py-2 border-b app-border bg-amber-50 dark:bg-amber-950/30 text-amber-900 dark:text-amber-200 text-xs flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            {effectiveOffline && <WifiOff className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />}
            <span>
              {importNotice ||
                'Offline Reading Mode active — all pinned PDF, EPUB, DjVu files, annotations, and study courses remain available from local IndexedDB.'}
            </span>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {importProgress && (
              <button
                type="button"
                onClick={() => {
                  cancelImportRef.current = true;
                }}
                className="font-medium underline whitespace-nowrap"
              >
                Cancel ({importProgress.done}/{importProgress.total})
              </button>
            )}
            {simulatedOffline && (
              <button
                type="button"
                onClick={() => setSimulatedOffline(false)}
                className="font-medium underline whitespace-nowrap"
              >
                Reconnect
              </button>
            )}
          </div>
        </div>
      )}

      {/* Workspace Body */}
      <div className="flex-1 flex flex-col lg:flex-row min-h-0">
        {activeTab === 'library' && (
          <>
            <LibrarySidebar
              books={books}
              folderTree={folderTree}
              activeCollection={activeCollection}
              activeFolder={activeFolder}
              activeFormat={activeFormat}
              simulatedOffline={simulatedOffline}
              isOnline={isOnline}
              userEmail={user?.email || null}
              readingGoal={readingGoal}
              collapsed={sidebarCollapsed}
              onToggleCollapse={() => setSidebarCollapsed((prev) => !prev)}
              onSelectCollection={setActiveCollection}
              onSelectFolder={setActiveFolder}
              onSelectFormat={setActiveFormat}
              onToggleSimulatedOffline={() => setSimulatedOffline((prev) => !prev)}
              onOpenSyncBackup={() => setActiveTab('sync')}
              onOpenGoals={() => setActiveTab('goals')}
            />
            <div className="flex-1 flex flex-col min-w-0">
              <LibraryView
                books={visibleBooks}
                totalBooksCount={books.length}
                folderTree={folderTree}
                activeCollection={activeCollection}
                bookCovers={bookCovers}
                annotations={annotations}
                courses={courses}
                activeFolder={activeFolder}
                searchQuery={searchQuery}
                semanticMode={semanticMode}
                semanticResults={semanticResults}
                semanticLoading={semanticLoading}
                semanticSourceLabel={semanticSourceLabel}
                sortBy={sortBy}
                sortDirection={sortDirection}
                viewMode={viewMode}
                onSelectFolder={setActiveFolder}
                onSearchChange={setSearchQuery}
                onToggleSemanticMode={() => {
                  setSemanticMode((prev) => !prev);
                  setSemanticResults([]);
                  setSemanticSourceLabel(null);
                }}
                onRunSemanticSearch={(q) => void handleRunSemanticSearch(q)}
                onSortChange={setSortBy}
                onToggleSortDirection={() =>
                  setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'))
                }
                onViewModeChange={setViewMode}
                onOpenBook={handleOpenBook}
                onToggleFavorite={handleToggleFavorite}
                onToggleOfflinePin={(b) => void handleToggleOfflinePin(b)}
                onDeleteBook={(b) => void handleDeleteBook(b)}
                onOpenCourseModal={(b) => {
                  handleOpenBook(b, undefined, 'course');
                }}
                onConvertBook={(b) => {
                  setConverterBookId(b.id);
                  setActiveTab('convert');
                }}
                onTriggerImport={() => setImportModalOpen(true)}
                onDropFiles={async (files) => {
                  await handleImportFileList(files);
                }}
                onOpenDuplicatesModal={() => setDuplicatesOpen(true)}
                duplicateCount={duplicateRemovableCount}
              />
            </div>
          </>
        )}

        {activeTab === 'goals' && (
          <ReadingGoalsView
            goal={readingGoal}
            books={books}
            onLogActivity={handleRecordReadingActivity}
            onUpdateTargets={handleUpdateGoalTargets}
            onOpenBook={(b) => handleOpenBook(b)}
          />
        )}

        {activeTab === 'courses' && (
          <CoursesHubView
            books={books}
            courses={courses}
            isOnline={isOnline}
            simulatedOffline={simulatedOffline}
            onOpenBook={(b) => handleOpenBook(b)}
            onGenerateCourse={handleGenerateCourse}
          />
        )}

        {activeTab === 'convert' && (
          <ConverterView
            books={books}
            initialBookId={converterBookId}
            onAddConvertedToLibrary={handleAddConvertedToLibrary}
            onOpenBook={(b) => handleOpenBook(b)}
          />
        )}

        {activeTab === 'sync' && (
          <SyncBackupView
            user={user}
            syncStatus={syncStatus}
            books={books}
            offlineBytes={offlineBytes}
            backups={backups}
            preferences={preferences}
            linkedBackupDirName={linkedBackupDirName}
            customCloudConfig={customCloudConfig}
            customCloudStatus={customCloudStatus}
            customCloudBusy={customCloudBusy}
            onSignIn={() => void signInWithGoogle()}
            onSignOut={() => void signOutUser()}
            onSyncAllToCloud={() => void handleSyncAllToCloud()}
            onToggleOfflinePin={(b) => void handleToggleOfflinePin(b)}
            onPinAllOffline={() => {
              books.forEach((b) => {
                if (!b.offlinePinned) void handleToggleOfflinePin(b);
              });
            }}
            onChangeBackupFrequency={(freq: BackupFrequency) =>
              handleUpdatePreferences({...preferences, backupFrequency: freq, updatedAtMs: Date.now()})
            }
            onTriggerManualBackup={() => void runBackupSnapshot('manual')}
            onDownloadBackupFile={(id) => void handleDownloadBackupFile(id)}
            onRestoreBackupFile={(file) => void handleRestoreBackupFile(file)}
            onRestoreSnapshot={(id) => void handleRestoreSnapshot(id)}
            onLinkLocalBackupFolder={() => void handleLinkLocalBackupFolder()}
            onUpdateCustomCloudConfig={handleUpdateCustomCloudConfig}
            onTestCustomCloud={handleTestCustomCloud}
            onSyncCustomCloud={handleSyncCustomCloud}
            onPullCustomCloud={handlePullCustomCloud}
          />
        )}
      </div>

      {/* Quiet Workspace Footer with Themes, Accent Colors & Fonts */}
      <footer className="px-6 py-3 border-t app-border app-surface flex flex-wrap items-center justify-between gap-3 text-xs opacity-85">
        <span>DocuTrack — Local-first PDF, EPUB &amp; DjVu Library</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setAppearanceOpen(true)}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md border app-border hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
          >
            <Palette className="w-3.5 h-3.5 accent-text" aria-hidden="true" />
            <span>Themes &amp; Fonts</span>
          </button>
          <button
            type="button"
            onClick={() =>
              handleUpdatePreferences({
                ...preferences,
                uiTheme: darkActive ? 'light' : 'dark',
                updatedAtMs: Date.now(),
              })
            }
            aria-label={darkActive ? 'Switch to Light theme' : 'Switch to Dark theme'}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md border app-border hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
          >
            {darkActive ? (
              <>
                <Sun className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Light</span>
              </>
            ) : (
              <>
                <Moon className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Dark</span>
              </>
            )}
          </button>
        </div>
      </footer>
    </div>
  );
}
