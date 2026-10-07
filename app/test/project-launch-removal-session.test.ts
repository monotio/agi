import { test } from "node:test";
import assert from "node:assert/strict";
import { installWebLocksFixture } from "./webLocksFixture.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { openProjectSession } from "../src/project/projectSession.ts";
import { compileProjectDocuments } from "../../src/authoring/projectDocuments.ts";
import { createContainer, openContainer } from "../../src/container/container.ts";
import { writeProjectWorkspace } from "../../src/authoring/projectWorkspace.ts";
import { requireProjectId } from "../../src/gameIdentity.ts";
import { PROFILES } from "../../src/runtime/profile.ts";
import { rebuildProjectJournal } from "../src/project/projectSessionCore.ts";
import { commitProject, authoringFingerprint } from "../src/project/gameStorage.ts";
import {
  decodeJournalValue,
  type ProjectJournalCapture,
} from "../src/project/projectJournalCapture.ts";
installWebLocksFixture();
installIndexedDbFixture();
const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
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
const profile = PROFILES["2.936"];

test("room removal, Launches, journal replay and Undo share one edit", async () => {
  const world = JSON.stringify(
    {
      rooms: {},
      facts: {},
      quests: {},
      launches: {
        "2": { selected: "cart", entries: [{ id: "cart", name: "At the cart" }] },
        "1": {
          entries: [
            {
              id: "path",
              name: "Path",
              cameFrom: { room: 2, edge: 3 },
              items: { "0": 2, "1": 255 },
            },
          ],
        },
      },
    },
    null,
    2,
  );
  const documents = { "logic:0": "return;", "logic:1": "return;", "logic:2": "return;", world };
  const compiled = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents,
    profileId: "2.936",
  });
  const data = {
    projectId: requireProjectId("launch-removal-project"),
    title: "Launches",
    authoredAt: "",
    files: Object.fromEntries(compiled.files()),
    words: [],
    workspace: writeProjectWorkspace(documents),
  };
  const admission = {
    runToken: "removal-run",
    admit: async () => ({
      status: "committed" as const,
      expected: null,
      current: null,
      patchGeneration: 1,
    }),
  };
  let session = openProjectSession({ data, lifetime: "initial", admission });
  try {
    await session.drafts().ready;
    const before = session.model.capture().documents();
    const beforeCommits = session.history.capture().commits.length;
    const outcome = await session.update([{ key: "logic:2", content: null }]);
    assert.equal(outcome.status, "committed", JSON.stringify(outcome));
    assert.equal(session.history.capture().commits.length, beforeCommits + 1);
    const pruned = session.model.capture().documents();
    assert.deepEqual(JSON.parse(String(pruned["world"])).launches, {
      "1": { entries: [{ id: "path", name: "Path", items: { "1": 255 } }] },
    });
    for (const callback of [...frames.values()]) callback(0);
    frames.clear();
    const encoded = [...values.entries()].find(([key]) =>
      key.startsWith("monotio_agi.project-writes."),
    )![1];
    const envelope = JSON.parse(encoded) as { entries: unknown };
    const capture = (
      decodeJournalValue(envelope.entries) as { capture: ProjectJournalCapture }[]
    )[0]!.capture;
    session.dispose();
    const recovered = await rebuildProjectJournal(data, capture, {
      commit: commitProject,
      fingerprint: authoringFingerprint,
    });
    session = openProjectSession({
      data: { ...recovered.data, projectId: data.projectId, authoredAt: "" },
      lifetime: "initial",
      admission,
    });
    await session.drafts().ready;
    assert.deepEqual(
      session.model.capture().documents(),
      pruned,
      "journal replay keeps the complete pruned edit",
    );
    assert.equal((await session.undo())?.status, "committed");
    assert.deepEqual(session.model.capture().documents(), before);
    assert.equal((await session.redo())?.status, "committed");
    assert.deepEqual(session.model.capture().documents(), pruned);
    const image = openContainer(session.model.capture().lastAdmissibleBuild!.files(), { profile });
    assert.equal(image.getResource("logic", 2), null);
  } finally {
    session.dispose();
  }
});
