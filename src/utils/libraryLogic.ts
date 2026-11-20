import type {
  Annotation,
  AnnotationKind,
  AnnotationPosition,
  AppAccentColor,
  BackupArchive,
  BookFormat,
  BookMetadata,
  DocumentTextChunk,
  EpubViewMode,
  FolderNode,
  HighlightColor,
  LibraryCollection,
  ReaderFontFamily,
  ReaderPreferences,
  ReaderTheme,
  ReadingDayLog,
  ReadingGoal,
  SemanticSearchResult,
  SortDirection,
  SortField,
  StudyCourse,
  UITheme,
} from '../types/library';

export const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function sanitizeId(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
  return cleaned.length > 0 ? cleaned : `doc_${Date.now()}`;
}

export function normalizeFolderPath(rawPath: string): string {
  const trimmed = rawPath.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
  if (!trimmed || trimmed === '/') return '/Root';
  const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const withoutTrailing = withLeading.length > 1 && withLeading.endsWith('/') ? withLeading.slice(0, -1) : withLeading;
  return withoutTrailing.slice(0, 320);
}

export function deriveFolderFromRelativePath(webkitRelativePath?: string, fallbackFolder = '/Imported'): string {
  if (!webkitRelativePath || !webkitRelativePath.includes('/')) {
    return normalizeFolderPath(fallbackFolder);
  }
  const segments = webkitRelativePath.split('/').filter(Boolean);
  if (segments.length <= 1) {
    return normalizeFolderPath(fallbackFolder);
  }
  segments.pop(); // remove filename
  return normalizeFolderPath(`/${segments.join('/')}`);
}

export function buildFolderTree(books: BookMetadata[]): FolderNode[] {
  const nodeMap = new Map<string, FolderNode>();

  const ensureNode = (folderPath: string): FolderNode => {
    const normalized = normalizeFolderPath(folderPath);
    const existing = nodeMap.get(normalized);
    if (existing) return existing;

    const parts = normalized.split('/').filter(Boolean);
    const name = parts[parts.length - 1] || 'Root';
    const node: FolderNode = {
      name,
      path: normalized,
      count: 0,
      children: [],
    };
    nodeMap.set(normalized, node);

    if (parts.length > 1) {
      const parentPath = `/${parts.slice(0, -1).join('/')}`;
      const parent = ensureNode(parentPath);
      if (!parent.children.some((c) => c.path === node.path)) {
        parent.children.push(node);
      }
    }
    return node;
  };

  for (const book of books) {
    const normalized = normalizeFolderPath(book.folderPath);
    const parts = normalized.split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++) {
      const ancestorPath = `/${parts.slice(0, i).join('/')}`;
      const node = ensureNode(ancestorPath);
      node.count += 1;
    }
  }

  const sortChildren = (nodes: FolderNode[]): FolderNode[] => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    for (const n of nodes) {
      sortChildren(n.children);
    }
    return nodes;
  };

  const roots: FolderNode[] = [];
  for (const node of nodeMap.values()) {
    const parts = node.path.split('/').filter(Boolean);
    if (parts.length === 1) {
      roots.push(node);
    }
  }
  return sortChildren(roots);
}

export interface FolderViewContents {
  breadcrumbs: {name: string; path: string}[];
  childFolders: FolderNode[];
  parentPath: string | null;
}

export function getFolderViewContents(
  folderTree: FolderNode[],
  currentFolderPath: string | null,
): FolderViewContents {
  if (!currentFolderPath) {
    return {
      breadcrumbs: [],
      childFolders: folderTree,
      parentPath: null,
    };
  }

  const normalized = normalizeFolderPath(currentFolderPath);
  const parts = normalized.split('/').filter(Boolean);
  const breadcrumbs = parts.map((name, idx) => ({
    name,
    path: `/${parts.slice(0, idx + 1).join('/')}`,
  }));
  const parentPath = parts.length > 1 ? `/${parts.slice(0, -1).join('/')}` : null;

  let currentNodes = folderTree;
  let matched: FolderNode | undefined;
  for (let i = 0; i < breadcrumbs.length; i++) {
    matched = currentNodes.find((n) => n.path === breadcrumbs[i].path);
    if (!matched) {
      currentNodes = [];
      break;
    }
    currentNodes = matched.children;
  }

  return {
    breadcrumbs,
    childFolders: matched ? matched.children : [],
    parentPath,
  };
}

