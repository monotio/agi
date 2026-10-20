import { readFileSync } from "node:fs";
import type { BuildViewInput } from "../../src/view/view.ts";
import { decodeSave } from "../../src/runtime/persistence.ts";
import { customizedLegacyBoot, releasedTemplates } from "../../test/released-template-fixtures.ts";
import { Engine, HostWait } from "../../src/runtime/engine.ts";
import { isLegacyAuthoredProject } from "../../src/authoring/projectConventions.ts";
import { buildProjectZip, buildPublicGameZip } from "../src/archive/projectArchive.ts";
import { readGameZip } from "../src/archive/gameZip.ts";
import { addLibraryGame, copyLibraryGame } from "../src/library/gameLibrary.ts";
/**
 * The one-time script.size migration an older authored game receives when it
 * opens (CHANGELOG 1.2.5, "Updated for 1.2.5"), driven
 * through the real project session and browser storage: the running game
 * takes the new LOGIC 0 through ordinary admission, and the save, second-tab
 * and close-before-commit failure paths leave exactly one migration commit.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { compileProjectDocuments } from "../../src/authoring/projectDocuments.ts";
import {
  writeProjectWorkspace,
  readProjectWorkspace,
} from "../../src/authoring/projectWorkspace.ts";
import { createContainer, openContainer } from "../../src/container/container.ts";
import { decodeLogicInsns } from "../../src/logic/disassembler.ts";
import {
  authoringFingerprint,
  commitProject,
  loadAuthoredGame,
  loadAuthoredGameWithHistoryLifetime,
} from "../src/project/gameStorage.ts";
import type { CachedGameData } from "../src/project/gameTypes.ts";
import { normalizeLibraryMetadata, type LibraryMetadata } from "../src/project/gameMetadata.ts";
import { computeResourceRevision } from "../../src/authoring/resourceRevision.ts";
import {
  openOwnedProjectSession,
  PROJECT_UPDATE_LABEL,
} from "../src/project/projectSessionCore.ts";
import type { PreviewUpdateOutcome } from "../src/worker/workerProtocol.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { installWebLocksFixture } from "./webLocksFixture.ts";
import { testProjectId } from "./identity.ts";

installIndexedDbFixture();
installWebLocksFixture();
const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  },
});
const frames = new Map<number, FrameRequestCallback>();
let frame = 0;
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: (callback: FrameRequestCallback) => {
    frames.set(++frame, callback);
    return frame;
  },
});
Object.defineProperty(globalThis, "cancelAnimationFrame", {
  configurable: true,
  value: (id: number) => frames.delete(id),
});
function runFrames() {
  for (const callback of [...frames.values()]) callback(0);
  frames.clear();
}

const PRE_125_LOGIC0 = releasedTemplates.at(-1)!.source;
const storage = { commit: commitProject, fingerprint: authoringFingerprint };

/** A project stored by 1.2.4: template logic 0 without script.size. */
async function storedProject(
  name: string,
  extra: {
    files?: Record<string, Uint8Array>;
    logic0?: string;
    documents?: Record<string, string>;
    data?: Partial<CachedGameData>;
    source?: LibraryMetadata["source"];
  } = {},
) {
  const documents = {
    "logic:0": extra.logic0 ?? PRE_125_LOGIC0,
    "logic:1": "accept.input(); return;",
    words: JSON.stringify([["known", 1]]),
    inventory: "[]",
    ...extra.documents,
  };
  const compiled = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents,
    profileId: "2.936",
  });
  const projectId = testProjectId(name);
  await commitProject({
    projectId,
    workspaceId: "initial",
    commitId: "initial",
    expected: null,
    buildId: compiled.build.identity.buildId,
    documents: [],
    data: {
      title: "Older game",
      files: { ...Object.fromEntries(compiled.files()), ...extra.files },
      words: [],
      workspace: writeProjectWorkspace(documents),
      ...(extra.source
        ? {
            library: normalizeLibraryMetadata(undefined, {
              revision: computeResourceRevision(Object.fromEntries(compiled.files())),
              source: extra.source,
            }),
          }
        : {}),
      ...extra.data,
    },
  });
  return projectId;
}

