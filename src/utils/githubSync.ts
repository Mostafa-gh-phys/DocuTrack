import type {BackupArchive} from '../types/library';
import {mergeLibraryArchives} from './customCloudSync';
import {validateBackupArchive} from './libraryLogic';

export interface GitHubSyncConfig {
  enabled: boolean;
  owner: string;
  repo: string;
  branch: string;
  filePath: string;
  token: string;
  lastSyncedAtMs?: number;
}

export const DEFAULT_GITHUB_SYNC_CONFIG: GitHubSyncConfig = {
  enabled: false,
  owner: '',
  repo: '',
  branch: 'main',
  filePath: 'docutrack-library-sync.json',
  token: '',
};

const GITHUB_STORAGE_KEY = 'docutrack_github_sync_config_v1';
const SAFE_SEGMENT_RE = /^[a-zA-Z0-9._-]+$/;

export function loadGitHubSyncConfig(): GitHubSyncConfig {
  if (typeof localStorage === 'undefined') return DEFAULT_GITHUB_SYNC_CONFIG;
  try {
    const raw = localStorage.getItem(GITHUB_STORAGE_KEY);
    if (!raw) return DEFAULT_GITHUB_SYNC_CONFIG;
    const parsed = JSON.parse(raw) as Partial<GitHubSyncConfig>;
    return {
      ...DEFAULT_GITHUB_SYNC_CONFIG,
      ...parsed,
    };
  } catch {
    return DEFAULT_GITHUB_SYNC_CONFIG;
  }
}

export function saveGitHubSyncConfig(config: GitHubSyncConfig, persistToken: boolean): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const sanitized: GitHubSyncConfig = {
      ...config,
      token: persistToken ? config.token : '',
    };
    localStorage.setItem(GITHUB_STORAGE_KEY, JSON.stringify(sanitized));
  } catch {
    // Ignore storage quota restrictions
  }
}

export function normalizeGitHubRepoInputs(ownerInput: string, repoInput: string): {owner: string; repo: string} {
  let owner = (ownerInput || '').trim();
  let repo = (repoInput || '').trim();

  const tryParseFullRepo = (raw: string): {o: string; r: string} | null => {
    const cleaned = raw
      .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
      .replace(/^git@github\.com:/i, '')
      .replace(/\.git$/i, '')
      .replace(/^\/+|\/+$/g, '');
    const parts = cleaned.split('/').filter(Boolean);
    if (parts.length >= 2) {
      return {o: parts[0], r: parts[1]};
    }
    return null;
  };

  if (owner.includes('github.com') || (owner.includes('/') && !repo)) {
    const parsed = tryParseFullRepo(owner);
    if (parsed) {
      owner = parsed.o;
      repo = parsed.r;
    }
  } else if (repo.includes('github.com') || repo.includes('/')) {
    const parsed = tryParseFullRepo(repo);
    if (parsed) {
      if (!owner) owner = parsed.o;
      repo = parsed.r;
    }
  }

  return {
    owner: owner.replace(/^@/, '').trim(),
    repo: repo.replace(/\.git$/i, '').trim(),
  };
}

export function validateGitHubSyncConfig(config: GitHubSyncConfig): {
  valid: boolean;
  owner?: string;
  repo?: string;
  branch?: string;
  encodedPath?: string;
  cleanPath?: string;
  error?: string;
} {
  const owner = (config.owner || '').trim();
  const repo = (config.repo || '').trim();
  const branch = (config.branch || 'main').trim() || 'main';
  const rawPath = (config.filePath || 'docutrack-library-sync.json')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');

  if (!owner || !SAFE_SEGMENT_RE.test(owner)) {
    return {valid: false, error: 'Enter a valid GitHub username or organization name.'};
  }
  if (!repo || !SAFE_SEGMENT_RE.test(repo)) {
    return {valid: false, error: 'Enter a valid GitHub repository name.'};
  }
  if (branch.includes('..') || !/^[a-zA-Z0-9._/-]+$/.test(branch)) {
    return {valid: false, error: 'Enter a valid Git branch name (e.g. main).'};
  }
  const parts = rawPath.split('/').filter(Boolean);
  if (parts.length === 0 || parts.some((p) => p === '.' || p === '..')) {
    return {valid: false, error: 'Enter a safe repository file path (e.g. sync/docutrack-library.json).'};
  }
  const cleanPath = parts.join('/');
  const encodedPath = parts.map((p) => encodeURIComponent(p)).join('/');
  return {valid: true, owner, repo, branch, cleanPath, encodedPath};
}

function encodeBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(bin);
}

function decodeBase64Utf8(b64: string): string {
  const clean = b64.replace(/\s+/g, '');
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

function buildGitHubHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
  };
  if (token.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  return headers;
}