export interface LibraryFilterOptions {
  collection: LibraryCollection;
  folderPath: string | null;
  format: BookFormat | 'all';
  query: string;
  sortBy: SortField;
  sortDirection: SortDirection;
}

export function sortAndFilterBooks(books: BookMetadata[], options: LibraryFilterOptions): BookMetadata[] {
  const q = options.query.trim().toLowerCase();

  const filtered = books.filter((book) => {
    if (options.collection === 'reading' && !(book.progress > 0 && book.progress < 100)) {
      return false;
    }
    if (options.collection === 'favorites' && !book.isFavorite) {
      return false;
    }
    if (options.collection === 'offline' && !book.offlinePinned) {
      return false;
    }
    if (options.format !== 'all' && book.format !== options.format) {
      return false;
    }
    if (options.folderPath) {
      const normBookFolder = normalizeFolderPath(book.folderPath);
      const normTarget = normalizeFolderPath(options.folderPath);
      if (normBookFolder !== normTarget && !normBookFolder.startsWith(`${normTarget}/`)) {
        return false;
      }
    }
    if (q) {
      const haystack = `${book.title} ${book.author} ${book.folderPath} ${book.format} ${book.tags.join(' ')} ${book.excerpt || ''}`.toLowerCase();
      if (!haystack.includes(q)) {
        return false;
      }
    }
    return true;
  });

  const dir = options.sortDirection === 'asc' ? 1 : -1;

  return [...filtered].sort((a, b) => {
    switch (options.sortBy) {
      case 'title':
        return a.title.localeCompare(b.title) * dir;
      case 'author':
        return a.author.localeCompare(b.author) * dir;
      case 'format':
        return a.format.localeCompare(b.format) * dir;
      case 'folderPath':
        return a.folderPath.localeCompare(b.folderPath) * dir;
      case 'progress':
        return (a.progress - b.progress) * dir;
      case 'fileSize':
        return (a.fileSize - b.fileSize) * dir;
      case 'addedAt':
        return (a.addedAt - b.addedAt) * dir;
      case 'lastOpenedAt':
      default: {
        const aTime = a.lastOpenedAt ?? a.addedAt;
        const bTime = b.lastOpenedAt ?? b.addedAt;
        return (aTime - bTime) * dir;
      }
    }
  });
}

const SEMANTIC_SYNONYMS: Record<string, string[]> = {
  consensus: ['paxos', 'raft', 'quorum', 'agreement', 'distributed', 'replication', 'fault'],
  typography: ['font', 'typeface', 'kerning', 'leading', 'serif', 'measure', 'grid', 'layout'],
  reading: ['attention', 'comprehension', 'cognition', 'memory', 'focus', 'literacy', 'deep'],
  signal: ['wave', 'fourier', 'frequency', 'optics', 'interference', 'spectrum', 'transform'],
  offline: ['cache', 'local', 'storage', 'sync', 'indexeddb', 'backup'],
  reliability: ['fault', 'resilience', 'replication', 'recovery', 'availability', 'consistency'],
};

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2);
}