/** Every LOGIC 0 image the running game admitted, as script.size operands. */
type Admitted = number[][];
let run = 0;
async function open(
  projectId: ReturnType<typeof testProjectId>,
  admitted: Admitted,
  options: {
    open?: typeof openOwnedProjectSession;
    write?: Parameters<typeof openOwnedProjectSession>[0]["write"];
  } = {},
) {
  const opened = (await loadAuthoredGameWithHistoryLifetime(projectId))!;
  return (options.open ?? openOwnedProjectSession)(
    {
      data: opened.data,
      lifetime: opened.lifetime!,
      publish: () => {},
      ...(options.write ? { write: options.write } : {}),
      admission: {
        runToken: `script-size-${++run}`,
        admit: async (compiled): Promise<PreviewUpdateOutcome> => {
          const logic0 = openContainer(compiled.files()).getResource("logic", 0)!;
          admitted.push(
            decodeLogicInsns(logic0)
              .filter((insn) => insn.kind === "action" && insn.name === "script.size")
              .map((insn) => insn.args![0]!),
          );
          return { status: "committed", expected: null, current: null, patchGeneration: 1 };
        },
      },
    },
    storage,
  );
}
/** Wait for the session's queued work (the migration) to settle. */
async function settle(session: Awaited<ReturnType<typeof open>>) {
  for (let i = 0; i < 20 && session.saveStatus().state !== "saved"; i++) {
    await session.flush().catch(() => {});
    runFrames();
  }
}
function migrationCommits(data: CachedGameData) {
  return (data.projectHistory?.commits ?? []).filter(
    (commit) => commit.label === PROJECT_UPDATE_LABEL,
  ).length;
}
function storedLogic0(data: CachedGameData) {
  return readProjectWorkspace(data.workspace!)["logic:0"] as string;
}

test("an older authored game's running session takes script.size(200) once, as one History entry", async () => {
  const projectId = await storedProject("script-size-open");
  const admitted: Admitted = [];
  const session = await open(projectId, admitted);
  await settle(session);
  session.dispose();
  assert.deepEqual(admitted, [[200]], "the running game admitted the migrated LOGIC 0 at once");
  const stored = (await loadAuthoredGame(projectId))!;
  assert.match(storedLogic0(stored), /set\(f200\);\n {2}script\.size\(200\);/);
  assert.equal(migrationCommits(stored), 1);
  assert.equal(stored.projectHistory!.commits.at(-1)!.label, PROJECT_UPDATE_LABEL);
  const again: Admitted = [];
  const reopened = await open(projectId, again);
  await settle(reopened);
  reopened.dispose();
  assert.deepEqual(again, [], "a migrated game opens without another update");
  assert.equal(migrationCommits((await loadAuthoredGame(projectId))!), 1);
});

test("a refused migration write leaves the stored game as it was and the next open migrates", async () => {
  const projectId = await storedProject("script-size-refused");
  const before = (await loadAuthoredGame(projectId))!;
  const session = await open(projectId, [], {
    write: async () => {
      throw new Error("Storage is full");
    },
  });
  await session.flush().catch(() => {});
  await assert.rejects(session.flush(), /Could not save/);
  session.dispose();
  const after = (await loadAuthoredGame(projectId))!;
  assert.equal(after.generation, before.generation, "the stored generation did not move");
  assert.equal(storedLogic0(after), PRE_125_LOGIC0, "the stored LOGIC 0 is unchanged");
  assert.equal(migrationCommits(after), 0);
  assert.equal(after.authoringConventions, undefined, "a refused write cannot stamp the old body");
  const admitted: Admitted = [];
  const retry = await open(projectId, admitted);
  await settle(retry);
  retry.dispose();
  assert.deepEqual(admitted, [[200]]);
  const stored = (await loadAuthoredGame(projectId))!;
  assert.equal(migrationCommits(stored), 1);
  assert.match(storedLogic0(stored), /script\.size\(200\);/);
});

