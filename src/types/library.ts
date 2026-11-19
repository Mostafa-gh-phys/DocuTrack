export type BookFormat = 'pdf' | 'epub' | 'djvu';

export type HighlightColor = 'amber' | 'sage' | 'sky' | 'rose' | 'violet';

export type AnnotationKind = 'highlight' | 'underline' | 'note' | 'area' | 'ink';

export interface AnnotationPosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ReaderTheme =
  | 'paper'
  | 'sepia'
  | 'parchment'
  | 'sage'
  | 'dusk'
  | 'nord'
  | 'night'
  | 'amoled';

export type UITheme = 'light' | 'parchment' | 'sage' | 'dark' | 'obsidian';

export type AppAccentColor = 'cobalt' | 'forest' | 'burgundy' | 'ochre' | 'indigo' | 'graphite';

export type ReaderFontFamily =
  | 'serif'
  | 'literary'
  | 'garamond'
  | 'merriweather'
  | 'sans'
  | 'humanist'
  | 'accessible'
  | 'mono';

export type EpubViewMode = 'scroll' | 'paginated' | 'spread';

export type ScanPreset = 'original' | 'clean-scan' | 'high-contrast' | 'bleed-reduce';

export interface ScanEnhanceSettings {
  preset: ScanPreset;
  contrast: number; // 0.6 to 2.4
  brightness: number; // -60 to 60
  sharpness: number; // 0 to 1
  cleanBackground: boolean;
}

export type BackupFrequency = 'manual' | 'onChange' | 'hourly' | 'daily';

export type SortField =
  | 'lastOpenedAt'
  | 'title'
  | 'author'
  | 'format'
  | 'folderPath'
  | 'addedAt'
  | 'progress'
  | 'fileSize';

export type SortDirection = 'asc' | 'desc';

export type LibraryCollection = 'all' | 'reading' | 'favorites' | 'offline';

export interface BookMetadata {
  id: string;
  ownerId: string;
  title: string;
  author: string;
  format: BookFormat;
  folderPath: string;
  fileSize: number;
  pageCount: number;
  currentPage: number;
  progress: number;
  isFavorite: boolean;
  offlinePinned: boolean;
  tags: string[];
  coverUrl?: string;
  excerpt?: string;
  language?: string;
  addedAt: number;
  lastOpenedAt?: number;
  updatedAtMs: number;
}

export interface FolderNode {
  name: string;
  path: string;
  count: number;
  children: FolderNode[];
}

export interface Annotation {
  id: string;
  ownerId: string;
  bookId: string;
  page: number;
  chapterTitle?: string;
  kind?: AnnotationKind;
  quote: string;
  note: string;
  color: HighlightColor;
  tags?: string[];
  position?: AnnotationPosition;
  rects?: AnnotationPosition[];
  inkStrokes?: string[];
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CourseModule {
  moduleNumber: number;
  title: string;
  durationMinutes: number;
  objectives: string[];
  lectureNotes: string;
  quizQuestion: string;
  quizAnswer: string;
}

export interface StudyCourse {
  id: string;
  ownerId: string;
  bookId: string;
  title: string;
  summary: string;
  keyConcepts: string[];
  modules: CourseModule[];
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ReaderPreferences {
  theme: ReaderTheme;
  uiTheme: UITheme;
  accentColor?: AppAccentColor;
  fontFamily: ReaderFontFamily;
  fontSize: number;
  lineHeight: number;
  maxWidth: number;
  columnCount: 1 | 2;
  epubViewMode?: EpubViewMode;
  novelIndent?: boolean;
  novelJustify?: boolean;
  novelDropCap?: boolean;
  backupFrequency: BackupFrequency;
  updatedAtMs: number;
}

export interface ReadingDayLog {
  date: string;
  pages: number;
  minutes: number;
}

export interface ReadingGoal {
  id: string;
  ownerId: string;
  dailyPagesTarget: number;
  weeklyMinutesTarget: number;
  yearlyBooksTarget: number;
  currentStreakDays: number;
  longestStreakDays: number;
  totalPagesRead: number;
  totalMinutesRead: number;
  dailyHistory: string[];
  updatedAtMs: number;
}

export interface DocumentTextChunk {
  bookId: string;
  bookTitle: string;
  page: number;
  chapterTitle?: string;
  text: string;
}

export interface SemanticSearchResult {
  bookId: string;
  bookTitle: string;
  page: number;
  snippet: string;
  score: number;
  reason: string;
}

export interface BackupSnapshotRecord {
  id: string;
  createdAtMs: number;
  trigger: 'manual' | 'auto';
  bookCount: number;
  annotationCount: number;
  courseCount: number;
  sizeBytes: number;
  destination: string;
}

export interface BackupArchive {
  version: number;
  exportedAtMs: number;
  books: BookMetadata[];
  annotations: Annotation[];
  courses: StudyCourse[];
  preferences: ReaderPreferences;
  readingGoal?: ReadingGoal;
  textChunks: DocumentTextChunk[];
}