export function searchLocalSemanticChunks(query: string, chunks: DocumentTextChunk[]): SemanticSearchResult[] {
  const baseTerms = tokenize(query);
  if (baseTerms.length === 0) return [];

  const expanded = new Set<string>(baseTerms);
  for (const term of baseTerms) {
    for (const [root, syns] of Object.entries(SEMANTIC_SYNONYMS)) {
      if (term === root || syns.includes(term)) {
        expanded.add(root);
        for (const s of syns) expanded.add(s);
      }
    }
  }

  const scored: SemanticSearchResult[] = [];
  for (const chunk of chunks) {
    const chunkTokens = tokenize(`${chunk.bookTitle} ${chunk.chapterTitle || ''} ${chunk.text}`);
    if (chunkTokens.length === 0) continue;

    let directHits = 0;
    let semanticHits = 0;
    const matchedTerms = new Set<string>();

    for (const token of chunkTokens) {
      if (baseTerms.includes(token)) {
        directHits += 1;
        matchedTerms.add(token);
      } else if (expanded.has(token)) {
        semanticHits += 1;
        matchedTerms.add(token);
      }
    }

    const rawScore = (directHits * 2.5 + semanticHits * 1.1) / Math.sqrt(chunkTokens.length + 8);
    if (rawScore > 0.05) {
      const normalizedScore = Math.min(0.99, Math.round(rawScore * 100) / 100);
      const matchedList = Array.from(matchedTerms).slice(0, 4).join(', ');
      scored.push({
        bookId: chunk.bookId,
        bookTitle: chunk.bookTitle,
        page: chunk.page,
        snippet: chunk.text.slice(0, 240),
        score: normalizedScore,
        reason: matchedList
          ? `Offline conceptual match on: ${matchedList}`
          : 'Offline lexical match',
      });
    }
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, 8);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function calculateProgress(currentPage: number, pageCount: number): number {
  if (pageCount <= 1) return 100;
  const clamped = Math.max(1, Math.min(currentPage, pageCount));
  return Math.round((clamped / pageCount) * 100);
}

// --- Reading Goals & Activity Pure Logic ---
export function formatDateKey(timestampMs = Date.now()): string {
  const d = new Date(timestampMs);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function shiftDateKey(dateKey: string, deltaDays: number): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(y, (m || 1) - 1, d || 1);
  dt.setDate(dt.getDate() + deltaDays);
  return formatDateKey(dt.getTime());
}

export function parseDailyHistory(entries: string[]): ReadingDayLog[] {
  const map = new Map<string, ReadingDayLog>();
  for (const raw of entries) {
    const [date, pStr, mStr] = String(raw).split('|');
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const pages = Math.max(0, Math.floor(Number(pStr) || 0));
    const minutes = Math.max(0, Math.floor(Number(mStr) || 0));
    const prev = map.get(date);
    if (prev) {
      prev.pages += pages;
      prev.minutes += minutes;
    } else {
      map.set(date, {date, pages, minutes});
    }
  }
  return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
}

export function serializeDailyHistory(logs: ReadingDayLog[]): string[] {
  return [...logs]
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-90)
    .map((l) => `${l.date}|${Math.max(0, Math.floor(l.pages))}|${Math.max(0, Math.floor(l.minutes))}`);
}

export function computeReadingStreak(logs: ReadingDayLog[], todayKey: string, dailyTarget: number): number {
  const byDate = new Map<string, ReadingDayLog>();
  for (const l of logs) byDate.set(l.date, l);

  let streak = 0;
  // Count consecutive days meeting daily target (or active reading >= 1 page if counting today in progress)
  const todayLog = byDate.get(todayKey);
  let cursor = todayLog && todayLog.pages >= dailyTarget ? todayKey : shiftDateKey(todayKey, -1);

  for (let i = 0; i < 365; i++) {
    const entry = byDate.get(cursor);
    if (!entry || entry.pages < dailyTarget) break;
    streak += 1;
    cursor = shiftDateKey(cursor, -1);
  }
  return streak;
}

export function createDefaultReadingGoal(ownerId = 'local', todayKey = formatDateKey()): ReadingGoal {
  const yesterday = shiftDateKey(todayKey, -1);
  const twoDaysAgo = shiftDateKey(todayKey, -2);
  const threeDaysAgo = shiftDateKey(todayKey, -3);
  const seedLogs: ReadingDayLog[] = [
    {date: threeDaysAgo, pages: 26, minutes: 28},
    {date: twoDaysAgo, pages: 28, minutes: 35},
    {date: yesterday, pages: 26, minutes: 31},
    {date: todayKey, pages: 8, minutes: 12},
  ];
  return {
    id: 'default',
    ownerId: sanitizeId(ownerId),
    dailyPagesTarget: 25,
    weeklyMinutesTarget: 180,
    yearlyBooksTarget: 24,
    currentStreakDays: 3,
    longestStreakDays: 3,
    totalPagesRead: 88,
    totalMinutesRead: 106,
    dailyHistory: serializeDailyHistory(seedLogs),
    updatedAtMs: Date.now(),
  };
}

