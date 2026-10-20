import { ProjectHistory } from "../../src/authoring/projectHistory.ts";
import { sha256Hex } from "../../src/crypto.ts";
import { readProjectDocuments } from "../../src/authoring/projectDocuments.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createContainer, openContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { Engine } from "../../src/runtime/engine.ts";
import { PROFILES, type ProfileId } from "../../src/runtime/profile.ts";
import {
  writeProjectWorkspace,
  readProjectWorkspace,
} from "../../src/authoring/projectWorkspace.ts";
import {
  commitProject,
  authoringFingerprint,
  loadAuthoredGameWithHistoryLifetime,
} from "../src/project/gameStorage.ts";
import { openOwnedProjectSession } from "../src/project/projectSessionCore.ts";
import { inspectEditableProject } from "../src/project/projectWorkspaceSource.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { installWebLocksFixture } from "./webLocksFixture.ts";
import { normalizeLibraryMetadata } from "../src/project/gameMetadata.ts";
import { computeResourceRevision } from "../../src/authoring/resourceRevision.ts";
import { compileProjectDocuments } from "../../src/authoring/projectDocuments.ts";
import { testProjectId } from "./identity.ts";
import type { BuildViewInput } from "../../src/view/view.ts";

installIndexedDbFixture();
installWebLocksFixture();
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/view-builder-1.2.4.json", import.meta.url), "utf8"),
) as {
  cases: { profileId: ProfileId; facing: number; input: BuildViewInput; bytes: number[] }[];
};
const label = "VIEWs updated for 1.2.5";
const baselineLabel = "VIEWs before the 1.2.5 update";

test("opening released VIEWs appends a baseline and one rebuild, keeps prior History, and Undo restores exact old bytes", async (t) => {
  for (const { profileId, facing, input, bytes } of fixture.cases) {
    for (const envelope of ["workspace", "legacy"] as const) {
      for (const hasHistory of [false, true]) {
        await t.test(
          `${profileId}, ${envelope}, ${hasHistory ? "existing" : "no"} History`,
          async () => {
            const profile = PROFILES[profileId];
            const source = JSON.stringify(input);
            const container = createContainer();
            container.putResource("view", 1, Uint8Array.from(bytes));
            container.putResource(
              "logic",
              0,
              assembleLogic(
                `
        if (!isset(f200)) {
          set(f200); load.view(1); animate.obj(o0); set.view(o0, 1);
          fix.loop(o0); stop.cycling(o0); position(o0, 20, 80);
          set.loop(o0, ${facing}); draw(o0);
        }
        return;
      `,
                { dictionary: new Map(), profile },
              ).payload,
            );
            const projectId = testProjectId(
              `view-migration-${profileId}-${envelope}-${hasHistory}`,
            );
            const priorHistory = new ProjectHistory(sha256Hex);
            const releasedDocuments = {
              ...readProjectDocuments({ files: Object.fromEntries(container.files), profileId })
                .documents,
              "view:1": source,
            };
            priorHistory.record(releasedDocuments, {
              label: "Created VIEW",
              origin: "view",
              author: "creator",
              time: 1,
            });
            await commitProject({
              projectId,
              workspaceId: "initial",
              commitId: "initial",
              expected: null,
              buildId: compileProjectDocuments({
                files: Object.fromEntries(container.files),
                documents: { "view:1": Uint8Array.from(bytes) },
                profileId,
              }).build.identity.buildId,
              documents: [],
              data: {
                ...(hasHistory ? { projectHistory: priorHistory.capturePortable() } : {}),
                title: "Released VIEW",
                files: Object.fromEntries(container.files),
                words: [],
                library: normalizeLibraryMetadata(
                  { version: 1, profile: profileId },
                  {
                    source: "authored",
                    revision: computeResourceRevision(Object.fromEntries(container.files)),
                  },
                ),
                ...(envelope === "workspace"
                  ? { workspace: writeProjectWorkspace(releasedDocuments) }
                  : { authoringState: { sources: { views: [[1, input]] } } }),
              },
            });
            let run = 0;
            async function open() {
              const loaded = (await loadAuthoredGameWithHistoryLifetime(projectId))!;
              assert.equal(
                inspectEditableProject(loaded.data).rejectedSources["view:1"],
                undefined,
                "the author's valid VIEW source is kept",
              );
              return openOwnedProjectSession(
                {
                  data: loaded.data,
                  lifetime: loaded.lifetime!,
                  admission: {
                    runToken: `${projectId}-${++run}`,
                    admit: async () => ({
                      status: "committed",
                      expected: null,
                      current: null,
                      patchGeneration: 1,
                    }),
                  },
                  // Use the same fenced storage commit, with no browser recovery journal.
                  write: async (request) => (await commitProject(request)).receipt,
                },
                { commit: commitProject, fingerprint: authoringFingerprint },
              );
            }
            const session = await open();
            await session.flush();
            const stored = (await loadAuthoredGameWithHistoryLifetime(projectId))!.data;
            const expectedLabels = [...(hasHistory ? ["Created VIEW"] : []), baselineLabel, label];
            assert.deepEqual(
              stored.projectHistory!.commits.map((c) => c.label),
              expectedLabels,
            );
            if (hasHistory) {
              const original = priorHistory.capturePortable();
              assert.deepEqual(
                stored.projectHistory!.commits.slice(0, original.commits.length),
                original.commits,
              );
              for (const [hash, blob] of Object.entries(original.blobs))
                assert.deepEqual(stored.projectHistory!.blobs[hash], blob);
            }
            assert.equal(readProjectWorkspace(stored.workspace!)["view:1"], source);
            const engine = new Engine(
              openContainer(new Map(Object.entries(stored.files)), { profile }),
              {
                print() {},
                displayAt() {},
                statusLine() {},
                takeInputLine: () => null,
                takeKeys: () => [],
              },
              new Map(),
              { profile },
            );
            engine.tick();
            assert.deepEqual(
              [...engine.getFrame().visual.slice(80 * 160 + 20, 80 * 160 + 23)],
              [15, 2, 1],
            );
            session.dispose();
            const reopened = await open();
            await reopened.flush();
            assert.deepEqual(
              (await loadAuthoredGameWithHistoryLifetime(projectId))!.data.projectHistory!.commits,
              stored.projectHistory!.commits,
            );
            await reopened.undo();
            await reopened.flush();
            const undone = (await loadAuthoredGameWithHistoryLifetime(projectId))!.data;
            assert.deepEqual(
              [
                ...openContainer(new Map(Object.entries(undone.files)), { profile }).getResource(
                  "view",
                  1,
                )!,
              ],
              bytes,
            );
            reopened.dispose();
            const afterUndo = await open();
            await afterUndo.flush();
            afterUndo.dispose();
            const final = (await loadAuthoredGameWithHistoryLifetime(projectId))!.data;
            assert.deepEqual(final.projectHistory!.commits, stored.projectHistory!.commits);
            assert.equal(final.projectHistory!.cursor, stored.projectHistory!.commits.at(-2)!.id);
            assert.deepEqual(
              [
                ...openContainer(new Map(Object.entries(final.files)), { profile }).getResource(
                  "view",
                  1,
                )!,
              ],
              bytes,
            );
          },
        );
      }
    }
  }
});
