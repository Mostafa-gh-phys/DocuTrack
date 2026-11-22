import React, {useEffect, useMemo, useState} from 'react';
import {
  ArrowDownUp,
  BookPlus,
  Download,
  ExternalLink,
  Globe,
  RefreshCw,
  Search,
} from 'lucide-react';
import {
  DEFAULT_LIBGEN_MIRRORS,
  sortLibgenResults,
  type LibgenBookResult,
  type LibgenMirrorStatus,
  type LibgenSortDirection,
  type LibgenSortField,
} from '../utils/libgenParser';

interface DownloadFilesViewProps {
  isOnline: boolean;
  simulatedOffline: boolean;
  onImportDownloadedFile: (buffer: ArrayBuffer, filename: string, targetFolder: string) => Promise<void>;
}

export const DownloadFilesView: React.FC<DownloadFilesViewProps> = ({
  isOnline,
  simulatedOffline,
  onImportDownloadedFile,
}) => {
  const [mirrors, setMirrors] = useState<LibgenMirrorStatus[]>(() =>
    DEFAULT_LIBGEN_MIRRORS.map((m) => ({...m, open: false, latencyMs: null})),
  );
  const [activeMirror, setActiveMirror] = useState<string>(DEFAULT_LIBGEN_MIRRORS[0].url);
  const [customMirrorInput, setCustomMirrorInput] = useState('');
  const [probingMirrors, setProbingMirrors] = useState(false);
  const [probeSummary, setProbeSummary] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [searchColumn, setSearchColumn] = useState<'def' | 'title' | 'author' | 'identifier' | 'publisher'>('def');
  const [formatFilter, setFormatFilter] = useState<string>('all');
  const [languageFilter, setLanguageFilter] = useState<string>('all');
  const [sortBy, setSortBy] = useState<LibgenSortField>('relevance');
  const [sortDirection, setSortDirection] = useState<LibgenSortDirection>('desc');
  const [resultsLimit, setResultsLimit] = useState<number>(50);

  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [results, setResults] = useState<LibgenBookResult[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [busyDownloadId, setBusyDownloadId] = useState<string | null>(null);
  const [downloadFeedback, setDownloadFeedback] = useState<string | null>(null);

  const discoverOpenMirrors = async (extraMirror?: string) => {
    if (!isOnline || simulatedOffline) {
      setProbeSummary('Offline mode active — reconnect to probe LibGen mirrors.');
      return;
    }
    setProbingMirrors(true);
    setProbeSummary('Scanning mirrors and discovering open addresses...');
    try {
      const res = await fetch('/api/libgen/mirrors', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          customMirror: extraMirror?.trim() || customMirrorInput.trim() || undefined,
        }),
      });
      const data = (await res.json()) as {
        mirrors?: LibgenMirrorStatus[];
        bestMirror?: string | null;
        discoveredCount?: number;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error || 'Mirror check failed.');
      if (Array.isArray(data.mirrors) && data.mirrors.length > 0) {
        setMirrors(data.mirrors);
        const openOnes = data.mirrors.filter((m) => m.open);
        if (data.bestMirror) {
          setActiveMirror(data.bestMirror);
        }
        setProbeSummary(
          openOnes.length > 0
            ? `Found ${openOnes.length} open mirror${openOnes.length === 1 ? '' : 's'} — connected to ${data.bestMirror || openOnes[0].url}`
            : 'No preset mirrors responded from this network. You can enter a working custom LibGen address above.',
        );
      }
    } catch (err) {
      setProbeSummary(err instanceof Error ? err.message : 'Unable to probe LibGen mirrors.');
    } finally {
      setProbingMirrors(false);
    }
  };

  useEffect(() => {
    void discoverOpenMirrors();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSearch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const cleaned = query.trim();
    if (!cleaned) return;
    if (!isOnline || simulatedOffline) {
      setSearchError('Disable Offline Reading Mode to search LibGen mirrors.');
      return;
    }

    setSearching(true);
    setSearchError(null);
    setHasSearched(true);
    try {
      const params = new URLSearchParams({
        q: cleaned,
        mirror: activeMirror,
        column: searchColumn,
        limit: String(resultsLimit),
      });
      const res = await fetch(`/api/libgen/search?${params.toString()}`);
      const data = (await res.json()) as {
        results?: LibgenBookResult[];
        usedMirror?: string;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error || 'LibGen search failed.');
      }
      if (data.usedMirror && data.usedMirror !== activeMirror) {
        setActiveMirror(data.usedMirror);
      }
      setResults(Array.isArray(data.results) ? data.results : []);
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : 'Search request failed.');
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  const handleDownloadAction = async (item: LibgenBookResult, mode: 'import' | 'save') => {
    setBusyDownloadId(item.id);
    setDownloadFeedback(null);
    try {
      const res = await fetch('/api/libgen/download', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          md5: item.md5,
          downloadPageUrl: item.downloadPageUrl,
          mirrorOrigin: item.mirrorOrigin,
          title: item.title,
          extension: item.extension,
        }),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as {error?: string};
        throw new Error(errBody.error || `Download failed (HTTP ${res.status})`);
      }

      const rawName = res.headers.get('X-Filename');
      const safeTitle = item.title.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'document';
      const fallbackExt = item.extension || 'pdf';
      const filename = rawName ? decodeURIComponent(rawName) : `${safeTitle}.${fallbackExt}`;
      const buffer = await res.arrayBuffer();

      if (mode === 'import') {
        const supported = /^(pdf|epub|djvu)$/i.test(fallbackExt);
        if (!supported) {
          throw new Error(
            `Format .${fallbackExt.toUpperCase()} downloaded — DocuTrack library supports .pdf, .epub, and .djvu directly. Use "Save" to download raw .${fallbackExt} to disk.`,
          );
        }
        await onImportDownloadedFile(buffer, filename, '/LibGen Downloads');
        setDownloadFeedback(`Imported "${item.title}" directly into your DocuTrack library (/LibGen Downloads).`);
      } else {
        const blob = new Blob([buffer]);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
        setDownloadFeedback(`Saved "${filename}" to your downloads folder.`);
      }
    } catch (err) {
      setDownloadFeedback(err instanceof Error ? err.message : 'Unable to fetch file from mirror.');
    } finally {
      setBusyDownloadId(null);
    }
  };

  const availableFormats = useMemo(() => {
    const set = new Set<string>();
    results.forEach((r) => {
      if (r.extension) set.add(r.extension.toLowerCase());
    });
    return Array.from(set).sort();
  }, [results]);

  const availableLanguages = useMemo(() => {
    const set = new Set<string>();
    results.forEach((r) => {
      if (r.language) set.add(r.language);
    });
    return Array.from(set).sort();
  }, [results]);

  const displayedResults = useMemo(() => {
    const filtered = results.filter((item) => {
      if (formatFilter !== 'all' && item.extension.toLowerCase() !== formatFilter) return false;
      if (languageFilter !== 'all' && item.language !== languageFilter) return false;
      return true;
    });
    return sortLibgenResults(filtered, sortBy, sortDirection);
  }, [results, formatFilter, languageFilter, sortBy, sortDirection]);

  return (
    <div className="flex-1 p-6 max-w-6xl mx-auto w-full space-y-6">
      <div className="pb-4 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100 tracking-tight">
            Download Files (LibGen Mirror Search)
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Automatically locate open Library Genesis addresses, search and sort catalogs inside DocuTrack, and import PDF, EPUB, or DjVu editions directly into your library.
          </p>
        </div>
      </div>

      {/* Mirror Selector & Auto-Discovery */}
      <section
        aria-label="LibGen mirror status"
        className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-700 dark:text-slate-200">
            <Globe className="w-4 h-4 accent-text" aria-hidden="true" />
            <span>Mirror Addresses &amp; Auto-Discovery</span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              type="url"
              value={customMirrorInput}
              onChange={(e) => setCustomMirrorInput(e.target.value)}
              placeholder="https://libgen.example"
              aria-label="Custom LibGen mirror URL"
              className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent text-xs font-mono w-56"
            />
            <button
              type="button"
              disabled={probingMirrors}
              onClick={() => void discoverOpenMirrors(customMirrorInput)}
              className="px-3.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-1.5 whitespace-nowrap disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${probingMirrors ? 'animate-spin' : ''}`} aria-hidden="true" />
              {probingMirrors ? 'Finding Open Address...' : 'Find Open Address'}
            </button>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {mirrors.map((m) => {
            const selected = activeMirror === m.url;
            return (
              <button
                key={m.url}
                type="button"
                onClick={() => setActiveMirror(m.url)}
                className={`px-3 py-1.5 rounded-lg border text-xs flex items-center gap-2 transition-colors whitespace-nowrap ${
                  selected
                    ? 'accent-btn border-transparent font-medium'
                    : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800'
                }`}
              >
                <span className="font-mono">{m.url.replace(/^https?:\/\//, '')}</span>
                <span className={`text-[11px] tabular-nums ${selected ? 'opacity-90' : m.open ? 'text-emerald-600 dark:text-emerald-400' : 'opacity-50'}`}>
                  {m.open ? `${m.latencyMs ?? 0}ms` : 'closed'}
                </span>
              </button>
            );
          })}
        </div>

        {probeSummary && (
          <p className="text-xs text-slate-500 dark:text-slate-400">{probeSummary}</p>
        )}
      </section>

      {/* Search & Sort Controls */}
      <form
        onSubmit={(e) => void handleSearch(e)}
        className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4"
      >
        <div className="flex flex-col md:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search books by title, author, ISBN, or topic..."
              aria-label="Search LibGen catalog"
              className="w-full pl-9 pr-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent text-sm"
            />
          </div>

          <select
            aria-label="Search field"
            value={searchColumn}
            onChange={(e) => setSearchColumn(e.target.value as typeof searchColumn)}
            className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs font-medium"
          >
            <option value="def">All Fields</option>
            <option value="title">Title</option>
            <option value="author">Author</option>
            <option value="publisher">Publisher</option>
            <option value="identifier">ISBN / Identifier</option>
          </select>

          <select
            aria-label="Max search results"
            value={resultsLimit}
            onChange={(e) => setResultsLimit(Number(e.target.value))}
            className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs font-medium tabular-nums"
          >
            <option value={25}>25 results</option>
            <option value={50}>50 results</option>
            <option value={100}>100 results</option>
          </select>

          <button
            type="submit"
            disabled={searching || !query.trim()}
            className="px-5 py-2 rounded-lg accent-btn text-xs font-semibold whitespace-nowrap disabled:opacity-50"
          >
            {searching ? 'Searching...' : 'Search Catalog'}
          </button>
        </div>

        {/* Client-side Filter & Multi-Field Sort Bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-100 dark:border-slate-800 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="libgen-format-filter" className="text-slate-500 dark:text-slate-400">
              Format
            </label>
            <select
              id="libgen-format-filter"
              value={formatFilter}
              onChange={(e) => setFormatFilter(e.target.value)}
              className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800"
            >
              <option value="all">All ({results.length})</option>
              {availableFormats.map((ext) => (
                <option key={ext} value={ext}>
                  .{ext.toUpperCase()}
                </option>
              ))}
            </select>

            <label htmlFor="libgen-lang-filter" className="text-slate-500 dark:text-slate-400 ml-2">
              Language
            </label>
            <select
              id="libgen-lang-filter"
              value={languageFilter}
              onChange={(e) => setLanguageFilter(e.target.value)}
              className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800"
            >
              <option value="all">All Languages</option>
              {availableLanguages.map((lang) => (
                <option key={lang} value={lang}>
                  {lang}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <label htmlFor="libgen-sort-by" className="text-slate-500 dark:text-slate-400">
              Sort by
            </label>
            <select
              id="libgen-sort-by"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as LibgenSortField)}
              className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800"
            >
              <option value="relevance">Relevance</option>
              <option value="title">Title</option>
              <option value="authors">Author</option>
              <option value="year">Publication Year</option>
              <option value="sizeBytes">File Size</option>
              <option value="extension">Format</option>
            </select>

            <button
              type="button"
              onClick={() => setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'))}
              aria-label={`Sort direction: ${sortDirection === 'asc' ? 'Ascending' : 'Descending'}`}
              className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-1"
            >
              <ArrowDownUp className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{sortDirection === 'asc' ? 'Asc' : 'Desc'}</span>
            </button>
          </div>
        </div>
      </form>

      {searchError && (
        <div className="rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 p-4 text-xs text-red-700 dark:text-red-300">
          {searchError}
        </div>
      )}

      {downloadFeedback && (
        <div className="rounded-xl border border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-950/30 p-3.5 text-xs text-blue-800 dark:text-blue-200">
          {downloadFeedback}
        </div>
      )}

      {/* Results Table */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
        {!hasSearched ? (
          <div className="p-10 text-center text-sm text-slate-500 dark:text-slate-400">
            Enter a book title, author, or ISBN above to search the active LibGen mirror inside DocuTrack.
          </div>
        ) : searching ? (
          <div className="p-10 text-center text-sm text-slate-500 dark:text-slate-400">
            Querying {activeMirror.replace(/^https?:\/\//, '')}...
          </div>
        ) : displayedResults.length === 0 ? (
          <div className="p-10 text-center text-sm text-slate-500 dark:text-slate-400">
            No matching files found on {activeMirror.replace(/^https?:\/\//, '')}. Try switching mirrors or broadening your search terms.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/40 text-slate-500 dark:text-slate-400">
                  <th className="py-2.5 px-4 font-semibold">Title &amp; Authors</th>
                  <th className="py-2.5 px-3 font-semibold">Publisher</th>
                  <th className="py-2.5 px-3 font-semibold text-right">Year</th>
                  <th className="py-2.5 px-3 font-semibold">Language</th>
                  <th className="py-2.5 px-3 font-semibold text-right">Size</th>
                  <th className="py-2.5 px-3 font-semibold">Format</th>
                  <th className="py-2.5 px-4 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {displayedResults.map((item) => {
                  const isBusy = busyDownloadId === item.id;
                  const canDirectImport = /^(pdf|epub|djvu)$/i.test(item.extension);
                  return (
                    <tr
                      key={item.id}
                      className="hover:bg-slate-50/70 dark:hover:bg-slate-800/30 transition-colors"
                    >
                      <td className="py-3 px-4 max-w-md">
                        <div className="font-medium text-slate-900 dark:text-slate-100 line-clamp-2">
                          {item.title}
                        </div>
                        <div className="mt-0.5 text-slate-500 dark:text-slate-400 truncate">
                          {item.authors}
                        </div>
                      </td>
                      <td className="py-3 px-3 text-slate-600 dark:text-slate-400 max-w-[140px] truncate">
                        {item.publisher}
                      </td>
                      <td className="py-3 px-3 text-right tabular-nums text-slate-600 dark:text-slate-300">
                        {item.year ?? '—'}
                      </td>
                      <td className="py-3 px-3 text-slate-600 dark:text-slate-400">
                        {item.language}
                      </td>
                      <td className="py-3 px-3 text-right tabular-nums text-slate-600 dark:text-slate-300 whitespace-nowrap">
                        {item.sizeLabel}
                      </td>
                      <td className="py-3 px-3 font-mono font-semibold uppercase text-slate-700 dark:text-slate-200">
                        {item.extension}
                      </td>
                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5">
                          {canDirectImport && (
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => void handleDownloadAction(item, 'import')}
                              className="px-2.5 py-1.5 rounded-lg accent-btn text-[11px] font-medium inline-flex items-center gap-1 disabled:opacity-50"
                            >
                              <BookPlus className="w-3.5 h-3.5" aria-hidden="true" />
                              {isBusy ? 'Fetching...' : 'Import'}
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => void handleDownloadAction(item, 'save')}
                            className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-[11px] font-medium hover:bg-slate-100 dark:hover:bg-slate-800 inline-flex items-center gap-1 disabled:opacity-50"
                          >
                            <Download className="w-3.5 h-3.5" aria-hidden="true" />
                            Save
                          </button>
                          <a
                            href={item.downloadPageUrl}
                            target="_blank"
                            rel="noreferrer noopener"
                            aria-label={`Open mirror link for ${item.title}`}
                            className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-slate-900 dark:hover:text-slate-100"
                          >
                            <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                          </a>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
};