test("two tabs opening the same older game store exactly one migration", async () => {
  const projectId = await storedProject("script-size-tabs");
  // A second page loads its own copy of the session module.
  const secondTab = "../src/project/projectSessionCore.ts?second-tab";
  const { openOwnedProjectSession: openInSecondTab } = (await import(secondTab)) as {
    openOwnedProjectSession: typeof openOwnedProjectSession;
  };
  // Both pages read the unmigrated body before either writes.
  const firstAdmitted: Admitted = [];
  const secondAdmitted: Admitted = [];
  const [first, second] = await Promise.all([
    open(projectId, firstAdmitted),
    open(projectId, secondAdmitted, { open: openInSecondTab }),
  ]);
  await Promise.all([settle(first), settle(second)]);
  assert.deepEqual(firstAdmitted, [[200]], "the first page's game took the migration");
  assert.deepEqual(secondAdmitted, [[200]], "the second page's game took it too");
  first.dispose();
  second.dispose();
  runFrames();
  const stored = (await loadAuthoredGame(projectId))!;
  assert.equal(migrationCommits(stored), 1);
  assert.equal((storedLogic0(stored).match(/script\.size\(200\);/g) ?? []).length, 1);
});

test("closing before the migration write commits, then reopening, migrates once", async () => {
  const projectId = await storedProject("script-size-close");
  let started!: () => void;
  const writing = new Promise<void>((resolve) => {
    started = resolve;
  });
  // The page closes while its write is still in flight: the write never lands.
  const session = await open(projectId, [], {
    write: () => {
      started();
      return new Promise(() => {});
    },
  });
  await writing;
  assert.notEqual(session.saveStatus().state, "saved", "the write had not committed");
  session.dispose();
  assert.equal(migrationCommits((await loadAuthoredGame(projectId))!), 0);
  assert.equal(
    (await loadAuthoredGame(projectId))!.authoringConventions,
    undefined,
    "closing before commit leaves provenance unchanged",
  );
  const admitted: Admitted = [];
  const reopened = await open(projectId, admitted);
  await settle(reopened);
  reopened.dispose();
  assert.deepEqual(admitted, [[200]]);
  assert.equal(migrationCommits((await loadAuthoredGame(projectId))!), 1);
});

test("closing with the migration journaled recovers it once on reopen", async () => {
  const projectId = await storedProject("script-size-journal");
  const admitted: Admitted = [];
  const session = await open(projectId, admitted);
  // The session holds the admitted migration once its model takes it.
  const migrated = () =>
    /script\.size\(200\);/.test(String(session.model.capture().read("logic:0")!.content));
  await new Promise<void>((resolve) => {
    if (migrated()) resolve();
    session.subscribe(() => {
      if (migrated()) resolve();
    });
  });
  assert.deepEqual(admitted, [[200]]);
  runFrames();
  session.dispose();
  const recovered = (await loadAuthoredGame(projectId))!;
  assert.equal(migrationCommits(recovered), 1);
  const again: Admitted = [];
  const reopened = await open(projectId, again);
  await settle(reopened);
  reopened.dispose();
  assert.deepEqual(again, []);
  assert.equal(migrationCommits((await loadAuthoredGame(projectId))!), 1);
});

test("Undo of the migration never adds a second entry on reopen", async () => {
  const projectId = await storedProject("script-size-undo");
  const admitted: Admitted = [];
  const first = await open(projectId, admitted);
  await settle(first);
  assert.deepEqual(admitted, [[200]], "the older game migrated on open");
  // The first Undo after opening removes the added line again; the
  // migration commit itself stays in the project's History.
  await first.undo();
  await settle(first);
  first.dispose();
  const undone = (await loadAuthoredGame(projectId))!;
  assert.equal(storedLogic0(undone), PRE_125_LOGIC0, "Undo removed the added line");
  assert.equal(migrationCommits(undone), 1, "the migration commit stays in History");
  const again: Admitted = [];
  const reopened = await open(projectId, again);
  await settle(reopened);
  reopened.dispose();
  assert.deepEqual(again, [], "the reopened session adds nothing");
  const stored = (await loadAuthoredGame(projectId))!;
  assert.equal(migrationCommits(stored), 1, "still one migration entry");
  assert.equal(storedLogic0(stored), PRE_125_LOGIC0);
});

