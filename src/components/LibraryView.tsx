import React, {useMemo, useState} from 'react';
import {
  ArrowDownUp,
  ArrowLeft,
  BookOpen,
  ChevronRight,
  CopyCheck,
  Folder,
  FolderTree,
  GraduationCap,
  HardDriveDownload,
  Heart,
  LayoutGrid,
  List,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
} from 'lucide-react';
import type {
  Annotation,
  BookMetadata,
  FolderNode,
  LibraryCollection,
  SemanticSearchResult,
  SortDirection,
  SortField,
  StudyCourse,
} from '../types/library';
import {extractFilesFromDataTransfer} from '../utils/folderWalk';
import {formatBytes, getFolderViewContents} from '../utils/libraryLogic';

interface LibraryViewProps {
  books: BookMetadata[];
  totalBooksCount: number;
  folderTree: FolderNode[];
  activeCollection: LibraryCollection;
  bookCovers: Record<string, string>;
  annotations: Annotation[];
  courses: StudyCourse[];
  activeFolder: string | null;
  searchQuery: string;
  semanticMode: boolean;
  semanticResults: SemanticSearchResult[];
  semanticLoading: boolean;
  semanticSourceLabel: string | null;
  sortBy: SortField;
  sortDirection: SortDirection;
  viewMode: 'grid' | 'list';
  onSelectFolder: (path: string | null) => void;
  onSearchChange: (q: string) => void;
  onToggleSemanticMode: () => void;
  onRunSemanticSearch: (query: string) => void;
  onSortChange: (field: SortField) => void;
  onToggleSortDirection: () => void;
  onViewModeChange: (mode: 'grid' | 'list') => void;
  onOpenBook: (book: BookMetadata, targetPage?: number) => void;
  onToggleFavorite: (book: BookMetadata) => void;
  onToggleOfflinePin: (book: BookMetadata) => void;
  onDeleteBook: (book: BookMetadata) => void;
  onOpenCourseModal: (book: BookMetadata) => void;
  onConvertBook: (book: BookMetadata) => void;
  onTriggerImport: () => void;
  onDropFiles: (files: File[]) => Promise<void>;
  onOpenDuplicatesModal: () => void;
  duplicateCount?: number;
}

