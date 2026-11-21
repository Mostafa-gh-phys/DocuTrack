import assert from 'node:assert/strict';
import test from 'node:test';
import type {BackupArchive, BookMetadata, ReaderPreferences} from '../types/library';
import {
  buildCustomCloudTargetUrl,
  mergeLibraryArchives,
  validateCustomCloudEndpointUrl,
} from './customCloudSync';

const DEFAULT_READER_PREFERENCES: ReaderPreferences = {
  theme: 'paper',
  uiTheme: 'light',
  fontFamily: 'serif',
  fontSize: 18,
  lineHeight: 1.65,
  maxWidth: 740,
  columnCount: 1,
  backupFrequency: 'onChange',
  updatedAtMs: 1,
};

function makeBook(id: string, title: string, updatedAtMs: number): BookMetadata {
  return {
    id,
    ownerId: 'local',
    title,
    author: 'Tester',
    format: 'epub',
    folderPath: '/Reading',
    fileSize: 1024,
    pageCount: 10,
    currentPage: 1,
    progress: 10,
    isFavorite: false,
    offlinePinned: true,
    tags: [],
    addedAt: 1000,
    updatedAtMs,
  };
}

test('validateCustomCloudEndpointUrl blocks loopback, private ranges, metadata IPs, and non-HTTP schemes', () => {
  assert.equal(validateCustomCloudEndpointUrl('').valid, false);
  assert.equal(validateCustomCloudEndpointUrl('ftp://files.example.com/dav').valid, false);
  assert.equal(validateCustomCloudEndpointUrl('http://localhost:8080/dav').valid, false);
  assert.equal(validateCustomCloudEndpointUrl('http://127.0.0.1:3000/sync').valid, false);
  assert.equal(validateCustomCloudEndpointUrl('http://169.254.169.254/latest/meta-data').valid, false);
  assert.equal(validateCustomCloudEndpointUrl('http://192.168.1.25/remote.php/dav').valid, false);
  assert.equal(validateCustomCloudEndpointUrl('http://10.0.0.4/sync').valid, false);
  assert.equal(validateCustomCloudEndpointUrl('http://172.16.5.2/sync').valid, false);
  assert.equal(validateCustomCloudEndpointUrl('https://nas.local/webdav').valid, false);

  const ok = validateCustomCloudEndpointUrl('https://cloud.example.com/remote.php/dav/files/alex/DocuTrack');
  assert.equal(ok.valid, true);
  assert.equal(ok.normalizedUrl, 'https://cloud.example.com/remote.php/dav/files/alex/DocuTrack');
});

test('buildCustomCloudTargetUrl joins WebDAV folders cleanly and preserves custom JSON URLs', () => {
  assert.equal(
    buildCustomCloudTargetUrl({
      enabled: true,
      provider: 'webdav',
      endpointUrl: 'https://cloud.example.com/dav/DocuTrack/',
      remoteFileName: 'my library.json',
      authType: 'basic',
      username: 'alex',
      secret: '',
      autoSync: false,
    }),
    'https://cloud.example.com/dav/DocuTrack/my%20library.json',
  );

  assert.equal(
    buildCustomCloudTargetUrl({
      enabled: true,
      provider: 'webdav',
      endpointUrl: 'https://cloud.example.com/dav/DocuTrack/archive.json',
      remoteFileName: 'ignored.json',
      authType: 'none',
      username: '',
      secret: '',
      autoSync: false,
    }),
    'https://cloud.example.com/dav/DocuTrack/archive.json',
  );

  assert.equal(
    buildCustomCloudTargetUrl({
      enabled: true,
      provider: 'custom-json',
      endpointUrl: 'https://api.example.com/v1/docutrack-sync',
      remoteFileName: 'ignored.json',
      authType: 'bearer',
      username: '',
      secret: '',
      autoSync: false,
    }),
    'https://api.example.com/v1/docutrack-sync',
  );
});

test('mergeLibraryArchives resolves conflicts by updatedAtMs and preserves unique textChunks', () => {
  const local: BackupArchive = {
    version: 1,
    exportedAtMs: 2000,
    books: [
      makeBook('b1', 'Local Older', 100),
      makeBook('b2', 'Local Only', 500),
    ],
    annotations: [
      {
        id: 'a1',
        ownerId: 'local',
        bookId: 'b1',
        page: 2,
        quote: 'Quote',
        note: 'Newer local note',
        color: 'amber',
        createdAtMs: 100,
        updatedAtMs: 900,
      },
    ],
    courses: [],
    preferences: {...DEFAULT_READER_PREFERENCES, fontSize: 20, updatedAtMs: 800},
    textChunks: [
      {bookId: 'b1', bookTitle: 'Local Older', page: 1, text: 'Local chunk 1'},
    ],
  };

  const remote: BackupArchive = {
    version: 2,
    exportedAtMs: 3000,
    books: [
      makeBook('b1', 'Remote Newer', 600),
      makeBook('b3', 'Remote Only', 400),
    ],
    annotations: [
      {
        id: 'a1',
        ownerId: 'local',
        bookId: 'b1',
        page: 2,
        quote: 'Quote',
        note: 'Older remote note',
        color: 'sky',
        createdAtMs: 100,
        updatedAtMs: 300,
      },
    ],
    courses: [],
    preferences: {...DEFAULT_READER_PREFERENCES, fontSize: 16, updatedAtMs: 400},
    textChunks: [
      {bookId: 'b1', bookTitle: 'Remote Newer', page: 1, text: 'Remote chunk 1'},
      {bookId: 'b3', bookTitle: 'Remote Only', page: 1, text: 'Remote chunk 3'},
    ],
  };

  const merged = mergeLibraryArchives(local, remote);
  assert.equal(merged.version, 2);
  assert.equal(merged.books.length, 3);
  assert.equal(merged.books.find((b) => b.id === 'b1')?.title, 'Remote Newer');
  assert.equal(merged.annotations[0].note, 'Newer local note');
  assert.equal(merged.preferences.fontSize, 20);
  // Unique textChunks preserved and local wins same bookId:page key
  assert.equal(merged.textChunks.length, 2);
  assert.equal(merged.textChunks.find((c) => c.bookId === 'b1')?.text, 'Local chunk 1');
  assert.equal(merged.textChunks.find((c) => c.bookId === 'b3')?.text, 'Remote chunk 3');
});