test("deleting the migrated line never adds a second entry on reopen", async () => {
  const projectId = await storedProject("script-size-delete");
  const admitted: Admitted = [];
  const first = await open(projectId, admitted);
  await settle(first);
  assert.deepEqual(admitted, [[200]], "the older game migrated on open");
  // The author deletes the added line: an ordinary edit whose commit the
  // History records beside the migration's own.
  await first.submit({
    proposal: first.model.propose(first.model.capture(), "Edit", [
      { key: "logic:0", content: PRE_125_LOGIC0 },
    ]),
    label: "Edit",
    origin: "logic",
    author: "creator",
  });
  await settle(first);
  first.dispose();
  const deleted = (await loadAuthoredGame(projectId))!;
  assert.equal(storedLogic0(deleted), PRE_125_LOGIC0, "the line is gone again");
  assert.equal(migrationCommits(deleted), 1, "the migration commit stays in History");
  const again: Admitted = [];
  const reopened = await open(projectId, again);
  await settle(reopened);
  reopened.dispose();
  assert.deepEqual(again, [], "the reopened session adds nothing");
  const stored = (await loadAuthoredGame(projectId))!;
  assert.equal(migrationCommits(stored), 1, "still one migration entry");
  assert.equal(storedLogic0(stored), PRE_125_LOGIC0);
});

test("a re-imported project archive or remix with the template boot shape migrates", async () => {
  for (const source of ["zip", "remix"] as const) {
    const projectId = await storedProject(`script-size-${source}`, {
      source,
      data: { imported: true, authoringConventions: { version: 0, legacyRoomMemory: true } },
    });
    const before = (await loadAuthoredGame(projectId))!;
    assert.equal(before.library?.source, source);
    assert.equal(before.imported, true);
    const admitted: Admitted = [];
    const session = await open(projectId, admitted);
    await settle(session);
    session.dispose();
    assert.deepEqual(admitted, [[200]], `a ${source} project migrates`);
    assert.equal(migrationCommits((await loadAuthoredGame(projectId))!), 1);
  }
});

test("an imported original release is never migrated, even with the template boot shape", async () => {
  // An interpreter binary shipped beside the data identifies an original
  // release (src/runtime/profile.ts detectVersionString).
  const projectId = await storedProject("script-size-original", {
    files: { AGI: new TextEncoder().encode("Version 2.936\0") },
    data: { imported: true },
  });
  const before = (await loadAuthoredGame(projectId))!;
  const admitted: Admitted = [];
  const session = await open(projectId, admitted);
  await settle(session);
  session.dispose();
  assert.deepEqual(admitted, []);
  const after = (await loadAuthoredGame(projectId))!;
  assert.equal(after.generation, before.generation);
  assert.equal(storedLogic0(after), PRE_125_LOGIC0);
});

