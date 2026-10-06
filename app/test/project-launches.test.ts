import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAuthoringState } from "../../src/authoring/authoringState.ts";
import {
  addLaunch,
  selectLaunch,
  updateLaunch,
  type Launch,
} from "../../src/authoring/launches.ts";
import { readProjectWorkspace } from "../../src/authoring/projectWorkspace.ts";
import type { ProjectId } from "../../src/gameIdentity.ts";
import { buildProjectZip, buildPublicGameZip } from "../src/archive/projectArchive.ts";
import { readGameZip } from "../src/archive/gameZip.ts";
import { openEditableProject } from "../src/project/editableProject.ts";
import * as storage from "../src/project/gameStorage.ts";
import type { CachedGameData } from "../src/project/gameTypes.ts";
import { prepareLocalProject } from "../src/project/localProject.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";

const records = installIndexedDbFixture();
const cache = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => cache.get(key) ?? null,
    setItem: (key: string, value: string) => {
      cache.set(key, value);
    },
    removeItem: (key: string) => cache.delete(key),
  },
});

async function storedBody(projectId: ProjectId) {
  const data = await storage.loadAuthoredGame(projectId);
  assert.ok(data);
  return data;
}

async function seedProject(name: string, adjust?: (data: CachedGameData) => void) {
  const prepared = prepareLocalProject({ title: name, kind: "boilerplate" });
  await prepared.save();
  if (adjust) {
    const data = await storage.loadAuthoredGame(prepared.projectId);
    assert.ok(data);
    adjust(data);
    assert.equal(await storage.saveAuthoredGame(prepared.projectId, data), true);
  }
  return prepared.projectId;
}

type EditableProject = Awaited<ReturnType<typeof openEditableProject>>;

function readWorld(ws: EditableProject): Record<string, unknown> {
  const document = ws.draft.capture().read("world");
  assert.ok(document && typeof document.content === "string");
  return JSON.parse(document.content) as Record<string, unknown>;
}

/** A launch edit as the workspace transaction path carries it: one world-document change. */
function applyWorld(ws: EditableProject, world: Record<string, unknown>) {
  const proposal = ws.draft.propose(ws.draft.capture(), "Edit launches", [
    { key: "world", content: JSON.stringify(world) },
  ]);
  return ws.draft.apply(proposal);
}

const VACUUM_DEATH: Omit<Launch, "id"> = {
  name: "Vacuum death",
  cameFrom: { room: 8, edge: 3 },
  flags: { "10": true },
  variables: { "3": 7 },
  items: { "0": 255 },
  hero: { x: 92, y: 148 },
  seed: 4242,
};

test("a Launch edit keeps, reopens, and undoes through the project transaction path", async () => {
  const projectId = await seedProject("ws-launches-undo");
  const ws = await openEditableProject(projectId);
  const base = ws.savedIdentity();

  const before = readWorld(ws);
  const edited = addLaunch(before as Parameters<typeof addLaunch>[0], 1, VACUUM_DEATH);
  const transaction = applyWorld(ws, edited as Record<string, unknown>);

  ws.draft.undo(transaction.id);
  assert.equal(readWorld(ws)["launches"], undefined, "undo restores the pre-edit world");
  ws.draft.redo(transaction.id);
  assert.ok(readWorld(ws)["launches"], "redo replays the launch edit");

  const candidate = ws.buildSelected(["world"]);
  const kept = await ws.keepCandidate(candidate);
  assert.equal(kept.saved.revision, base.revision, "a launch edit moves no playable bytes");
  assert.notEqual(kept.saved.authoring, base.authoring);

  const data = await storedBody(projectId);
  const stored = JSON.parse(String(readProjectWorkspace(data.workspace)["world"])) as {
    launches?: Record<string, { entries: { name: string }[] }>;
  };
  assert.equal(stored.launches?.["1"]?.entries[0]?.name, "Vacuum death");
  const authoring = data.authoringState!["authoring"] as { world: { launches?: unknown } };
  assert.deepEqual(authoring.world.launches, stored.launches);

  const reopened = await openEditableProject(projectId);
  const reopenedWorld = readWorld(reopened) as {
    launches: Record<string, { entries: { name: string }[] }>;
  };
  assert.equal(reopenedWorld.launches["1"]!.entries[0]!.name, "Vacuum death");

  // A second transaction undoes and redoes over the kept baseline.
  const second = applyWorld(
    reopened,
    updateLaunch(reopenedWorld as Parameters<typeof updateLaunch>[0], 1, "launch-1", {
      seed: 7,
    }) as Record<string, unknown>,
  );
  reopened.draft.undo(second.id);
  assert.equal(
    (readWorld(reopened)["launches"] as { "1": { entries: { seed: number }[] } })["1"]!.entries[0]!
      .seed,
    4242,
  );
  reopened.draft.redo(second.id);
  await reopened.keepCandidate(reopened.buildSelected(["world"]));
  const final = JSON.parse(
    String(readProjectWorkspace((await storedBody(projectId)).workspace)["world"]),
  ) as {
    launches: { "1": { entries: { seed: number }[] } };
  };
  assert.equal(final.launches["1"]!.entries[0]!.seed, 7);
});

