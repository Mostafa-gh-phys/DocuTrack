import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {onAuthStateChanged, type User} from 'firebase/auth';
import {FolderUp, Moon, Sun, WifiOff} from 'lucide-react';
import {CoursesHubView} from './components/CoursesHubView';
import {DocuTrackLogo} from './components/DocuTrackLogo';
import {LibrarySidebar} from './components/LibrarySidebar';
import {LibraryView} from './components/LibraryView';
import {ReaderView} from './components/ReaderView';
import {ReadingGoalsView} from './components/ReadingGoalsView';
import {SyncBackupView} from './components/SyncBackupView';
import {
  auth,
  deleteAnnotationFromCloud,
  deleteBookFromCloud,
  ensureUserProfile,
  signInWithGoogle,
  signOutUser,
  subscribeToCloudLibrary,
  syncAnnotationToCloud,
  syncBookToCloud,
  syncCourseToCloud,
  syncPreferencesToCloud,
  syncReadingGoalToCloud,
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
  recordReadingActivity,
  runWithConcurrency,
  sanitizeId,
  searchLocalSemanticChunks,
  sortAndFilterBooks,
  validateBackupArchive,
} from './utils/libraryLogic';
import {
  createLocalBackupSnapshot,
  DEFAULT_PREFERENCES,
  deleteAnnotationLocal,
  deleteBookLocal,
  estimateOfflineStorageBytes,
  getBackupArchiveById,
  indexRemainingBookChunks,
  ingestImportedFile,
  initializeLibraryStore,
  restoreFromArchive,
  saveAnnotationLocal,
  saveBookLocal,
  saveCourseLocal,
  savePreferencesLocal,
  saveReadingGoalLocal,
} from './utils/offlineStorage';

