import assert from "node:assert/strict";
import { test } from "node:test";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildWordsTok } from "../../src/logic/words.ts";
import { readGameFiles, readGameZip } from "../src/gameZip.ts";
import { gameRevision, normalizeLibraryMetadata, readPublicMetadata } from "../src/gameMetadata.ts";
import { addLibraryGame, copyLibraryGame } from "../src/gameLibrary.ts";
import { loadAuthoredCartridge, updateAuthoredCartridgeFiles } from "../src/cartridgeStorage.ts";
import { inspectGame } from "../src/gameInspection.ts";
import { buildPublicGameZip } from "../src/projectArchive.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";

installIndexedDbFixture();

function game(
  source = 'display(5, 2, "Hello apprentice"); accept.input(); return;',
): Record<string, Uint8Array> {
  const c = createContainer();
  c.putResource("logic", 0, assembleLogic(source, { dictionary: new Map() }).payload);
  return { ...Object.fromEntries(c.files), "WORDS.TOK": buildWordsTok([]) };
}

function installLocalStorage(t: { after(callback: () => void): void }): void {
  const values = new Map<string, string>();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem(key: string): string | null {
        return values.get(key) ?? null;
      },
      setItem(key: string, value: string): void {
        values.set(key, value);
        Object.defineProperty(this, key, {
          configurable: true,
          enumerable: true,
          writable: true,
          value,
        });
      },
      removeItem(key: string): void {
        values.delete(key);
        Reflect.deleteProperty(this, key);
      },
    },
  });
}

const opening = {
  preview: "data:image/png;base64,iVBORw0KGgo=",
  status: "ready" as const,
  message: "Opening checked.",
  profile: "2.936",
};

test("folder and ZIP resource identity is independent of path, case and entry order", async () => {
  const files = game();
  const folder = readGameFiles(
    new Map(Object.entries(files).map(([n, b]) => [`My Game/${n.toLowerCase()}`, b])),
  );
  assert.deepEqual(folder.files, files);
  assert.equal(
    await gameRevision(folder.files),
    await gameRevision(Object.fromEntries(Object.entries(files).reverse())),
  );
  assert.equal(
    await gameRevision(folder.files),
    await gameRevision(
      Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name.toLowerCase(), bytes])),
    ),
  );
  const changed = game('display(5, 2, "Different game"); return;');
  assert.notEqual(await gameRevision(changed), await gameRevision(files));
  assert.throws(
    () => readGameFiles(new Map([...Object.entries(files), ["other/LOGDIR", files["LOGDIR"]!]])),
    /one AGI game/,
  );
  assert.throws(
    () => readGameFiles(new Map([...Object.entries(files), ["logdir", files["LOGDIR"]!]])),
    /Duplicate/,
  );
});

test("opening inspection captures real text and rejects missing boot resources and runaway logic", () => {
  const opened = readGameFiles(new Map(Object.entries(game())));
  const result = inspectGame(opened);
  assert.equal(result.status, "ready");
  assert.ok(result.rows.join(" ").includes("Hello apprentice"));
  assert.equal(result.rgba.length, 320 * 200 * 4);
  assert.throws(
    () => inspectGame(readGameFiles(new Map(Object.entries(game("call(99); return;"))))),
    /logic.*99/i,
  );
  assert.throws(
    () => inspectGame(readGameFiles(new Map(Object.entries(game("loop: goto loop;"))))),
    /budget/i,
  );
});

test("public metadata is versioned, bounded and cannot carry private history or local validation", () => {
  assert.deepEqual(readPublicMetadata({ format: "monotio.agi", version: 1, title: "Game" }), {
    title: "Game",
    roomGeneration: false,
    metadata: {},
  });
  assert.throws(
    () => readPublicMetadata({ format: "monotio.agi", version: 99, title: "Future" }),
    /version/i,
  );
  for (const blank of ["", "   ", "\n\t"]) {
    assert.equal(
      readPublicMetadata({ format: "monotio.agi", version: 1, title: blank }).title,
      undefined,
      `A blank title ${JSON.stringify(blank)} falls back to the importer's name.`,
    );
  }
  assert.equal(
    readPublicMetadata({ format: "monotio.agi", version: 1, title: "  Padded  " }).title,
    "Padded",
  );
  assert.equal(
    readPublicMetadata({ format: "monotio.agi", version: 1, title: "x".repeat(200) }).title,
    "x".repeat(160),
  );
  const metadata = readPublicMetadata({
    format: "monotio.agi",
    version: 1,
    title: "Game",
    metadata: {
      description: "A room",
      author: "Author",
      license: "MIT",
      transcript: ["private"],
      preview: "https://tracker.example/image",
      validation: { status: "ready" },
    },
  });
  assert.deepEqual(metadata.metadata, { description: "A room", author: "Author", license: "MIT" });
  assert.equal(
    normalizeLibraryMetadata(
      { version: 1, source: "toString" },
      { gameId: "safe", revision: "1".repeat(64), source: "zip" },
    ).source,
    "zip",
  );
});

test("malformed public metadata reports a useful import error", () => {
  assert.throws(
    () =>
      readGameFiles(
        new Map([...Object.entries(game()), ["GAME.JSON", new TextEncoder().encode("{")]]),
      ),
    /GAME\.JSON contains invalid JSON\. Obtain a fresh copy of the game or correct its metadata\./,
  );
});

