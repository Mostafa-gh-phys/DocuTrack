import {initializeApp} from 'firebase/app';
import {GoogleAuthProvider, getAuth, signInWithPopup, signOut, type User} from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDocFromServer,
  initializeFirestore,
  onSnapshot,
  serverTimestamp,
  setDoc,
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

const app = initializeApp(firebaseConfig);
export const db = initializeFirestore(
  app,
  {
    experimentalAutoDetectLongPolling: true,
    ignoreUndefinedProperties: true,
  },
  firebaseConfig.firestoreDatabaseId,
);
export const auth = getAuth(app);

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

async function testConnection() {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}
void testConnection();

export async function signInWithGoogle(): Promise<User> {
  const provider = new GoogleAuthProvider();
  const result = await signInWithPopup(auth, provider);
  return result.user;
}

export async function signOutUser(): Promise<void> {
  await signOut(auth);
}

export async function ensureUserProfile(user: User): Promise<void> {
  const path = `users/${user.uid}`;
  try {
    await setDoc(
      doc(db, 'users', user.uid),
      {
        uid: user.uid,
        displayName: (user.displayName || user.email || 'Reader').slice(0, 120),
        email: (user.email || '').slice(0, 254),
        photoURL: (user.photoURL || '').slice(0, 500),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      },
      {merge: true},
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function syncBookToCloud(uid: string, book: BookMetadata): Promise<void> {
  const payload = clampBookPayload(book, uid);
  const path = `users/${uid}/books/${payload.id}`;
  try {
    await setDoc(doc(db, 'users', uid, 'books', payload.id), {
      ...payload,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
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
  try {
    await setDoc(doc(db, 'users', uid, 'annotations', payload.id), {
      ...payload,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
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
  try {
    await setDoc(doc(db, 'users', uid, 'courses', payload.id), {
      ...payload,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function syncPreferencesToCloud(uid: string, prefs: ReaderPreferences): Promise<void> {
  const payload = clampPreferencesPayload(prefs, uid);
  const path = `users/${uid}/preferences/reader`;
  try {
    await setDoc(doc(db, 'users', uid, 'preferences', 'reader'), {
      ...payload,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function syncReadingGoalToCloud(uid: string, goal: ReadingGoal): Promise<void> {
  const payload = clampReadingGoalPayload(goal, uid);
  const path = `users/${uid}/goals/${payload.id}`;
  try {
    await setDoc(doc(db, 'users', uid, 'goals', payload.id), {
      ...payload,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export function subscribeToCloudLibrary(
  uid: string,
  callbacks: {
    onBooks: (books: BookMetadata[]) => void;
    onAnnotations: (annotations: Annotation[]) => void;
    onCourses: (courses: StudyCourse[]) => void;
    onGoal?: (goal: ReadingGoal) => void;
    onError: (err: Error) => void;
  },
): Unsubscribe {
  const booksPath = `users/${uid}/books`;
  const annPath = `users/${uid}/annotations`;
  const coursesPath = `users/${uid}/courses`;
  const goalsPath = `users/${uid}/goals`;

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
          coverUrl: typeof data.coverUrl === 'string' ? data.coverUrl : undefined,
          excerpt: typeof data.excerpt === 'string' ? data.excerpt : undefined,
          language: typeof data.language === 'string' ? data.language : undefined,
          addedAt: Number(data.addedAt || Date.now()),
          lastOpenedAt: typeof data.lastOpenedAt === 'number' ? data.lastOpenedAt : undefined,
          updatedAtMs: Date.now(),
        };
      });
      callbacks.onBooks(items);
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
          createdAtMs: Date.now(),
          updatedAtMs: Date.now(),
        };
      });
      callbacks.onAnnotations(items);
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
          createdAtMs: Date.now(),
          updatedAtMs: Date.now(),
        };
      });
      callbacks.onCourses(items);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, coursesPath);
      } catch (e) {
        callbacks.onError(e as Error);
      }
    },
  );

  const unsubGoals = onSnapshot(
    collection(db, 'users', uid, 'goals'),
    (snap) => {
      const first = snap.docs[0];
      if (!first || !callbacks.onGoal) return;
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
        updatedAtMs: Date.now(),
      });
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
    unsubGoals();
  };
}
