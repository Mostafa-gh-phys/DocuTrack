import type {
  Annotation,
  BackupArchive,
  BookMetadata,
  StudyCourse,
} from '../types/library';
import {validateBackupArchive} from './libraryLogic';

export type CustomCloudProvider = 'webdav' | 'custom-json';
export type CustomCloudAuthType = 'basic' | 'bearer' | 'none';

export interface CustomCloudConfig {
  enabled: boolean;
  provider: CustomCloudProvider;
  endpointUrl: string;
  remoteFileName: string;
  authType: CustomCloudAuthType;
  username: string;
  secret: string;
  autoSync: boolean;
  lastSyncedAtMs?: number;
}

export const DEFAULT_CUSTOM_CLOUD_CONFIG: CustomCloudConfig = {
  enabled: false,
  provider: 'webdav',
  endpointUrl: '',
  remoteFileName: 'docutrack-library-sync.json',
  authType: 'basic',
  username: '',
  secret: '',
  autoSync: false,
};

const STORAGE_KEY = 'docutrack_custom_cloud_config_v1';

export function loadCustomCloudConfig(): CustomCloudConfig {
  if (typeof localStorage === 'undefined') return DEFAULT_CUSTOM_CLOUD_CONFIG;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_CUSTOM_CLOUD_CONFIG;
    const parsed = JSON.parse(raw) as Partial<CustomCloudConfig>;
    return {
      ...DEFAULT_CUSTOM_CLOUD_CONFIG,
      ...parsed,
      // Never auto-hydrate a stored raw secret unless user explicitly saved non-empty
      secret: typeof parsed.secret === 'string' ? parsed.secret : '',
    };
  } catch {
    return DEFAULT_CUSTOM_CLOUD_CONFIG;
  }
}

export function saveCustomCloudConfig(config: CustomCloudConfig, persistSecret = false): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const toStore: CustomCloudConfig = {
      ...config,
      secret: persistSecret ? config.secret : '',
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toStore));
  } catch {
    // Ignore storage quota restrictions
  }
}

export function validateCustomCloudEndpointUrl(rawUrl: string): {
  valid: boolean;
  normalizedUrl?: string;
  error?: string;
} {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) {
    return {valid: false, error: 'Enter your WebDAV folder URL or HTTPS sync endpoint.'};
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {valid: false, error: 'Invalid URL format. Example: https://cloud.example.com/remote.php/dav/files/user/DocuTrack'};
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return {valid: false, error: 'Only HTTP and HTTPS endpoints are supported.'};
  }

  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    return {valid: false, error: 'Private, loopback, or metadata IP addresses cannot be used as remote sync targets.'};
  }

  return {valid: true, normalizedUrl: parsed.toString()};
}

export function buildCustomCloudTargetUrl(config: CustomCloudConfig): string {
  const base = config.endpointUrl.trim().replace(/\/+$/, '');
  const file = (config.remoteFileName || 'docutrack-library-sync.json').trim().replace(/^\/+/, '');
  if (config.provider === 'custom-json') {
    return base;
  }
  if (base.toLowerCase().endsWith('.json')) {
    return base;
  }
  return `${base}/${encodeURIComponent(file).replace(/%2F/g, '/')}`;
}

