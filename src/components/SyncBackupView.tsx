import React, {useRef, useState} from 'react';
import type {User} from 'firebase/auth';
import {
  Cloud,
  Download,
  FolderSync,
  GitBranch,
  Laptop,
  LogOut,
  RefreshCw,
  Server,
  ShieldCheck,
  Upload,
} from 'lucide-react';
import type {
  BackupFrequency,
  BackupSnapshotRecord,
  ReaderPreferences,
} from '../types/library';
import type {CustomCloudAuthType, CustomCloudConfig, CustomCloudProvider} from '../utils/customCloudSync';
import type {GitHubSyncConfig} from '../utils/githubSync';
import {formatBytes} from '../utils/libraryLogic';

interface SyncBackupViewProps {
  user: User | null;
  syncStatus: string;
  backups: BackupSnapshotRecord[];
  preferences: ReaderPreferences;
  linkedBackupDirName: string | null;
  customCloudConfig: CustomCloudConfig;
  customCloudStatus: string | null;
  customCloudBusy: boolean;
  githubConfig: GitHubSyncConfig;
  githubStatus: string | null;
  githubBusy: boolean;
  onSignIn: () => void;
  onSignOut: () => void;
  onSyncAllToCloud: () => void;
  onChangeBackupFrequency: (freq: BackupFrequency) => void;
  onTriggerManualBackup: () => void;
  onDownloadBackupFile: (backupId?: string) => void;
  onRestoreBackupFile: (file: File) => void;
  onRestoreSnapshot: (backupId: string) => void;
  onLinkLocalBackupFolder: () => void;
  onUpdateCustomCloudConfig: (next: CustomCloudConfig, persistSecret: boolean) => void;
  onTestCustomCloud: () => Promise<{ok: boolean; message: string}>;
  onSyncCustomCloud: () => Promise<void>;
  onPullCustomCloud: () => Promise<void>;
  onUpdateGitHubConfig: (next: GitHubSyncConfig, persistToken: boolean) => void;
  onTestGitHub: () => Promise<{ok: boolean; message: string}>;
  onSyncGitHub: () => Promise<void>;
  onPullGitHub: () => Promise<void>;
}

