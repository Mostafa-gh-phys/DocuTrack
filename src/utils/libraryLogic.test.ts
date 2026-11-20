import assert from 'node:assert/strict';
import test from 'node:test';
import type {BookMetadata, DocumentTextChunk, ReaderPreferences} from '../types/library';
import {
  buildFolderTree,
  calculateProgress,
  clampAnnotationPayload,
  clampBookPayload,
  clampPreferencesPayload,
  clampReadingGoalPayload,
  computeBufferSha256,
  createDefaultReadingGoal,
  deriveFolderFromRelativePath,
  detectSupportedBookFormat,
  exportAnnotationsToMarkdown,
  findDuplicateBookGroups,
  formatZoteroCitation,
  getFolderViewContents,
  getReadingGoalStats,
  normalizeFolderPath,
  pickRecommendedKeepBookId,
  recordReadingActivity,
  runWithConcurrency,
  searchLocalSemanticChunks,
  sortAndFilterBooks,
  validateBackupArchive,
} from './libraryLogic';

const sampleBooks: BookMetadata[] = [
  {
    id: 'book-1',
    ownerId: 'local',
    title: 'Designing Reliable Distributed Systems',
    author: 'Elena Vance',
    format: 'pdf',
    folderPath: '/Computer Science/Systems',
    fileSize: 420000,
    pageCount: 12,
    currentPage: 5,
    progress: 42,
    isFavorite: true,
    offlinePinned: true,
    tags: ['consensus', 'paxos'],
    addedAt: 1000,
    lastOpenedAt: 5000,
    updatedAtMs: 5000,
  },
  {
    id: 'book-2',
    ownerId: 'local',
    title: 'The Elements of Digital Typography',
    author: 'Martin Bringhurst',
    format: 'epub',
    folderPath: '/Design/Editorial',
    fileSize: 180000,
    pageCount: 6,
    currentPage: 6,
    progress: 100,
    isFavorite: false,
    offlinePinned: true,
    tags: ['typography', 'grid'],
    addedAt: 2000,
    lastOpenedAt: 4000,
    updatedAtMs: 4000,
  },
  {
    id: 'book-3',
    ownerId: 'local',
    title: 'Foundations of Optical & Signal Theory',
    author: 'H. K. Lindholm',
    format: 'djvu',
    folderPath: '/Physics/Optics',
    fileSize: 950000,
    pageCount: 4,
    currentPage: 1,
    progress: 25,
    isFavorite: false,
    offlinePinned: false,
    tags: ['optics', 'fourier'],
    addedAt: 3000,
    lastOpenedAt: 3000,
    updatedAtMs: 3000,
  },
];

test('normalizeFolderPath and deriveFolderFromRelativePath handle OS paths cleanly', () => {
  assert.equal(normalizeFolderPath('Research\\Papers/'), '/Research/Papers');
  assert.equal(normalizeFolderPath(''), '/Root');
  assert.equal(
    deriveFolderFromRelativePath('HardDriveBooks/Computer Science/Systems/raft.pdf'),
    '/HardDriveBooks/Computer Science/Systems',
  );
  assert.equal(deriveFolderFromRelativePath('singlefile.epub', '/Uploads'), '/Uploads');
});

test('buildFolderTree builds nested folders with accurate descendant counts', () => {
  const tree = buildFolderTree(sampleBooks);
  assert.equal(tree.length, 3);
  const cs = tree.find((n) => n.name === 'Computer Science');
  assert.ok(cs);
  assert.equal(cs.count, 1);
  assert.equal(cs.children[0].path, '/Computer Science/Systems');
  assert.equal(cs.children[0].count, 1);
});

test('getFolderViewContents resolves root folders, nested subfolders, breadcrumbs, and parentPath', () => {
  const tree = buildFolderTree(sampleBooks);
  const root = getFolderViewContents(tree, null);
  assert.equal(root.breadcrumbs.length, 0);
  assert.equal(root.parentPath, null);
  assert.equal(root.childFolders.length, 3);

  const cs = getFolderViewContents(tree, '/Computer Science');
  assert.deepEqual(cs.breadcrumbs, [{name: 'Computer Science', path: '/Computer Science'}]);
  assert.equal(cs.parentPath, null);
  assert.equal(cs.childFolders.length, 1);
  assert.equal(cs.childFolders[0].path, '/Computer Science/Systems');

  const leaf = getFolderViewContents(tree, '/Computer Science/Systems');
  assert.deepEqual(leaf.breadcrumbs, [
    {name: 'Computer Science', path: '/Computer Science'},
    {name: 'Systems', path: '/Computer Science/Systems'},
  ]);
  assert.equal(leaf.parentPath, '/Computer Science');
  assert.equal(leaf.childFolders.length, 0);
});

