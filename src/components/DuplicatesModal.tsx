import React, {useEffect, useMemo, useState} from 'react';
import {AlertTriangle, CheckCircle2, CopyCheck, RefreshCw, ShieldCheck, Trash2, X} from 'lucide-react';
import type {Annotation, BookMetadata} from '../types/library';
import {findDuplicateBookGroups, formatBytes, type DuplicateBookGroup} from '../utils/libraryLogic';

interface DuplicatesModalProps {
  open: boolean;
  books: BookMetadata[];
  annotations: Annotation[];
  onClose: () => void;
  onScanHashes: () => Promise<BookMetadata[]>;
  onDeleteDuplicates: (
    removals: {removeBook: BookMetadata; keepBookId: string}[],
    preserveAnnotations: boolean,
  ) => Promise<void>;
}

export const DuplicatesModal: React.FC<DuplicatesModalProps> = ({
  open,
  books,
  annotations,
  onClose,
  onScanHashes,
  onDeleteDuplicates,
}) => {
  const [scanning, setScanning] = useState(false);
  const [scannedBooks, setScannedBooks] = useState<BookMetadata[]>(books);
  const [keepByGroup, setKeepByGroup] = useState<Record<string, string>>({});
  const [selectedToRemove, setSelectedToRemove] = useState<Record<string, boolean>>({});
  const [preserveAnnotations, setPreserveAnnotations] = useState(true);
  const [confirmStep, setConfirmStep] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const runScan = async (sourceBooks: BookMetadata[]) => {
    setScanning(true);
    setConfirmStep(false);
    try {
      const enriched = await onScanHashes();
      const targetBooks = enriched.length > 0 ? enriched : sourceBooks;
      setScannedBooks(targetBooks);

      const detected = findDuplicateBookGroups(targetBooks, annotations);
      const nextKeep: Record<string, string> = {};
      const nextRemove: Record<string, boolean> = {};
      for (const g of detected) {
        nextKeep[g.id] = g.recommendedKeepId;
        for (const b of g.books) {
          if (b.id !== g.recommendedKeepId) {
            nextRemove[b.id] = true;
          }
        }
      }
      setKeepByGroup(nextKeep);
      setSelectedToRemove(nextRemove);
    } finally {
      setScanning(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setScannedBooks(books);
    void runScan(books);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const groups: DuplicateBookGroup[] = useMemo(
    () => findDuplicateBookGroups(scannedBooks, annotations),
    [scannedBooks, annotations],
  );

  const annotationCountByBook = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of annotations) {
      map.set(a.bookId, (map.get(a.bookId) || 0) + 1);
    }
    return map;
  }, [annotations]);

  const pendingRemovals = useMemo(() => {
    const items: {removeBook: BookMetadata; keepBookId: string}[] = [];
    for (const g of groups) {
      const keepId = keepByGroup[g.id] || g.recommendedKeepId;
      for (const b of g.books) {
        if (b.id !== keepId && selectedToRemove[b.id]) {
          items.push({removeBook: b, keepBookId: keepId});
        }
      }
    }
    return items;
  }, [groups, keepByGroup, selectedToRemove]);

  const reclaimableBytes = useMemo(
    () => pendingRemovals.reduce((acc, item) => acc + (item.removeBook.fileSize || 0), 0),
    [pendingRemovals],
  );

  if (!open) return null;

  const handleSetKeep = (group: DuplicateBookGroup, newKeepId: string) => {
    setConfirmStep(false);
    const prevKeepId = keepByGroup[group.id] || group.recommendedKeepId;
    setKeepByGroup((prev) => ({...prev, [group.id]: newKeepId}));
    setSelectedToRemove((prev) => {
      const next = {...prev};
      delete next[newKeepId];
      if (prevKeepId && prevKeepId !== newKeepId) {
        next[prevKeepId] = true;
      }
      return next;
    });
  };

  const handleConfirmDelete = async () => {
    if (pendingRemovals.length === 0) return;
    setDeleting(true);
    try {
      await onDeleteDuplicates(pendingRemovals, preserveAnnotations);
      setConfirmStep(false);
      onClose();
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Duplicate file detector"
      className="fixed inset-0 z-50 bg-black/45 backdrop-blur-xs flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl max-h-[86vh] rounded-2xl border app-border app-surface shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b app-border flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <CopyCheck className="w-4 h-4 accent-text" aria-hidden="true" />
            <div>
              <h2 className="text-base font-semibold">Duplicate Document Detector</h2>
              <p className="text-xs opacity-65">
                SHA-256 content verification &amp; metadata check · requires your permission before deleting
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void runScan(books)}
              disabled={scanning || deleting}
              aria-label="Re-scan library for duplicates"
              className="px-2.5 py-1.5 rounded-lg border app-border text-xs font-medium hover:opacity-80 flex items-center gap-1.5 disabled:opacity-45"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${scanning ? 'animate-spin' : ''}`} aria-hidden="true" />
              Scan
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close duplicate detector"
              className="p-1.5 rounded-lg opacity-60 hover:opacity-100"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {scanning ? (
            <div className="py-12 text-center space-y-2">
              <RefreshCw className="w-7 h-7 mx-auto opacity-50 animate-spin" aria-hidden="true" />
              <p className="text-sm font-medium">Checking SHA-256 file fingerprints across your library...</p>
              <p className="text-xs opacity-60">Comparing binary payloads and metadata safely inside IndexedDB.</p>
            </div>
          ) : groups.length === 0 ? (
            <div className="py-12 text-center space-y-2">
              <CheckCircle2 className="w-9 h-9 mx-auto text-emerald-600" aria-hidden="true" />
              <h3 className="text-sm font-semibold">No duplicate documents detected</h3>
              <p className="text-xs opacity-65 max-w-md mx-auto">
                Every file across {scannedBooks.length} documents in your DocuTrack library has a unique fingerprint.
              </p>
            </div>
          ) : (
            <>
              <div className="rounded-xl border app-border app-surface-muted px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-xs">
                <span>
                  Found <strong>{groups.length}</strong> duplicate {groups.length === 1 ? 'group' : 'groups'} ·{' '}
                  <strong>{pendingRemovals.length}</strong> selected ({formatBytes(reclaimableBytes)} reclaimable in app)
                </span>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={preserveAnnotations}
                    onChange={(e) => setPreserveAnnotations(e.target.checked)}
                  />
                  <span>Move annotations to kept copy</span>
                </label>
              </div>

              {groups.map((group, gIdx) => {
                const keepId = keepByGroup[group.id] || group.recommendedKeepId;
                return (
                  <section
                    key={group.id}
                    data-testid="duplicate-group"
                    className="rounded-xl border app-border overflow-hidden"
                  >
                    <div className="px-4 py-2.5 border-b app-border app-surface-muted flex items-center justify-between gap-2 text-xs">
                      <span className="font-semibold">
                        Group {gIdx + 1}: {group.books[0]?.title}
                      </span>
                      <span className="opacity-70">{group.reason}</span>
                    </div>

                    <div className="divide-y divide-black/10 dark:divide-white/10">
                      {group.books.map((book) => {
                        const isKeep = book.id === keepId;
                        const isCheckedForRemoval = !isKeep && Boolean(selectedToRemove[book.id]);
                        const annCount = annotationCountByBook.get(book.id) || 0;

                        return (
                          <div
                            key={book.id}
                            className={`px-4 py-3 flex items-center justify-between gap-3 text-xs ${
                              isKeep ? 'bg-emerald-500/5' : ''
                            }`}
                          >
                            <div className="flex items-start gap-3 min-w-0">
                              {isKeep ? (
                                <ShieldCheck
                                  className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5"
                                  aria-label="Kept copy"
                                />
                              ) : (
                                <input
                                  type="checkbox"
                                  checked={isCheckedForRemoval}
                                  aria-label={`Select duplicate ${book.title} in ${book.folderPath} for removal`}
                                  onChange={(e) => {
                                    setConfirmStep(false);
                                    setSelectedToRemove((prev) => ({
                                      ...prev,
                                      [book.id]: e.target.checked,
                                    }));
                                  }}
                                  className="mt-0.5"
                                />
                              )}

                              <div className="min-w-0 space-y-0.5">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="font-semibold text-sm truncate max-w-sm">{book.title}</span>
                                  <span className="font-mono uppercase opacity-60">{book.format}</span>
                                  {isKeep && (
                                    <span className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-400">
                                      Keeping
                                    </span>
                                  )}
                                </div>
                                <div className="opacity-65 font-mono truncate">
                                  {book.folderPath} · {formatBytes(book.fileSize)} · {book.progress}% read
                                  {annCount > 0 ? ` · ${annCount} notes` : ''}
                                </div>
                              </div>
                            </div>

                            {!isKeep && (
                              <button
                                type="button"
                                onClick={() => handleSetKeep(group, book.id)}
                                className="px-2.5 py-1 rounded-md border app-border hover:opacity-80 font-medium whitespace-nowrap shrink-0"
                              >
                                Keep this copy
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
            </>
          )}
        </div>

        <div className="px-5 py-3.5 border-t app-border app-surface-muted flex flex-wrap items-center justify-between gap-3">
          {confirmStep ? (
            <div className="w-full flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-xs text-amber-800 dark:text-amber-300">
                <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span>
                  Permission required: remove <strong>{pendingRemovals.length}</strong> duplicate{' '}
                  {pendingRemovals.length === 1 ? 'entry' : 'entries'} from DocuTrack? Kept copies &amp; disk files stay untouched.
                </span>
              </div>
              <div className="flex items-center gap-2 ml-auto">
                <button
                  type="button"
                  disabled={deleting}
                  onClick={() => setConfirmStep(false)}
                  className="px-3 py-1.5 rounded-lg border app-border app-surface text-xs font-medium"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={deleting}
                  onClick={() => void handleConfirmDelete()}
                  className="px-3.5 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50"
                >
                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                  {deleting ? 'Removing...' : 'Confirm & Delete from App'}
                </button>
              </div>
            </div>
          ) : (
            <>
              <span className="text-xs opacity-65">
                Hard-drive files are never modified; removals affect DocuTrack library only.
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-3 py-1.5 rounded-lg border app-border app-surface text-xs font-medium"
                >
                  Close
                </button>
                {groups.length > 0 && (
                  <button
                    type="button"
                    disabled={pendingRemovals.length === 0 || scanning}
                    onClick={() => setConfirmStep(true)}
                    className="px-3.5 py-1.5 rounded-lg accent-btn text-xs font-medium disabled:opacity-45 flex items-center gap-1.5"
                  >
                    <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                    Delete Selected ({pendingRemovals.length})
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
