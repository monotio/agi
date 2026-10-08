import assert from "node:assert/strict";
import { test } from "node:test";
import { openContainer } from "../../src/container/container.ts";
import { readSoundDocumentEnvelope } from "../../src/sound/document.ts";
import { readProjectWorkspace } from "../../src/authoring/projectWorkspace.ts";
import { buildProjectZip } from "../src/archive/projectArchive.ts";
import { readGameZip } from "../src/archive/gameZip.ts";
import { prepareLocalProject } from "../src/project/localProject.ts";
import { openProjectSession } from "../src/project/projectSession.ts";
import type { CachedGameData } from "../src/project/gameTypes.ts";
import { computeResourceRevision } from "../../src/authoring/resourceRevision.ts";
import { updateAcceptedSourceClaims } from "../src/project/projectWorkspaceSource.ts";

test("accepted starter sound edits export immediately and reopen with exact event identity", async () => {
  const local = prepareLocalProject({ title: "Sound save", kind: "starter" });
  const data: CachedGameData = { ...local.data(), projectId: local.projectId, authoredAt: "" };
  data.authoringState!["custom"] = { note: "Retained project metadata" };
  const before = structuredClone(data.authoringState!);
  let published: CachedGameData | undefined;
  let saved: CachedGameData | undefined;
  const session = openProjectSession({
    data,
    lifetime: "sound-save",
    admission: {
      runToken: "sound-save",
      async admit() {
        return { status: "committed", expected: null, current: null, patchGeneration: 1 };
      },
    },
    publish(_snapshot, next) {
      published = { ...next, projectId: data.projectId, authoredAt: "" };
    },
    async write(request) {
      saved = structuredClone({ ...request.data, projectId: data.projectId, authoredAt: "" });
      return {
        commitId: request.commitId,
        workspaceId: request.workspaceId,
        candidateHash: "a",
        documents: request.documents,
        saved: {
          ...request.expected!,
          generation: request.expected!.generation + 1,
          buildId: request.buildId,
        },
      };
    },
  });
  try {
    const original = readSoundDocumentEnvelope(
      JSON.parse(String(session.model.capture().read("sound:1")!.content)),
    );
    const id = original.tracks()![0]![0]!.id;
    // Allocate then remove an event: reopening must not reuse the deleted id.
    const edited = original
      .duplicateEvent(id)
      .removeEvent(`e${original.serialize().nextEventId}`)
      .updateEvent(id, { note: "C5" });
    const envelope = edited.serialize();
    assert.deepEqual(envelope.eventIds, original.serialize().eventIds);
    assert.equal(envelope.nextEventId, original.serialize().nextEventId + 1);
    const compatibility = structuredClone(before);
    const compatibilitySources = compatibility["sources"] as Record<string, unknown>;
    compatibilitySources["views"] = { unreadable: "kept for review" };
    (compatibilitySources["sounds"] as unknown[]).push(["unreadable", { retained: true }]);
    const claims = updateAcceptedSourceClaims(compatibility, session.model.capture().documents(), {
      ...session.model.capture().documents(),
      "sound:1": JSON.stringify(envelope),
    })!["sources"] as Record<string, unknown>;
    assert.deepEqual(claims["views"], compatibilitySources["views"]);
    assert.deepEqual((claims["sounds"] as unknown[]).at(-1), ["unreadable", { retained: true }]);
    assert.deepEqual(compatibilitySources["sounds"], [
      ...(before["sources"] as { sounds: unknown[] }).sounds,
      ["unreadable", { retained: true }],
    ]);
    const outcome = await session.submit({
      proposal: session.model.propose(session.model.capture(), "Chime", [
        { key: "sound:1", content: JSON.stringify(envelope) },
      ]),
      origin: "agent",
      author: "agent",
      label: "Chime",
    });
    assert.equal(outcome.status, "committed");
    assert.ok(published);
    const immediate = await readGameZip(await buildProjectZip(published));
    await session.flush();
    assert.ok(saved);
    for (const offered of [published, saved]) {
      const sources = offered.authoringState!["sources"] as Record<string, unknown>;
      const oldSources = before["sources"] as Record<string, unknown>;
      assert.deepEqual(
        (sources["sounds"] as [number, unknown][]).find(([num]) => num === 1)![1],
        envelope,
      );
      assert.deepEqual(
        (sources["sounds"] as [number, unknown][]).filter(([num]) => num !== 1),
        (oldSources["sounds"] as [number, unknown][]).filter(([num]) => num !== 1),
      );
      for (const field of ["logics", "pictures", "views"])
        assert.deepEqual(sources[field], oldSources[field]);
      assert.equal(offered.library!.revision, computeResourceRevision(offered.files));
      assert.deepEqual(offered.authoringState!["custom"], before["custom"]);
      const held = openContainer(new Map(Object.entries(offered.files)));
      const initial = openContainer(new Map(Object.entries(data.files)));
      for (const kind of ["logic", "picture", "view", "sound"] as const)
        for (let num = 0; num < 256; num++)
          if (kind !== "sound" || num !== 1)
            assert.deepEqual(held.getResource(kind, num), initial.getResource(kind, num));
      for (const key of ["WORDS.TOK", "OBJECT"])
        assert.deepEqual(offered.files[key], data.files[key]);
    }
    session.dispose();
    const reopened = openProjectSession({ ...sessionInput(saved), data: saved });
    try {
      assert.deepEqual(
        JSON.parse(String(reopened.model.capture().read("sound:1")!.content)),
        envelope,
      );
      const archive = await readGameZip(await buildProjectZip(saved));
      for (const opened of [immediate, archive]) {
        assert.deepEqual(
          openContainer(new Map(Object.entries(opened.files))).getResource("sound", 1),
          edited.encode(),
        );
        assert.equal(
          readProjectWorkspace(opened.project!.workspace!)["sound:1"],
          JSON.stringify(envelope),
        );
        assert.deepEqual(opened.project!.authoringState, saved.authoringState);
      }
    } finally {
      reopened.dispose();
    }
  } finally {
    session.dispose();
  }
});

function sessionInput(data: CachedGameData) {
  return {
    data,
    lifetime: "reopened",
    admission: {
      runToken: "reopened",
      async admit() {
        return { status: "committed" as const, expected: null, current: null, patchGeneration: 1 };
      },
    },
  };
}
