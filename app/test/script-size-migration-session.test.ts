import { readFileSync } from "node:fs";
import { prepareLocalProject } from "../src/project/localProject.ts";
import { readSoundDocumentEnvelope } from "../../src/sound/document.ts";
import { ProjectHistory } from "../../src/authoring/projectHistory.ts";
import { captureProjectJournal, decodeJournalValue } from "../src/project/projectJournalCapture.ts";
import {
  claimProjectSaveJournal,
  projectSaveJournalKey,
  readProjectSaveRecoveries,
  writeProjectSaveJournal,
} from "../src/project/projectSaveJournal.ts";
import { sha256Hex } from "../../src/crypto.ts";
import { projectDocumentId } from "../../src/authoring/projectContent.ts";
import { inspectEditableProject } from "../src/project/projectWorkspaceSource.ts";
import { buildView, parseView, type BuildViewInput } from "../../src/view/view.ts";
import { decodeSave } from "../../src/runtime/persistence.ts";
import { customizedLegacyBoot, releasedTemplates } from "../../test/released-template-fixtures.ts";
import { Engine, HostWait } from "../../src/runtime/engine.ts";
import {
  effectiveProjectCompatibility,
  isLegacyAuthoredProject,
} from "../../src/authoring/projectConventions.ts";
import { buildProjectZip, buildPublicGameZip } from "../src/archive/projectArchive.ts";
import { readGameFiles, readGameZip } from "../src/archive/gameZip.ts";
import { previewGame } from "../src/library/gamePreview.ts";
import { installPreviewWorkerFixture } from "./previewWorkerFixture.ts";
import { unstampedArchive } from "./unstampedArchive.ts";
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
  serializeWriteAction,
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