function feedback(files: CachedGameData["files"]): void {
  for (const position of [1, 2, 4, 7, 10]) {
    const lines: string[] = [];
    const engine = new Engine(
      openContainer(new Map(Object.entries(files))),
      {
        print() {},
        displayAt() {},
        statusLine() {},
        waitKey() {
          throw new HostWait();
        },
        takeKeys: () => [],
        takeInputLine: () => lines.shift() ?? null,
      },
      new Map([["known", 1]]),
      { legacyRoomMemory: true },
    );
    for (let n = 0; n < 4; n++) engine.tick();
    const words = Array.from({ length: position }, () => "known");
    words[position - 1] = "flibberty";
    lines.push(words.join(" "));
    for (let n = 0; n < 3; n++) engine.tick();
    const screen = Array.from({ length: 25 }, (_, row) => engine.textRow(row)).join("\n");
    assert.ok(screen.includes('"flibberty"'), `unknown word at position ${position}: ${screen}`);
  }
}
test("ordinary session fixes the released fallback, including several word positions and both export reimports", async () => {
  const id = await storedProject("word-feedback");
  const session = await open(id, []);
  await settle(session);
  session.dispose();
  const data = (await loadAuthoredGame(id))!;
  assert.equal(migrationCommits(data), 1);
  assert.deepEqual(data.authoringConventions, { version: 1, legacyRoomMemory: true });
  feedback(data.files);
  for (const bytes of [buildPublicGameZip(data), await buildProjectZip(data)]) {
    const opened = await readGameZip(bytes);
    feedback(opened.files);
    const imported = await addLibraryGame(opened, "Reimported", "zip", {
      preview: "data:image/png;base64,iVBORw0KGgo=",
      status: "ready",
      message: "Ready",
      profile: "2.936",
    });
    const stored = (await loadAuthoredGame(imported))!;
    assert.equal(isLegacyAuthoredProject(stored), true);
    feedback(stored.files);
  }
});
test("custom source has no write on open; the next commit and every copy/export carry the pending conventions until a session commit", async () => {
  const source = "set(f199); return;";
  const id = await storedProject("no-write-on-open", { logic0: source });
  const before = (await loadAuthoredGame(id))!;
  let writes = 0;
  const session = await open(id, [], {
    write: async (...args) => {
      writes++;
      return (await commitProject(...args)).receipt;
    },
  });
  await session.ready;
  assert.equal(writes, 0);
  assert.equal((await loadAuthoredGame(id))!.generation, before.generation);
  const copy = await copyLibraryGame(id);
  assert.deepEqual((await loadAuthoredGame(copy))!.authoringConventions, {
    version: 0,
    legacyRoomMemory: true,
  });
  const exported = await readGameZip(buildPublicGameZip(before));
  assert.deepEqual(exported.authoringConventions, { version: 0, legacyRoomMemory: true });
  await session.submit({
    proposal: session.model.propose(session.model.capture(), "Edit", [
      { key: "logic:0", content: source + "\n// Change" },
    ]),
    label: "Edit",
    origin: "logic",
    author: "creator",
  });
  await settle(session);
  session.dispose();
  assert.deepEqual((await loadAuthoredGame(id))!.authoringConventions, {
    version: 1,
    legacyRoomMemory: true,
  });
});
test("a pruned or cleared History never reapplies an undone upgrade", async () => {
  const id = await storedProject("upgrade-pruned");
  const session = await open(id, []);
  await settle(session);
  await session.undo();
  await settle(session);
  session.dispose();
  const data = (await loadAuthoredGame(id))!;
  assert.deepEqual(data.authoringConventions, { version: 1, legacyRoomMemory: true });
  // A copy can omit its edit History; provenance still owns the once-only rule.
  const { projectId: _project, authoredAt: _authored, generation: _generation, ...rest } = data;
  const pruned = await storedProject("upgrade-pruned-copy", {
    data: { ...rest, projectHistory: undefined },
  });
  const admitted: Admitted = [];
  const reopened = await open(pruned, admitted);
  await settle(reopened);
  reopened.dispose();
  assert.deepEqual(admitted, []);
  assert.equal(storedLogic0((await loadAuthoredGame(pruned))!), PRE_125_LOGIC0);
});

test("customized f199 keeps busy rooms playable through session admission and both export/reimports", async () => {
  const source = customizedLegacyBoot;
  const id = await storedProject("f199-round-trip", {
    logic0: source,
    documents: {
      "logic:1": `if (isset(f5)) { load.pic(1); draw.pic(1); load.view(1); ${"add.to.pic(1,0,0,0,0,9,0);".repeat(12)} } return;`,
      "logic:5": "script.size(120); return;",
      "picture:1": "vis 1\nfill 0,0\nend",
      "view:1": JSON.stringify({ loops: [{ cels: [{ width: 1, height: 1, pixels: [1] }] }] }),
    },
  });
  const admitted: Admitted = [];
  const session = await open(id, admitted);
  await settle(session);
  session.dispose();
  const data = (await loadAuthoredGame(id))!;
  assert.deepEqual(admitted, [[]], "only the released fallback changes; f199 boot is preserved");
  assert.ok(storedLogic0(data).includes("set(f199);"));
  for (const bytes of [buildPublicGameZip(data), await buildProjectZip(data)]) {
    const opened = await readGameZip(bytes);
    const imported = await addLibraryGame(opened, "Custom game", "zip", {
      preview: "data:image/png;base64,iVBORw0KGgo=",
      status: "ready",
      message: "Ready",
      profile: "2.936",
    });
    const kept = (await loadAuthoredGame(imported))!;
    const engine = new Engine(
      openContainer(new Map(Object.entries(kept.files))),
      {
        print() {},
        displayAt() {},
        statusLine() {},
        takeInputLine: () => null,
        takeKeys: () => [],
      },
      new Map(),
      { legacyRoomMemory: isLegacyAuthoredProject(kept), adoptDeclaredScriptSize: true },
    );
    assert.doesNotThrow(() => {
      for (let n = 0; n < 4; n++) engine.tick();
    });
    assert.equal(engine.surface.visual[100], 1);
    const edited = compileProjectDocuments({
      files: kept.files,
      documents: {
        ...readProjectWorkspace(data.workspace!),
        "logic:0": storedLogic0(data) + "\nassignn(v42,1);",
      },
      profileId: "2.936",
    });
    const outcome = engine.commitPreviewUpdate(
      engine.preparePreviewUpdate({ files: edited.files() }),
    );
    assert.equal(outcome.status, "committed", JSON.stringify(outcome));
    assert.doesNotThrow(() => engine.tick());
  }
});

