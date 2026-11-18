import React, {useState} from 'react';
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  Cloud,
  CloudOff,
  FileText,
  Folder,
  FolderOpen,
  HardDriveDownload,
  Heart,
  Library,
  Target,
  WifiOff,
} from 'lucide-react';
import type {BookFormat, BookMetadata, FolderNode, LibraryCollection, ReadingGoal} from '../types/library';
import {getReadingGoalStats} from '../utils/libraryLogic';
import {PWAInstallButton} from './PWAInstallButton';

interface LibrarySidebarProps {
  books: BookMetadata[];
  folderTree: FolderNode[];
  activeCollection: LibraryCollection;
  activeFolder: string | null;
  activeFormat: BookFormat | 'all';
  simulatedOffline: boolean;
  isOnline: boolean;
  userEmail: string | null;
  readingGoal?: ReadingGoal;
  onSelectCollection: (c: LibraryCollection) => void;
  onSelectFolder: (path: string | null) => void;
  onSelectFormat: (f: BookFormat | 'all') => void;
  onToggleSimulatedOffline: () => void;
  onOpenSyncBackup: () => void;
  onOpenGoals?: () => void;
}

const FolderTreeItem: React.FC<{
  node: FolderNode;
  depth: number;
  activeFolder: string | null;
  onSelectFolder: (path: string | null) => void;
}> = ({node, depth, activeFolder, onSelectFolder}) => {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.children.length > 0;
  const isSelected = activeFolder === node.path;

  return (
    <div>
      <div className="flex items-center" style={{paddingLeft: `${depth * 12}px`}}>
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            aria-label={expanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
            className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
          >
            {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>
        ) : (
          <span className="w-5.5 shrink-0" aria-hidden="true" />
        )}
        <button
          type="button"
          onClick={() => onSelectFolder(isSelected ? null : node.path)}
          className={`flex-1 flex items-center justify-between gap-2 px-2 py-1.5 rounded-md text-left text-xs transition-colors ${
            isSelected
              ? 'bg-blue-50 text-blue-900 font-semibold dark:bg-blue-950/60 dark:text-blue-200'
              : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/70'
          }`}
        >
          <span className="flex items-center gap-2 min-w-0">
            {isSelected ? (
              <FolderOpen className="w-3.5 h-3.5 shrink-0 text-blue-700 dark:text-blue-400" aria-hidden="true" />
            ) : (
              <Folder className="w-3.5 h-3.5 shrink-0 text-slate-400" aria-hidden="true" />
            )}
            <span className="truncate">{node.name}</span>
          </span>
          <span className="text-[11px] tabular-nums text-slate-400 dark:text-slate-500 shrink-0">
            {node.count}
          </span>
        </button>
      </div>
      {hasChildren && expanded && (
        <div className="mt-0.5">
          {node.children.map((child) => (
            <FolderTreeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              activeFolder={activeFolder}
              onSelectFolder={onSelectFolder}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export const LibrarySidebar: React.FC<LibrarySidebarProps> = ({
  books,
  folderTree,
  activeCollection,
  activeFolder,
  activeFormat,
  simulatedOffline,
  isOnline,
  userEmail,
  readingGoal,
  onSelectCollection,
  onSelectFolder,
  onSelectFormat,
  onToggleSimulatedOffline,
  onOpenSyncBackup,
  onOpenGoals,
}) => {
  const goalStats = readingGoal ? getReadingGoalStats(readingGoal, books) : null;
  const readingCount = books.filter((b) => b.progress > 0 && b.progress < 100).length;
  const favCount = books.filter((b) => b.isFavorite).length;
  const offlineCount = books.filter((b) => b.offlinePinned).length;

  const collections: {id: LibraryCollection; label: string; count: number; icon: React.ReactNode}[] = [
    {id: 'all', label: 'All Documents', count: books.length, icon: <Library className="w-4 h-4" />},
    {id: 'reading', label: 'Reading Now', count: readingCount, icon: <BookOpen className="w-4 h-4" />},
    {id: 'favorites', label: 'Favorites', count: favCount, icon: <Heart className="w-4 h-4" />},
    {id: 'offline', label: 'Offline Cached', count: offlineCount, icon: <HardDriveDownload className="w-4 h-4" />},
  ];

  const formats: {id: BookFormat | 'all'; label: string; count: number}[] = [
    {id: 'all', label: 'All Formats', count: books.length},
    {id: 'pdf', label: 'PDF Documents', count: books.filter((b) => b.format === 'pdf').length},
    {id: 'epub', label: 'EPUB Books', count: books.filter((b) => b.format === 'epub').length},
    {id: 'djvu', label: 'DjVu Archives', count: books.filter((b) => b.format === 'djvu').length},
  ];

  const [mobileOpen, setMobileOpen] = useState(false);
  const effectiveOffline = !isOnline || simulatedOffline;

  return (
    <aside
      aria-label="Library navigation"
      className="w-full lg:w-[264px] shrink-0 border-b lg:border-b-0 lg:border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-col justify-between"
    >
      <div className="lg:hidden px-4 py-2.5 flex items-center justify-between border-b border-slate-100 dark:border-slate-800">
        <button
          type="button"
          onClick={() => setMobileOpen((prev) => !prev)}
          aria-expanded={mobileOpen}
          className="text-xs font-medium text-slate-700 dark:text-slate-200 flex items-center gap-2"
        >
          <Folder className="w-4 h-4 text-blue-700 dark:text-blue-400" aria-hidden="true" />
          {mobileOpen ? 'Hide Folders & Filters' : `Folders & Filters (${activeFolder || activeCollection})`}
        </button>
        <span className="text-xs tabular-nums text-slate-400">{books.length} docs</span>
      </div>

      <div className={`${mobileOpen ? 'block' : 'hidden'} lg:block p-4 space-y-6 overflow-y-auto`}>
        <div>
          <h2 className="px-2 text-xs font-semibold text-slate-500 dark:text-slate-400 tracking-wide">
            Collections
          </h2>
          <nav className="mt-2 space-y-1">
            {collections.map((item) => {
              const active = activeCollection === item.id && activeFolder === null;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    onSelectCollection(item.id);
                    onSelectFolder(null);
                  }}
                  className={`w-full flex items-center justify-between px-2.5 py-2 rounded-lg text-sm transition-colors ${
                    active
                      ? 'bg-blue-50 text-blue-900 font-medium dark:bg-blue-950/60 dark:text-blue-200'
                      : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/70'
                  }`}
                >
                  <span className="flex items-center gap-2.5 whitespace-nowrap">
                    <span className={active ? 'text-blue-700 dark:text-blue-400' : 'text-slate-400'} aria-hidden="true">
                      {item.icon}
                    </span>
                    {item.label}
                  </span>
                  <span className="text-xs tabular-nums text-slate-400 dark:text-slate-500">
                    {item.count}
                  </span>
                </button>
              );
            })}
          </nav>
        </div>

        <div>
          <div className="px-2 flex items-center justify-between">
            <h2 className="text-xs font-semibold text-slate-500 dark:text-slate-400 tracking-wide">
              Drive Folder Tree
            </h2>
            {activeFolder && (
              <button
                type="button"
                onClick={() => onSelectFolder(null)}
                className="text-xs text-blue-700 dark:text-blue-400 hover:underline"
              >
                Clear
              </button>
            )}
          </div>
          <div className="mt-2 space-y-0.5">
            {folderTree.length === 0 ? (
              <p className="px-2 text-xs text-slate-400">No folders indexed yet.</p>
            ) : (
              folderTree.map((node) => (
                <FolderTreeItem
                  key={node.path}
                  node={node}
                  depth={0}
                  activeFolder={activeFolder}
                  onSelectFolder={onSelectFolder}
                />
              ))
            )}
          </div>
        </div>

        <div>
          <h2 className="px-2 text-xs font-semibold text-slate-500 dark:text-slate-400 tracking-wide">
            Formats
          </h2>
          <div className="mt-2 space-y-1">
            {formats.map((f) => {
              const active = activeFormat === f.id;
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => onSelectFormat(f.id)}
                  className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-md text-xs transition-colors ${
                    active
                      ? 'bg-slate-100 text-slate-900 font-semibold dark:bg-slate-800 dark:text-slate-100'
                      : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/60'
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <FileText className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" />
                    {f.label}
                  </span>
                  <span className="tabular-nums text-slate-400">{f.count}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className={`${mobileOpen ? 'block' : 'hidden'} lg:block p-4 border-t border-slate-200 dark:border-slate-800 space-y-2.5 bg-slate-50/70 dark:bg-slate-900`}>
        {readingGoal && goalStats && onOpenGoals && (
          <button
            type="button"
            onClick={onOpenGoals}
            className="w-full text-left px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700/70 transition-colors space-y-1.5"
          >
            <div className="flex items-center justify-between text-xs font-medium text-slate-700 dark:text-slate-200">
              <span className="flex items-center gap-1.5">
                <Target className="w-3.5 h-3.5 text-blue-700 dark:text-blue-400" aria-hidden="true" />
                Daily Goal
              </span>
              <span className="tabular-nums text-slate-500 dark:text-slate-400">
                {goalStats.todayPages}/{readingGoal.dailyPagesTarget}p · {readingGoal.currentStreakDays}d streak
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-slate-100 dark:bg-slate-700 overflow-hidden">
              <div
                className="h-full bg-blue-700 dark:bg-blue-500"
                style={{width: `${goalStats.dailyPct}%`}}
              />
            </div>
          </button>
        )}

        <button
          type="button"
          onClick={onToggleSimulatedOffline}
          aria-pressed={effectiveOffline}
          className={`w-full flex items-center justify-between px-3 py-2 rounded-lg border text-xs font-medium transition-colors ${
            effectiveOffline
              ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200'
              : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200'
          }`}
        >
          <span className="flex items-center gap-2">
            <WifiOff className="w-3.5 h-3.5" aria-hidden="true" />
            Offline Reading Mode
          </span>
          <span>{effectiveOffline ? 'Active' : 'Off'}</span>
        </button>

        <button
          type="button"
          onClick={onOpenSyncBackup}
          className="w-full flex items-center justify-between px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
        >
          <span className="flex items-center gap-2 truncate">
            {userEmail ? (
              <Cloud className="w-3.5 h-3.5 text-emerald-600 shrink-0" aria-hidden="true" />
            ) : (
              <CloudOff className="w-3.5 h-3.5 text-slate-400 shrink-0" aria-hidden="true" />
            )}
            <span className="truncate">{userEmail || 'Connect Cloud Sync'}</span>
          </span>
        </button>

        <PWAInstallButton />
      </div>
    </aside>
  );
};
