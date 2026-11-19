import React, {useState} from 'react';
import {FileUp, FolderOpen, Upload, X} from 'lucide-react';
import {extractFilesFromDataTransfer} from '../utils/folderWalk';
import {normalizeFolderPath} from '../utils/libraryLogic';

interface ImportModalProps {
  open: boolean;
  onClose: () => void;
  onPickFiles: (targetFolder?: string) => void;
  onPickFolder: () => void;
  onDropFiles: (files: File[], fallbackFolder?: string) => Promise<void>;
}

export const ImportModal: React.FC<ImportModalProps> = ({
  open,
  onClose,
  onPickFiles,
  onPickFolder,
  onDropFiles,
}) => {
  const [customFolder, setCustomFolder] = useState('/Local Drive');
  const [dragging, setDragging] = useState(false);

  if (!open) return null;

  const cleanFolder = normalizeFolderPath(customFolder);

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    const files = await extractFilesFromDataTransfer(e.dataTransfer);
    if (files.length > 0) {
      onClose();
      await onDropFiles(files, cleanFolder);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="import-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/45 backdrop-blur-xs"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-2xl border app-border app-surface p-6 space-y-5 shadow-xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="import-modal-title" className="text-base font-semibold">
              Import Documents or Folders
            </h2>
            <p className="mt-1 text-xs opacity-70">
              Add PDF, EPUB, or DjVu files locally. Nested hard drive folders are preserved in your library tree.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close import dialog"
            className="p-1.5 rounded-lg opacity-60 hover:opacity-100 hover:bg-black/5 dark:hover:bg-white/10"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Drag & Drop Surface */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => void handleDrop(e)}
          className={`rounded-xl border-2 border-dashed p-7 text-center transition-colors ${
            dragging
              ? 'accent-border accent-soft'
              : 'app-border app-surface-muted'
          }`}
        >
          <Upload className="w-7 h-7 mx-auto opacity-55" aria-hidden="true" />
          <p className="mt-2.5 text-sm font-medium">
            Drop files or entire folders here
          </p>
          <p className="mt-1 text-xs opacity-65">
            Supports PDF, EPUB, and DjVu — indexed and stored offline in your library
          </p>
        </div>

        {/* Optional Folder Path for Single-File Imports */}
        <div className="space-y-1.5">
          <label htmlFor="import-folder-target" className="block text-xs font-medium opacity-80">
            Destination folder for loose files
          </label>
          <input
            id="import-folder-target"
            type="text"
            value={customFolder}
            onChange={(e) => setCustomFolder(e.target.value)}
            placeholder="/Research/2026"
            className="w-full px-3 py-2 rounded-lg border app-border bg-transparent text-xs font-mono focus:outline-none focus:ring-2 focus:ring-blue-700/30"
          />
        </div>

        {/* Two Clean Import Actions */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
          <button
            type="button"
            onClick={() => {
              onClose();
              onPickFiles(cleanFolder);
            }}
            className="px-4 py-3 rounded-xl accent-btn text-xs font-medium flex items-center justify-center gap-2 transition-colors"
          >
            <FileUp className="w-4 h-4" aria-hidden="true" />
            Select Files (.pdf, .epub, .djvu)
          </button>
          <button
            type="button"
            onClick={() => {
              onClose();
              onPickFolder();
            }}
            className="px-4 py-3 rounded-xl border app-border hover:bg-black/5 dark:hover:bg-white/10 text-xs font-medium flex items-center justify-center gap-2 transition-colors"
          >
            <FolderOpen className="w-4 h-4" aria-hidden="true" />
            Import Folder (Keep Tree)
          </button>
        </div>
      </div>
    </div>
  );
};