for (const [name, prefix] of [
  ["Astra commented guard", "// Historical boot: if (!isset(f200)) {\nset(f200);"],
  ["Astra earlier unrelated setter", "set(f200);\n" + PRE_125_LOGIC0],
  ["setter outside guard", "if (!isset(f200)) { assignn(v42,1); } set(f200);"],
] as const)
  test(`${name} survives ordinary session open, four ticks and save/restore`, async () => {
    const source = `assignn(v0,1);\n${prefix}\nif (!isset(f220)) { set(f220); assignn(v43,1); load.pic(v43); draw.pic(v43); }`;
    const id = await storedProject(`session-${name.replaceAll(" ", "-")}`, {
      logic0: source,
      documents: { "picture:1": "vis 1\nfill 0,0\nend" },
    });
    const session = await open(id, []);
    await settle(session);
    session.dispose();
    const data = (await loadAuthoredGame(id))!;
    assert.ok(!storedLogic0(data).includes("script.size(200)"));
    const host = {
      print() {},
      displayAt() {},
      statusLine() {},
      takeInputLine: () => null,
      takeKeys: () => [],
    };
    const engine = new Engine(openContainer(new Map(Object.entries(data.files))), host, new Map(), {
      legacyRoomMemory: true,
    });
    for (let n = 0; n < 4; n++) {
      engine.tick();
      const saved = decodeSave(engine.serialize(), engine.profile);
      assert.equal(saved.replayActive, 2);
      // Native replay kinds 2 and 4 load and draw PICTURE 1.
      assert.deepEqual(saved.replay.slice(0, saved.replayActive), [
        { kind: 2, value: 1 },
        { kind: 4, value: 1 },
      ]);
    }
    const restored = new Engine(
      openContainer(new Map(Object.entries(data.files))),
      host,
      new Map(),
      { legacyRoomMemory: true },
    );
    restored.restoreImage(engine.serialize());
    assert.equal(restored.surface.visual[0], 1);
  });

test("copy and Project reimport of an untouched released template still receive the update", async () => {
  const id = await storedProject("untouched-template");
  const ids = [await copyLibraryGame(id)];
  const copy = (await loadAuthoredGame(ids[0]!))!;
  for (const bytes of [await buildProjectZip(copy)]) {
    ids.push(
      await addLibraryGame(await readGameZip(bytes), "Untouched copy", "zip", {
        preview: "data:image/png;base64,iVBORw0KGgo=",
        status: "ready",
        message: "Ready",
        profile: "2.936",
      }),
    );
  }
  for (const copied of ids) {
    assert.deepEqual((await loadAuthoredGame(copied))!.authoringConventions, {
      version: 0,
      legacyRoomMemory: true,
    });
    const session = await open(copied, []);
    await settle(session);
    session.dispose();
    const after = (await loadAuthoredGame(copied))!;
    assert.equal(migrationCommits(after), 1);
    feedback(after.files);
  }
});

