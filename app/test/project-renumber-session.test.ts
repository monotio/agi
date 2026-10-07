import { test } from "node:test";
import assert from "node:assert/strict";
import { installWebLocksFixture } from "./webLocksFixture.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { openProjectSession } from "../src/project/projectSession.ts";
import { compileProjectDocuments } from "../../src/authoring/projectDocuments.ts";
import { createContainer, openContainer } from "../../src/container/container.ts";
import { writeProjectWorkspace } from "../../src/authoring/projectWorkspace.ts";
import { prepareProjectRenumber } from "../../src/authoring/projectRenumber.ts";
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
test("Update and journal recovery renumber the whole project; one Undo restores documents and image", async () => {
  const documents = {
    "logic:0": "new.room(1); return;",
    "logic:1": "new.room(2); return;",
    "logic:2": "return;",
    "logic:90": "call.v(v40); return;",
    bindings: JSON.stringify({ hall: { kind: "logic", num: 2 } }),
    world: JSON.stringify({
      rooms: {
        "1": { title: "Home", description: "", exits: { door: 2 } },
        "2": { title: "Hall", description: "", exits: {} },
      },
      facts: {},
      quests: {},
    }),
    tests: JSON.stringify({
      format: "monotio.agi.tests.v2",
      tests: [{ name: "Door", room: 2, steps: [], expect: { room: 2 } }],
    }),
    references: JSON.stringify([{ id: "art", kind: "room", target: 2, brief: "Hall", images: [] }]),
  };
  const compiled = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents,
    profileId: "2.936",
  });
  const data = {
    projectId: requireProjectId("renumber-project"),
    title: "Numbers",
    authoredAt: "",
    files: Object.fromEntries(compiled.files()),
    words: [],
    workspace: writeProjectWorkspace(documents),
  };
  let session = openProjectSession({
    data,
    lifetime: "initial",
    admission: {
      runToken: "renumber-run",
      admit: async () => ({
        status: "committed",
        expected: null,
        current: null,
        patchGeneration: 1,
      }),
    },
  });
  try {
    const drafts = session.drafts();
    await drafts.ready;
    drafts.stage([{ key: "logic:1", content: "new.room(2); // a saved draft\nreturn;" }]);
    const before = session.workingSnapshot().documents();
    const plan = prepareProjectRenumber({
      documents: before,
      key: "logic:2",
      number: 7,
      profile,
    });
    assert.ok(plan.ok);
    const { diffProjectDocuments } = await import("../../src/authoring/projectContent.ts");
    const outcome = await session.update(
      diffProjectDocuments(session.model.capture().documents(), plan.documents),
      false,
      undefined,
      {
        key: "logic:2",
        number: 7,
      },
    );
    assert.equal(outcome.status, "committed", JSON.stringify(outcome));
    await drafts.clear();
    const image = openContainer(session.model.capture().lastAdmissibleBuild!.files(), { profile });
    assert.equal(image.getResource("logic", 2), null);
    assert.deepEqual([...image.getResource("logic", 7)!], [1, 0, 0, 0, 2, 0]);
    for (const callback of [...frames.values()]) callback(0);
    frames.clear();
    const encoded = [...values.entries()].find(([key]) =>
      key.startsWith("monotio_agi.project-writes."),
    )![1];
    const envelope = JSON.parse(encoded) as { entries: unknown };
    const capture = (
      decodeJournalValue(envelope.entries) as { capture: ProjectJournalCapture }[]
    )[0]!.capture;
    const cursor = session.history.capture().cursor;
    session.dispose();
    const recovered = await rebuildProjectJournal(data, capture, {
      commit: commitProject,
      fingerprint: authoringFingerprint,
    });
    assert.equal(
      recovered.data.projectHistory!.cursor,
      cursor,
      "recovery preserves exact History identity",
    );
    session = openProjectSession({
      data: { ...recovered.data, projectId: data.projectId, authoredAt: "" },
      lifetime: "initial",
      admission: {
        runToken: "recovered-run",
        admit: async () => ({
          status: "committed",
          expected: null,
          current: null,
          patchGeneration: 1,
        }),
      },
    });
    await session.drafts().ready;
    assert.equal((await session.undo())?.status, "committed");
    assert.deepEqual(session.model.capture().documents(), before);
    const restored = openContainer(session.model.capture().lastAdmissibleBuild!.files(), {
      profile,
    });
    assert.equal(restored.getResource("logic", 7), null);
    assert.deepEqual(restored.getResource("logic", 2), new Uint8Array([1, 0, 0, 0, 2, 0]));
    assert.equal((await session.redo())?.status, "committed");
    assert.equal(session.model.capture().read("logic:2"), undefined);
  } finally {
    session.dispose();
  }
});
