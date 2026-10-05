import { captureDropHandles, type CapturedDrop } from "./gameDropCapture.ts";
import { isDiskImageName } from "../../../src/container/disk/image.ts";

export type { CapturedDrop } from "./gameDropCapture.ts";

export type GameDrop = { kind: "zip"; file: File } | { kind: "folder"; files: Map<string, File> };

const MAX_FOLDER_FILES = 1024;
const MAX_FOLDER_DIRECTORIES = 1024;
const MAX_FOLDER_BYTES = 256 * 1024 * 1024;
const MAX_FOLDER_FILE_BYTES = 64 * 1024 * 1024;

const PICK_ONE_ERROR = "Drop one game folder or one ZIP at a time.";
const FOLDER_FALLBACK_ERROR =
  "This browser cannot read that dropped folder. Use Add game → Game folder instead.";

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

/** Resolve drop handles captured while the event was live: traverse folders, apply the budgets. */
export async function resolveGameDrop(captured: CapturedDrop): Promise<GameDrop> {
  const { entries, fallbackFiles } = captured;
  const directory = entries.find((entry) => entry.isDirectory);
  if (directory) {
    if (entries.length !== 1 || fallbackFiles.length) throw new Error(PICK_ONE_ERROR);
    return { kind: "folder", files: await readFolder(directory as FileSystemDirectoryEntry) };
  }
  const files = [...fallbackFiles];
  for (const entry of entries) {
    if (!entry.isFile) throw new Error(FOLDER_FALLBACK_ERROR);
    files.push(await fileFromEntry(entry as FileSystemFileEntry));
  }
  if (files.length === 1 && isZip(files[0]!)) return { kind: "zip", file: files[0]! };
  if (files.length && files.every((file) => isDiskImageName(file.name))) {
    const selected = new Map<string, File>();
    for (const file of files) {
      if (selected.has(file.name))
        throw new Error(
          `Two disks are named ${file.name}. Give each disk a different name and add them together.`,
        );
      selected.set(file.name, file);
    }
    return { kind: "folder", files: selected };
  }
  if (files.length > 1 && files.some(isZip)) throw new Error(PICK_ONE_ERROR);
  if (files.length) throw new Error(FOLDER_FALLBACK_ERROR);
  throw new Error("Drop a game folder, a ZIP, or its disk images to open it.");
}

/**
 * The one-call form for callers that already have this module loaded:
 * captures the handles synchronously, then resolves them asynchronously.
 */
export function captureGameDrop(dataTransfer: DataTransfer): Promise<GameDrop> {
  return resolveGameDrop(captureDropHandles(dataTransfer));
}