export const SyncBackupView: React.FC<SyncBackupViewProps> = ({
  user,
  syncStatus,
  backups,
  preferences,
  linkedBackupDirName,
  customCloudConfig,
  customCloudStatus,
  customCloudBusy,
  githubConfig,
  githubStatus,
  githubBusy,
  onSignIn,
  onSignOut,
  onSyncAllToCloud,
  onChangeBackupFrequency,
  onTriggerManualBackup,
  onDownloadBackupFile,
  onRestoreBackupFile,
  onRestoreSnapshot,
  onLinkLocalBackupFolder,
  onUpdateCustomCloudConfig,
  onTestCustomCloud,
  onSyncCustomCloud,
  onPullCustomCloud,
  onUpdateGitHubConfig,
  onTestGitHub,
  onSyncGitHub,
  onPullGitHub,
}) => {
  const restoreInputRef = useRef<HTMLInputElement | null>(null);
  const [restoreFeedback, setRestoreFeedback] = useState<string | null>(null);
  const [persistSecret, setPersistSecret] = useState(Boolean(customCloudConfig.secret));
  const [customTestResult, setCustomTestResult] = useState<{ok: boolean; message: string} | null>(null);
  const [persistGitHubToken, setPersistGitHubToken] = useState(Boolean(githubConfig.token));
  const [githubTestResult, setGitHubTestResult] = useState<{ok: boolean; message: string} | null>(null);

  const supportsDirectoryPicker =
    typeof window !== 'undefined' && 'showDirectoryPicker' in window;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onRestoreBackupFile(file);
      setRestoreFeedback(`Restoring archive from ${file.name}...`);
      e.target.value = '';
    }
  };

  return (
    <div className="flex-1 p-6 max-w-5xl mx-auto w-full space-y-8">
      <div className="pb-4 border-b border-slate-200 dark:border-slate-800">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100 tracking-tight">
          Cross-Device Cloud Sync &amp; Automated Backups
        </h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Keep reading progress, highlights, AI lecture courses, and reader preferences synchronized across devices with cloud sync and automated local backups.
        </p>
      </div>

      {/* 1. Cross-Device Cloud Sync Section */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Cloud className="w-5 h-5 text-blue-700 dark:text-blue-400" aria-hidden="true" />
            <div>
              <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                Cross-Device Cloud Library Sync
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {user
                  ? `Signed in as ${user.displayName || user.email} · Real-time Firestore synchronization active`
                  : 'Sign in with Google to synchronize library metadata, annotations, reading positions, and AI courses across devices.'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {user ? (
              <>
                <button
                  type="button"
                  onClick={onSyncAllToCloud}
                  className="px-3.5 py-2 rounded-lg bg-blue-800 text-white text-xs font-medium hover:bg-blue-900 flex items-center gap-1.5"
                >
                  <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                  Sync Now
                </button>
                <button
                  type="button"
                  onClick={onSignOut}
                  className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-1.5"
                >
                  <LogOut className="w-3.5 h-3.5" aria-hidden="true" />
                  Sign Out
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={onSignIn}
                className="px-4 py-2 rounded-lg bg-blue-800 text-white text-xs font-medium hover:bg-blue-900"
              >
                Sign In with Google
              </button>
            )}
          </div>
        </div>
        {syncStatus && (
          <div className="text-xs text-slate-600 dark:text-slate-300 pt-2 border-t border-slate-100 dark:border-slate-800">
            Sync status: {syncStatus}
          </div>
        )}
      </section>

      {/* 1a. GitHub Repository Sync */}
      <section
        aria-label="GitHub repository sync"
        className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-5"
      >
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <GitBranch className="w-5 h-5 accent-text" aria-hidden="true" />
            <div>
              <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                GitHub Repository Sync
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Store and merge your DocuTrack library catalog, reading progress, highlights, and study courses in any GitHub repository.
              </p>
            </div>
          </div>

          <label className="flex items-center gap-2 text-xs font-medium cursor-pointer">
            <input
              type="checkbox"
              checked={githubConfig.enabled}
              onChange={(e) =>
                onUpdateGitHubConfig({...githubConfig, enabled: e.target.checked}, persistGitHubToken)
              }
            />
            <span>Enable GitHub Sync</span>
          </label>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
          <div className="space-y-1.5">
            <label htmlFor="gh-owner" className="block font-medium opacity-80">
              GitHub Owner / Organization
            </label>
            <input
              id="gh-owner"
              type="text"
              value={githubConfig.owner}
              onChange={(e) => {
                setGitHubTestResult(null);
                onUpdateGitHubConfig({...githubConfig, owner: e.target.value}, persistGitHubToken);
              }}
              placeholder="octocat"
              className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent font-mono text-xs"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="gh-repo" className="block font-medium opacity-80">
              Repository Name
            </label>
            <input
              id="gh-repo"
              type="text"
              value={githubConfig.repo}
              onChange={(e) => {
                setGitHubTestResult(null);
                onUpdateGitHubConfig({...githubConfig, repo: e.target.value}, persistGitHubToken);
              }}
              placeholder="docutrack-library"
              className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent font-mono text-xs"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="gh-branch" className="block font-medium opacity-80">
              Branch
            </label>
            <input
              id="gh-branch"
              type="text"
              value={githubConfig.branch}
              onChange={(e) =>
                onUpdateGitHubConfig({...githubConfig, branch: e.target.value}, persistGitHubToken)
              }
              placeholder="main"
              className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent font-mono text-xs"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="gh-filepath" className="block font-medium opacity-80">
              Archive File Path in Repo
            </label>
            <input
              id="gh-filepath"
              type="text"
              value={githubConfig.filePath}
              onChange={(e) =>
                onUpdateGitHubConfig({...githubConfig, filePath: e.target.value}, persistGitHubToken)
              }
              placeholder="docutrack-library-sync.json"
              className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent font-mono text-xs"
            />
          </div>

          <div className="space-y-1.5 md:col-span-2">
            <label htmlFor="gh-token" className="block font-medium opacity-80">
              Personal Access Token (Fine-grained PAT with Contents Read &amp; Write)
            </label>
            <input
              id="gh-token"
              type="password"
              autoComplete="off"
              value={githubConfig.token}
              onChange={(e) => {
                setGitHubTestResult(null);
                onUpdateGitHubConfig({...githubConfig, token: e.target.value}, persistGitHubToken);
              }}
              placeholder="github_pat_..."
              className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent font-mono text-xs"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <label className="flex items-center gap-2 text-xs opacity-75 cursor-pointer">
            <input
              type="checkbox"
              checked={persistGitHubToken}
              onChange={(e) => {
                const nextPersist = e.target.checked;
                setPersistGitHubToken(nextPersist);
                onUpdateGitHubConfig(githubConfig, nextPersist);
              }}
            />
            <span>Remember token on this browser</span>
          </label>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={githubBusy || !githubConfig.owner.trim() || !githubConfig.repo.trim()}
              onClick={() => {
                void (async () => {
                  const res = await onTestGitHub();
                  setGitHubTestResult(res);
                })();
              }}
              className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-45"
            >
              Test GitHub Repo
            </button>
            <button
              type="button"
              disabled={githubBusy || !githubConfig.owner.trim() || !githubConfig.repo.trim()}
              onClick={() => void onPullGitHub()}
              className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-45"
            >
              Pull from GitHub
            </button>
            <button
              type="button"
              disabled={githubBusy || !githubConfig.owner.trim() || !githubConfig.repo.trim()}
              onClick={() => void onSyncGitHub()}
              className="px-3.5 py-2 rounded-lg accent-btn text-xs font-medium flex items-center gap-1.5 disabled:opacity-45"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${githubBusy ? 'animate-spin' : ''}`} aria-hidden="true" />
              Sync to GitHub
            </button>
          </div>
        </div>

        {(githubTestResult || githubStatus || githubConfig.lastSyncedAtMs) && (
          <div className="pt-2 border-t border-slate-100 dark:border-slate-800 text-xs space-y-1">
            {githubTestResult && (
              <p className={githubTestResult.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>
                {githubTestResult.message}
              </p>
            )}
            {githubStatus && <p className="text-slate-600 dark:text-slate-300">{githubStatus}</p>}
            {githubConfig.lastSyncedAtMs && (
              <p className="text-slate-500 dark:text-slate-400 tabular-nums">
                Last GitHub sync: {new Date(githubConfig.lastSyncedAtMs).toLocaleString()}
              </p>
            )}
          </div>
        )}
      </section>

      {/* 1b. Custom Cloud Storage Sync (WebDAV / Nextcloud / ownCloud / Custom HTTPS) */}
      <section
        aria-label="Custom cloud storage sync"
        className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-5"
      >
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Server className="w-5 h-5 accent-text" aria-hidden="true" />
            <div>
              <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                Custom Cloud Storage Sync (WebDAV / Custom HTTPS)
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Synchronize your library catalog, bookmarks, annotations, and courses to Nextcloud, ownCloud, Synology WebDAV, or your own HTTPS storage endpoint.
              </p>
            </div>
          </div>

          <label className="flex items-center gap-2 text-xs font-medium cursor-pointer">
            <input
              type="checkbox"
              checked={customCloudConfig.enabled}
              onChange={(e) =>
                onUpdateCustomCloudConfig({...customCloudConfig, enabled: e.target.checked}, persistSecret)
              }
            />
            <span>Enable Custom Sync</span>
          </label>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
          <div className="space-y-1.5">
            <label htmlFor="custom-cloud-provider" className="block font-medium opacity-80">
              Storage Protocol
            </label>
            <select
              id="custom-cloud-provider"
              value={customCloudConfig.provider}
              onChange={(e) =>
                onUpdateCustomCloudConfig(
                  {...customCloudConfig, provider: e.target.value as CustomCloudProvider},
                  persistSecret,
                )
              }
              className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100"
            >
              <option value="webdav">WebDAV Folder (Nextcloud / ownCloud / NAS)</option>
              <option value="custom-json">Custom HTTPS JSON Endpoint (GET / PUT)</option>
            </select>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="custom-cloud-auth" className="block font-medium opacity-80">
              Authentication Method
            </label>
            <select
              id="custom-cloud-auth"
              value={customCloudConfig.authType}
              onChange={(e) =>
                onUpdateCustomCloudConfig(
                  {...customCloudConfig, authType: e.target.value as CustomCloudAuthType},
                  persistSecret,
                )
              }
              className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100"
            >
              <option value="basic">Basic Auth (Username + App Password)</option>
              <option value="bearer">Bearer API Token</option>
              <option value="none">No Auth Header</option>
            </select>
          </div>

          <div className="space-y-1.5 md:col-span-2">
            <label htmlFor="custom-cloud-url" className="block font-medium opacity-80">
              {customCloudConfig.provider === 'webdav' ? 'WebDAV Folder URL' : 'HTTPS Endpoint URL'}
            </label>
            <input
              id="custom-cloud-url"
              type="url"
              value={customCloudConfig.endpointUrl}
              onChange={(e) => {
                setCustomTestResult(null);
                onUpdateCustomCloudConfig({...customCloudConfig, endpointUrl: e.target.value}, persistSecret);
              }}
              placeholder={
                customCloudConfig.provider === 'webdav'
                  ? 'https://cloud.example.com/remote.php/dav/files/username/DocuTrack'
                  : 'https://storage.example.com/api/docutrack-sync'
              }
              className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent font-mono text-xs"
            />
          </div>

          {customCloudConfig.provider === 'webdav' && (
            <div className="space-y-1.5">
              <label htmlFor="custom-cloud-filename" className="block font-medium opacity-80">
                Remote Archive Filename
              </label>
              <input
                id="custom-cloud-filename"
                type="text"
                value={customCloudConfig.remoteFileName}
                onChange={(e) =>
                  onUpdateCustomCloudConfig({...customCloudConfig, remoteFileName: e.target.value}, persistSecret)
                }
                placeholder="docutrack-library-sync.json"
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent font-mono text-xs"
              />
            </div>
          )}

          {customCloudConfig.authType === 'basic' && (
            <div className="space-y-1.5">
              <label htmlFor="custom-cloud-user" className="block font-medium opacity-80">
                Username
              </label>
              <input
                id="custom-cloud-user"
                type="text"
                autoComplete="username"
                value={customCloudConfig.username}
                onChange={(e) =>
                  onUpdateCustomCloudConfig({...customCloudConfig, username: e.target.value}, persistSecret)
                }
                placeholder="nextcloud-user"
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent text-xs"
              />
            </div>
          )}

          {customCloudConfig.authType !== 'none' && (
            <div className={`space-y-1.5 ${customCloudConfig.provider === 'custom-json' && customCloudConfig.authType === 'bearer' ? 'md:col-span-2' : ''}`}>
              <label htmlFor="custom-cloud-secret" className="block font-medium opacity-80">
                {customCloudConfig.authType === 'bearer' ? 'Bearer Token' : 'App Password / Secret'}
              </label>
              <input
                id="custom-cloud-secret"
                type="password"
                autoComplete="current-password"
                value={customCloudConfig.secret}
                onChange={(e) =>
                  onUpdateCustomCloudConfig({...customCloudConfig, secret: e.target.value}, persistSecret)
                }
                placeholder="••••••••••••"
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent font-mono text-xs"
              />
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <label className="flex items-center gap-2 text-xs opacity-75 cursor-pointer">
            <input
              type="checkbox"
              checked={persistSecret}
              onChange={(e) => {
                const nextPersist = e.target.checked;
                setPersistSecret(nextPersist);
                onUpdateCustomCloudConfig(customCloudConfig, nextPersist);
              }}
            />
            <span>Remember password/token on this browser</span>
          </label>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={customCloudBusy}
              onClick={() => {
                void (async () => {
                  const res = await onTestCustomCloud();
                  setCustomTestResult(res);
                })();
              }}
              className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-45"
            >
              Test Connection
            </button>
            <button
              type="button"
              disabled={customCloudBusy || !customCloudConfig.endpointUrl.trim()}
              onClick={() => void onPullCustomCloud()}
              className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-45"
            >
              Pull Remote
            </button>
            <button
              type="button"
              disabled={customCloudBusy || !customCloudConfig.endpointUrl.trim()}
              onClick={() => void onSyncCustomCloud()}
              className="px-3.5 py-2 rounded-lg accent-btn text-xs font-medium flex items-center gap-1.5 disabled:opacity-45"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${customCloudBusy ? 'animate-spin' : ''}`} aria-hidden="true" />
              Sync (Merge &amp; Push)
            </button>
          </div>
        </div>

        {(customTestResult || customCloudStatus || customCloudConfig.lastSyncedAtMs) && (
          <div className="pt-2 border-t border-slate-100 dark:border-slate-800 text-xs space-y-1">
            {customTestResult && (
              <p className={customTestResult.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>
                {customTestResult.message}
              </p>
            )}
            {customCloudStatus && (
              <p className="text-slate-600 dark:text-slate-300">{customCloudStatus}</p>
            )}
            {customCloudConfig.lastSyncedAtMs && (
              <p className="text-slate-500 dark:text-slate-400 tabular-nums">
                Last custom sync: {new Date(customCloudConfig.lastSyncedAtMs).toLocaleString()}
              </p>
            )}
          </div>
        )}
      </section>

      {/* 2. Automated Local Storage Backups */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <ShieldCheck className="w-5 h-5 text-slate-700 dark:text-slate-300" aria-hidden="true" />
            <div>
              <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                Automated Local Storage Backups
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Automatically snapshot your library index, annotations, AI courses, and reader settings to local storage or a chosen hard drive folder.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <label htmlFor="backup-freq" className="text-xs text-slate-500 dark:text-slate-400">
              Schedule
            </label>
            <select
              id="backup-freq"
              value={preferences.backupFrequency}
              onChange={(e) => onChangeBackupFrequency(e.target.value as BackupFrequency)}
              className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs font-medium text-slate-800 dark:text-slate-200"
            >
              <option value="onChange">Automatic (On Every Change)</option>
              <option value="hourly">Automatic (Every Hour)</option>
              <option value="daily">Automatic (Daily)</option>
              <option value="manual">Manual Only</option>
            </select>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 pt-1">
          <button
            type="button"
            onClick={onTriggerManualBackup}
            className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 text-xs font-medium hover:opacity-90"
          >
            Run Backup Snapshot Now
          </button>

          <button
            type="button"
            onClick={() => onDownloadBackupFile()}
            className="px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-1.5"
          >
            <Download className="w-3.5 h-3.5" aria-hidden="true" />
            Export .docutrack-backup.json
          </button>

          {supportsDirectoryPicker && (
            <button
              type="button"
              onClick={onLinkLocalBackupFolder}
              className="px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-1.5"
            >
              <FolderSync className="w-3.5 h-3.5" aria-hidden="true" />
              {linkedBackupDirName ? `Linked Folder: ${linkedBackupDirName}` : 'Link Local Disk Folder'}
            </button>
          )}

          <button
            type="button"
            onClick={() => restoreInputRef.current?.click()}
            className="px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-1.5"
          >
            <Upload className="w-3.5 h-3.5" aria-hidden="true" />
            Restore Backup File
          </button>
          <input
            ref={restoreInputRef}
            type="file"
            accept=".json,.docutrack-backup.json,.folio-backup.json"
            onChange={handleFileChange}
            className="hidden"
          />
        </div>

        {restoreFeedback && (
          <p className="text-xs text-blue-700 dark:text-blue-400">{restoreFeedback}</p>
        )}

        <div className="pt-2 border-t border-slate-100 dark:border-slate-800">
          <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-2">
            Snapshot History ({backups.length})
          </h3>
          {backups.length === 0 ? (
            <p className="text-xs text-slate-400">No backup snapshots recorded yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
                    <th className="py-2 pr-3">Timestamp</th>
                    <th className="py-2 px-3">Trigger</th>
                    <th className="py-2 px-3">Destination</th>
                    <th className="py-2 px-3 text-right">Contents</th>
                    <th className="py-2 px-3 text-right">Size</th>
                    <th className="py-2 pl-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {backups.map((bkp) => (
                    <tr key={bkp.id}>
                      <td className="py-2 pr-3 tabular-nums text-slate-700 dark:text-slate-300">
                        {new Date(bkp.createdAtMs).toLocaleString()}
                      </td>
                      <td className="py-2 px-3 capitalize text-slate-600 dark:text-slate-400">
                        {bkp.trigger}
                      </td>
                      <td className="py-2 px-3 text-slate-600 dark:text-slate-400">
                        {bkp.destination}
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums text-slate-600 dark:text-slate-400">
                        {bkp.bookCount} books · {bkp.annotationCount} notes
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums text-slate-500">
                        {formatBytes(bkp.sizeBytes)}
                      </td>
                      <td className="py-2 pl-3 text-right whitespace-nowrap space-x-2">
                        <button
                          type="button"
                          onClick={() => onDownloadBackupFile(bkp.id)}
                          className="text-blue-700 dark:text-blue-400 hover:underline"
                        >
                          Download
                        </button>
                        <button
                          type="button"
                          onClick={() => onRestoreSnapshot(bkp.id)}
                          className="text-slate-700 dark:text-slate-300 hover:underline"
                        >
                          Restore
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {/* 4. Desktop Installers & GitHub Release Pipeline */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-4">
        <div className="flex items-center gap-3">
          <Laptop className="w-5 h-5 text-blue-700 dark:text-blue-400" aria-hidden="true" />
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Desktop Installers (GitHub Actions CI)
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Automated multi-OS Electron packaging configured in{' '}
              <code className="font-mono text-[11px]">.github/workflows/release-desktop.yml</code> and{' '}
              <code className="font-mono text-[11px]">electron-builder.yml</code>. Push a{' '}
              <code className="font-mono text-[11px]">v*</code> tag or run{' '}
              <code className="font-mono text-[11px]">workflow_dispatch</code> with a version identifier (e.g.{' '}
              <code className="font-mono text-[11px]">v.1.0.0</code>) on GitHub to build and publish native binaries.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3.5 space-y-1">
            <div className="font-semibold text-slate-900 dark:text-slate-100">Windows (x64)</div>
            <p className="text-slate-500 dark:text-slate-400">NSIS Installer (.exe) with PDF, EPUB &amp; DjVu file associations</p>
          </div>
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3.5 space-y-1">
            <div className="font-semibold text-slate-900 dark:text-slate-100">Linux (x64)</div>
            <p className="text-slate-500 dark:text-slate-400">Portable AppImage (.AppImage) bundle</p>
          </div>
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3.5 space-y-1">
            <div className="font-semibold text-slate-900 dark:text-slate-100">macOS (Universal / Apple Silicon)</div>
            <p className="text-slate-500 dark:text-slate-400">Disk Image (.dmg) &amp; Archive (.zip) for x64 + arm64</p>
          </div>
        </div>
      </section>
    </div>
  );
};