export function recordReadingActivity(
  goal: ReadingGoal,
  pagesDelta: number,
  minutesDelta: number,
  todayKey = formatDateKey(),
): ReadingGoal {
  const safePages = Math.max(0, Math.floor(pagesDelta));
  const safeMinutes = Math.max(0, Math.floor(minutesDelta));
  if (safePages === 0 && safeMinutes === 0) return goal;

  const logs = parseDailyHistory(goal.dailyHistory);
  const existing = logs.find((l) => l.date === todayKey);
  if (existing) {
    existing.pages += safePages;
    existing.minutes += safeMinutes;
  } else {
    logs.push({date: todayKey, pages: safePages, minutes: safeMinutes});
  }

  const streak = computeReadingStreak(logs, todayKey, Math.max(1, goal.dailyPagesTarget));
  return {
    ...goal,
    currentStreakDays: streak,
    longestStreakDays: Math.max(goal.longestStreakDays, streak),
    totalPagesRead: Math.min(1000000, goal.totalPagesRead + safePages),
    totalMinutesRead: Math.min(1000000, goal.totalMinutesRead + safeMinutes),
    dailyHistory: serializeDailyHistory(logs),
    updatedAtMs: Date.now(),
  };
}

export function getReadingGoalStats(goal: ReadingGoal, books: BookMetadata[], todayKey = formatDateKey()) {
  const logs = parseDailyHistory(goal.dailyHistory);
  const byDate = new Map(logs.map((l) => [l.date, l]));

  const last7Days: {date: string; label: string; pages: number; minutes: number; metTarget: boolean}[] = [];
  for (let i = 6; i >= 0; i--) {
    const dk = shiftDateKey(todayKey, -i);
    const [y, m, d] = dk.split('-').map(Number);
    const dt = new Date(y, (m || 1) - 1, d || 1);
    const label = dt.toLocaleDateString('en-US', {weekday: 'short'});
    const log = byDate.get(dk);
    const pages = log?.pages || 0;
    const minutes = log?.minutes || 0;
    last7Days.push({
      date: dk,
      label,
      pages,
      minutes,
      metTarget: pages >= goal.dailyPagesTarget,
    });
  }

  const todayEntry = byDate.get(todayKey);
  const todayPages = todayEntry?.pages || 0;
  const todayMinutes = todayEntry?.minutes || 0;
  const dailyPct = Math.min(100, Math.round((todayPages / Math.max(1, goal.dailyPagesTarget)) * 100));

  const weeklyMinutes = last7Days.reduce((acc, day) => acc + day.minutes, 0);
  const weeklyPages = last7Days.reduce((acc, day) => acc + day.pages, 0);
  const weeklyPct = Math.min(100, Math.round((weeklyMinutes / Math.max(1, goal.weeklyMinutesTarget)) * 100));

  const completedBooks = books.filter((b) => b.progress >= 100).length;
  const yearlyPct = Math.min(100, Math.round((completedBooks / Math.max(1, goal.yearlyBooksTarget)) * 100));

  return {
    todayPages,
    todayMinutes,
    dailyPct,
    weeklyMinutes,
    weeklyPages,
    weeklyPct,
    completedBooks,
    yearlyPct,
    last7Days,
  };
}

// --- Zotero Citation & Annotation Export Helpers ---
export function formatZoteroCitation(book: BookMetadata, annotation: Annotation): string {
  const author = book.author || 'Unknown Author';
  const kindLabel = annotation.kind && annotation.kind !== 'highlight' ? ` [${annotation.kind}]` : '';
  const base = `"${annotation.quote}" (${author}, ${book.title}, p. ${annotation.page})${kindLabel}`;
  return annotation.note ? `${base}\nNote: ${annotation.note}` : base;
}