export function mergeLibraryArchives(local: BackupArchive, remote: BackupArchive): BackupArchive {
  const mergeByUpdatedAt = <T extends {id: string; updatedAtMs?: number}>(
    aList: T[],
    bList: T[],
  ): T[] => {
    const map = new Map<string, T>();
    for (const item of aList) {
      map.set(item.id, item);
    }
    for (const item of bList) {
      const existing = map.get(item.id);
      if (!existing || (item.updatedAtMs || 0) >= (existing.updatedAtMs || 0)) {
        map.set(item.id, item);
      }
    }
    return Array.from(map.values());
  };

  const mergedBooks = mergeByUpdatedAt<BookMetadata>(local.books || [], remote.books || []);
  const mergedAnnotations = mergeByUpdatedAt<Annotation>(local.annotations || [], remote.annotations || []);
  const mergedCourses = mergeByUpdatedAt<StudyCourse>(local.courses || [], remote.courses || []);

  const mergedPrefs =
    (remote.preferences?.updatedAtMs || 0) > (local.preferences?.updatedAtMs || 0)
      ? remote.preferences
      : local.preferences;

  const mergedGoal =
    remote.readingGoal &&
    (!local.readingGoal || (remote.readingGoal.updatedAtMs || 0) > (local.readingGoal.updatedAtMs || 0))
      ? remote.readingGoal
      : local.readingGoal;

  // Preserve unique text chunks keyed by bookId+page
  const chunkMap = new Map<string, BackupArchive['textChunks'][number]>();
  for (const ch of [...(remote.textChunks || []), ...(local.textChunks || [])]) {
    chunkMap.set(`${ch.bookId}:${ch.page}`, ch);
  }

  return {
    version: Math.max(local.version || 1, remote.version || 1),
    exportedAtMs: Date.now(),
    books: mergedBooks,
    annotations: mergedAnnotations,
    courses: mergedCourses,
    preferences: mergedPrefs,
    readingGoal: mergedGoal,
    textChunks: Array.from(chunkMap.values()),
  };
}

async function callCustomSyncProxy<T>(payload: {
  action: 'test' | 'pull' | 'push';
  provider: CustomCloudProvider;
  targetUrl: string;
  authType: CustomCloudAuthType;
  username?: string;
  secret?: string;
  archive?: BackupArchive;
}): Promise<T> {
  const res = await fetch('/api/cloud/custom-sync', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(payload),
  });
  const data = (await res.json().catch(() => ({}))) as T & {error?: string};
  if (!res.ok) {
    throw new Error(data.error || `Custom cloud sync failed (HTTP ${res.status})`);
  }
  return data;
}

export async function testCustomCloudConnection(config: CustomCloudConfig): Promise<{ok: boolean; message: string}> {
  const check = validateCustomCloudEndpointUrl(config.endpointUrl);
  if (!check.valid || !check.normalizedUrl) {
    return {ok: false, message: check.error || 'Invalid endpoint URL'};
  }
  const targetUrl =
    config.provider === 'webdav' ? config.endpointUrl.trim() : buildCustomCloudTargetUrl(config);
  const res = await callCustomSyncProxy<{ok: boolean; status: number; message: string}>({
    action: 'test',
    provider: config.provider,
    targetUrl,
    authType: config.authType,
    username: config.username,
    secret: config.secret,
  });
  return {ok: res.ok, message: res.message};
}

export async function pullFromCustomCloud(config: CustomCloudConfig): Promise<{
  found: boolean;
  archive: BackupArchive | null;
}> {
  const check = validateCustomCloudEndpointUrl(config.endpointUrl);
  if (!check.valid) throw new Error(check.error || 'Invalid endpoint URL');
  const targetUrl = buildCustomCloudTargetUrl(config);
  const res = await callCustomSyncProxy<{found: boolean; archive?: unknown}>({
    action: 'pull',
    provider: config.provider,
    targetUrl,
    authType: config.authType,
    username: config.username,
    secret: config.secret,
  });
  if (!res.found || !res.archive) {
    return {found: false, archive: null};
  }
  if (!validateBackupArchive(res.archive)) {
    throw new Error('Remote sync file is not a valid DocuTrack archive.');
  }
  return {found: true, archive: res.archive};
}

export async function pushToCustomCloud(
  config: CustomCloudConfig,
  archive: BackupArchive,
): Promise<{status: number; uploadedBytes: number}> {
  const check = validateCustomCloudEndpointUrl(config.endpointUrl);
  if (!check.valid) throw new Error(check.error || 'Invalid endpoint URL');
  const targetUrl = buildCustomCloudTargetUrl(config);
  return await callCustomSyncProxy<{status: number; uploadedBytes: number}>({
    action: 'push',
    provider: config.provider,
    targetUrl,
    authType: config.authType,
    username: config.username,
    secret: config.secret,
    archive,
  });
}