type WorkspaceTab = 'library' | 'goals' | 'courses' | 'sync';

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
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [courses, setCourses] = useState<StudyCourse[]>([]);
  const [textChunks, setTextChunks] = useState<DocumentTextChunk[]>([]);
  const [preferences, setPreferences] = useState<ReaderPreferences>(DEFAULT_PREFERENCES);
  const [readingGoal, setReadingGoal] = useState<ReadingGoal>(() => createDefaultReadingGoal('local'));
  const [backups, setBackups] = useState<BackupSnapshotRecord[]>([]);
  const [offlineBytes, setOfflineBytes] = useState(0);

  // Library filters & sort state
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
  const [syncStatus, setSyncStatus] = useState('Local library ready');
  const [importNotice, setImportNotice] = useState<string | null>(null);

  // Automated local disk backup handle
  const backupDirHandleRef = useRef<DirectoryHandleLike | null>(null);
  const [linkedBackupDirName, setLinkedBackupDirName] = useState<string | null>(null);
  const autoBackupTimerRef = useRef<number | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  // Sync Tailwind dark class on <html>
  useEffect(() => {
    const root = document.documentElement;
    if (preferences.uiTheme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [preferences.uiTheme]);

  // Initial IndexedDB Hydration
  useEffect(() => {
    async function boot() {
      const store = await initializeLibraryStore();
      setBooks(store.books);
      setAnnotations(store.annotations);
      setCourses(store.courses);
      setPreferences(store.preferences);
      setReadingGoal(store.readingGoal);
      setTextChunks(store.textChunks);
      setBackups(store.backups);
      setOfflineBytes(await estimateOfflineStorageBytes());
      setInitialized(true);
    }
    void boot();
  }, []);

  // Firebase Auth Listener & Cross-Device Cloud Subscription
  useEffect(() => {
    let unsubCloud: (() => void) | null = null;

    const unsubAuth = onAuthStateChanged(auth, async (nextUser) => {
      setUser(nextUser);
      if (unsubCloud) {
        unsubCloud();
        unsubCloud = null;
      }

      if (nextUser) {
        setSyncStatus('Connected to Cloud Sync');
        try {
          await ensureUserProfile(nextUser);
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
              setSyncStatus(`Sync warning: ${err.message}`);
            },
          });
        } catch (err) {
          setSyncStatus(err instanceof Error ? err.message : 'Cloud initialization warning');
        }
      } else {
        setSyncStatus('Local-first mode (sign in for cross-device sync)');
      }
    });

    return () => {
      unsubAuth();
      if (unsubCloud) unsubCloud();
    };
  }, []);

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
    }, 1500);
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

  const handleImportFileList = async (files: FileList | File[]) => {
    const supportedFiles = Array.from(files).filter((f) => detectSupportedBookFormat(f.name) !== null);
    if (supportedFiles.length === 0) {
      setImportNotice('No supported PDF, EPUB, or DjVu files were found in the selection.');
      window.setTimeout(() => setImportNotice(null), 4500);
      return;
    }

    const ownerId = user?.uid || 'local';
    setImportNotice(
      `Importing ${supportedFiles.length} document${supportedFiles.length > 1 ? 's' : ''}...`,
    );

    const results = await runWithConcurrency(supportedFiles, 3, async (file) => {
      const res = await ingestImportedFile(file, ownerId);
      if (res && user?.emailVerified && isOnline && !simulatedOffline) {
        void syncBookToCloud(user.uid, res.book);
      }
      return res;
    });

    const successful = results.filter(
      (r): r is NonNullable<typeof r> => r !== null,
    );

    if (successful.length > 0) {
      const newBooks = successful.map((r) => r.book);
      const newChunks = successful.flatMap((r) => r.chunks);
      setBooks((prev) => [...newBooks, ...prev]);
      setTextChunks((prev) => [...newChunks, ...prev]);
      setOfflineBytes(await estimateOfflineStorageBytes());
      setImportNotice(
        `Imported ${successful.length} document${successful.length > 1 ? 's' : ''} into your library.`,
      );
      scheduleAutoBackup();

      // Quietly index remaining pages of multi-page documents in background without blocking UI
      const pendingIndex = successful.filter((r) => r.needsFullIndex);
      if (pendingIndex.length > 0) {
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
            }
          })();
        }, 120);
      }
    } else {
      setImportNotice('No supported PDF, EPUB, or DjVu files could be imported.');
    }
    window.setTimeout(() => setImportNotice(null), 4500);
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
          if (user?.emailVerified && isOnline && !simulatedOffline) {
            void syncBookToCloud(user.uid, updated);
          }
          return updated;
        }),
      );
      scheduleAutoBackup();
    },
    [isOnline, scheduleAutoBackup, simulatedOffline, user],
  );

  const handleToggleFavorite = (book: BookMetadata) => {
    const updated = {...book, isFavorite: !book.isFavorite, updatedAtMs: Date.now()};
    setBooks((prev) => prev.map((b) => (b.id === book.id ? updated : b)));
    void saveBookLocal(updated);
    if (user?.emailVerified && isOnline && !simulatedOffline) {
      void syncBookToCloud(user.uid, updated);
    }
    scheduleAutoBackup();
  };

  const handleToggleOfflinePin = async (book: BookMetadata) => {
    const updated = {...book, offlinePinned: !book.offlinePinned, updatedAtMs: Date.now()};
    setBooks((prev) => prev.map((b) => (b.id === book.id ? updated : b)));
    await saveBookLocal(updated);
    setOfflineBytes(await estimateOfflineStorageBytes());
    if (user?.emailVerified && isOnline && !simulatedOffline) {
      void syncBookToCloud(user.uid, updated);
    }
    scheduleAutoBackup();
  };

  const handleDeleteBook = async (book: BookMetadata) => {
    setBooks((prev) => prev.filter((b) => b.id !== book.id));
    setAnnotations((prev) => prev.filter((a) => a.bookId !== book.id));
    setCourses((prev) => prev.filter((c) => c.bookId !== book.id));
    setTextChunks((prev) => prev.filter((t) => t.bookId !== book.id));
    await deleteBookLocal(book.id);
    setOfflineBytes(await estimateOfflineStorageBytes());
    if (user?.emailVerified && isOnline && !simulatedOffline) {
      void deleteBookFromCloud(user.uid, book.id);
    }
    scheduleAutoBackup();
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
    if (user?.emailVerified && isOnline && !simulatedOffline) {
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
        if (user?.emailVerified && isOnline && !simulatedOffline) {
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
    if (user?.emailVerified && isOnline && !simulatedOffline) {
      void deleteAnnotationFromCloud(user.uid, id);
    }
    scheduleAutoBackup();
  };

  const handleUpdatePreferences = (nextPrefs: ReaderPreferences) => {
    setPreferences(nextPrefs);
    void savePreferencesLocal(nextPrefs);
    if (user?.emailVerified && isOnline && !simulatedOffline) {
      void syncPreferencesToCloud(user.uid, nextPrefs);
    }
  };

  const handleRecordReadingActivity = useCallback(
    (pagesDelta: number, minutesDelta: number) => {
      setReadingGoal((prev) => {
        const next = recordReadingActivity(prev, pagesDelta, minutesDelta);
        void saveReadingGoalLocal(next);
        if (user?.emailVerified && isOnline && !simulatedOffline) {
          void syncReadingGoalToCloud(user.uid, next);
        }
        return next;
      });
      scheduleAutoBackup();
    },
    [isOnline, scheduleAutoBackup, simulatedOffline, user],
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
      if (user?.emailVerified && isOnline && !simulatedOffline) {
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
    if (user?.emailVerified && isOnline && !simulatedOffline) {
      void syncCourseToCloud(user.uid, course);
    }
    scheduleAutoBackup();
    return course;
  };

  const handleSyncAllToCloud = async () => {
    if (!user) return;
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

  if (!initialized) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F8F9FA] dark:bg-slate-950 text-slate-600 dark:text-slate-400 text-sm">
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

  return (
    <div className="min-h-screen flex flex-col bg-[#F8F9FA] dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      {/* Hidden File & Directory Inputs */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.epub,.djvu"
        multiple
        onChange={(e) => {
          if (e.target.files) void handleImportFileList(e.target.files);
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

      {/* Strict 3-Zone Top Bar Contract */}
      <header className="h-16 px-6 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-8 shrink-0">
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
          <button
            type="button"
            onClick={() => setActiveTab('library')}
            className={`whitespace-nowrap shrink-0 py-1 border-b-2 transition-colors ${
              activeTab === 'library'
                ? 'border-blue-800 text-slate-900 dark:border-blue-400 dark:text-slate-100'
                : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            Library
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('goals')}
            className={`whitespace-nowrap shrink-0 py-1 border-b-2 transition-colors ${
              activeTab === 'goals'
                ? 'border-blue-800 text-slate-900 dark:border-blue-400 dark:text-slate-100'
                : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            Goals
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('courses')}
            className={`whitespace-nowrap shrink-0 py-1 border-b-2 transition-colors ${
              activeTab === 'courses'
                ? 'border-blue-800 text-slate-900 dark:border-blue-400 dark:text-slate-100'
                : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            Study Courses
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('sync')}
            className={`whitespace-nowrap shrink-0 py-1 border-b-2 transition-colors ${
              activeTab === 'sync'
                ? 'border-blue-800 text-slate-900 dark:border-blue-400 dark:text-slate-100'
                : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            Sync &amp; Backups
          </button>
          <button
            type="button"
            onClick={() => void handleImportDirectory()}
            className="whitespace-nowrap shrink-0 py-1 border-b-2 border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 transition-colors"
          >
            Scan Folder
          </button>
        </nav>

        {/* Zone 3: Single Primary Action */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="px-4 py-2 rounded-lg bg-blue-800 text-white text-xs font-medium hover:bg-blue-900 transition-colors flex items-center gap-2 whitespace-nowrap shrink-0"
          >
            <FolderUp className="w-3.5 h-3.5" aria-hidden="true" />
            Import Files
          </button>
        </div>
      </header>

      {/* Mobile Secondary Navigation Strip */}
      <div className="md:hidden flex items-center justify-between gap-1 px-3 py-2 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 overflow-x-auto">
        <button
          type="button"
          onClick={() => setActiveTab('library')}
          className={`px-2.5 py-1.5 rounded-md text-xs font-medium whitespace-nowrap ${
            activeTab === 'library' ? 'bg-blue-50 text-blue-900 dark:bg-blue-950 dark:text-blue-200' : 'text-slate-600 dark:text-slate-400'
          }`}
        >
          Library
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('goals')}
          className={`px-2.5 py-1.5 rounded-md text-xs font-medium whitespace-nowrap ${
            activeTab === 'goals' ? 'bg-blue-50 text-blue-900 dark:bg-blue-950 dark:text-blue-200' : 'text-slate-600 dark:text-slate-400'
          }`}
        >
          Goals
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('courses')}
          className={`px-2.5 py-1.5 rounded-md text-xs font-medium whitespace-nowrap ${
            activeTab === 'courses' ? 'bg-blue-50 text-blue-900 dark:bg-blue-950 dark:text-blue-200' : 'text-slate-600 dark:text-slate-400'
          }`}
        >
          Courses
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('sync')}
          className={`px-2.5 py-1.5 rounded-md text-xs font-medium whitespace-nowrap ${
            activeTab === 'sync' ? 'bg-blue-50 text-blue-900 dark:bg-blue-950 dark:text-blue-200' : 'text-slate-600 dark:text-slate-400'
          }`}
        >
          Sync
        </button>
        <button
          type="button"
          onClick={() => void handleImportDirectory()}
          className="px-2.5 py-1.5 rounded-md text-xs font-medium text-slate-600 dark:text-slate-400 whitespace-nowrap"
        >
          Folder
        </button>
      </div>

      {/* Offline Status or Import Feedback Bar */}
      {(effectiveOffline || importNotice) && (
        <div className="px-6 py-2 border-b border-slate-200 dark:border-slate-800 bg-amber-50 dark:bg-amber-950/30 text-amber-900 dark:text-amber-200 text-xs flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            {effectiveOffline && <WifiOff className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />}
            <span>
              {importNotice ||
                'Offline Reading Mode active — all pinned PDF, EPUB, DjVu files, annotations, and study courses remain available from local IndexedDB.'}
            </span>
          </div>
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
                onTriggerImportFiles={() => fileInputRef.current?.click()}
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

        {activeTab === 'sync' && (
          <SyncBackupView
            user={user}
            syncStatus={syncStatus}
            books={books}
            offlineBytes={offlineBytes}
            backups={backups}
            preferences={preferences}
            linkedBackupDirName={linkedBackupDirName}
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
          />
        )}
      </div>

      {/* Quiet Workspace Footer with UI Light/Dark Toggle */}
      <footer className="px-6 py-3 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
        <span>DocuTrack — Local-first PDF, EPUB &amp; DjVu Library</span>
        <button
          type="button"
          onClick={() =>
            handleUpdatePreferences({
              ...preferences,
              uiTheme: preferences.uiTheme === 'dark' ? 'light' : 'dark',
              updatedAtMs: Date.now(),
            })
          }
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300"
        >
          {preferences.uiTheme === 'dark' ? (
            <>
              <Sun className="w-3.5 h-3.5" aria-hidden="true" />
              Light Interface
            </>
          ) : (
            <>
              <Moon className="w-3.5 h-3.5" aria-hidden="true" />
              Dark Interface
            </>
          )}
        </button>
      </footer>
    </div>
  );
}
