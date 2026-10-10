import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  captureAgentWorkspace,
  describeWorkspaceDefects,
} from "../src/authoring/projectAgentCandidate.ts";
import {
  compileProjectDocuments,
  readProjectDocuments,
} from "../src/authoring/projectDocuments.ts";
import { ProjectDraft } from "../src/authoring/projectDraft.ts";
import { openContainer } from "../src/container/container.ts";
import { detectProfile } from "../src/runtime/profile.ts";
import { RESOURCE_KINDS } from "../src/types.ts";
import { fixtureReadiness, scanFixtures } from "./fixtures.ts";
import { loadGame } from "./game-fixture.ts";

/**
 * Every installed game fixture can be edited the way Create does: capture the
 * native documents, open the whole-game tools, make one small valid change
 * and finish. Original releases ship directory entries past their volumes,
 * stale records and references to absent logics (docs/testing.md, "Fixture
 * notes"); those defects carry forward byte for byte and never refuse an
 * unrelated edit. Missing fixtures skip explicitly.
 */
const fixtures = scanFixtures().all.filter(
  (fixture) => !fixture.files.has("project.json") && !fixture.files.has("game.json"),
);

const VIEW_DOCUMENT = JSON.stringify({
  loops: [{ cels: [{ width: 2, height: 1, transparentColor: 0, pixels: [1, 0] }] }],
});

function unreadableSlots(container: ReturnType<typeof openContainer>): Map<string, string> {
  const slots = new Map<string, string>();
  for (const kind of RESOURCE_KINDS)
    for (let num = 0; num < 256; num++) {
      try {
        container.getResource(kind, num);
      } catch (error) {
        slots.set(`${kind}:${num}`, String(error));
      }
    }
  return slots;
}

describe("agent edits on installed game fixtures", () => {
  if (fixtures.length === 0)
    test("installed fixtures", {
      skip: "Place your own game files under games/ to run this test.",
    });
  for (const fixture of fixtures) {
    test(
      `${fixture.folder}: a no-op yields no changes and one new view finishes`,
      {
        skip: fixtureReadiness(fixture.folder, fixture.dir, fixture.files, [], {
          checkVolumes: "shipped",
        }),
      },
      () => {
        const game = loadGame(fixture.folder, { interpreterFiles: true, checkVolumes: "shipped" });
        const files = Object.fromEntries(game.files);
        files["WORDS.TOK"] = new Uint8Array(
          readFileSync(fixture.dir + fixture.files.get("words.tok")!),
        );
        const profileId = detectProfile(new Map(Object.entries(files))).id;
        const read = readProjectDocuments({ files, profileId });
        const workspace = captureAgentWorkspace({
          draft: new ProjectDraft(read.documents),
          files,
          profileId,
        });
        assert.equal(workspace.compilable, true, JSON.stringify(workspace.diagnostics.slice(0, 3)));
        const before = unreadableSlots(openContainer(new Map(Object.entries(files))));
        assert.deepEqual(
          workspace.defects.filter((d) => d.cause === "unreadable").map((d) => d.key),
          [...before.keys()],
        );
        for (const sentence of describeWorkspaceDefects(workspace.defects))
          assert.match(sentence, /stays? as (it is|they are)\.$/);

        assert.deepEqual(workspace.openToolState().finish("nothing").changes(), []);
        assert.deepEqual(workspace.propose("nothing", []).changes(), []);

        let num = 255;
        while (read.documents[`view:${num}`] !== undefined || before.has(`view:${num}`)) num--;
        const key = `view:${num}`;
        const proposal = workspace
          .openToolState()
          .finish("one view", [{ key, content: VIEW_DOCUMENT }]);
        assert.deepEqual(
          proposal.changes().map((c) => c.key),
          [key],
        );
        const documents = { ...workspace.documents(), [key]: VIEW_DOCUMENT };
        const exported = compileProjectDocuments({ files, profileId, documents }).files();
        const after = openContainer(exported);
        assert.deepEqual(unreadableSlots(after), before, "every unreadable slot fails as before");
        assert.ok(after.getResource("view", num));
      },
    );
  }
});