test("a rejected write leaves the previous Launches in storage untouched", async () => {
  const projectId = await seedProject("ws-launches-rejected");
  const ws = await openEditableProject(projectId);
  const original = readWorld(ws);
  applyWorld(
    ws,
    addLaunch(original as Parameters<typeof addLaunch>[0], 1, VACUUM_DEATH) as Record<
      string,
      unknown
    >,
  );
  const candidate = ws.buildSelected(["world"]);

  const realSet = records.set.bind(records);
  records.set = (key, value) => {
    if (key === projectId) throw new Error("quota");
    return realSet(key, value);
  };
  try {
    await assert.rejects(ws.keepCandidate(candidate), /quota/);
  } finally {
    records.set = realSet;
  }
  const stored = await storedBody(projectId);
  assert.deepEqual(
    JSON.parse(String(readProjectWorkspace(stored.workspace)["world"])),
    original,
    "the failed write left the previous world — and its launches — intact",
  );
});

test("a second page cannot silently overwrite another page's Launch edits", async () => {
  const projectId = await seedProject("ws-launches-two-pages");
  const first = await openEditableProject(projectId);
  const second = await openEditableProject(projectId);

  applyWorld(
    first,
    addLaunch(readWorld(first) as Parameters<typeof addLaunch>[0], 1, VACUUM_DEATH) as Record<
      string,
      unknown
    >,
  );
  await first.keepCandidate(first.buildSelected(["world"]));

  // Opened before the first page's Keep landed: its write must refuse rather
  // than silently drop the other page's launch.
  applyWorld(
    second,
    addLaunch(readWorld(second) as Parameters<typeof addLaunch>[0], 2, {
      name: "Forest entry",
    }) as Record<string, unknown>,
  );
  await assert.rejects(
    second.keepCandidate(second.buildSelected(["world"])),
    /modified|removed|replaced/i,
  );

  // Reopened on the new base, the second page's edit joins the first.
  const third = await openEditableProject(projectId);
  applyWorld(
    third,
    addLaunch(readWorld(third) as Parameters<typeof addLaunch>[0], 2, {
      name: "Forest entry",
    }) as Record<string, unknown>,
  );
  await third.keepCandidate(third.buildSelected(["world"]));

  const stored = JSON.parse(
    String(readProjectWorkspace((await storedBody(projectId)).workspace)["world"]),
  ) as {
    launches: Record<string, { entries: { name: string }[] }>;
  };
  assert.equal(stored.launches["1"]!.entries[0]!.name, "Vacuum death");
  assert.equal(stored.launches["2"]!.entries[0]!.name, "Forest entry");
});

test("Launches survive a project archive round trip and never reach the playable export", async () => {
  const projectId = await seedProject("ws-launches-archive");
  const ws = await openEditableProject(projectId);
  applyWorld(
    ws,
    selectLaunch(
      addLaunch(readWorld(ws) as Parameters<typeof addLaunch>[0], 1, VACUUM_DEATH) as Parameters<
        typeof selectLaunch
      >[0],
      1,
      "launch-1",
    ) as Record<string, unknown>,
  );
  await ws.keepCandidate(ws.buildSelected(["world"]));

  const stored = await storedBody(projectId);
  const filesBefore = new Map(
    Object.entries(stored.files).map(([name, bytes]) => [name, [...bytes]]),
  );
  const playableBefore = buildPublicGameZip(stored);
  const opened = await readGameZip(await buildProjectZip(stored));

  const archivedWorld = readProjectWorkspace(opened.project!.workspace!)["world"];
  const launches = (JSON.parse(String(archivedWorld)) as { launches?: unknown }).launches;
  assert.deepEqual(
    launches,
    {
      "1": {
        selected: "launch-1",
        entries: [{ id: "launch-1", ...VACUUM_DEATH }],
      },
    },
    "the project archive keeps the exact launch",
  );
  const authoring = opened.project!.authoringState!["authoring"] as { world: unknown };
  assert.deepEqual(
    (authoring.world as { launches?: unknown }).launches,
    launches,
    "the archived authoring state keeps it too",
  );
  validateAuthoringState(opened.project!.authoringState!["authoring"]);

  // The playable export is built from files, library and title only: a
  // launches keep changed none of them, so the bytes are identical.
  const reopened = await openEditableProject(projectId);
  applyWorld(
    reopened,
    addLaunch(readWorld(reopened) as Parameters<typeof addLaunch>[0], 2, {
      name: "Forest entry",
    }) as Record<string, unknown>,
  );
  await reopened.keepCandidate(reopened.buildSelected(["world"]));
  const after = await storedBody(projectId);
  assert.deepEqual(buildPublicGameZip(after), playableBefore);
  assert.equal(after.library?.profile, stored.library?.profile, "profile id unchanged");
  assert.equal(after.library?.revision, stored.library?.revision, "resource revision unchanged");
  assert.deepEqual(
    Object.keys(after.files).sort(),
    [...filesBefore.keys()].sort(),
    "the playable file set is unchanged",
  );
  for (const [name, bytes] of filesBefore) {
    assert.deepEqual([...after.files[name]!], bytes, `${name} bytes changed`);
  }
});