const oldView = (
  JSON.parse(
    readFileSync(new URL("./fixtures/view-builder-1.2.4.json", import.meta.url), "utf8"),
  ) as {
    cases: { profileId: string; input: BuildViewInput; bytes: number[] }[];
  }
).cases.find((c) => c.profileId === "2.936")!;
async function storedCombined(name: string) {
  const id = await storedProject(name, { documents: { "view:1": JSON.stringify(oldView.input) } });
  const before = (await loadAuthoredGame(id))!;
  const container = openContainer(new Map(Object.entries(before.files)));
  container.putResource("view", 1, Uint8Array.from(oldView.bytes));
  const { saveAuthoredGame } = await import("../src/project/gameStorage.ts");
  await saveAuthoredGame(id, { ...before, files: Object.fromEntries(container.files) });
  return id;
}
function viewBytes(data: CachedGameData) {
  return [...openContainer(new Map(Object.entries(data.files))).getResource("view", 1)!];
}
function assertCombined(data: CachedGameData) {
  assert.equal(migrationCommits(data), 1);
  assert.deepEqual(
    data.projectHistory!.commits.map((c) => c.label),
    ["Opened", "Updated for 1.2.5"],
  );
  assert.match(storedLogic0(data), /script\.size\(200\);/);
  assert.notDeepEqual(viewBytes(data), oldView.bytes);
  assert.deepEqual(data.authoringConventions, { version: 1, legacyRoomMemory: true });
}

test("one update on open rebuilds VIEWs and LOGIC together; Undo restores exact old native bytes", async () => {
  const id = await storedCombined("combined-update");
  const before = (await loadAuthoredGame(id))!;
  const session = await open(id, []);
  await settle(session);
  assertCombined((await loadAuthoredGame(id))!);
  await session.undo();
  await settle(session);
  session.dispose();
  const undone = (await loadAuthoredGame(id))!;
  assert.deepEqual(undone.files, before.files);
  const reopened = await open(id, []);
  await settle(reopened);
  reopened.dispose();
  assert.deepEqual((await loadAuthoredGame(id))!.files, before.files);
});

test("a refused VIEW and LOGIC update writes neither resource nor stamp and retries both on reopen", async () => {
  const id = await storedCombined("combined-refused");
  const before = (await loadAuthoredGame(id))!;
  const session = await open(id, [], {
    write: async () => {
      throw new Error("Storage is full");
    },
  });
  await session.flush().catch(() => {});
  await assert.rejects(session.flush(), /Could not save/);
  session.dispose();
  const refused = (await loadAuthoredGame(id))!;
  assert.deepEqual(refused.files, before.files);
  assert.equal(refused.authoringConventions, undefined);
  assert.equal(migrationCommits(refused), 0);
  const retry = await open(id, []);
  await settle(retry);
  retry.dispose();
  assertCombined((await loadAuthoredGame(id))!);
});

test("two tabs store one combined VIEW and LOGIC update", async () => {
  const id = await storedCombined("combined-tabs");
  const modulePath = "../src/project/projectSessionCore.ts?combined-second-tab";
  const { openOwnedProjectSession: secondOpen } = (await import(modulePath)) as {
    openOwnedProjectSession: typeof openOwnedProjectSession;
  };
  const [first, second] = await Promise.all([open(id, []), open(id, [], { open: secondOpen })]);
  await Promise.all([settle(first), settle(second)]);
  first.dispose();
  second.dispose();
  runFrames();
  assertCombined((await loadAuthoredGame(id))!);
});

test("closing before the combined VIEW and LOGIC write commits leaves old bytes and retries both", async () => {
  const id = await storedCombined("combined-close");
  const before = (await loadAuthoredGame(id))!;
  let started!: () => void;
  const writing = new Promise<void>((resolve) => {
    started = resolve;
  });
  const session = await open(id, [], {
    write: () => {
      started();
      return new Promise(() => {});
    },
  });
  await writing;
  assert.notEqual(session.saveStatus().state, "saved");
  session.dispose();
  const closed = (await loadAuthoredGame(id))!;
  assert.deepEqual(closed.files, before.files);
  assert.equal(closed.authoringConventions, undefined);
  const reopened = await open(id, []);
  await settle(reopened);
  reopened.dispose();
  assertCombined((await loadAuthoredGame(id))!);
});
