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
  FolderSync,
  FolderTree,
  HardDriveDownload,
  Heart,
  Library,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Target,
  WifiOff,
  X,
} from 'lucide-react';
import type {BookFormat, BookMetadata, FolderNode, LibraryCollection, ReadingGoal} from '../types/library';
import type {WatchedFolderSnapshotMeta} from '../utils/diskFolderWatch';
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
  collapsed: boolean;
  watchedFolderMeta?: WatchedFolderSnapshotMeta | null;
  watchedFolderBusy?: boolean;
  onToggleCollapse: () => void;
  onSelectCollection: (c: LibraryCollection) => void;
  onSelectFolder: (path: string | null) => void;
  onSelectFormat: (f: BookFormat | 'all') => void;
  onToggleSimulatedOffline: () => void;
  onOpenSyncBackup: () => void;
  onOpenGoals?: () => void;
  onLinkWatchedFolder?: () => void;
  onScanWatchedFolder?: () => void;
  onUnlinkWatchedFolder?: () => void;
  onToggleWatchedAutoPoll?: () => void;
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
            className="p-1 opacity-55 hover:opacity-100"
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
              ? 'accent-soft font-semibold'
              : 'opacity-85 hover:opacity-100 hover:bg-black/5 dark:hover:bg-white/5'
          }`}
        >
          <span className="flex items-center gap-2 min-w-0">
            {isSelected ? (
              <FolderOpen className="w-3.5 h-3.5 shrink-0 accent-text" aria-hidden="true" />
            ) : (
              <Folder className="w-3.5 h-3.5 shrink-0 opacity-55" aria-hidden="true" />
            )}
            <span className="truncate">{node.name}</span>
          </span>
          <span className="text-[11px] tabular-nums opacity-55 shrink-0">{node.count}</span>
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
  collapsed,
  watchedFolderMeta,
  watchedFolderBusy,
  onToggleCollapse,
  onSelectCollection,
  onSelectFolder,
  onSelectFormat,
  onToggleSimulatedOffline,
  onOpenSyncBackup,
  onOpenGoals,
  onLinkWatchedFolder,
  onScanWatchedFolder,
  onUnlinkWatchedFolder,
  onToggleWatchedAutoPoll,
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
      data-collapsed={collapsed ? 'true' : 'false'}
      className={`w-full ${
        collapsed ? 'lg:w-[54px]' : 'lg:w-[248px]'
      } shrink-0 border-b lg:border-b-0 lg:border-r app-border app-surface flex flex-col justify-between transition-[width] duration-150`}
    >
      <div className="lg:hidden px-4 py-2.5 flex items-center justify-between border-b app-border">
        <button
          type="button"
          onClick={() => setMobileOpen((prev) => !prev)}
          aria-expanded={mobileOpen}
          className="text-xs font-medium flex items-center gap-2"
        >
          <Folder className="w-4 h-4 accent-text" aria-hidden="true" />
          {mobileOpen ? 'Hide Folders & Filters' : `Folders & Filters (${activeFolder || activeCollection})`}
        </button>
        <span className="text-xs tabular-nums opacity-60">{books.length} docs</span>
      </div>

      {/* Collapsed Desktop Rail */}
      {collapsed && (
        <div className="hidden lg:flex flex-col items-center justify-between flex-1 py-3 gap-4">
          <div className="flex flex-col items-center gap-2">
            <button
              type="button"
              onClick={onToggleCollapse}
              aria-label="Expand sidebar"
              title="Expand sidebar"
              className="p-2 rounded-lg opacity-75 hover:opacity-100 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            >
              <PanelLeftOpen className="w-4 h-4" aria-hidden="true" />
            </button>

            <div className="w-6 border-t app-border my-1" aria-hidden="true" />

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
                  aria-label={item.label}
                  title={`${item.label} (${item.count})`}
                  className={`p-2 rounded-lg transition-colors ${
                    active
                      ? 'accent-soft accent-text'
                      : 'opacity-70 hover:opacity-100 hover:bg-black/5 dark:hover:bg-white/5'
                  }`}
                >
                  {item.icon}
                </button>
              );
            })}

            <button
              type="button"
              onClick={onToggleCollapse}
              aria-label="Browse folder tree"
              title="Open sidebar folder tree"
              className={`p-2 rounded-lg transition-colors ${
                activeFolder
                  ? 'accent-soft accent-text'
                  : 'opacity-70 hover:opacity-100 hover:bg-black/5 dark:hover:bg-white/5'
              }`}
            >
              <FolderTree className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>

          <div className="flex flex-col items-center gap-2 pt-2 border-t app-border">
            {readingGoal && onOpenGoals && (
              <button
                type="button"
                onClick={onOpenGoals}
                aria-label="Daily reading goal"
                title="Daily Reading Goal"
                className="p-2 rounded-lg opacity-70 hover:opacity-100 hover:bg-black/5 dark:hover:bg-white/5"
              >
                <Target className="w-4 h-4 accent-text" aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              onClick={onToggleSimulatedOffline}
              aria-pressed={effectiveOffline}
              aria-label="Offline reading mode"
              title={effectiveOffline ? 'Offline Reading Mode: Active' : 'Offline Reading Mode: Off'}
              className={`p-2 rounded-lg transition-colors ${
                effectiveOffline
                  ? 'bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-200'
                  : 'opacity-70 hover:opacity-100 hover:bg-black/5 dark:hover:bg-white/5'
              }`}
            >
              <WifiOff className="w-4 h-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={onOpenSyncBackup}
              aria-label="Cloud sync and backups"
              title={userEmail || 'Connect Cloud Sync'}
              className="p-2 rounded-lg opacity-70 hover:opacity-100 hover:bg-black/5 dark:hover:bg-white/5"
            >
              {userEmail ? (
                <Cloud className="w-4 h-4 text-emerald-600" aria-hidden="true" />
              ) : (
                <CloudOff className="w-4 h-4" aria-hidden="true" />
              )}
            </button>
          </div>
        </div>
      )}

      <div className={`${mobileOpen ? 'block' : 'hidden'} ${collapsed ? 'lg:hidden' : 'lg:block'} p-3.5 space-y-5 overflow-y-auto`}>
        <div>
          <div className="px-2 flex items-center justify-between">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider opacity-55">Collections</h2>
            <button
              type="button"
              onClick={onToggleCollapse}
              aria-label="Collapse sidebar"
              title="Collapse sidebar"
              className="hidden lg:inline-flex p-1 rounded-md opacity-55 hover:opacity-100 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            >
              <PanelLeftClose className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
          <nav className="mt-1.5 space-y-0.5">
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
                  className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-[13px] transition-colors ${
                    active
                      ? 'accent-soft font-medium'
                      : 'opacity-85 hover:opacity-100 hover:bg-black/5 dark:hover:bg-white/5'
                  }`}
                >
                  <span className="flex items-center gap-2.5 whitespace-nowrap">
                    <span className={active ? 'accent-text' : 'opacity-55'} aria-hidden="true">
                      {item.icon}
                    </span>
                    {item.label}
                  </span>
                  <span className="text-xs tabular-nums opacity-55">{item.count}</span>
                </button>
              );
            })}
          </nav>
        </div>

        <div>
          <div className="px-2 flex items-center justify-between">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider opacity-55">Folders</h2>
            {activeFolder && (
              <button
                type="button"
                onClick={() => onSelectFolder(null)}
                className="text-xs accent-text hover:underline"
              >
                Clear
              </button>
            )}
          </div>
          <div className="mt-2 space-y-0.5">
            {folderTree.length === 0 ? (
              <p className="px-2 text-xs opacity-55">No folders indexed yet.</p>
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
          <h2 className="px-2 text-xs font-semibold opacity-60 tracking-wide">Formats</h2>
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
                      ? 'app-surface-muted font-semibold'
                      : 'opacity-75 hover:opacity-100 hover:bg-black/5 dark:hover:bg-white/5'
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <FileText className="w-3.5 h-3.5 opacity-55" aria-hidden="true" />
                    {f.label}
                  </span>
                  <span className="tabular-nums opacity-55">{f.count}</span>
                </button>
              );
            })}
          </div>
        </div>

        {onLinkWatchedFolder && (
          <div className="pt-2 border-t app-border space-y-2">
            <div className="px-2 flex items-center justify-between gap-2">
              <h2 className="text-[11px] font-semibold uppercase tracking-wider opacity-55">
                Auto-Bookshelf Folder
              </h2>
              {watchedFolderMeta && onUnlinkWatchedFolder && (
                <button
                  type="button"
                  onClick={onUnlinkWatchedFolder}
                  aria-label="Unlink watched hard-disk folder"
                  title="Stop watching folder"
                  className="p-0.5 opacity-55 hover:opacity-100"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {watchedFolderMeta ? (
              <div className="mx-1 p-2.5 rounded-lg border app-border app-surface-muted space-y-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 font-medium truncate">
                    <FolderSync className="w-3.5 h-3.5 accent-text shrink-0" aria-hidden="true" />
                    <span className="truncate">{watchedFolderMeta.folderName}</span>
                  </span>
                  {onToggleWatchedAutoPoll && (
                    <button
                      type="button"
                      onClick={onToggleWatchedAutoPoll}
                      aria-pressed={watchedFolderMeta.autoPollEnabled}
                      className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                        watchedFolderMeta.autoPollEnabled
                          ? 'accent-soft font-semibold'
                          : 'opacity-65 border app-border'
                      }`}
                    >
                      {watchedFolderMeta.autoPollEnabled ? 'Auto' : 'Manual'}
                    </button>
                  )}
                </div>

                <div className="flex items-center justify-between gap-2 text-[11px] opacity-75">
                  <span className="tabular-nums">{watchedFolderMeta.knownSignatures.length} tracked</span>
                  {onScanWatchedFolder && (
                    <button
                      type="button"
                      disabled={watchedFolderBusy}
                      onClick={onScanWatchedFolder}
                      className="inline-flex items-center gap-1 accent-text font-medium hover:underline disabled:opacity-50"
                    >
                      <RefreshCw className={`w-3 h-3 ${watchedFolderBusy ? 'animate-spin' : ''}`} aria-hidden="true" />
                      {watchedFolderBusy ? 'Scanning...' : 'Push New Books'}
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={onLinkWatchedFolder}
                className="w-full flex items-center justify-between px-2.5 py-2 rounded-lg border border-dashed app-border text-xs opacity-85 hover:opacity-100 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
              >
                <span className="flex items-center gap-2">
                  <FolderSync className="w-3.5 h-3.5 accent-text shrink-0" aria-hidden="true" />
                  <span>Watch Disk Folder</span>
                </span>
                <span className="text-[10px] opacity-60">Auto</span>
              </button>
            )}
          </div>
        )}
      </div>

      <div className={`${mobileOpen ? 'block' : 'hidden'} ${collapsed ? 'lg:hidden' : 'lg:block'} p-4 border-t app-border app-surface-muted space-y-2.5`}>
        {readingGoal && goalStats && onOpenGoals && (
          <button
            type="button"
            onClick={onOpenGoals}
            className="w-full text-left px-3 py-2.5 rounded-lg border app-border app-surface hover:opacity-95 transition-colors space-y-1.5"
          >
            <div className="flex items-center justify-between text-xs font-medium">
              <span className="flex items-center gap-1.5">
                <Target className="w-3.5 h-3.5 accent-text" aria-hidden="true" />
                Daily Goal
              </span>
              <span className="tabular-nums opacity-65">
                {goalStats.todayPages}/{readingGoal.dailyPagesTarget}p · {readingGoal.currentStreakDays}d streak
              </span>
            </div>
            <div className="h-1.5 rounded-full app-surface-muted overflow-hidden">
              <div
                className="h-full transition-all"
                style={{width: `${goalStats.dailyPct}%`, backgroundColor: 'var(--accent)'}}
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
              ? 'border-amber-400/60 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200'
              : 'app-border app-surface hover:opacity-90'
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
          className="w-full flex items-center justify-between px-3 py-2 rounded-lg border app-border app-surface text-xs hover:opacity-90 transition-colors"
        >
          <span className="flex items-center gap-2 truncate">
            {userEmail ? (
              <Cloud className="w-3.5 h-3.5 text-emerald-600 shrink-0" aria-hidden="true" />
            ) : (
              <CloudOff className="w-3.5 h-3.5 opacity-50 shrink-0" aria-hidden="true" />
            )}
            <span className="truncate">{userEmail || 'Connect Cloud Sync'}</span>
          </span>
        </button>

        <PWAInstallButton />
      </div>
    </aside>
  );
};