export const LibraryView: React.FC<LibraryViewProps> = ({
  books,
  totalBooksCount,
  folderTree,
  activeCollection,
  bookCovers,
  annotations,
  courses,
  activeFolder,
  searchQuery,
  semanticMode,
  semanticResults,
  semanticLoading,
  semanticSourceLabel,
  sortBy,
  sortDirection,
  viewMode,
  onSelectFolder,
  onSearchChange,
  onToggleSemanticMode,
  onRunSemanticSearch,
  onSortChange,
  onToggleSortDirection,
  onViewModeChange,
  onOpenBook,
  onToggleFavorite,
  onToggleOfflinePin,
  onDeleteBook,
  onOpenCourseModal,
  onConvertBook,
  onTriggerImport,
  onDropFiles,
  onOpenDuplicatesModal,
  duplicateCount = 0,
}) => {
  const [failedCovers, setFailedCovers] = useState<Record<string, boolean>>({});
  const [draggingOver, setDraggingOver] = useState(false);

  const folderContents = useMemo(
    () => getFolderViewContents(folderTree, activeFolder),
    [folderTree, activeFolder],
  );
  const showFolderBrowser =
    activeCollection === 'all' &&
    !searchQuery.trim() &&
    !semanticMode &&
    (folderContents.childFolders.length > 0 || activeFolder !== null);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (semanticMode && searchQuery.trim()) {
      onRunSemanticSearch(searchQuery.trim());
    }
  };

  const handleLibraryDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDraggingOver(false);
    const files = await extractFilesFromDataTransfer(e.dataTransfer);
    if (files.length > 0) {
      await onDropFiles(files);
    }
  };

  return (
    <div
      className="flex-1 min-w-0 flex flex-col relative"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDraggingOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDraggingOver(false);
      }}
      onDrop={(e) => void handleLibraryDrop(e)}
    >
      {/* Subtle Drag & Drop Overlay */}
      {draggingOver && (
        <div className="absolute inset-0 z-30 bg-black/25 backdrop-blur-xs flex items-center justify-center p-8 pointer-events-none">
          <div className="rounded-2xl border-2 border-dashed accent-border app-surface px-8 py-6 text-center shadow-lg">
            <p className="text-sm font-semibold">Drop files or folders to import</p>
            <p className="text-xs opacity-70 mt-1">Folder hierarchy will be preserved automatically</p>
          </div>
        </div>
      )}

      {/* Workspace Toolbar */}
      <div className="px-6 py-3.5 border-b app-border app-surface flex flex-wrap items-center justify-between gap-4">
        <form onSubmit={handleSearchSubmit} className="flex-1 min-w-[260px] max-w-xl flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="w-4 h-4 opacity-45 absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder={
                semanticMode
                  ? 'Semantic search across concepts & passages (Enter)...'
                  : 'Filter by title, author, folder path, or tag...'
              }
              aria-label="Search library"
              className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border app-border app-surface-muted placeholder:opacity-55 focus:outline-none focus:ring-2 focus:ring-blue-700/25"
            />
          </div>
          <button
            type="button"
            onClick={onToggleSemanticMode}
            aria-pressed={semanticMode}
            className={`px-3 py-2 rounded-lg text-xs font-medium border flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
              semanticMode ? 'accent-btn border-transparent' : 'app-border app-surface hover:opacity-90'
            }`}
          >
            <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
            Semantic
          </button>
          {semanticMode && (
            <button
              type="submit"
              disabled={semanticLoading || !searchQuery.trim()}
              className="px-3.5 py-2 rounded-lg text-xs font-medium bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 disabled:opacity-40 whitespace-nowrap shrink-0"
            >
              {semanticLoading ? 'Analyzing...' : 'Retrieve'}
            </button>
          )}
        </form>

        <div className="flex items-center gap-2.5 flex-wrap">
          <label htmlFor="library-sort" className="text-xs opacity-60 whitespace-nowrap">
            Sort
          </label>
          <select
            id="library-sort"
            value={sortBy}
            onChange={(e) => onSortChange(e.target.value as SortField)}
            className="px-2.5 py-1.5 text-xs font-medium rounded-lg border app-border app-surface focus:outline-none"
          >
            <option value="lastOpenedAt">Recently Opened</option>
            <option value="title">Title (Metadata)</option>
            <option value="author">Author (Metadata)</option>
            <option value="folderPath">Hard Drive Folder</option>
            <option value="format">File Format</option>
            <option value="progress">Reading Progress</option>
            <option value="fileSize">File Size</option>
            <option value="addedAt">Date Imported</option>
          </select>

          <button
            type="button"
            onClick={onToggleSortDirection}
            aria-label={`Sort direction: ${sortDirection === 'asc' ? 'Ascending' : 'Descending'}`}
            className="p-2 rounded-lg border app-border app-surface hover:opacity-85"
          >
            <ArrowDownUp className="w-3.5 h-3.5" />
          </button>

          <div className="flex items-center p-0.5 rounded-lg app-surface-muted border app-border">
            <button
              type="button"
              onClick={() => onViewModeChange('grid')}
              aria-label="Grid view"
              aria-pressed={viewMode === 'grid'}
              className={`p-1.5 rounded-md transition-colors ${
                viewMode === 'grid' ? 'app-surface shadow-xs' : 'opacity-55 hover:opacity-100'
              }`}
            >
              <LayoutGrid className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => onViewModeChange('list')}
              aria-label="List view"
              aria-pressed={viewMode === 'list'}
              className={`p-1.5 rounded-md transition-colors ${
                viewMode === 'list' ? 'app-surface shadow-xs' : 'opacity-55 hover:opacity-100'
              }`}
            >
              <List className="w-3.5 h-3.5" />
            </button>
          </div>

          <button
            type="button"
            onClick={onOpenDuplicatesModal}
            aria-label="Find and clean duplicate files"
            className="px-2.5 py-1.5 rounded-lg border app-border app-surface hover:opacity-85 text-xs font-medium flex items-center gap-1.5 whitespace-nowrap"
          >
            <CopyCheck className="w-3.5 h-3.5 accent-text" aria-hidden="true" />
            <span>Duplicates{duplicateCount > 0 ? ` (${duplicateCount})` : ''}</span>
          </button>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="p-6 space-y-6 flex-1 overflow-y-auto">
        <div className="space-y-2.5">
          {activeFolder && (
            <nav aria-label="Folder breadcrumbs" className="flex items-center flex-wrap gap-1 text-xs">
              <button
                type="button"
                onClick={() => onSelectFolder(null)}
                className="px-2 py-1 rounded-md opacity-75 hover:opacity-100 hover:bg-black/5 dark:hover:bg-white/5 font-medium flex items-center gap-1.5"
              >
                <FolderTree className="w-3.5 h-3.5" aria-hidden="true" />
                All Folders
              </button>
              {folderContents.breadcrumbs.map((crumb, idx) => {
                const isLast = idx === folderContents.breadcrumbs.length - 1;
                return (
                  <React.Fragment key={crumb.path}>
                    <ChevronRight className="w-3.5 h-3.5 opacity-40" aria-hidden="true" />
                    <button
                      type="button"
                      onClick={() => onSelectFolder(crumb.path)}
                      aria-current={isLast ? 'page' : undefined}
                      className={`px-2 py-1 rounded-md transition-colors ${
                        isLast
                          ? 'accent-soft font-semibold'
                          : 'opacity-75 hover:opacity-100 hover:bg-black/5 dark:hover:bg-white/5'
                      }`}
                    >
                      {crumb.name}
                    </button>
                  </React.Fragment>
                );
              })}
            </nav>
          )}

          <div className="flex flex-wrap items-baseline justify-between gap-4">
            <div>
              <h1 className="text-xl font-semibold tracking-tight">
                {activeFolder ? activeFolder : 'Personal Library'}
              </h1>
              <p className="mt-1 text-xs opacity-65 tabular-nums">
                Showing {books.length} of {totalBooksCount} documents · {annotations.length} annotations · {courses.length} AI courses
              </p>
            </div>
            {activeFolder && (
              <button
                type="button"
                onClick={() => onSelectFolder(folderContents.parentPath)}
                className="px-3 py-1.5 rounded-lg border app-border app-surface text-xs font-medium hover:opacity-85 flex items-center gap-1.5"
              >
                <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
                {folderContents.parentPath ? 'Up Folder' : 'All Folders'}
              </button>
            )}
          </div>
        </div>

        {/* Readest-inspired Folder Shelf Browser */}
        {showFolderBrowser && folderContents.childFolders.length > 0 && (
          <section aria-label="Folder structure" className="space-y-2.5">
            <div className="flex items-center justify-between">
              <h2 className="text-[11px] font-semibold uppercase tracking-wider opacity-55">
                {activeFolder ? 'Subfolders' : 'Folders'}
              </h2>
              <span className="text-xs tabular-nums opacity-55">
                {folderContents.childFolders.length}{' '}
                {folderContents.childFolders.length === 1 ? 'folder' : 'folders'}
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-2.5">
              {folderContents.childFolders.map((folder) => (
                <button
                  key={folder.path}
                  type="button"
                  data-testid="main-folder-card"
                  onClick={() => onSelectFolder(folder.path)}
                  className="group text-left rounded-lg border app-border app-surface px-3 py-2.5 hover:border-current transition-colors flex items-center gap-2.5 min-w-0"
                >
                  <Folder className="w-4 h-4 accent-text shrink-0" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium truncate group-hover:underline">{folder.name}</p>
                    <p className="text-[11px] opacity-60 tabular-nums truncate">
                      {folder.count} {folder.count === 1 ? 'book' : 'books'}
                      {folder.children.length > 0 ? ` · ${folder.children.length} sub` : ''}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}

        {/* Semantic Search Results */}
        {semanticMode && (semanticLoading || semanticResults.length > 0 || semanticSourceLabel) && (
          <section
            aria-label="Semantic search results"
            className="rounded-xl border app-border app-surface p-5"
          >
            <div className="flex items-center justify-between gap-4 pb-3 border-b app-border">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 accent-text" aria-hidden="true" />
                <h2 className="text-sm font-semibold">Semantic Passage Retrieval</h2>
              </div>
              {semanticSourceLabel && <span className="text-xs opacity-60">{semanticSourceLabel}</span>}
            </div>

            {semanticLoading ? (
              <div className="py-6 text-sm opacity-65">
                Analyzing conceptual relevance across your library...
              </div>
            ) : semanticResults.length === 0 ? (
              <div className="py-6 text-sm opacity-65">
                No matching passages found. Try a broader concept such as "quorum replication" or "typographic measure".
              </div>
            ) : (
              <div className="divide-y divide-black/10 dark:divide-white/10">
                {semanticResults.map((hit, idx) => {
                  const targetBook = books.find((b) => b.id === hit.bookId);
                  return (
                    <div key={`${hit.bookId}-${hit.page}-${idx}`} className="py-3.5 flex items-start justify-between gap-4">
                      <div className="min-w-0 space-y-1">
                        <div className="flex items-center gap-2 text-xs opacity-65">
                          <span className="font-semibold opacity-100">{hit.bookTitle}</span>
                          <span aria-hidden="true">·</span>
                          <span className="tabular-nums">Page {hit.page}</span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono tabular-nums accent-text">
                            {(hit.score * 100).toFixed(0)}% match
                          </span>
                        </div>
                        <p className="text-sm opacity-90 leading-relaxed line-clamp-2">"{hit.snippet}"</p>
                        <p className="text-xs opacity-60">{hit.reason}</p>
                      </div>
                      {targetBook && (
                        <button
                          type="button"
                          onClick={() => onOpenBook(targetBook, hit.page)}
                          className="px-3 py-1.5 rounded-lg border app-border text-xs font-medium hover:bg-black/5 dark:hover:bg-white/5 whitespace-nowrap shrink-0"
                        >
                          Jump to Page {hit.page}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {/* Empty State */}
        {books.length === 0 ? (
          <div className="rounded-xl border app-border app-surface p-12 text-center">
            <FolderTree className="w-10 h-10 opacity-30 mx-auto" aria-hidden="true" />
            <h2 className="mt-4 text-base font-semibold">No matching documents in this view</h2>
            <p className="mt-1.5 text-sm opacity-65 max-w-md mx-auto">
              Drop files or nested folders anywhere here, or click Import in the top bar.
            </p>
            <button
              type="button"
              onClick={onTriggerImport}
              className="mt-5 px-4 py-2 rounded-lg accent-btn text-sm font-medium transition-colors"
            >
              Import Documents
            </button>
          </div>
        ) : viewMode === 'grid' ? (
          /* Readest-Inspired Bookshelf Grid: Upright 2:3 Covers + Uncluttered Metadata Below */
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-x-5 gap-y-7">
            {books.map((book) => {
              const bookAnnCount = annotations.filter((a) => a.bookId === book.id).length;
              const hasCourse = courses.some((c) => c.bookId === book.id);
              const resolvedCover = bookCovers[book.id] || book.coverUrl;
              const showFallbackCover = !resolvedCover || failedCovers[book.id];

              return (
                <article
                  key={book.id}
                  data-testid="book-shelf-card"
                  className="group flex flex-col min-w-0"
                >
                  <button
                    type="button"
                    onClick={() => onOpenBook(book)}
                    className="text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-700 rounded-lg"
                  >
                    {/* Upright Book Cover Frame */}
                    <div className="relative aspect-[2/3] w-full rounded-lg border app-border app-surface overflow-hidden shadow-xs group-hover:shadow-md transition-all">
                      {!showFallbackCover ? (
                        <img
                          src={resolvedCover}
                          alt={`Cover for ${book.title}`}
                          referrerPolicy="no-referrer"
                          onError={() => setFailedCovers((prev) => ({...prev, [book.id]: true}))}
                          className="w-full h-full object-cover bg-white transition-transform duration-200 group-hover:scale-[1.02]"
                        />
                      ) : (
                        <div className="w-full h-full p-4 flex flex-col justify-between app-surface-muted">
                          <div className="flex items-center justify-between text-[10px] font-mono uppercase tracking-wider opacity-60">
                            <span>{book.format}</span>
                            <span className="tabular-nums">{book.pageCount}p</span>
                          </div>
                          <div className="my-auto py-2">
                            <p className="font-serif-reader text-sm font-semibold leading-snug line-clamp-4">
                              {book.title}
                            </p>
                          </div>
                          <p className="text-[11px] opacity-65 truncate border-t app-border pt-2">
                            {book.author}
                          </p>
                        </div>
                      )}
                      {/* Subtle book spine crease on left edge */}
                      <div
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-y-0 left-0 w-2 bg-gradient-to-r from-black/15 to-transparent"
                      />
                    </div>

                    {/* Clean Unboxed Title & Metadata Below Cover */}
                    <div className="pt-2.5 space-y-0.5">
                      <h3 className="text-sm font-semibold leading-snug line-clamp-2 group-hover:underline">
                        {book.title}
                      </h3>
                      <p className="text-xs opacity-65 truncate">{book.author}</p>
                      <div className="text-[11px] opacity-55 flex items-center justify-between gap-2 tabular-nums pt-0.5">
                        <span className="font-mono uppercase">{book.format}</span>
                        <span>
                          {book.progress}% · {book.pageCount}p
                        </span>
                      </div>
                    </div>
                  </button>

                  {/* Slim Reading Progress Track & Compact Action Strip */}
                  <div className="mt-2 space-y-2">
                    <div className="h-[3px] w-full rounded-full app-surface-muted overflow-hidden">
                      <div
                        className="h-full transition-[width] duration-200"
                        style={{width: `${book.progress}%`, backgroundColor: 'var(--accent)'}}
                      />
                    </div>

                    <div className="flex items-center justify-between gap-1">
                      <div className="flex items-center gap-0.5">
                        <button
                          type="button"
                          onClick={() => onToggleFavorite(book)}
                          aria-label={book.isFavorite ? `Remove ${book.title} from favorites` : `Favorite ${book.title}`}
                          aria-pressed={book.isFavorite}
                          className={`p-1 rounded transition-colors ${
                            book.isFavorite
                              ? 'text-rose-600 bg-rose-50 dark:bg-rose-950/40'
                              : 'opacity-45 hover:opacity-100'
                          }`}
                        >
                          <Heart className="w-3.5 h-3.5" fill={book.isFavorite ? 'currentColor' : 'none'} />
                        </button>
                        <button
                          type="button"
                          onClick={() => onToggleOfflinePin(book)}
                          aria-label={
                            book.offlinePinned
                              ? `Remove ${book.title} from offline cache`
                              : `Pin ${book.title} for offline reading`
                          }
                          aria-pressed={book.offlinePinned}
                          className={`p-1 rounded transition-colors ${
                            book.offlinePinned
                              ? 'text-emerald-700 bg-emerald-50 dark:text-emerald-400 dark:bg-emerald-950/40'
                              : 'opacity-45 hover:opacity-100'
                          }`}
                        >
                          <HardDriveDownload className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onOpenCourseModal(book)}
                          aria-label={`AI summary and lecture course for ${book.title}`}
                          className={`p-1 rounded transition-colors ${
                            hasCourse ? 'accent-soft' : 'opacity-45 hover:opacity-100'
                          }`}
                        >
                          <GraduationCap className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onConvertBook(book)}
                          aria-label={`Convert ${book.title} format`}
                          title="Convert format"
                          className="p-1 rounded opacity-45 hover:opacity-100 transition-colors"
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onDeleteBook(book)}
                          aria-label={`Delete ${book.title}`}
                          className="p-1 rounded opacity-45 hover:opacity-100 hover:text-red-600 transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      <button
                        type="button"
                        onClick={() => onOpenBook(book)}
                        className="px-2 py-1 rounded text-[11px] font-medium accent-soft hover:opacity-90 flex items-center gap-1 whitespace-nowrap"
                      >
                        <BookOpen className="w-3 h-3" aria-hidden="true" />
                        Read {bookAnnCount > 0 ? `(${bookAnnCount})` : ''}
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          /* Clean Table List View */
          <div className="rounded-xl border app-border app-surface overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b app-border text-xs font-medium opacity-60">
                  <th className="py-2.5 px-4">Document</th>
                  <th className="py-2.5 px-3">Author</th>
                  <th className="py-2.5 px-3">Folder Path</th>
                  <th className="py-2.5 px-3">Format</th>
                  <th className="py-2.5 px-3 text-right">Progress</th>
                  <th className="py-2.5 px-3 text-right">Size</th>
                  <th className="py-2.5 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-black/10 dark:divide-white/10 text-sm">
                {books.map((book) => (
                  <tr key={book.id} className="hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                    <td className="py-2.5 px-4 font-medium max-w-xs truncate">
                      <button
                        type="button"
                        onClick={() => onOpenBook(book)}
                        className="hover:underline text-left truncate w-full"
                      >
                        {book.title}
                      </button>
                    </td>
                    <td className="py-2.5 px-3 text-xs opacity-70 whitespace-nowrap">{book.author}</td>
                    <td className="py-2.5 px-3 text-xs font-mono opacity-60 max-w-[200px] truncate">
                      {book.folderPath}
                    </td>
                    <td className="py-2.5 px-3 text-xs font-mono uppercase opacity-75">{book.format}</td>
                    <td className="py-2.5 px-3 text-xs tabular-nums text-right opacity-80">
                      {book.currentPage}/{book.pageCount} ({book.progress}%)
                    </td>
                    <td className="py-2.5 px-3 text-xs tabular-nums text-right opacity-60">
                      {formatBytes(book.fileSize)}
                    </td>
                    <td className="py-2.5 px-4 text-right whitespace-nowrap space-x-2">
                      <button
                        type="button"
                        onClick={() => onConvertBook(book)}
                        className="px-2 py-1 rounded-md text-xs opacity-75 hover:opacity-100"
                      >
                        Convert
                      </button>
                      <button
                        type="button"
                        onClick={() => onOpenBook(book)}
                        className="px-2.5 py-1 rounded-md text-xs font-medium accent-soft"
                      >
                        Open
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