test('sortAndFilterBooks filters by folder hierarchy, format, collection, and sorts accurately', () => {
  const byFolder = sortAndFilterBooks(sampleBooks, {
    collection: 'all',
    folderPath: '/Computer Science',
    format: 'all',
    query: '',
    sortBy: 'title',
    sortDirection: 'asc',
  });
  assert.equal(byFolder.length, 1);
  assert.equal(byFolder[0].id, 'book-1');

  const readingNow = sortAndFilterBooks(sampleBooks, {
    collection: 'reading',
    folderPath: null,
    format: 'all',
    query: '',
    sortBy: 'progress',
    sortDirection: 'desc',
  });
  assert.deepEqual(
    readingNow.map((b) => b.id),
    ['book-1', 'book-3'],
  );

  const sortedBySize = sortAndFilterBooks(sampleBooks, {
    collection: 'all',
    folderPath: null,
    format: 'all',
    query: '',
    sortBy: 'fileSize',
    sortDirection: 'desc',
  });
  assert.equal(sortedBySize[0].id, 'book-3');
});

test('searchLocalSemanticChunks retrieves conceptually related passages via semantic expansion', () => {
  const chunks: DocumentTextChunk[] = [
    {
      bookId: 'book-1',
      bookTitle: 'Designing Reliable Distributed Systems',
      page: 2,
      text: 'Quorum replication protocols like Raft ensure fault tolerance even when minority nodes partition.',
    },
    {
      bookId: 'book-2',
      bookTitle: 'The Elements of Digital Typography',
      page: 1,
      text: 'Measure, kerning, and vertical leading establish rhythm across editorial pages.',
    },
  ];
  const results = searchLocalSemanticChunks('consensus', chunks);
  assert.equal(results.length, 1);
  assert.equal(results[0].bookId, 'book-1');
  assert.ok(results[0].score > 0.1);
});

test('payload clampers enforce blueprint boundaries and calculateProgress bounds', () => {
  assert.equal(calculateProgress(5, 10), 50);
  assert.equal(calculateProgress(99, 10), 100);

  const clampedBook = clampBookPayload(
    {
      ...sampleBooks[0],
      id: 'bad/id with spaces!',
      title: 'A'.repeat(300),
      currentPage: 999,
      pageCount: 12,
      tags: Array.from({length: 15}, (_, i) => `tag${i}`),
    },
    'user_123',
  );
  assert.equal(clampedBook.id, 'bad_id_with_spaces_');
  assert.equal(clampedBook.title.length, 240);
  assert.equal(clampedBook.currentPage, 12);
  assert.equal(clampedBook.tags.length, 10);

  const clampedAnn = clampAnnotationPayload(
    {
      id: 'ann-1',
      ownerId: 'u1',
      bookId: 'book-1',
      page: 0,
      kind: 'area',
      quote: '   ',
      note: 'note',
      color: 'violet',
      tags: ['key-figure', 'architecture'],
      position: {x: -0.2, y: 0.3, width: 1.5, height: 0.25},
      rects: [
        ...Array.from({length: 30}, (_, idx) => ({
          x: idx === 0 ? -0.5 : 0.1,
          y: 0.2,
          width: idx === 0 ? 1.8 : 0.4,
          height: 0.03,
        })),
      ],
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    'u1',
  );
  assert.equal(clampedAnn.page, 1);
  assert.equal(clampedAnn.kind, 'area');
  assert.equal(clampedAnn.color, 'violet');
  assert.equal(clampedAnn.quote, 'Highlighted passage');
  assert.equal(clampedAnn.position?.x, 0);
  assert.equal(clampedAnn.position?.width, 1);
  assert.equal(clampedAnn.rects?.length, 24);
  assert.equal(clampedAnn.rects?.[0].x, 0);
  assert.equal(clampedAnn.rects?.[0].width, 1);

  const prefs: ReaderPreferences = {
    theme: 'nord',
    uiTheme: 'parchment',
    accentColor: 'burgundy',
    fontFamily: 'literary',
    fontSize: 99,
    lineHeight: 0.5,
    maxWidth: 2000,
    columnCount: 2,
    epubViewMode: 'spread',
    novelIndent: true,
    novelJustify: true,
    novelDropCap: false,
    backupFrequency: 'hourly',
    updatedAtMs: 1,
  };
  const clampedPrefs = clampPreferencesPayload(prefs, 'u1');
  assert.equal(clampedPrefs.theme, 'nord');
  assert.equal(clampedPrefs.uiTheme, 'parchment');
  assert.equal(clampedPrefs.accentColor, 'burgundy');
  assert.equal(clampedPrefs.fontFamily, 'literary');
  assert.equal(clampedPrefs.epubViewMode, 'spread');
  assert.equal(clampedPrefs.novelDropCap, false);
  assert.equal(clampedPrefs.fontSize, 32);
  assert.equal(clampedPrefs.lineHeight, 1.1);
  assert.equal(clampedPrefs.maxWidth, 1200);
});

test('reading goals track daily pages, weekly minutes, streaks, and clamp payloads', () => {
  const today = '2026-11-18';
  const baseGoal = createDefaultReadingGoal('u1', today);
  const initialStats = getReadingGoalStats(baseGoal, sampleBooks, today);
  assert.equal(initialStats.todayPages, 8);
  assert.equal(initialStats.completedBooks, 1);
  assert.equal(initialStats.last7Days.length, 7);

  const updated = recordReadingActivity(baseGoal, 20, 15, today);
  const updatedStats = getReadingGoalStats(updated, sampleBooks, today);
  assert.equal(updatedStats.todayPages, 28);
  assert.equal(updatedStats.dailyPct, 100);
  assert.equal(updated.currentStreakDays, 4);
  assert.equal(updated.longestStreakDays, 4);

  const clampedGoal = clampReadingGoalPayload(
    {
      ...updated,
      dailyPagesTarget: 99999,
      weeklyMinutesTarget: 2,
      yearlyBooksTarget: 0,
    },
    'u1',
  );
  assert.equal(clampedGoal.dailyPagesTarget, 1000);
  assert.equal(clampedGoal.weeklyMinutesTarget, 10);
  assert.equal(clampedGoal.yearlyBooksTarget, 1);
});

test('Zotero citation and markdown export format annotations accurately', () => {
  const ann = {
    id: 'a1',
    ownerId: 'local',
    bookId: 'book-1',
    page: 5,
    kind: 'underline' as const,
    quote: 'Leader leases prevent split-brain writes.',
    note: 'Compare with Raft §6.4',
    color: 'sky' as const,
    tags: ['leases', 'consistency'],
    createdAtMs: 1,
    updatedAtMs: 1,
  };
  const citation = formatZoteroCitation(sampleBooks[0], ann);
  assert.match(citation, /Elena Vance, Designing Reliable Distributed Systems, p\. 5/);
  assert.match(citation, /\[underline\]/);

  const md = exportAnnotationsToMarkdown(sampleBooks[0], [ann]);
  assert.match(md, /# Reading Notes: Designing Reliable Distributed Systems/);
  assert.match(md, /#leases #consistency/);
  assert.match(md, /Compare with Raft §6\.4/);
});

test('validateBackupArchive validates structure cleanly', () => {
  assert.equal(
    validateBackupArchive({
      version: 1,
      exportedAtMs: Date.now(),
      books: [],
      annotations: [],
      courses: [],
    }),
    true,
  );
  assert.equal(validateBackupArchive({version: 1}), false);
});

test('detectSupportedBookFormat filters supported formats before file reads', () => {
  assert.equal(detectSupportedBookFormat('paper.PDF'), 'pdf');
  assert.equal(detectSupportedBookFormat('notes.epub'), 'epub');
  assert.equal(detectSupportedBookFormat('archive.DjVu'), 'djvu');
  assert.equal(detectSupportedBookFormat('photo.png'), null);
  assert.equal(detectSupportedBookFormat('.pdf'), null);
  assert.equal(detectSupportedBookFormat('README'), null);
});

test('runWithConcurrency preserves order while bounding parallel workers', async () => {
  let active = 0;
  let maxActive = 0;
  const inputs = [10, 20, 30, 40, 50, 60];
  const out = await runWithConcurrency(inputs, 2, async (val) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 5));
    active -= 1;
    return val * 2;
  });
  assert.deepEqual(out, [20, 40, 60, 80, 100, 120]);
  assert.ok(maxActive <= 2);
});