const records = installIndexedDbFixture();
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
    setItem(key: string, value: string) {
      values.set(key, value);
      Object.defineProperty(this, key, { configurable: true, enumerable: true, value });
    },
    removeItem(key: string) {
      values.delete(key);
      Reflect.deleteProperty(this, key);
    },
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
    view?: Uint8Array;
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
  const native = openContainer(compiled.files());
  if (extra.view !== undefined) native.putResource("view", 1, extra.view);
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
      files: { ...Object.fromEntries(native.files), ...extra.files },
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
    opened?: NonNullable<Awaited<ReturnType<typeof loadAuthoredGameWithHistoryLifetime>>>;
    open?: typeof openOwnedProjectSession;
    write?: Parameters<typeof openOwnedProjectSession>[0]["write"];
    admit?: Parameters<typeof openOwnedProjectSession>[0]["admission"]["admit"];
    workingDocumentId?: string;
  } = {},
) {
  const opened = options.opened ?? (await loadAuthoredGameWithHistoryLifetime(projectId))!;
  return (options.open ?? openOwnedProjectSession)(
    {
      data: opened.data,
      lifetime: opened.lifetime!,
      publish: () => {},
      ...(options.workingDocumentId ? { workingDocumentId: options.workingDocumentId } : {}),
      ...(options.write ? { write: options.write } : {}),
      admission: {
        runToken: `script-size-${++run}`,
        admit:
          options.admit ??
          (async (compiled): Promise<PreviewUpdateOutcome> => {
            const logic0 = openContainer(compiled.files()).getResource("logic", 0)!;
            admitted.push(
              decodeLogicInsns(logic0)
                .filter((insn) => insn.kind === "action" && insn.name === "script.size")
                .map((insn) => insn.args![0]!),
            );
            return { status: "committed", expected: null, current: null, patchGeneration: 1 };
          }),
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

test("customized f199 keeps busy rooms playable through session admission and both export/reimports", async (t) => {
  installPreviewWorkerFixture(t);
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
    const opening = await previewGame(opened, opened.profile);
    assert.equal(opening.status, "ready");
    const imported = await addLibraryGame(opened, "Custom game", "zip", opening);
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
      {
        legacyRoomMemory: effectiveProjectCompatibility(kept).legacyRoomMemory,
        adoptDeclaredScriptSize: true,
      },
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

for (const kind of ["public", "private"] as const)
  for (const stamp of ["released", "version-0"] as const)
    test(`${kind} ${stamp} f199 archive passes the mandatory busy-opening preview without rewriting LOGIC 0`, async (t) => {
      installPreviewWorkerFixture(t);
      const id = await storedProject(`preview-${kind}-${stamp}`, {
        logic0: customizedLegacyBoot,
        documents: {
          words: JSON.stringify([
            ["known", 1],
            [`${kind}${stamp}`, 2],
          ]),
          "logic:1": `if (isset(f5)) { load.pic(1); draw.pic(1); load.view(1); ${"add.to.pic(1,0,0,0,0,9,0);".repeat(12)} show.pic(); } return;`,
          "picture:1": "vis 1\nfill 0,0\nend",
          "view:1": JSON.stringify({ loops: [{ cels: [{ width: 1, height: 1, pixels: [1] }] }] }),
        },
        data: {
          provider: "stub",
          model: "stub",
          transcript: [{ role: "user", content: "Private creator notes" }],
        },
      });
      const original = (await loadAuthoredGame(id))!;
      const logic0 = openContainer(new Map(Object.entries(original.files))).getResource("logic", 0);
      const zip =
        kind === "public" ? buildPublicGameZip(original) : await buildProjectZip(original);
      const opened = await readGameZip(stamp === "released" ? unstampedArchive(zip) : zip);
      assert.deepEqual(
        opened.authoringConventions,
        stamp === "released" ? undefined : { version: 0, legacyRoomMemory: true },
      );
      const opening = await previewGame(opened, opened.profile);
      assert.equal(opening.status, "ready");
      const imported = await addLibraryGame(opened, "Busy legacy game", "zip", opening);
      const stored = (await loadAuthoredGame(imported))!;
      assert.deepEqual(
        openContainer(new Map(Object.entries(stored.files))).getResource("logic", 0),
        logic0,
      );
      assert.deepEqual(stored.authoringConventions, { version: 0, legacyRoomMemory: true });
      // A raw reimport must reach dedup through the same busy-opening gate.
      const raw = readGameFiles(new Map(Object.entries(stored.files)));
      const rawOpening = await previewGame(raw, undefined, "folder");
      assert.equal(await addLibraryGame(raw, "Raw reimport", "folder", rawOpening), imported);
      assert.equal((await previewGame(original, undefined, "stored")).status, "ready");
      const copy = (await loadAuthoredGame(await copyLibraryGame(imported)))!;
      for (const exported of [buildPublicGameZip(copy), await buildProjectZip(copy)]) {
        const reopened = await readGameZip(exported);
        assert.deepEqual(reopened.authoringConventions, { version: 0, legacyRoomMemory: true });
        if (reopened.project)
          assert.deepEqual(reopened.project.authoringConventions, {
            version: 0,
            legacyRoomMemory: true,
          });
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
  return storedProject(name, {
    documents: { "view:1": JSON.stringify(oldView.input) },
    view: Uint8Array.from(oldView.bytes),
  });
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

for (const envelope of ["workspace", "legacy"] as const)
  for (const bootUpdate of [false, true])
    test(`a stale mirrored ${envelope} claim keeps native art and its diagnostic ${bootUpdate ? "through a boot update" : "on open"}`, async () => {
      const input: BuildViewInput = {
        loops: [oldView.input.loops[0]!, { mirrorLoop: 0 }],
      };
      const source = JSON.stringify(input);
      const id = await storedProject(`stale-mirror-${envelope}-${bootUpdate}`, {
        logic0: bootUpdate ? PRE_125_LOGIC0 : "accept.input(); return;",
        documents: { "view:1": source },
      });
      const before = (await loadAuthoredGame(id))!;
      const native = buildView({
        loops: [{ cels: [{ width: 3, height: 1, pixels: [4, 5, 0] }] }],
      });
      const container = openContainer(new Map(Object.entries(before.files)));
      container.putResource("view", 1, native);
      const { saveAuthoredGame } = await import("../src/project/gameStorage.ts");
      const data = { ...before, files: Object.fromEntries(container.files) };
      if (envelope === "legacy") {
        delete data.workspace;
        data.authoringState = {
          sources: {
            views: [[1, input]],
            logics: [[0, bootUpdate ? PRE_125_LOGIC0 : "accept.input(); return;"]],
          },
        };
      }
      await saveAuthoredGame(id, data);
      const session = await open(id, []);
      await settle(session);
      session.dispose();
      const updated = (await loadAuthoredGame(id))!;
      assert.deepEqual(
        [...parseView(Uint8Array.from(viewBytes(updated))).loops[0]!.cels[0]!.pixels],
        [4, 5, 0],
      );
      assert.deepEqual(viewBytes(updated), [...native]);
      const inspection = inspectEditableProject(updated);
      assert.equal(inspection.rejectedSources["view:1"], source);
      assert.ok(inspection.diagnostics.some(({ key }) => key === "view:1"));
      assert.deepEqual(inspection.viewRebuilds, {});
      assert.equal(updated.authoringConventions?.version, bootUpdate ? 1 : undefined);
      assert.equal(migrationCommits(updated), bootUpdate ? 1 : 0);
      const creator = await open(id, []);
      await creator.submit({
        proposal: creator.model.propose(creator.model.capture(), "Choose VIEW source", [
          { key: "view:1", content: source },
        ]),
        label: "Choose VIEW source",
        origin: "view",
        author: "creator",
      });
      await settle(creator);
      creator.dispose();
      const chosen = (await loadAuthoredGame(id))!;
      assert.deepEqual(viewBytes(chosen), [...buildView(input)]);
      assert.equal(inspectEditableProject(chosen).rejectedSources["view:1"], undefined);
      assert.equal(chosen.authoringState?.["pendingViewRebuilds"], undefined);
    });

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

test("a broken room draft accepts the VIEW and LOGIC update exactly once across two opens", async () => {
  const id = await storedCombined("combined-broken-draft");
  const { saveAuthoredGame } = await import("../src/project/gameStorage.ts");
  const before = (await loadAuthoredGame(id))!;
  await saveAuthoredGame(id, {
    ...before,
    workspace: writeProjectWorkspace({
      ...readProjectWorkspace(before.workspace!),
      "logic:1": "if (",
    }),
  });
  const admitted: Admitted = [];
  const session = await open(id, admitted);
  await settle(session);
  assert.ok(session.capture().diagnostics.length > 0);
  session.dispose();
  const updated = (await loadAuthoredGame(id))!;
  assert.equal(migrationCommits(updated), 1);
  assert.equal(updated.authoringConventions?.version, 1);
  assert.deepEqual(updated.files, before.files, "diagnostics keep the last playable image");
  assert.equal(readProjectWorkspace(updated.workspace!)["view:1"], JSON.stringify(oldView.input));
  assert.equal(readProjectWorkspace(updated.workspace!)["logic:1"], "if (");
  const reopened = await open(id, admitted);
  await settle(reopened);
  reopened.dispose();
  const after = (await loadAuthoredGame(id))!;
  assert.equal(migrationCommits(after), 1);
  assert.deepEqual(after.projectHistory, updated.projectHistory);
  assert.deepEqual(admitted, [], "the broken room stays a draft");
  const repair = await open(id, admitted);
  assert.equal(repair.model.capture().read("view:1")?.content, JSON.stringify(oldView.input));
  await repair.submit({
    proposal: repair.model.propose(repair.model.capture(), "Repair room", [
      { key: "logic:1", content: "accept.input(); return;" },
    ]),
    label: "Repair room",
    origin: "logic",
    author: "creator",
  });
  await settle(repair);
  repair.dispose();
  const repaired = (await loadAuthoredGame(id))!;
  // Two shared loops at 11; the third has its own reversed [0, 2, 1] cel at 20.
  assert.deepEqual(
    viewBytes(repaired),
    [
      0, 0, 3, 0, 0, 11, 0, 11, 0, 20, 0, 1, 3, 0, 3, 1, 128, 17, 33, 0, 1, 3, 0, 3, 1, 32, 1, 33,
      17, 0,
    ],
  );
  assert.equal(migrationCommits(repaired), 1);
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

test("an edited recognized original rebuilds its released mirrored VIEW with History and keeps its boot", async () => {
  const id = await storedCombined("original-mirror-update");
  const { saveAuthoredGame } = await import("../src/project/gameStorage.ts");
  const before = (await loadAuthoredGame(id))!;
  await saveAuthoredGame(id, {
    ...before,
    imported: true,
    files: { ...before.files, AGI: new TextEncoder().encode("Version 2.936\0") },
    library: normalizeLibraryMetadata(undefined, {
      source: "remix",
      revision: computeResourceRevision(before.files),
    }),
  });
  const session = await open(id, []);
  await settle(session);
  session.dispose();
  const updated = (await loadAuthoredGame(id))!;
  assert.equal(migrationCommits(updated), 1);
  assert.notDeepEqual(viewBytes(updated), oldView.bytes);
  assert.equal(storedLogic0(updated), PRE_125_LOGIC0);
  assert.equal(readProjectWorkspace(updated.workspace!)["view:1"], JSON.stringify(oldView.input));
  assert.equal(inspectEditableProject(updated).rejectedSources["view:1"], undefined);
});

test("refused update admission followed by an ordinary edit leaves both updates pending on reopen", async () => {
  const id = await storedCombined("refused-admission-edit");
  let attempts = 0;
  const session = await open(id, [], {
    admit: async () => ({
      status: ++attempts === 1 ? "refused" : "committed",
      expected: null,
      current: null,
      patchGeneration: 0,
    }),
  });
  await session.flush();
  assert.equal(attempts, 1);
  await session.submit({
    proposal: session.model.propose(session.model.capture(), "Room edit", [
      { key: "logic:1", content: 'print("Garden"); return;' },
    ]),
    label: "Room edit",
    origin: "logic",
    author: "creator",
  });
  await settle(session);
  session.dispose();
  const edited = (await loadAuthoredGame(id))!;
  assert.equal(edited.authoringConventions, undefined);
  assert.equal(migrationCommits(edited), 0);
  assert.deepEqual(viewBytes(edited), oldView.bytes);
  const reopened = await open(id, []);
  await settle(reopened);
  reopened.dispose();
  const updated = (await loadAuthoredGame(id))!;
  assert.equal(migrationCommits(updated), 1);
  assert.match(storedLogic0(updated), /script\.size\(200\);/);
  assert.notDeepEqual(viewBytes(updated), oldView.bytes);
  assert.equal(readProjectWorkspace(updated.workspace!)["logic:1"], 'print("Garden"); return;');
});

test("journal recovery keeps a 1.2.4 LOGIC update and deferred VIEW rebuild pending until reopen", async (t) => {
  for (const withViews of [false, true])
    await t.test(withViews ? "deferred VIEW and LOGIC" : "1.2.4 LOGIC journal", async () => {
      const id = withViews
        ? await storedCombined("older-journal-view-edit")
        : await storedProject("older-journal-logic-edit");
      const before = (await loadAuthoredGame(id))!;
      const inspection = inspectEditableProject(before);
      const documents = {
        ...inspection.documents,
        ...readProjectWorkspace(before.workspace!),
        ...(withViews ? { "view:1": Uint8Array.from(oldView.bytes) } : {}),
      };
      const session = await open(id, [], {
        workingDocumentId: projectDocumentId(documents, sha256Hex),
      });
      await session.replay({
        kind: "edit",
        changes: [{ key: "logic:1", content: 'print("Recovered"); return;', version: 2 }],
        metadata: { label: "Recovered room", origin: "logic", author: "creator", time: 1 },
      });
      runFrames();
      assert.ok(
        [...values.keys()].some((key) => key.startsWith(`monotio_agi.project-writes.${id}.`)),
      );
      session.dispose();
      // Loading drives journal decoding, exact-image rebuilding and the durable commit.
      const recovered = (await loadAuthoredGame(id))!;
      assert.equal(recovered.authoringConventions, undefined);
      assert.equal(migrationCommits(recovered), 0);
      const reopened = await open(id, []);
      await settle(reopened);
      reopened.dispose();
      const updated = (await loadAuthoredGame(id))!;
      assert.equal(migrationCommits(updated), 1);
      assert.match(storedLogic0(updated), /script\.size\(200\);/);
      if (withViews) assert.notDeepEqual(viewBytes(updated), oldView.bytes);
      assert.equal(
        readProjectWorkspace(updated.workspace!)["logic:1"],
        'print("Recovered"); return;',
      );
      assert.equal(updated.authoringState?.["pendingViewRebuilds"], undefined);
    });
});

test("a failed 1.2.4 JSON VIEW journal opens the last save, keeps edits and updates once", async () => {
  const id = await storedCombined("released-json-view-journal");
  const opened = (await loadAuthoredGameWithHistoryLifetime(id))!;
  const before = opened.data;
  const documents = {
    ...inspectEditableProject(before).documents,
    ...readProjectWorkspace(before.workspace!),
  };
  const content = 'print("Recovered from 1.2.4"); return;';
  const edited = { ...documents, "logic:1": content };
  // Use released VIEW bytes to model the old compiler's output, while its
  // accepted documents and journal image identities retain the active JSON.
  const compile = (source: typeof documents) =>
    compileProjectDocuments({
      files: before.files,
      documents: { ...source, "view:1": Uint8Array.from(oldView.bytes) },
      profileId: "2.936",
    });
  const base = compile(documents);
  const image = compile(edited);
  const metadata = {
    label: "Recovered room",
    origin: "logic",
    author: "creator",
    time: 2,
  } as const;
  const history = new ProjectHistory(sha256Hex);
  history.record(documents, { ...metadata, label: "Opened", time: 1 });
  history.record(edited, metadata);
  const expected = {
    projectId: id,
    lifetime: opened.lifetime!,
    generation: before.generation ?? 0,
    revision: computeResourceRevision(before.files),
    authoring: authoringFingerprint(before.authoringState, before.workspace),
    buildId: base.build.identity.buildId,
  };
  const capture = captureProjectJournal({
    base: before,
    expected,
    openedAt: 1,
    baseImage: projectDocumentId(documents, sha256Hex),
    image: projectDocumentId(edited, sha256Hex),
    operations: [{ kind: "edit", changes: [{ key: "logic:1", content, version: 2 }], metadata }],
    request: {
      projectId: id,
      workspaceId: "released-session",
      commitId: "released-edit",
      expected,
      buildId: image.build.identity.buildId,
      documents: Object.keys(edited).map((key) => ({ key, version: key === "logic:1" ? 2 : 1 })),
      data: {
        ...before,
        files: Object.fromEntries(image.files()),
        workspace: writeProjectWorkspace(edited),
        projectHistory: history.capturePortable(),
      },
    },
  });
  const key = projectSaveJournalKey(id, "released-owner");
  writeProjectSaveJournal(localStorage, key, [{ capture, attempted: false }]);
  const raw = localStorage.getItem(key);
  const recovered = (await loadAuthoredGame(id))!;
  assert.deepEqual(recovered.files, before.files);
  assert.equal(readProjectWorkspace(recovered.workspace!)["logic:1"], documents["logic:1"]);
  assert.equal(localStorage.getItem(key), raw, "the failed journal stays intact");
  assert.equal(readProjectSaveRecoveries(localStorage, id)[0]?.raw, raw);
  const reopened = await open(id, []);
  await settle(reopened);
  reopened.dispose();
  const updated = (await loadAuthoredGame(id))!;
  assert.equal(readProjectWorkspace(updated.workspace!)["logic:1"], documents["logic:1"]);
  assert.equal(migrationCommits(updated), 1);
  assert.notDeepEqual(viewBytes(updated), oldView.bytes);
  const again = await open(id, []);
  await settle(again);
  again.dispose();
  assert.equal(migrationCommits((await loadAuthoredGame(id))!), 1);
  assert.equal(localStorage.getItem(key), raw);
});

test("temporary recovery failure keeps the pending update's base until reload recovers once", async () => {
  const id = await storedCombined("temporary-journal-update");
  const opened = (await loadAuthoredGameWithHistoryLifetime(id))!;
  const before = opened.data;
  const compiled = compileProjectDocuments({
    files: before.files,
    documents: inspectEditableProject(before).documents,
    profileId: "2.936",
  });
  const key = projectSaveJournalKey(id, "interrupted");
  writeProjectSaveJournal(localStorage, key, [
    {
      attempted: false,
      request: {
        projectId: id,
        workspaceId: "interrupted",
        commitId: "pending-recovery",
        expected: {
          projectId: id,
          lifetime: opened.lifetime!,
          generation: before.generation!,
          revision: computeResourceRevision(before.files),
          authoring: authoringFingerprint(before.authoringState, before.workspace),
          buildId: compiled.build.identity.buildId,
        },
        buildId: compiled.build.identity.buildId,
        documents: [],
        data: { ...before, title: "Recovered work" },
      },
    },
  ]);
  const raw = localStorage.getItem(key);
  const set = records.set;
  let failures = 0;
  records.set = function (key, value) {
    if (key === `commit/${id}/pending-recovery`) {
      failures++;
      throw new DOMException("Temporary storage failure", "AbortError");
    }
    return set.call(this, key, value);
  };
  try {
    const ordinary = await open(id, []);
    await settle(ordinary);
    ordinary.dispose();
    assert.ok(failures > 0, "ordinary open attempted recovery");
    const unchanged = (await loadAuthoredGame(id))!;
    assert.equal(
      unchanged.generation,
      before.generation,
      "automatic writes preserve the recovery base",
    );
    assert.equal(migrationCommits(unchanged), 0);
    assert.equal(localStorage.getItem(key), raw);
    assert.deepEqual(readProjectSaveRecoveries(localStorage, id), []);
  } finally {
    records.set = set;
  }
  const reload = await open(id, []);
  await settle(reload);
  reload.dispose();
  const recovered = (await loadAuthoredGame(id))!;
  assert.equal(recovered.title, "Recovered work");
  assertCombined(recovered);
  assert.equal(localStorage.getItem(key), null);
});

for (const pause of [
  "admission",
  "automatic flush",
  "storage queue",
  "closing before acknowledgment a-first",
  "closing before acknowledgment z-last",
] as const)
  test(`a journal published during ${pause} preserves recovery and updates once on reopen`, async () => {
    const closes = pause.startsWith("closing");
    const queues = pause === "storage queue" || closes;
    const id = await storedCombined(`late-journal-${pause.replaceAll(" ", "-")}`);
    if (pause === "automatic flush") {
      const { saveAuthoredGame } = await import("../src/project/gameStorage.ts");
      const data = (await loadAuthoredGame(id))!;
      const starter = prepareLocalProject({ title: "Sound claim", kind: "starter" }).data();
      const original = readSoundDocumentEnvelope(
        JSON.parse(String(readProjectWorkspace(starter.workspace!)["sound:1"])),
      );
      const edited = original.updateEvent(original.tracks()![0]![0]!.id, { note: "C5" });
      const documents = {
        ...readProjectWorkspace(data.workspace!),
        "sound:1": JSON.stringify(edited.serialize()),
      };
      const compiled = compileProjectDocuments({
        files: data.files,
        documents: { ...documents, "view:1": Uint8Array.from(oldView.bytes) },
        profileId: "2.936",
      });
      await saveAuthoredGame(id, {
        ...data,
        files: Object.fromEntries(compiled.files()),
        workspace: writeProjectWorkspace(documents),
        authoringState: { sources: { sounds: [[1, original.serialize()]] } },
      });
    }
    const opened = (await loadAuthoredGameWithHistoryLifetime(id))!;
    const before = opened.data;
    if (queues) assert.equal(before.generation, 1);
    const compiled = compileProjectDocuments({
      files: before.files,
      documents: inspectEditableProject(before).documents,
      profileId: "2.936",
    });
    const key = projectSaveJournalKey(id, pause.endsWith("z-last") ? "z-other-tab" : "other-tab");
    const writer = claimProjectSaveJournal(key);
    assert.equal(await writer.ready, true);
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const queued = queues
      ? serializeWriteAction(id, async () => {
          entered.resolve();
          await held.promise;
        })
      : undefined;
    if (queued !== undefined) await entered.promise;
    const committing = Promise.withResolvers<void>();
    const decided = Promise.withResolvers<void>();
    const acknowledgment = Promise.withResolvers<void>();
    const session = await open(id, [], {
      ...(queues
        ? {
            opened,
            open: (input, backing) =>
              openOwnedProjectSession(input, {
                ...backing,
                commit: (async (...args: Parameters<typeof commitProject>) => {
                  committing.resolve();
                  const result = await commitProject(...args);
                  if (closes) {
                    decided.resolve();
                    await acknowledgment.promise;
                  }
                  return result;
                }) as typeof commitProject,
              }),
          }
        : {}),
      ...(pause === "automatic flush"
        ? {
            workingDocumentId: projectDocumentId(
              inspectEditableProject(before).documents,
              sha256Hex,
            ),
          }
        : {}),
      admit: async () => {
        entered.resolve();
        if (!queues) await resume.promise;
        return { status: "committed", expected: null, current: null, patchGeneration: 0 };
      },
    });
    if (pause === "automatic flush")
      session.subscribe(() => {
        if (session.saveStatus().state === "pending") runFrames();
        if (session.saveStatus().state === "saving") entered.resolve();
      });
    const flushing = session.flush();
    try {
      await (queues ? committing.promise : entered.promise);
      writeProjectSaveJournal(localStorage, key, [
        {
          attempted: false,
          request: {
            projectId: id,
            workspaceId: "other-tab",
            commitId: "interrupted-late-edit",
            expected: {
              projectId: id,
              lifetime: opened.lifetime!,
              generation: before.generation!,
              revision: computeResourceRevision(before.files),
              authoring: authoringFingerprint(before.authoringState, before.workspace),
              buildId: compiled.build.identity.buildId,
            },
            buildId: compiled.build.identity.buildId,
            documents: [],
            data: { ...before, title: "Recovered late work" },
          },
        },
      ]);
      const raw = localStorage.getItem(key);
      writer.release(); // The other page closes before its durable write.
      resume.resolve();
      held.resolve();
      await queued;
      if (closes) {
        await decided.promise;
        session.dispose();
        acknowledgment.resolve();
      }
      if (closes) await assert.rejects(flushing, /Project save is pending/);
      else {
        await flushing;
        assert.equal(session.saveStatus().state, "saved", "deferral needs no new notice");
      }
      session.dispose();
      // Inspect committed storage directly: loading would already attempt recovery.
      const unchanged = records.get(id) as CachedGameData;
      assert.equal(
        unchanged.generation,
        before.generation,
        "no automatic write overtakes recovery",
      );
      assert.deepEqual(unchanged.files, before.files);
      assert.equal(migrationCommits(unchanged), 0);
      assert.equal(unchanged.authoringConventions, undefined);
      assert.equal(localStorage.getItem(key), raw);
      assert.deepEqual(readProjectSaveRecoveries(localStorage, id), []);
      const pending = [...values.keys()].filter((entry) =>
        entry.startsWith(`monotio_agi.project-writes.${id}.`),
      );
      if (closes) {
        assert.equal(pending.length, 2, "closing precedes automatic journal acknowledgment");
        const automatic = pending.find((entry) => entry !== key)!;
        const entries = decodeJournalValue(
          JSON.parse(localStorage.getItem(automatic)!).entries,
        ) as {
          automatic?: boolean;
        }[];
        assert.equal(entries[0]!.automatic, true);
      } else assert.deepEqual(pending, [key]);
      const reopened = await open(id, []);
      await settle(reopened);
      reopened.dispose();
      const recovered = (await loadAuthoredGame(id))!;
      assert.equal(recovered.title, "Recovered late work");
      assertCombined(recovered);
      assert.equal(localStorage.getItem(key), null);
      assert.deepEqual(readProjectSaveRecoveries(localStorage, id), []);
      assert.ok(pending.every((entry) => localStorage.getItem(entry) === null));
      const again = await open(id, []);
      await settle(again);
      again.dispose();
      assert.equal(migrationCommits((await loadAuthoredGame(id))!), 1);
    } finally {
      writer.release();
      resume.resolve();
      held.resolve();
      acknowledgment.resolve();
      await queued;
      session.dispose();
      await flushing.catch(() => {});
    }
  });

test("copy and archives keep a recognized remix's VIEW update pending without legacy room memory", async () => {
  const id = await storedCombined("recognized-copy-mirror");
  const { saveAuthoredGame } = await import("../src/project/gameStorage.ts");
  const before = (await loadAuthoredGame(id))!;
  await saveAuthoredGame(id, {
    ...before,
    imported: true,
    files: { ...before.files, AGI: new TextEncoder().encode("Version 2.936\0") },
    library: normalizeLibraryMetadata(undefined, {
      source: "remix",
      revision: computeResourceRevision(before.files),
    }),
  });
  const original = (await loadAuthoredGame(id))!;
  const copied = await copyLibraryGame(id);
  const copiedData = (await loadAuthoredGame(copied))!;
  assert.deepEqual(copiedData.authoringConventions, { version: 0 });
  const projectZip = await readGameZip(await buildProjectZip(original));
  const publicZip = await readGameZip(await buildPublicGameZip(original));
  assert.deepEqual(projectZip.project?.authoringConventions, { version: 0 });
  assert.deepEqual(publicZip.authoringConventions, { version: 0 });
  const imported = await addLibraryGame(projectZip, "Recognized copy", "zip", {
    preview: "data:image/png;base64,iVBORw0KGgo=",
    status: "ready",
    message: "Ready",
    profile: "2.936",
  });
  for (const candidate of [copied, imported]) {
    assert.equal(isLegacyAuthoredProject((await loadAuthoredGame(candidate))!), false);
    const session = await open(candidate, []);
    await settle(session);
    session.dispose();
    const updated = (await loadAuthoredGame(candidate))!;
    assert.equal(migrationCommits(updated), 1);
    assert.notDeepEqual(viewBytes(updated), oldView.bytes);
    assert.equal(storedLogic0(updated), PRE_125_LOGIC0);
    assert.deepEqual(updated.authoringConventions, { version: 1 });
    const reopen = await open(candidate, []);
    await settle(reopen);
    reopen.dispose();
    assert.equal(migrationCommits((await loadAuthoredGame(candidate))!), 1);
  }
});
