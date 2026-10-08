import assert from "node:assert/strict";
import { test } from "node:test";
import { ref } from "vue";
import { prepareLocalProject } from "../src/project/localProject.ts";
import { clearCachedGame, loadAuthoredGame } from "../src/project/gameStorage.ts";
import { emptyProject } from "../src/home/emptyProjectRoute.ts";
import {
  closeEmptyStageSession,
  emptyStageSession,
  openPlayableProject,
} from "../src/home/emptyStageSession.ts";
import { emptyWorkspaceChanges } from "../src/studio/workspace/emptyWorkspace.ts";
import type { EngineApi } from "../src/engine/engineContext.ts";
import type { GameLibrary } from "../src/library/useGameLibrary.ts";
import type { Shell } from "../src/shell/useShell.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { installWebLocksFixture } from "./webLocksFixture.ts";

installIndexedDbFixture();
installWebLocksFixture();
const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  },
});

for (const outcome of ["refused", "accepted", "superseded"] as const) {
  test(`blank stage retains its saved room until its own boot is accepted: ${outcome}`, async (t) => {
    const candidate = prepareLocalProject({ title: "First room", kind: "blank" });
    await candidate.save();
    t.after(async () => {
      closeEmptyStageSession();
      emptyProject.value = null;
      await clearCachedGame(candidate.projectId);
    });
    const project = await loadAuthoredGame(candidate.projectId);
    assert.ok(project);
    emptyProject.value = project;
    const session = await emptyStageSession(project);
    assert.ok(session);
    const result = await session.submit({
      proposal: session.model.propose(
        session.model.capture(),
        "First room",
        emptyWorkspaceChanges("room"),
      ),
      label: "First room",
      origin: "template",
      author: "creator",
    });
    assert.equal(result.status, "committed");
    await session.flush();
    const before = session.model.capture().documents();
    const next = { ...project, title: "Another stage" };
    let expected = 0;
    let admitted = 0;
    await openPlayableProject({
      projectId: project.projectId,
      engine: { state: { phase: "idle" }, setProjectMode: () => {} } as unknown as EngineApi,
      library: {
        libraryActionBusy: ref(false),
        libraryActionError: ref(""),
        refreshLibrary: () => {},
        async onBootSavedGame(
          _busy: boolean,
          _context: number,
          _expected: unknown,
          isCurrent: () => boolean,
        ) {
          // A durable boot can admit while the old stage writer is still open.
          await session.flush();
          if (outcome === "superseded") {
            const heldAudio = Promise.withResolvers<void>();
            queueMicrotask(() => {
              emptyProject.value = next;
              heldAudio.resolve();
            });
            await heldAudio.promise;
            assert.equal(isCurrent?.(), false, "the replaced stage retires admission during audio");
            if (!isCurrent()) return false;
          }
          if (outcome === "accepted") admitted++;
          return outcome !== "refused";
        },
      } as unknown as GameLibrary,
      shell: { expectCreate: () => expected++ } as unknown as Shell,
    });
    assert.equal(admitted, outcome === "accepted" ? 1 : 0);
    if (outcome === "accepted") {
      assert.equal(emptyProject.value, null);
      assert.equal(expected, 1);
      await assert.rejects(session.flush(), /closed/i);
    } else {
      assert.equal(emptyProject.value, outcome === "refused" ? project : next);
      assert.equal(expected, 0);
      if (outcome === "refused") {
        assert.equal(await emptyStageSession(project), session);
        assert.deepEqual(session.model.capture().documents(), before);
        await session.flush();
      }
    }
    const saved = await loadAuthoredGame(project.projectId);
    assert.ok(saved?.workspace?.documents.some((document) => document.key === "logic:0"));
  });
}