test("ZIP and folder imports deduplicate the same resources and normalize room generation", async (t) => {
  installLocalStorage(t);
  const files = game();
  const zipGame = await readGameZip(buildPublicGameZip({ title: "ZIP title", files }));
  const folderGame = readGameFiles(
    new Map(
      Object.entries(zipGame.files).map(([name, bytes]) => [`Folder/${name.toLowerCase()}`, bytes]),
    ),
  );
  const zipSlug = await addLibraryGame(zipGame, "ZIP title", "zip", opening);
  const folderSlug = await addLibraryGame(folderGame, "Folder title", "folder", opening);
  assert.equal(folderSlug, zipSlug);
  assert.equal(
    await addLibraryGame({ files: zipGame.files, words: zipGame.words }, "No flag", "zip", opening),
    zipSlug,
  );
  assert.equal((await loadAuthoredCartridge(zipSlug))?.title, "ZIP title");
});

test("project imports with identical resources retain separate private histories", async (t) => {
  installLocalStorage(t);
  const files = game();
  const first = await addLibraryGame(
    {
      files,
      words: [],
      project: { provider: "stub", model: "one", transcript: [{ role: "user", content: "one" }] },
    },
    "First project",
    "zip",
    opening,
  );
  const second = await addLibraryGame(
    {
      files,
      words: [],
      project: { provider: "stub", model: "two", transcript: [{ role: "user", content: "two" }] },
    },
    "Second project",
    "zip",
    opening,
  );
  assert.notEqual(second, first);
  assert.equal((await loadAuthoredCartridge(first))?.model, "one");
  assert.equal((await loadAuthoredCartridge(second))?.model, "two");
});

test("a remix copy gets independent identity and bytes while preserving its original", async (t) => {
  installLocalStorage(t);
  const originalSlug = await addLibraryGame({ files: game(), words: [] }, "Garden", "zip", opening);
  const before = (await loadAuthoredCartridge(originalSlug))!;
  const copySlug = await copyLibraryGame(originalSlug);
  const copy = (await loadAuthoredCartridge(copySlug))!;
  assert.notEqual(copy.library?.gameId, before.library?.gameId);
  assert.deepEqual(copy.library?.parent, {
    gameId: before.library?.gameId,
    revision: before.library?.revision,
  });
  assert.equal(
    await updateAuthoredCartridgeFiles(copySlug, {
      ...copy.files,
      "VOL.0": Uint8Array.of(...copy.files["VOL.0"]!, 1),
    }),
    true,
  );
  assert.deepEqual((await loadAuthoredCartridge(originalSlug))!, before);
});

test("catalog resources cannot be overwritten in place", async (t) => {
  installLocalStorage(t);
  const errors: string[] = [];
  const originalError = console.error;
  t.after(() => {
    console.error = originalError;
  });
  console.error = (...values: unknown[]) => errors.push(values.map(String).join(" "));
  const slug = await addLibraryGame(
    { files: game(), words: [] },
    "Catalog game",
    "catalog",
    opening,
    { id: "garden", version: "1" },
  );
  const before = (await loadAuthoredCartridge(slug))!;
  assert.equal(
    await updateAuthoredCartridgeFiles(slug, {
      ...before.files,
      "VOL.0": Uint8Array.of(...before.files["VOL.0"]!, 1),
    }),
    false,
  );
  assert.deepEqual(await loadAuthoredCartridge(slug), before);
  assert.match(errors.join("\n"), /Catalog resources are immutable/);
});

test("catalog identity remains stable across separately stored releases", async (t) => {
  installLocalStorage(t);
  const first = await addLibraryGame(
    { files: game(), words: [] },
    "Catalog game",
    "catalog",
    opening,
    { id: "garden", version: "1" },
  );
  const second = await addLibraryGame(
    { files: game('display(5, 2, "New release"); return;'), words: [] },
    "Catalog game",
    "catalog",
    opening,
    { id: "garden", version: "2" },
  );
  assert.notEqual(second, first);
  assert.equal(
    (await loadAuthoredCartridge(second))?.library?.gameId,
    (await loadAuthoredCartridge(first))?.library?.gameId,
  );
  assert.equal((await loadAuthoredCartridge(first))?.library?.catalog?.version, "1");
  assert.equal((await loadAuthoredCartridge(second))?.library?.catalog?.version, "2");
});

test("trusted catalog projects deduplicate while imported project archives remain separate", async (t) => {
  installLocalStorage(t);
  const catalogGame = {
    files: game(),
    words: [] as [string, number][],
    project: {
      provider: "stub",
      model: "tutorial",
      transcript: [] as unknown[],
      authoringState: { sources: { logics: [[0, 'display(5, 2, "Hello apprentice"); return;']] } },
    },
  };
  const first = await addLibraryGame(catalogGame, "Tutorial", "catalog", opening, {
    id: "tutorial",
    version: "1",
  });
  const repeated = await addLibraryGame(catalogGame, "Tutorial", "catalog", opening, {
    id: "tutorial",
    version: "1",
  });
  assert.equal(repeated, first);
});
