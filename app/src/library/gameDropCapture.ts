/**
 * The browser-owned handles a live drop event exposes. `items`,
 * `webkitGetAsEntry`, `getAsFile` and `files` go empty once the drop event
 * finishes dispatching, so this read must run synchronously inside the
 * event handler — before any await or lazy module load. Traversal and
 * validation of the captured handles stays in `gameDrop.ts`, which loads
 * on the action.
 */
export interface CapturedDrop {
  readonly entries: FileSystemEntry[];
  readonly fallbackFiles: File[];
}

/** Capture browser-owned drop handles before the drop event becomes invalid. */
export function captureDropHandles(dataTransfer: DataTransfer): CapturedDrop {
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
  return { entries, fallbackFiles };
}