export function exportAnnotationsToMarkdown(book: BookMetadata, annotations: Annotation[]): string {
  const sorted = [...annotations].sort((a, b) => a.page - b.page);
  const lines = [
    `# Reading Notes: ${book.title}`,
    `**Author:** ${book.author} · **Format:** ${book.format.toUpperCase()}`,
    '',
  ];
  for (const ann of sorted) {
    const kind = (ann.kind || 'highlight').toUpperCase();
    const tags = ann.tags && ann.tags.length > 0 ? ` · Tags: ${ann.tags.map((t) => `#${t}`).join(' ')}` : '';
    lines.push(`### Page ${ann.page} (${kind}${tags})`);
    lines.push(`> ${ann.quote}`);
    if (ann.note) {
      lines.push('');
      lines.push(ann.note);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// Blueprint-synchronized sanitization helpers (matching firebase-blueprint.json verbatim)
export function clampBookPayload(book: BookMetadata, ownerId: string) {
  const pageCount = Math.max(1, Math.floor(book.pageCount || 1));
  const currentPage = Math.max(1, Math.min(pageCount, Math.floor(book.currentPage || 1)));
  return {
    id: sanitizeId(book.id),
    ownerId: sanitizeId(ownerId),
    title: (book.title || 'Untitled Document').trim().slice(0, 240),
    author: (book.author || 'Unknown Author').trim().slice(0, 160),
    format: (['pdf', 'epub', 'djvu'].includes(book.format) ? book.format : 'pdf') as BookFormat,
    folderPath: normalizeFolderPath(book.folderPath || '/Root'),
    fileSize: Math.max(0, Number(book.fileSize) || 0),
    pageCount,
    currentPage,
    progress: Math.max(0, Math.min(100, Number(book.progress) || 0)),
    isFavorite: Boolean(book.isFavorite),
    offlinePinned: Boolean(book.offlinePinned),
    tags: (book.tags || []).slice(0, 10).map((t) => String(t).trim().slice(0, 40)).filter(Boolean),
    coverUrl: (book.coverUrl || '').slice(0, 500),
    excerpt: (book.excerpt || '').slice(0, 2000),
    language: (book.language || 'English').slice(0, 32),
    addedAt: Math.max(0, Number(book.addedAt) || Date.now()),
    lastOpenedAt: Math.max(0, Number(book.lastOpenedAt || book.addedAt) || Date.now()),
  };
}

function clampPosition(pos?: AnnotationPosition): AnnotationPosition | undefined {
  if (!pos) return undefined;
  return {
    x: Math.max(0, Math.min(1, Number(pos.x) || 0)),
    y: Math.max(0, Math.min(1, Number(pos.y) || 0)),
    width: Math.max(0, Math.min(1, Number(pos.width) || 0)),
    height: Math.max(0, Math.min(1, Number(pos.height) || 0)),
  };
}

export function clampAnnotationPayload(ann: Annotation, ownerId: string) {
  const validColors: HighlightColor[] = ['amber', 'sage', 'sky', 'rose', 'violet'];
  const validKinds: AnnotationKind[] = ['highlight', 'underline', 'note', 'area', 'ink'];
  const payload: {
    id: string;
    ownerId: string;
    bookId: string;
    page: number;
    chapterTitle: string;
    kind: AnnotationKind;
    quote: string;
    note: string;
    color: HighlightColor;
    tags: string[];
    position?: AnnotationPosition;
    rects?: AnnotationPosition[];
    inkStrokes?: string[];
  } = {
    id: sanitizeId(ann.id),
    ownerId: sanitizeId(ownerId),
    bookId: sanitizeId(ann.bookId),
    page: Math.max(1, Math.floor(ann.page || 1)),
    chapterTitle: (ann.chapterTitle || '').slice(0, 200),
    kind: ann.kind && validKinds.includes(ann.kind) ? ann.kind : 'highlight',
    quote: (ann.quote || 'Highlighted passage').trim().slice(0, 2000) || 'Highlighted passage',
    note: (ann.note || '').slice(0, 4000),
    color: validColors.includes(ann.color) ? ann.color : 'amber',
    tags: (ann.tags || []).slice(0, 10).map((t) => String(t).trim().slice(0, 40)).filter(Boolean),
  };
  const pos = clampPosition(ann.position);
  if (pos) payload.position = pos;
  if (Array.isArray(ann.rects) && ann.rects.length > 0) {
    payload.rects = ann.rects
      .slice(0, 24)
      .map((r) => clampPosition(r))
      .filter((r): r is AnnotationPosition => Boolean(r));
  }
  if (Array.isArray(ann.inkStrokes) && ann.inkStrokes.length > 0) {
    payload.inkStrokes = ann.inkStrokes.slice(0, 30).map((s) => String(s).slice(0, 2000));
  }
  return payload;
}

export function clampCoursePayload(course: StudyCourse, ownerId: string) {
  return {
    id: sanitizeId(course.id),
    ownerId: sanitizeId(ownerId),
    bookId: sanitizeId(course.bookId),
    title: (course.title || 'Study Course').trim().slice(0, 240),
    summary: (course.summary || 'Course summary').trim().slice(0, 8000),
    keyConcepts: (course.keyConcepts || []).slice(0, 16).map((c) => String(c).slice(0, 160)),
    modules: (course.modules || []).slice(0, 16),
  };
}

const VALID_READER_THEMES: ReaderTheme[] = ['paper', 'sepia', 'parchment', 'sage', 'dusk', 'nord', 'night', 'amoled'];
const VALID_UI_THEMES: UITheme[] = ['light', 'parchment', 'sage', 'dark', 'obsidian'];
const VALID_ACCENT_COLORS: AppAccentColor[] = ['cobalt', 'forest', 'burgundy', 'ochre', 'indigo', 'graphite'];
const VALID_FONTS: ReaderFontFamily[] = [
  'serif',
  'literary',
  'garamond',
  'merriweather',
  'sans',
  'humanist',
  'accessible',
  'mono',
];
const VALID_EPUB_MODES: EpubViewMode[] = ['scroll', 'paginated', 'spread'];

export function clampPreferencesPayload(prefs: ReaderPreferences, ownerId: string) {
  return {
    ownerId: sanitizeId(ownerId),
    theme: VALID_READER_THEMES.includes(prefs.theme) ? prefs.theme : 'paper',
    uiTheme: VALID_UI_THEMES.includes(prefs.uiTheme) ? prefs.uiTheme : 'light',
    accentColor:
      prefs.accentColor && VALID_ACCENT_COLORS.includes(prefs.accentColor) ? prefs.accentColor : 'cobalt',
    fontFamily: VALID_FONTS.includes(prefs.fontFamily) ? prefs.fontFamily : 'serif',
    fontSize: Math.max(12, Math.min(32, Number(prefs.fontSize) || 18)),
    lineHeight: Math.max(1.1, Math.min(2.4, Number(prefs.lineHeight) || 1.65)),
    maxWidth: Math.max(480, Math.min(1200, Number(prefs.maxWidth) || 740)),
    columnCount: prefs.columnCount === 2 ? 2 : 1,
    epubViewMode:
      prefs.epubViewMode && VALID_EPUB_MODES.includes(prefs.epubViewMode) ? prefs.epubViewMode : 'scroll',
    novelIndent: Boolean(prefs.novelIndent ?? true),
    novelJustify: Boolean(prefs.novelJustify ?? true),
    novelDropCap: Boolean(prefs.novelDropCap ?? true),
    backupFrequency: ['manual', 'onChange', 'hourly', 'daily'].includes(prefs.backupFrequency)
      ? prefs.backupFrequency
      : 'onChange',
  };
}

export function clampReadingGoalPayload(goal: ReadingGoal, ownerId: string) {
  return {
    id: sanitizeId(goal.id || 'default'),
    ownerId: sanitizeId(ownerId),
    dailyPagesTarget: Math.max(1, Math.min(1000, Math.floor(goal.dailyPagesTarget ?? 25))),
    weeklyMinutesTarget: Math.max(10, Math.min(5000, Math.floor(goal.weeklyMinutesTarget ?? 180))),
    yearlyBooksTarget: Math.max(1, Math.min(500, Math.floor(goal.yearlyBooksTarget ?? 24))),
    currentStreakDays: Math.max(0, Math.min(3650, Math.floor(goal.currentStreakDays ?? 0))),
    longestStreakDays: Math.max(0, Math.min(3650, Math.floor(goal.longestStreakDays ?? 0))),
    totalPagesRead: Math.max(0, Math.min(1000000, Math.floor(goal.totalPagesRead ?? 0))),
    totalMinutesRead: Math.max(0, Math.min(1000000, Math.floor(goal.totalMinutesRead ?? 0))),
    dailyHistory: (goal.dailyHistory || []).slice(-90).map((s) => String(s).slice(0, 40)),
  };
}

export function validateBackupArchive(input: unknown): input is BackupArchive {
  if (!input || typeof input !== 'object') return false;
  const obj = input as Partial<BackupArchive>;
  return (
    typeof obj.version === 'number' &&
    typeof obj.exportedAtMs === 'number' &&
    Array.isArray(obj.books) &&
    Array.isArray(obj.annotations) &&
    Array.isArray(obj.courses)
  );
}

export function detectSupportedBookFormat(filename: string): BookFormat | null {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = filename.slice(dot + 1).toLowerCase();
  if (ext === 'pdf' || ext === 'epub' || ext === 'djvu') {
    return ext;
  }
  return null;
}

export async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= items.length) return;
      results[current] = await worker(items[current], current);
    }
  }

  await Promise.all(Array.from({length: limit}, () => runWorker()));
  return results;
}

