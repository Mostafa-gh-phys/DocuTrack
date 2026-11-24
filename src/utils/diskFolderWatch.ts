import {openDB, type DBSchema, type IDBPDatabase} from 'idb';
import type {BookMetadata} from '../types/library';
import {detectSupportedBookFormat, deriveFolderFromRelativePath} from './libraryLogic';

export interface WatchedDirectoryHandleLike {
  name: string;
  kind?: 'directory';
  queryPermission?: (opts?: {mode?: 'read' | 'readwrite'}) => Promise<'granted' | 'denied' | 'prompt'>;
  requestPermission?: (opts?: {mode?: 'read' | 'readwrite'}) => Promise<'granted' | 'denied' | 'prompt'>;
  values?: () => AsyncIterable<{
    kind: 'file' | 'directory';
    name: string;
    getFile?: () => Promise<File>;
    values?: () => AsyncIterable<unknown>;
  }>;
}

interface WatchDbSchema extends DBSchema {
  handles: {
    key: string;
    value: WatchedDirectoryHandleLike;
  };
}

export interface WatchedFolderSnapshotMeta {
  folderName: string;
  linkedAtMs: number;
  lastScanAtMs: number;
  knownSignatures: string[];
  autoPollEnabled: boolean;
}

const WATCH_META_KEY = 'docutrack_watched_folder_meta_v1';

let watchDbPromise: Promise<IDBPDatabase<WatchDbSchema>> | null = null;
function getWatchDb(): Promise<IDBPDatabase<WatchDbSchema>> {
  if (!watchDbPromise) {
    watchDbPromise = openDB<WatchDbSchema>('docutrack-watch-handles', 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('handles')) {
          db.createObjectStore('handles');
        }
      },
    });
  }
  return watchDbPromise;
}

export function buildWatchedFileSignature(relPath: string, size: number, lastModified: number): string {
  return `${relPath.replace(/\\/g, '/').toLowerCase()}|${Math.max(0, size)}|${Math.max(0, lastModified)}`;
}

export function loadWatchedFolderMeta(): WatchedFolderSnapshotMeta | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(WATCH_META_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<WatchedFolderSnapshotMeta>;
    if (!parsed.folderName) return null;
    return {
      folderName: String(parsed.folderName),
      linkedAtMs: Number(parsed.linkedAtMs || Date.now()),
      lastScanAtMs: Number(parsed.lastScanAtMs || 0),
      knownSignatures: Array.isArray(parsed.knownSignatures) ? parsed.knownSignatures.map(String) : [],
      autoPollEnabled: parsed.autoPollEnabled !== false,
    };
  } catch {
    return null;
  }
}

export function saveWatchedFolderMeta(meta: WatchedFolderSnapshotMeta | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (!meta) {
      localStorage.removeItem(WATCH_META_KEY);
    } else {
      localStorage.setItem(WATCH_META_KEY, JSON.stringify(meta));
    }
  } catch {
    // Ignore quota errors
  }
}

export async function saveWatchedDirectoryHandle(handle: WatchedDirectoryHandleLike | null): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  try {
    const db = await getWatchDb();
    if (!handle) {
      await db.delete('handles', 'primary');
    } else {
      await db.put('handles', handle, 'primary');
    }
  } catch {
    // Some browsers disallow structured-cloning directory handles
  }
}

export async function loadWatchedDirectoryHandle(): Promise<WatchedDirectoryHandleLike | null> {
  if (typeof indexedDB === 'undefined') return null;
  try {
    const db = await getWatchDb();
    return (await db.get('handles', 'primary')) || null;
  } catch {
    return null;
  }
}

/**
 * Diffs scanned disk files against known file signatures and existing library entries
 * so only brand-new or updated files added on disk get pushed to the bookshelf.
 */
export function filterNewDiskFilesForBookshelf(
  scannedFiles: File[],
  knownSignatures: string[],
  existingBooks: BookMetadata[],
): {newFiles: File[]; allSignatures: string[]} {
  const seen = new Set(knownSignatures);
  const existingKeys = new Set(
    existingBooks.map((b) => `${b.folderPath.toLowerCase()}|${b.title.toLowerCase()}|${b.fileSize}`),
  );
  const allSignatures: string[] = [];
  const newFiles: File[] = [];

  for (const file of scannedFiles) {
    if (!detectSupportedBookFormat(file.name)) continue;
    const rel =
      (file as File & {webkitRelativePath?: string}).webkitRelativePath || file.name;
    const sig = buildWatchedFileSignature(rel, file.size, file.lastModified);
    allSignatures.push(sig);
    if (seen.has(sig)) continue;

    const baseTitle = file.name.replace(/\.[^.]+$/, '').toLowerCase();
    const folder = deriveFolderFromRelativePath(rel);
    const softKey = `${folder.toLowerCase()}|${baseTitle}|${file.size}`;
    if (existingKeys.has(softKey)) continue;

    newFiles.push(file);
  }

  return {newFiles, allSignatures};
}

export async function collectSupportedFilesFromDirectoryHandle(
  rootHandle: WatchedDirectoryHandleLike,
): Promise<File[]> {
  const collected: File[] = [];
  const walk = async (handle: WatchedDirectoryHandleLike, prefix: string) => {
    if (!handle.values) return;
    for await (const entry of handle.values()) {
      if (entry.kind === 'file' && entry.getFile) {
        if (!detectSupportedBookFormat(entry.name)) continue;
        const file = await entry.getFile();
        Object.defineProperty(file, 'webkitRelativePath', {
          value: `${prefix}/${file.name}`,
          configurable: true,
        });
        collected.push(file);
      } else if (entry.kind === 'directory') {
        await walk(entry as WatchedDirectoryHandleLike, `${prefix}/${entry.name}`);
      }
    }
  };
  await walk(rootHandle, rootHandle.name);
  return collected;
}
