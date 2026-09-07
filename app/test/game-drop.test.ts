import assert from "node:assert/strict";
import { test } from "node:test";
import { captureGameDrop } from "../src/gameDrop.ts";

interface EntryLike {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly name: string;
  file?(success: (file: File) => void, failure?: (error: DOMException) => void): void;
  createReader?(): {
    readEntries(
      success: (entries: EntryLike[]) => void,
      failure?: (error: DOMException) => void,
    ): void;
  };
}

function fileEntry(name: string, contents: string): EntryLike {
  const file = new File([contents], name);
  return {
    isFile: true,
    isDirectory: false,
    name,
    file(success): void {
      queueMicrotask(() => success(file));
    },
  };
}

function directoryEntry(name: string, batches: EntryLike[][]): EntryLike {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader() {
      let index = 0;
      return {
        readEntries(success): void {
          const batch = batches[index++] ?? [];
          queueMicrotask(() => success(batch));
        },
      };
    },
  };
}

function transfer(
  entries: (EntryLike | null)[],
  options: { fallbackItems?: File[]; files?: File[] } = {},
): DataTransfer {
  const items = entries.map((entry, index) => ({
    kind: "file",
    type: options.fallbackItems?.[index]?.type ?? "",
    webkitGetAsEntry: entry === null ? undefined : () => entry,
    getAsFile: () => options.fallbackItems?.[index] ?? null,
  }));
  return {
    items: Object.assign(items, { item: (index: number) => items[index] ?? null }),
    files: Object.assign(options.files ?? [], {
      item: (index: number) => options.files?.[index] ?? null,
    }),
  } as unknown as DataTransfer;
}

test("folder drops preserve nested paths and consume every directory-reader batch", async () => {
  const root = directoryEntry("Space Quest", [
    [
      fileEntry("LOGDIR", "logic"),
      directoryEntry("extras", [[fileEntry("NOTES.TXT", "notes")], []]),
    ],
    [fileEntry("WORDS.TOK", "words")],
    [],
  ]);

  const dropped = await captureGameDrop(transfer([root]));

  assert.equal(dropped.kind, "folder");
  if (dropped.kind !== "folder") return;
  assert.deepEqual(
    [...dropped.files.keys()],
    ["Space Quest/LOGDIR", "Space Quest/extras/NOTES.TXT", "Space Quest/WORDS.TOK"],
  );
  assert.equal(await dropped.files.get("Space Quest/extras/NOTES.TXT")?.text(), "notes");
});

test("drop entries are captured while the browser event is still alive", async () => {
  const root = directoryEntry("Game", [[fileEntry("LOGDIR", "logic")], []]);
  let eventAlive = true;
  const item = {
    kind: "file",
    type: "",
    webkitGetAsEntry(): EntryLike | null {
      return eventAlive ? root : null;
    },
    getAsFile(): File | null {
      return null;
    },
  };
  const items = Object.assign([item], { item: (index: number) => (index === 0 ? item : null) });
  const dataTransfer = {
    items,
    files: Object.assign([], { item: () => null }),
  } as unknown as DataTransfer;

  const pending = captureGameDrop(dataTransfer);
  eventAlive = false;

  const dropped = await pending;
  assert.equal(dropped.kind, "folder");
});

test("a single ZIP falls back through getAsFile and DataTransfer.files", async () => {
  const zip = new File(["zip"], "game.ZIP", { type: "application/zip" });
  assert.deepEqual(await captureGameDrop(transfer([null], { fallbackItems: [zip] })), {
    kind: "zip",
    file: zip,
  });
  assert.deepEqual(await captureGameDrop(transfer([], { files: [zip] })), {
    kind: "zip",
    file: zip,
  });
});

test("ambiguous roots and unsupported loose files report actionable errors", async () => {
  const first = directoryEntry("First", [[]]);
  const second = directoryEntry("Second", [[]]);
  const zip = new File(["zip"], "game.zip");
  const loose = new File(["data"], "LOGDIR");

  await assert.rejects(captureGameDrop(transfer([first, second])), /one game folder or one ZIP/i);
  await assert.rejects(
    captureGameDrop(transfer([first, null], { fallbackItems: [undefined as never, zip] })),
    /one game folder or one ZIP/i,
  );
  await assert.rejects(
    captureGameDrop(transfer([null], { fallbackItems: [loose] })),
    /Use Add game → Game folder/,
  );
  await assert.rejects(
    captureGameDrop(
      transfer([null, null], { fallbackItems: [loose, new File(["data"], "WORDS.TOK")] }),
    ),
    /Use Add game → Game folder/,
  );
});

test("folder traversal rejects files beyond the import bounds", async () => {
  const huge = {
    isFile: true,
    isDirectory: false,
    name: "VOL.0",
    file(success: (file: File) => void): void {
      queueMicrotask(() => success({ name: "VOL.0", size: 64 * 1024 * 1024 + 1 } as File));
    },
  } satisfies EntryLike;
  const root = directoryEntry("Game", [[huge], []]);

  await assert.rejects(captureGameDrop(transfer([root])), /64 MB per-file limit/);
});