test('computeBufferSha256 and findDuplicateBookGroups detect exact hash and metadata duplicates and protect annotated copy', async () => {
  const bytesA = new TextEncoder().encode('identical-pdf-binary-stream');
  const bytesB = new TextEncoder().encode('different-binary-stream');
  const hashA1 = await computeBufferSha256(bytesA.buffer);
  const hashA2 = await computeBufferSha256(bytesA.slice().buffer);
  const hashB = await computeBufferSha256(bytesB.buffer);
  assert.equal(hashA1, hashA2);
  assert.notEqual(hashA1, hashB);

  const booksWithDups: BookMetadata[] = [
    {...sampleBooks[0], id: 'orig-1', contentHash: hashA1, addedAt: 1000, progress: 10},
    {
      ...sampleBooks[0],
      id: 'dup-1',
      title: 'Copy of Designing Reliable Distributed Systems',
      folderPath: '/Downloads',
      contentHash: hashA2,
      addedAt: 2000,
      progress: 80,
    },
    {...sampleBooks[1], id: 'meta-orig', contentHash: hashB, addedAt: 1500},
    {...sampleBooks[1], id: 'meta-dup', folderPath: '/Desktop', addedAt: 2500},
  ];

  const anns = [
    {
      id: 'a-keep',
      ownerId: 'local',
      bookId: 'dup-1',
      page: 2,
      quote: 'Important quote',
      note: 'Keep this annotated copy',
      color: 'amber' as const,
      createdAtMs: 1,
      updatedAtMs: 1,
    },
  ];

  assert.equal(pickRecommendedKeepBookId([booksWithDups[0], booksWithDups[1]], anns), 'dup-1');

  const groups = findDuplicateBookGroups(booksWithDups, anns);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].matchType, 'exact-hash');
  assert.equal(groups[0].recommendedKeepId, 'dup-1');
  assert.equal(groups[1].matchType, 'metadata-match');
});
