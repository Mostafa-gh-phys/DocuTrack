import {initializeApp} from 'firebase/app';
import {GoogleAuthProvider, getAuth, signInWithPopup, signOut, type User} from 'firebase/auth';
import {
  collection,
  deleteDoc,
  disableNetwork,
  doc,
  enableNetwork,
  getDoc,
  getDocFromServer,
  initializeFirestore,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
  type Unsubscribe,
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';
import type {Annotation, BookMetadata, ReaderPreferences, ReadingGoal, StudyCourse} from './types/library';
import {
  clampAnnotationPayload,
  clampBookPayload,
  clampCoursePayload,
  clampPreferencesPayload,
  clampReadingGoalPayload,
} from './utils/libraryLogic';

export const isFirebaseConfigured = Boolean(
  firebaseConfig?.apiKey &&
    firebaseConfig?.projectId &&
    firebaseConfig?.firestoreDatabaseId &&
    firebaseConfig.projectId !== 'remixed-project-id' &&
    !String(firebaseConfig.apiKey).startsWith('TODO'),
);

const app = initializeApp(firebaseConfig);
// Force standard HTTPS long-polling so WebChannel streaming proxies/VPNs/Electron
// never trigger "[code=unavailable]: Could not reach Cloud Firestore backend".
export const db = initializeFirestore(
  app,
  {
    experimentalForceLongPolling: true,
    ignoreUndefinedProperties: true,
  },
  firebaseConfig.firestoreDatabaseId,
);
export const auth = getAuth(app);

const isOfflineOrLocalFileProtocol = () =>
  (typeof navigator !== 'undefined' && navigator.onLine === false) ||
  (typeof window !== 'undefined' && window.location.protocol === 'file:');

if (isOfflineOrLocalFileProtocol()) {
  void disableNetwork(db).catch(() => {});
}

export async function enableCloudNetwork(): Promise<void> {
  if (!isFirebaseConfigured || isOfflineOrLocalFileProtocol()) return;
  try {
    await enableNetwork(db);
  } catch {
    // Ignore transient network state errors
  }
}

export async function disableCloudNetwork(): Promise<void> {
  try {
    await disableNetwork(db);
  } catch {
    // Ignore transient network state errors
  }
}

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null,
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

function timestampToMs(val: unknown): number {
  if (val && typeof val === 'object' && 'toMillis' in val && typeof (val as {toMillis?: unknown}).toMillis === 'function') {
    return Number((val as {toMillis: () => number}).toMillis()) || Date.now();
  }
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  return Date.now();
}

export async function testConnection(): Promise<boolean> {
  if (!isFirebaseConfigured) {
    console.error('Please check your Firebase configuration.');
    return false;
  }
  if (isOfflineOrLocalFileProtocol()) {
    return false;
  }
  try {
    await enableCloudNetwork();
    await getDocFromServer(doc(db, 'test', 'connection'));
    return true;
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error ? String((error as {code?: unknown}).code) : '';
    const message = error instanceof Error ? error.message : String(error);
    // Security rules intentionally deny /test/connection, so permission-denied proves the server responded.
    if (code === 'permission-denied') {
      return true;
    }
    if (
      code === 'unavailable' ||
      message.includes('the client is offline') ||
      message.includes('Failed to get document from server')
    ) {
      console.warn('Cloud Firestore backend unreachable; operating in local-first mode.');
      return false;
    }
    console.warn('Cloud Firestore connectivity check failed:', message);
    return false;
  }
}

export async function signInWithGoogle(): Promise<User> {
  await enableCloudNetwork();
  const provider = new GoogleAuthProvider();
  const result = await signInWithPopup(auth, provider);
  return result.user;
}

export async function signOutUser(): Promise<void> {
  await disableCloudNetwork();
  await signOut(auth);
}

/**
 * Creates user profile once or updates mutable profile metadata without mutating immutable createdAt.
 */
export async function ensureUserProfile(user: User): Promise<void> {
  if (!isFirebaseConfigured) return;
  const path = `users/${user.uid}`;
  const ref = doc(db, 'users', user.uid);
  const mutableFields = {
    displayName: (user.displayName || user.email || 'Reader').slice(0, 120),
    email: (user.email || '').slice(0, 254),
    photoURL: (user.photoURL || '').slice(0, 500),
  };

  try {
    const existingSnap = await getDoc(ref);
    if (!existingSnap.exists()) {
      await setDoc(ref, {
        uid: user.uid,
        ...mutableFields,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(ref, {
        ...mutableFields,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function syncBookToCloud(uid: string, book: BookMetadata): Promise<void> {
  const payload = clampBookPayload(book, uid);
  const path = `users/${uid}/books/${payload.id}`;
  const ref = doc(db, 'users', uid, 'books', payload.id);
  try {
    const existingSnap = await getDoc(ref);
    if (!existingSnap.exists()) {
      await setDoc(ref, {
        ...payload,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      const {id: _id, ownerId: _ownerId, format: _format, addedAt: _addedAt, ...mutable} = payload;
      await updateDoc(ref, {
        ...mutable,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function deleteBookFromCloud(uid: string, bookId: string): Promise<void> {
  const path = `users/${uid}/books/${bookId}`;
  try {
    await deleteDoc(doc(db, 'users', uid, 'books', bookId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function syncAnnotationToCloud(uid: string, ann: Annotation): Promise<void> {
  const payload = clampAnnotationPayload(ann, uid);
  const path = `users/${uid}/annotations/${payload.id}`;
  const ref = doc(db, 'users', uid, 'annotations', payload.id);
  try {
    const existingSnap = await getDoc(ref);
    if (!existingSnap.exists()) {
      await setDoc(ref, {
        ...payload,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(ref, {
        note: payload.note,
        color: payload.color,
        tags: payload.tags,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function deleteAnnotationFromCloud(uid: string, annotationId: string): Promise<void> {
  const path = `users/${uid}/annotations/${annotationId}`;
  try {
    await deleteDoc(doc(db, 'users', uid, 'annotations', annotationId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function syncCourseToCloud(uid: string, course: StudyCourse): Promise<void> {
  const payload = clampCoursePayload(course, uid);
  const path = `users/${uid}/courses/${payload.id}`;
  const ref = doc(db, 'users', uid, 'courses', payload.id);
  try {
    const existingSnap = await getDoc(ref);
    if (!existingSnap.exists()) {
      await setDoc(ref, {
        ...payload,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(ref, {
        title: payload.title,
        summary: payload.summary,
        keyConcepts: payload.keyConcepts,
        modules: payload.modules,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function syncPreferencesToCloud(uid: string, prefs: ReaderPreferences): Promise<void> {
  const payload = clampPreferencesPayload(prefs, uid);
  const path = `users/${uid}/preferences/reader`;
  const ref = doc(db, 'users', uid, 'preferences', 'reader');
  try {
    const existingSnap = await getDoc(ref);
    if (!existingSnap.exists()) {
      await setDoc(ref, {
        ...payload,
        updatedAt: serverTimestamp(),
      });
    } else {
      const {ownerId: _ownerId, ...mutable} = payload;
      await updateDoc(ref, {
        ...mutable,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function syncReadingGoalToCloud(uid: string, goal: ReadingGoal): Promise<void> {
  const payload = clampReadingGoalPayload(goal, uid);
  const path = `users/${uid}/goals/${payload.id}`;
  const ref = doc(db, 'users', uid, 'goals', payload.id);
  try {
    const existingSnap = await getDoc(ref);
    if (!existingSnap.exists()) {
      await setDoc(ref, {
        ...payload,
        updatedAt: serverTimestamp(),
      });
    } else {
      const {id: _id, ownerId: _ownerId, ...mutable} = payload;
      await updateDoc(ref, {
        ...mutable,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export interface CloudInitialSnapshotSummary {
  booksById: Map<string, number>;
  annsById: Map<string, number>;
  coursesById: Map<string, number>;
  prefsUpdatedAtMs: number | null;
  goalUpdatedAtMs: number | null;
}

export function subscribeToCloudLibrary(
  uid: string,
  callbacks: {
    onBooks: (books: BookMetadata[]) => void;
    onAnnotations: (annotations: Annotation[]) => void;
    onCourses: (courses: StudyCourse[]) => void;
    onPreferences?: (prefs: ReaderPreferences) => void;
    onGoal?: (goal: ReadingGoal) => void;
    onInitialSnapshotReady?: (summary: CloudInitialSnapshotSummary) => void;
    onError: (err: Error) => void;
  },
): Unsubscribe {
  const booksPath = `users/${uid}/books`;
  const annPath = `users/${uid}/annotations`;
  const coursesPath = `users/${uid}/courses`;
  const prefsPath = `users/${uid}/preferences/reader`;
  const goalsPath = `users/${uid}/goals`;

  const loaded = {books: false, anns: false, courses: false, prefs: false, goals: false};
  let emittedReady = false;
  const summary: CloudInitialSnapshotSummary = {
    booksById: new Map<string, number>(),
    annsById: new Map<string, number>(),
    coursesById: new Map<string, number>(),
    prefsUpdatedAtMs: null,
    goalUpdatedAtMs: null,
  };

  const maybeEmitReady = () => {
    if (emittedReady) return;
    if (loaded.books && loaded.anns && loaded.courses && loaded.prefs && loaded.goals) {
      emittedReady = true;
      callbacks.onInitialSnapshotReady?.(summary);
    }
  };

  const unsubBooks = onSnapshot(
    collection(db, 'users', uid, 'books'),
    (snap) => {
      const items: BookMetadata[] = snap.docs.map((d) => {
        const data = d.data();
        return {
          id: String(data.id || d.id),
          ownerId: String(data.ownerId || uid),
          title: String(data.title || 'Untitled'),
          author: String(data.author || 'Unknown'),
          format: (data.format as BookMetadata['format']) || 'pdf',
          folderPath: String(data.folderPath || '/Root'),
          fileSize: Number(data.fileSize || 0),
          pageCount: Number(data.pageCount || 1),
          currentPage: Number(data.currentPage || 1),
          progress: Number(data.progress || 0),
          isFavorite: Boolean(data.isFavorite),
          offlinePinned: Boolean(data.offlinePinned),
          tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
          coverUrl: typeof data.coverUrl === 'string' && data.coverUrl ? data.coverUrl : undefined,
          excerpt: typeof data.excerpt === 'string' ? data.excerpt : undefined,
          language: typeof data.language === 'string' ? data.language : undefined,
          addedAt: Number(data.addedAt || Date.now()),
          lastOpenedAt: typeof data.lastOpenedAt === 'number' ? data.lastOpenedAt : undefined,
          updatedAtMs: timestampToMs(data.updatedAt),
        };
      });
      if (!loaded.books) {
        loaded.books = true;
        for (const item of items) summary.booksById.set(item.id, item.updatedAtMs || 0);
      }
      callbacks.onBooks(items);
      maybeEmitReady();
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, booksPath);
      } catch (e) {
        callbacks.onError(e as Error);
      }
    },
  );

  const unsubAnns = onSnapshot(
    collection(db, 'users', uid, 'annotations'),
    (snap) => {
      const items: Annotation[] = snap.docs.map((d) => {
        const data = d.data();
        return {
          id: String(data.id || d.id),
          ownerId: String(data.ownerId || uid),
          bookId: String(data.bookId || ''),
          page: Number(data.page || 1),
          chapterTitle: typeof data.chapterTitle === 'string' ? data.chapterTitle : undefined,
          kind: (data.kind as Annotation['kind']) || 'highlight',
          quote: String(data.quote || ''),
          note: String(data.note || ''),
          color: (data.color as Annotation['color']) || 'amber',
          tags: Array.isArray(data.tags) ? data.tags.map(String) : undefined,
          position:
            data.position && typeof data.position === 'object'
              ? {
                  x: Number((data.position as Record<string, unknown>).x || 0),
                  y: Number((data.position as Record<string, unknown>).y || 0),
                  width: Number((data.position as Record<string, unknown>).width || 0),
                  height: Number((data.position as Record<string, unknown>).height || 0),
                }
              : undefined,
          rects: Array.isArray(data.rects)
            ? data.rects
                .filter((r): r is Record<string, unknown> => Boolean(r && typeof r === 'object'))
                .map((r) => ({
                  x: Number(r.x || 0),
                  y: Number(r.y || 0),
                  width: Number(r.width || 0),
                  height: Number(r.height || 0),
                }))
            : undefined,
          inkStrokes: Array.isArray(data.inkStrokes) ? data.inkStrokes.map(String) : undefined,
          createdAtMs: timestampToMs(data.createdAt),
          updatedAtMs: timestampToMs(data.updatedAt),
        };
      });
      if (!loaded.anns) {
        loaded.anns = true;
        for (const item of items) summary.annsById.set(item.id, item.updatedAtMs || 0);
      }
      callbacks.onAnnotations(items);
      maybeEmitReady();
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, annPath);
      } catch (e) {
        callbacks.onError(e as Error);
      }
    },
  );

  const unsubCourses = onSnapshot(
    collection(db, 'users', uid, 'courses'),
    (snap) => {
      const items: StudyCourse[] = snap.docs.map((d) => {
        const data = d.data();
        return {
          id: String(data.id || d.id),
          ownerId: String(data.ownerId || uid),
          bookId: String(data.bookId || ''),
          title: String(data.title || 'Course'),
          summary: String(data.summary || ''),
          keyConcepts: Array.isArray(data.keyConcepts) ? data.keyConcepts.map(String) : [],
          modules: Array.isArray(data.modules) ? data.modules : [],
          createdAtMs: timestampToMs(data.createdAt),
          updatedAtMs: timestampToMs(data.updatedAt),
        };
      });
      if (!loaded.courses) {
        loaded.courses = true;
        for (const item of items) summary.coursesById.set(item.id, item.updatedAtMs || 0);
      }
      callbacks.onCourses(items);
      maybeEmitReady();
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, coursesPath);
      } catch (e) {
        callbacks.onError(e as Error);
      }
    },
  );

  const unsubPrefs = onSnapshot(
    doc(db, 'users', uid, 'preferences', 'reader'),
    (snap) => {
      const ts = snap.exists() ? timestampToMs(snap.data().updatedAt) : null;
      if (!loaded.prefs) {
        loaded.prefs = true;
        summary.prefsUpdatedAtMs = ts;
      }
      if (snap.exists() && callbacks.onPreferences) {
        const data = snap.data();
        callbacks.onPreferences({
          theme: (data.theme as ReaderPreferences['theme']) || 'paper',
          uiTheme: (data.uiTheme as ReaderPreferences['uiTheme']) || 'light',
          accentColor: (data.accentColor as ReaderPreferences['accentColor']) || 'cobalt',
          fontFamily: (data.fontFamily as ReaderPreferences['fontFamily']) || 'serif',
          fontSize: Number(data.fontSize || 18),
          lineHeight: Number(data.lineHeight || 1.7),
          maxWidth: Number(data.maxWidth || 740),
          columnCount: data.columnCount === 2 ? 2 : 1,
          epubViewMode: (data.epubViewMode as ReaderPreferences['epubViewMode']) || 'scroll',
          novelIndent: typeof data.novelIndent === 'boolean' ? data.novelIndent : true,
          novelJustify: typeof data.novelJustify === 'boolean' ? data.novelJustify : true,
          novelDropCap: typeof data.novelDropCap === 'boolean' ? data.novelDropCap : true,
          applyThemeToDocument:
            typeof data.applyThemeToDocument === 'boolean' ? data.applyThemeToDocument : true,
          backupFrequency: (data.backupFrequency as ReaderPreferences['backupFrequency']) || 'onChange',
          updatedAtMs: ts || Date.now(),
        });
      }
      maybeEmitReady();
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.GET, prefsPath);
      } catch (e) {
        callbacks.onError(e as Error);
      }
    },
  );

  const unsubGoals = onSnapshot(
    collection(db, 'users', uid, 'goals'),
    (snap) => {
      const first = snap.docs[0];
      const ts = first ? timestampToMs(first.data().updatedAt) : null;
      if (!loaded.goals) {
        loaded.goals = true;
        summary.goalUpdatedAtMs = ts;
      }
      if (first && callbacks.onGoal) {
        const data = first.data();
        callbacks.onGoal({
          id: String(data.id || first.id || 'default'),
          ownerId: String(data.ownerId || uid),
          dailyPagesTarget: Number(data.dailyPagesTarget || 25),
          weeklyMinutesTarget: Number(data.weeklyMinutesTarget || 180),
          yearlyBooksTarget: Number(data.yearlyBooksTarget || 24),
          currentStreakDays: Number(data.currentStreakDays || 0),
          longestStreakDays: Number(data.longestStreakDays || 0),
          totalPagesRead: Number(data.totalPagesRead || 0),
          totalMinutesRead: Number(data.totalMinutesRead || 0),
          dailyHistory: Array.isArray(data.dailyHistory) ? data.dailyHistory.map(String) : [],
          updatedAtMs: ts || Date.now(),
        });
      }
      maybeEmitReady();
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, goalsPath);
      } catch (e) {
        callbacks.onError(e as Error);
      }
    },
  );

  return () => {
    unsubBooks();
    unsubAnns();
    unsubCourses();
    unsubPrefs();
    unsubGoals();
  };
}