export type DuplicateMatchType = 'exact-hash' | 'metadata-match';

export interface DuplicateBookGroup {
  id: string;
  matchType: DuplicateMatchType;
  reason: string;
  recommendedKeepId: string;
  books: BookMetadata[];
}

export async function computeBufferSha256(buffer: ArrayBuffer): Promise<string> {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle) {
    // Deterministic FNV-1a fallback if WebCrypto subtle is unavailable
    const view = new Uint8Array(buffer);
    let hash = 2166136261;
    for (let i = 0; i < view.length; i++) {
      hash ^= view[i];
      hash = Math.imul(hash, 16777619);
    }
    return `fnv_${view.length}_${(hash >>> 0).toString(16)}`;
  }
  const digest = await cryptoApi.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function pickRecommendedKeepBookId(
  groupBooks: BookMetadata[],
  annotations: Annotation[],
): string {
  const annCounts = new Map<string, number>();
  for (const ann of annotations) {
    annCounts.set(ann.bookId, (annCounts.get(ann.bookId) || 0) + 1);
  }

  const scored = [...groupBooks].sort((a, b) => {
    const scoreA =
      (annCounts.get(a.id) || 0) * 100 +
      (a.progress || 0) +
      (a.offlinePinned ? 20 : 0) +
      (a.isFavorite ? 15 : 0);
    const scoreB =
      (annCounts.get(b.id) || 0) * 100 +
      (b.progress || 0) +
      (b.offlinePinned ? 20 : 0) +
      (b.isFavorite ? 15 : 0);
    if (scoreB !== scoreA) return scoreB - scoreA;
    return a.addedAt - b.addedAt;
  });

  return scored[0]?.id || groupBooks[0].id;
}

