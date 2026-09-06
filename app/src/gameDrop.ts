export type GameDrop = { kind: "zip"; file: File } | { kind: "folder"; files: Map<string, File> };

const MAX_FOLDER_FILES = 1024;
const MAX_FOLDER_DIRECTORIES = 1024;
const MAX_FOLDER_BYTES = 256 * 1024 * 1024;
const MAX_FOLDER_FILE_BYTES = 64 * 1024 * 1024;

const PICK_ONE_ERROR = "Drop one game folder or one ZIP at a time.";
const FOLDER_FALLBACK_ERROR =
  "This browser cannot read that dropped folder. Use Open game → Game folder instead.";

function validSegment(name: string): boolean {
  return (
    name.length > 0 &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes(":") &&
    !name.includes("\0")
  );
}

function fileFromEntry(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    try {
      entry.file(resolve, () => reject(new Error(FOLDER_FALLBACK_ERROR)));
    } catch {
      reject(new Error(FOLDER_FALLBACK_ERROR));
    }
  });
}

function readEntryBatch(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    try {
      reader.readEntries(resolve, () => reject(new Error(FOLDER_FALLBACK_ERROR)));
    } catch {
      reject(new Error(FOLDER_FALLBACK_ERROR));
    }
  });
}

async function readFolder(root: FileSystemDirectoryEntry): Promise<Map<string, File>> {
  if (!validSegment(root.name)) throw new Error("The dropped folder contains an invalid path.");
  const files = new Map<string, File>();
  let fileCount = 0;
  let directoryCount = 1;
  let totalBytes = 0;

  const visitDirectory = async (
    directory: FileSystemDirectoryEntry,
    path: string,
  ): Promise<void> => {
    const reader = directory.createReader();
    for (;;) {
      const batch = await readEntryBatch(reader);
      if (batch.length === 0) return;
      for (const entry of batch) {
        if (!validSegment(entry.name))
          throw new Error("The dropped folder contains an invalid path.");
        const entryPath = `${path}/${entry.name}`;
        if (entry.isDirectory) {
          directoryCount++;
          if (directoryCount > MAX_FOLDER_DIRECTORIES)
            throw new Error("Choose a game folder with at most 1024 directories.");
          await visitDirectory(entry as FileSystemDirectoryEntry, entryPath);
          continue;
        }
        if (!entry.isFile) throw new Error(FOLDER_FALLBACK_ERROR);
        fileCount++;
        if (fileCount > MAX_FOLDER_FILES)
          throw new Error("Choose one game folder with at most 1024 files.");
        const file = await fileFromEntry(entry as FileSystemFileEntry);
        if (!Number.isSafeInteger(file.size) || file.size < 0)
          throw new Error("The dropped folder contains a file with an invalid size.");
        if (file.size > MAX_FOLDER_FILE_BYTES)
          throw new Error("A game folder file is larger than the 64 MB per-file limit.");
        totalBytes += file.size;
        if (totalBytes > MAX_FOLDER_BYTES)
          throw new Error("Choose a game folder smaller than 256 MB.");
        if (files.has(entryPath)) throw new Error(`Duplicate dropped file path: ${entryPath}.`);
        files.set(entryPath, file);
      }
    }
  };

  await visitDirectory(root, root.name);
  if (files.size === 0) throw new Error("The dropped game folder is empty.");
  return files;
}

function isZip(file: File): boolean {
  return /\.zip$/i.test(file.name);
}

async function resolveCapturedEntries(
  entries: FileSystemEntry[],
  fallbackFiles: File[],
): Promise<GameDrop> {
  if (entries.length > 1 || (entries.length > 0 && fallbackFiles.length > 0))
    throw new Error(PICK_ONE_ERROR);
  const entry = entries[0];
  if (entry?.isDirectory)
    return { kind: "folder", files: await readFolder(entry as FileSystemDirectoryEntry) };
  if (entry?.isFile) {
    const file = await fileFromEntry(entry as FileSystemFileEntry);
    if (isZip(file)) return { kind: "zip", file };
    throw new Error(FOLDER_FALLBACK_ERROR);
  }
  if (fallbackFiles.length > 1)
    throw new Error(fallbackFiles.every(isZip) ? PICK_ONE_ERROR : FOLDER_FALLBACK_ERROR);
  const file = fallbackFiles[0];
  if (file && isZip(file)) return { kind: "zip", file };
  if (file) throw new Error(FOLDER_FALLBACK_ERROR);
  throw new Error("Drop a game folder or ZIP to open it.");
}

/** Capture browser-owned drop handles before the drop event becomes invalid. */
export function captureGameDrop(dataTransfer: DataTransfer): Promise<GameDrop> {
  const entries: FileSystemEntry[] = [];
  const fallbackFiles: File[] = [];
  for (let index = 0; index < dataTransfer.items.length; index++) {
    const item = dataTransfer.items[index];
    if (!item || item.kind !== "file") continue;
    const getEntry = item.webkitGetAsEntry;
    const entry = typeof getEntry === "function" ? getEntry.call(item) : null;
    if (entry) entries.push(entry);
    else {
      const file = item.getAsFile();
      if (file) fallbackFiles.push(file);
    }
  }
  if (entries.length === 0 && fallbackFiles.length === 0) {
    for (let index = 0; index < dataTransfer.files.length; index++) {
      const file = dataTransfer.files[index];
      if (file) fallbackFiles.push(file);
    }
  }
  return resolveCapturedEntries(entries, fallbackFiles);
}
