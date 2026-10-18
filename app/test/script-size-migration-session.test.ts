/**
 * The one-time script.size migration an older authored game receives when it
 * opens (CHANGELOG 1.2.5, "Room memory raised for this version"), driven
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
import { BASE_TEMPLATE_LOGIC0_SOURCE } from "../../src/authoring/baseTemplate.ts";
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
  SCRIPT_SIZE_MIGRATION_LABEL,
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

const PRE_125_LOGIC0 = BASE_TEMPLATE_LOGIC0_SOURCE.replace("  script.size(200);\n", "");
const storage = { commit: commitProject, fingerprint: authoringFingerprint };

/** A project stored by 1.2.4: template logic 0 without script.size. */
async function storedProject(
  name: string,
  extra: {
    files?: Record<string, Uint8Array>;
    data?: Partial<CachedGameData>;
    source?: LibraryMetadata["source"];
  } = {},
) {
  const documents = { "logic:0": PRE_125_LOGIC0, "logic:1": "return;" };
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
    (commit) => commit.label === SCRIPT_SIZE_MIGRATION_LABEL,
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
  assert.equal(stored.projectHistory!.commits.at(-1)!.label, SCRIPT_SIZE_MIGRATION_LABEL);
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

test("a re-imported project archive or remix with the template boot shape migrates", async () => {
  for (const source of ["zip", "remix"] as const) {
    const projectId = await storedProject(`script-size-${source}`, {
      source,
      data: { imported: true },
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