export function findDuplicateBookGroups(
  books: BookMetadata[],
  annotations: Annotation[] = [],
): DuplicateBookGroup[] {
  const groups: DuplicateBookGroup[] = [];
  const claimedIds = new Set<string>();

  // 1. Exact binary SHA-256 hash duplicates
  const byHash = new Map<string, BookMetadata[]>();
  for (const book of books) {
    if (!book.contentHash) continue;
    const list = byHash.get(book.contentHash) || [];
    list.push(book);
    byHash.set(book.contentHash, list);
  }

  for (const [hash, list] of byHash.entries()) {
    if (list.length < 2) continue;
    for (const b of list) claimedIds.add(b.id);
    groups.push({
      id: `dup_hash_${hash.slice(0, 12)}`,
      matchType: 'exact-hash',
      reason: 'Identical file bytes (SHA-256 match)',
      recommendedKeepId: pickRecommendedKeepBookId(list, annotations),
      books: [...list].sort((a, b) => a.addedAt - b.addedAt),
    });
  }

  // 2. Normalized metadata + format + (same fileSize or same author & pageCount) fallback
  const byMeta = new Map<string, BookMetadata[]>();
  for (const book of books) {
    if (claimedIds.has(book.id)) continue;
    const normTitle = book.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!normTitle) continue;
    const normAuthor = (book.author || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const key =
      book.fileSize > 0
        ? `${book.format}|size:${book.fileSize}|${normTitle}`
        : `${book.format}|meta:${normTitle}|${normAuthor}|${book.pageCount}`;
    const list = byMeta.get(key) || [];
    list.push(book);
    byMeta.set(key, list);
  }

  for (const [key, list] of byMeta.entries()) {
    if (list.length < 2) continue;
    groups.push({
      id: `dup_meta_${sanitizeId(key).slice(0, 24)}`,
      matchType: 'metadata-match',
      reason: 'Matching title, format, and file size',
      recommendedKeepId: pickRecommendedKeepBookId(list, annotations),
      books: [...list].sort((a, b) => a.addedAt - b.addedAt),
    });
  }

  return groups;
}
