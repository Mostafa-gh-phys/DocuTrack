import {detectSupportedBookFormat} from './libraryLogic';

interface FileSystemEntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (success: (f: File) => void, error?: (err: unknown) => void) => void;
  createReader?: () => {
    readEntries: (success: (entries: FileSystemEntryLike[]) => void, error?: (err: unknown) => void) => void;
  };
}

function attachRelativePath(file: File, relPath: string): File {
  try {
    Object.defineProperty(file, 'webkitRelativePath', {
      value: relPath,
      configurable: true,
    });
  } catch {
    // Fallback when property is non-configurable
  }
  return file;
}

async function readEntryFiles(entry: FileSystemEntryLike, prefix = ''): Promise<File[]> {
  if (entry.isFile && entry.file) {
    return await new Promise<File[]>((resolve) => {
      entry.file!(
        (f) => {
          if (!detectSupportedBookFormat(f.name)) {
            resolve([]);
            return;
          }
          const relPath = prefix ? `${prefix}/${f.name}` : f.name;
          resolve([attachRelativePath(f, relPath)]);
        },
        () => resolve([]),
      );
    });
  }

  if (entry.isDirectory && entry.createReader) {
    const reader = entry.createReader();
    const allEntries: FileSystemEntryLike[] = [];
    // FileSystemDirectoryReader may return batches of 100 entries until empty
    while (true) {
      const batch = await new Promise<FileSystemEntryLike[]>((resolve) => {
        reader.readEntries(
          (items) => resolve(items),
          () => resolve([]),
        );
      });
      if (batch.length === 0) break;
      allEntries.push(...batch);
    }
    const nextPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
    const nested = await Promise.all(allEntries.map((child) => readEntryFiles(child, nextPrefix)));
    return nested.flat();
  }

  return [];
}

/**
 * Extracts supported documents (PDF, EPUB, DjVu) from a Drag & Drop DataTransfer,
 * recursively walking dropped directories while preserving webkitRelativePath.
 */
export async function extractFilesFromDataTransfer(dataTransfer: DataTransfer): Promise<File[]> {
  const items = Array.from(dataTransfer.items || []);
  const entries = items
    .map((item) => item.webkitGetAsEntry?.() as unknown as FileSystemEntryLike | null | undefined)
    .filter((e): e is FileSystemEntryLike => Boolean(e));

  if (entries.length > 0) {
    const walked = await Promise.all(entries.map((entry) => readEntryFiles(entry)));
    return walked.flat();
  }

  return Array.from(dataTransfer.files || []).filter((f) => detectSupportedBookFormat(f.name) !== null);
}