export async function testGitHubRepoConnection(
  config: GitHubSyncConfig,
): Promise<{ok: boolean; message: string}> {
  const check = validateGitHubSyncConfig(config);
  if (!check.valid || !check.owner || !check.repo || !check.branch) {
    return {ok: false, message: check.error || 'Invalid GitHub repository settings.'};
  }

  const repoUrl = `https://api.github.com/repos/${encodeURIComponent(check.owner)}/${encodeURIComponent(check.repo)}`;
  const res = await fetch(repoUrl, {
    method: 'GET',
    headers: buildGitHubHeaders(config.token),
    signal: AbortSignal.timeout(10000),
  });

  if (res.status === 404) {
    return {
      ok: false,
      message: `Repository ${check.owner}/${check.repo} not found or private without a valid access token.`,
    };
  }
  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      message: 'GitHub authentication failed or rate-limited. Provide a fine-grained PAT with Contents read/write access.',
    };
  }
  if (!res.ok) {
    return {ok: false, message: `GitHub API returned HTTP ${res.status}.`};
  }
  const info = (await res.json()) as {
    full_name?: string;
    default_branch?: string;
    private?: boolean;
    permissions?: {push?: boolean};
  };
  const canPush = info.permissions?.push;
  const accessNote =
    canPush === true
      ? 'read/write access verified'
      : canPush === false
        ? 'read-only access (add write PAT to push)'
        : 'repository reachable';
  const branchNote =
    info.default_branch && info.default_branch !== check.branch
      ? ` · default branch is "${info.default_branch}"`
      : '';
  return {
    ok: true,
    message: `Connected to ${info.full_name || `${check.owner}/${check.repo}`} (${accessNote}${branchNote}).`,
  };
}

export async function pullFromGitHubRepo(
  config: GitHubSyncConfig,
): Promise<{found: boolean; sha?: string; archive?: BackupArchive}> {
  const check = validateGitHubSyncConfig(config);
  if (!check.valid || !check.owner || !check.repo || !check.branch || !check.encodedPath) {
    throw new Error(check.error || 'Invalid GitHub repository configuration.');
  }

  const url = `https://api.github.com/repos/${encodeURIComponent(check.owner)}/${encodeURIComponent(
    check.repo,
  )}/contents/${check.encodedPath}?ref=${encodeURIComponent(check.branch)}`;

  const res = await fetch(url, {
    method: 'GET',
    headers: buildGitHubHeaders(config.token),
    signal: AbortSignal.timeout(15000),
  });

  if (res.status === 404) {
    return {found: false};
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`GitHub pull failed (HTTP ${res.status}): ${errText.slice(0, 140)}`);
  }

  const data = (await res.json()) as {
    sha?: string;
    content?: string;
    encoding?: string;
    download_url?: string | null;
  };

  let rawJson = '';
  if (typeof data.content === 'string' && data.encoding === 'base64') {
    rawJson = decodeBase64Utf8(data.content);
  } else if (data.download_url) {
    const rawRes = await fetch(data.download_url, {
      headers: config.token.trim() ? {Authorization: `Bearer ${config.token.trim()}`} : {},
      signal: AbortSignal.timeout(15000),
    });
    if (!rawRes.ok) {
      throw new Error(`Failed to fetch raw archive from GitHub (HTTP ${rawRes.status}).`);
    }
    rawJson = await rawRes.text();
  }

  const parsed = JSON.parse(rawJson);
  if (!validateBackupArchive(parsed)) {
    throw new Error('The GitHub file does not match a valid DocuTrack sync archive.');
  }

  return {found: true, sha: data.sha, archive: parsed};
}

export async function syncWithGitHubRepo(
  config: GitHubSyncConfig,
  localArchive: BackupArchive,
): Promise<{mergedArchive: BackupArchive; uploadedBytes: number; commitSha?: string}> {
  const check = validateGitHubSyncConfig(config);
  if (!check.valid || !check.owner || !check.repo || !check.branch || !check.encodedPath) {
    throw new Error(check.error || 'Invalid GitHub repository configuration.');
  }
  if (!config.token.trim()) {
    throw new Error('A GitHub Personal Access Token (with Contents read/write scope) is required to push changes.');
  }

  const putUrl = `https://api.github.com/repos/${encodeURIComponent(check.owner)}/${encodeURIComponent(
    check.repo,
  )}/contents/${check.encodedPath}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    let mergedArchive = localArchive;
    let existingSha: string | undefined;

    const remote = await pullFromGitHubRepo(config);
    if (remote.found) {
      existingSha = remote.sha;
      if (remote.archive) {
        mergedArchive = mergeLibraryArchives(localArchive, remote.archive);
      }
    }

    const serialized = JSON.stringify(mergedArchive, null, 2);
    const body: Record<string, unknown> = {
      message: `DocuTrack library sync (${mergedArchive.books.length} books, ${mergedArchive.annotations.length} notes)`,
      content: encodeBase64Utf8(serialized),
      branch: check.branch,
    };
    if (existingSha) {
      body.sha = existingSha;
    }

    const putRes = await fetch(putUrl, {
      method: 'PUT',
      headers: {
        ...buildGitHubHeaders(config.token),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });

    if (putRes.status === 409 && attempt === 0) {
      // Retry once after re-pulling if another device committed concurrently
      continue;
    }

    if (!putRes.ok) {
      const errText = await putRes.text().catch(() => '');
      if (putRes.status === 404 || (putRes.status === 422 && /branch/i.test(errText))) {
        throw new Error(
          `Branch "${check.branch}" was not found in ${check.owner}/${check.repo}. Initialize the repo with an initial README or verify the branch name.`,
        );
      }
      if (putRes.status === 409) {
        throw new Error(
          `GitHub conflict on ${check.owner}/${check.repo}: ensure the repository is initialized with a first commit on "${check.branch}".`,
        );
      }
      throw new Error(`GitHub push failed (HTTP ${putRes.status}): ${errText.slice(0, 160)}`);
    }

    const result = (await putRes.json()) as {commit?: {sha?: string}};
    return {
      mergedArchive,
      uploadedBytes: new TextEncoder().encode(serialized).byteLength,
      commitSha: result.commit?.sha,
    };
  }

  throw new Error('GitHub push failed after conflict retry.');
}
