import React, {useState} from 'react';
import {
  ArrowDownUp,
  BookOpen,
  FolderTree,
  GraduationCap,
  HardDriveDownload,
  Heart,
  LayoutGrid,
  List,
  Search,
  Sparkles,
  Trash2,
} from 'lucide-react';
import type {
  Annotation,
  BookMetadata,
  SemanticSearchResult,
  SortDirection,
  SortField,
  StudyCourse,
} from '../types/library';
import {formatBytes} from '../utils/libraryLogic';

interface LibraryViewProps {
  books: BookMetadata[];
  totalBooksCount: number;
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
  onTriggerImportFiles: () => void;
}

export const LibraryView: React.FC<LibraryViewProps> = ({
  books,
  totalBooksCount,
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
  onTriggerImportFiles,
}) => {
  const [failedCovers, setFailedCovers] = useState<Record<string, boolean>>({});

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (semanticMode && searchQuery.trim()) {
      onRunSemanticSearch(searchQuery.trim());
    }
  };

  return (
    <div className="flex-1 min-w-0 flex flex-col">
      {/* Workspace Toolbar (Search, Semantic Filter, Metadata/Folder Sort, View Toggle) */}
      <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-wrap items-center justify-between gap-4">
        <form onSubmit={handleSearchSubmit} className="flex-1 min-w-[260px] max-w-xl flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder={
                semanticMode
                  ? 'Semantic search across concepts & passages (press Enter)...'
                  : 'Filter library by title, author, folder path, or tag...'
              }
              aria-label="Search library"
              className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-700/30 focus:border-blue-700"
            />
          </div>
          <button
            type="button"
            onClick={onToggleSemanticMode}
            aria-pressed={semanticMode}
            className={`px-3 py-2 rounded-lg text-xs font-medium border flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
              semanticMode
                ? 'bg-blue-800 border-blue-800 text-white'
                : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700'
            }`}
          >
            <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
            Semantic Search
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
          <label htmlFor="library-sort" className="text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">
            Sort by
          </label>
          <select
            id="library-sort"
            value={sortBy}
            onChange={(e) => onSortChange(e.target.value as SortField)}
            className="px-2.5 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 focus:outline-none"
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
            className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700"
          >
            <ArrowDownUp className="w-3.5 h-3.5" />
          </button>

          <div className="flex items-center p-0.5 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
            <button
              type="button"
              onClick={() => onViewModeChange('grid')}
              aria-label="Grid view"
              aria-pressed={viewMode === 'grid'}
              className={`p-1.5 rounded-md transition-colors ${
                viewMode === 'grid'
                  ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-xs'
                  : 'text-slate-500 hover:text-slate-900 dark:hover:text-slate-200'
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
                viewMode === 'list'
                  ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-xs'
                  : 'text-slate-500 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <List className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="p-6 space-y-6 flex-1 overflow-y-auto">
        {/* Contextual Header */}
        <div className="flex flex-wrap items-baseline justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100 tracking-tight">
              {activeFolder ? activeFolder : 'Personal Library'}
            </h1>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
              Showing {books.length} of {totalBooksCount} documents · {annotations.length} annotations · {courses.length} AI courses
            </p>
          </div>
        </div>

        {/* Semantic Search Results Section */}
        {semanticMode && (semanticLoading || semanticResults.length > 0 || semanticSourceLabel) && (
          <section
            aria-label="Semantic search results"
            className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5"
          >
            <div className="flex items-center justify-between gap-4 pb-3 border-b border-slate-100 dark:border-slate-800">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-blue-700 dark:text-blue-400" aria-hidden="true" />
                <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Semantic Passage Retrieval
                </h2>
              </div>
              {semanticSourceLabel && (
                <span className="text-xs text-slate-500 dark:text-slate-400">{semanticSourceLabel}</span>
              )}
            </div>

            {semanticLoading ? (
              <div className="py-6 text-sm text-slate-500 dark:text-slate-400">
                Embedding query and analyzing conceptual relevance across your library...
              </div>
            ) : semanticResults.length === 0 ? (
              <div className="py-6 text-sm text-slate-500 dark:text-slate-400">
                No matching passages found. Try a broader concept such as "quorum replication" or "typographic measure".
              </div>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-slate-800">
                {semanticResults.map((hit, idx) => {
                  const targetBook = books.find((b) => b.id === hit.bookId);
                  return (
                    <div key={`${hit.bookId}-${hit.page}-${idx}`} className="py-3.5 flex items-start justify-between gap-4">
                      <div className="min-w-0 space-y-1">
                        <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                          <span className="font-semibold text-slate-900 dark:text-slate-100">{hit.bookTitle}</span>
                          <span aria-hidden="true">·</span>
                          <span className="tabular-nums">Page {hit.page}</span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono tabular-nums text-blue-700 dark:text-blue-400">
                            {(hit.score * 100).toFixed(0)}% match
                          </span>
                        </div>
                        <p className="text-sm text-slate-700 dark:text-slate-300 leading-relaxed line-clamp-2">
                          "{hit.snippet}"
                        </p>
                        <p className="text-xs text-slate-500 dark:text-slate-400">{hit.reason}</p>
                      </div>
                      {targetBook && (
                        <button
                          type="button"
                          onClick={() => onOpenBook(targetBook, hit.page)}
                          className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
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
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-12 text-center">
            <FolderTree className="w-10 h-10 text-slate-300 dark:text-slate-600 mx-auto" aria-hidden="true" />
            <h2 className="mt-4 text-base font-semibold text-slate-900 dark:text-slate-100">
              No matching documents in this view
            </h2>
            <p className="mt-1.5 text-sm text-slate-500 dark:text-slate-400 max-w-md mx-auto">
              Import PDF, EPUB, or DjVu files from your hard drive—including full folder hierarchies—or clear active filters.
            </p>
            <button
              type="button"
              onClick={onTriggerImportFiles}
              className="mt-5 px-4 py-2 rounded-lg bg-blue-800 text-white text-sm font-medium hover:bg-blue-900 transition-colors"
            >
              Import Local Documents
            </button>
          </div>
        ) : viewMode === 'grid' ? (
          /* Editorial Grid View */
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
            {books.map((book) => {
              const bookAnnCount = annotations.filter((a) => a.bookId === book.id).length;
              const hasCourse = courses.some((c) => c.bookId === book.id);
              const showFallbackCover = !book.coverUrl || failedCovers[book.id];

              return (
                <article
                  key={book.id}
                  className="group rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden flex flex-col transition-colors hover:border-slate-300 dark:hover:border-slate-700"
                >
                  <button
                    type="button"
                    onClick={() => onOpenBook(book)}
                    className="text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-700"
                  >
                    <div className="aspect-[4/3] w-full bg-slate-100 dark:bg-slate-800 overflow-hidden relative">
                      {!showFallbackCover ? (
                        <img
                          src={book.coverUrl}
                          alt={`Cover for ${book.title}`}
                          referrerPolicy="no-referrer"
                          onError={() => setFailedCovers((prev) => ({...prev, [book.id]: true}))}
                          className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
                        />
                      ) : (
                        <div className="w-full h-full flex flex-col justify-between p-5 bg-gradient-to-br from-slate-100 to-slate-200 dark:from-slate-800 dark:to-slate-900">
                          <span className="font-mono text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
                            {book.format}
                          </span>
                          <div>
                            <p className="font-serif-reader text-base font-semibold text-slate-900 dark:text-slate-100 line-clamp-2">
                              {book.title}
                            </p>
                            <p className="mt-1 text-xs text-slate-600 dark:text-slate-400 truncate">
                              {book.author}
                            </p>
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="p-4 pb-2 space-y-1.5">
                      <div className="text-xs text-slate-500 dark:text-slate-400 flex items-center gap-1.5 truncate">
                        <span className="font-mono uppercase font-medium text-slate-700 dark:text-slate-300">
                          {book.format}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="truncate">{book.folderPath}</span>
                      </div>
                      <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100 leading-snug line-clamp-2">
                        {book.title}
                      </h3>
                      <p className="text-xs text-slate-600 dark:text-slate-400 truncate">{book.author}</p>
                    </div>
                  </button>

                  <div className="px-4 pt-2 pb-4 mt-auto space-y-3">
                    {/* Clean unboxed reading telemetry */}
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                        <span>
                          Page {book.currentPage} of {book.pageCount} · {formatBytes(book.fileSize)}
                        </span>
                        <span className="font-medium text-slate-700 dark:text-slate-300">
                          {book.progress}%
                        </span>
                      </div>
                      <div className="h-1 w-full rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                        <div
                          className="h-full bg-blue-800 dark:bg-blue-500"
                          style={{width: `${book.progress}%`}}
                        />
                      </div>
                    </div>

                    <div className="pt-2 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => onToggleFavorite(book)}
                          aria-label={book.isFavorite ? `Remove ${book.title} from favorites` : `Favorite ${book.title}`}
                          aria-pressed={book.isFavorite}
                          className={`p-1.5 rounded-md transition-colors ${
                            book.isFavorite
                              ? 'text-rose-600 bg-rose-50 dark:bg-rose-950/40'
                              : 'text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
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
                          className={`p-1.5 rounded-md transition-colors ${
                            book.offlinePinned
                              ? 'text-emerald-700 bg-emerald-50 dark:text-emerald-400 dark:bg-emerald-950/40'
                              : 'text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
                          }`}
                        >
                          <HardDriveDownload className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onOpenCourseModal(book)}
                          aria-label={`AI summary and lecture course for ${book.title}`}
                          className={`p-1.5 rounded-md transition-colors ${
                            hasCourse
                              ? 'text-blue-800 bg-blue-50 dark:text-blue-300 dark:bg-blue-950/40'
                              : 'text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
                          }`}
                        >
                          <GraduationCap className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onDeleteBook(book)}
                          aria-label={`Delete ${book.title}`}
                          className="p-1.5 rounded-md text-slate-400 hover:text-red-600 transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      <button
                        type="button"
                        onClick={() => onOpenBook(book)}
                        className="px-3 py-1.5 rounded-md text-xs font-medium text-blue-900 dark:text-blue-200 bg-blue-50 dark:bg-blue-950/50 hover:bg-blue-100 dark:hover:bg-blue-900/60 flex items-center gap-1.5 whitespace-nowrap"
                      >
                        <BookOpen className="w-3.5 h-3.5" aria-hidden="true" />
                        Read {bookAnnCount > 0 ? `(${bookAnnCount})` : ''}
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          /* High-Density Table List View */
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400">
                  <th className="py-2.5 px-4">Document</th>
                  <th className="py-2.5 px-3">Author</th>
                  <th className="py-2.5 px-3">Folder Path</th>
                  <th className="py-2.5 px-3">Format</th>
                  <th className="py-2.5 px-3 text-right">Progress</th>
                  <th className="py-2.5 px-3 text-right">Size</th>
                  <th className="py-2.5 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-sm">
                {books.map((book) => (
                  <tr
                    key={book.id}
                    className="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
                  >
                    <td className="py-2.5 px-4 font-medium text-slate-900 dark:text-slate-100 max-w-xs truncate">
                      <button
                        type="button"
                        onClick={() => onOpenBook(book)}
                        className="hover:underline text-left truncate w-full"
                      >
                        {book.title}
                      </button>
                    </td>
                    <td className="py-2.5 px-3 text-xs text-slate-600 dark:text-slate-400 whitespace-nowrap">
                      {book.author}
                    </td>
                    <td className="py-2.5 px-3 text-xs font-mono text-slate-500 dark:text-slate-400 max-w-[200px] truncate">
                      {book.folderPath}
                    </td>
                    <td className="py-2.5 px-3 text-xs font-mono uppercase text-slate-700 dark:text-slate-300">
                      {book.format}
                    </td>
                    <td className="py-2.5 px-3 text-xs tabular-nums text-right text-slate-700 dark:text-slate-300">
                      {book.currentPage}/{book.pageCount} ({book.progress}%)
                    </td>
                    <td className="py-2.5 px-3 text-xs tabular-nums text-right text-slate-500 dark:text-slate-400">
                      {formatBytes(book.fileSize)}
                    </td>
                    <td className="py-2.5 px-4 text-right whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => onOpenBook(book)}
                        className="px-2.5 py-1 rounded-md text-xs font-medium text-blue-800 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950/50"
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
