import { installIndexedDbFixture } from "./indexedDbFixture.ts";
installIndexedDbFixture();
import { openProjectSession } from "../src/project/projectSession.ts";
import { requireProjectId } from "../../src/gameIdentity.ts";
import { writeProjectWorkspace } from "../../src/authoring/projectWorkspace.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ProjectModel, type ProjectProposal } from "../../src/authoring/projectModel.ts";
import { ProjectDraft } from "../../src/authoring/projectDraft.ts";
import { captureAgentWorkspace } from "../../src/authoring/projectAgentCandidate.ts";
import { createStarterProject } from "../../src/authoring/starterProject.ts";
import {
  readProjectDocuments,
  compileProjectDocuments,
} from "../../src/authoring/projectDocuments.ts";
import { sha256Hex } from "../../src/crypto.ts";
import { executeAgentTool } from "../../src/agent/tools.ts";
import { submitAgentState } from "../src/agent/projectTurn.ts";
import type { ProjectSession } from "../src/project/projectSession.ts";

const document = (tests: readonly unknown[]) =>
  JSON.stringify({ format: "monotio.agi.tests.v2", tests });
const entry = (name: string, room = 1) => ({ name, room, steps: [] });
function fixture() {
  const files = Object.fromEntries(createStarterProject("starter").files());
  const documents = {
    ...readProjectDocuments({ files, profileId: "2.936" }).documents,
    tests: document([entry("Echo"), entry("Change")]),
  };
  const build = compileProjectDocuments({ files, documents, profileId: "2.936" });
  const model = new ProjectModel({ documents, build, digest: sha256Hex });
  const base = model.capture();
  const state = captureAgentWorkspace({
    draft: new ProjectDraft(base.documents()),
    files,
    profileId: "2.936",
  }).openToolState().state;
  const apply = (proposal: ProjectProposal) => model.apply(model.issueApplication(proposal));
  const save = (tests: readonly unknown[]) =>
    apply(
      model.propose(model.capture(), "Creator tests", [{ key: "tests", content: document(tests) }]),
    );
  const session = {
    model,
    allowMissingRooms: true,
    submit: async ({ proposal }: { proposal: ProjectProposal }) => {
      apply(proposal);
      return { status: "committed", diagnostics: [] };
    },
  } as unknown as ProjectSession;
  return { model, base, state, session, apply, save };
}

for (const retry of [false, true])
  test(`Tests merge by name: background Agent ${retry ? "retries stale proposals over the latest names" : "preserves creator edits during its turn"}`, async () => {
    const f = fixture();
    executeAgentTool(f.state, "write_game_tests", {
      mode: "replace",
      names: null,
      tests: [entry("Echo"), entry("Change"), entry("Added")],
    });
    f.save([entry("Echo", 3), entry("Change", 4), entry("Creator")]);
    let attempts = 0;
    f.session.submit = async ({ proposal }) => {
      if (retry && attempts++ === 0) {
        f.save([entry("Echo", 5), entry("Change", 6), entry("Creator"), entry("During queue")]);
        throw new Error("Project proposal is stale.");
      }
      f.apply(proposal);
      return { status: "committed", diagnostics: [] };
    };
    await submitAgentState({
      session: f.session,
      base: f.base,
      state: f.state,
      profileId: "2.936",
      label: "Tests",
    });
    const tests = JSON.parse(String(f.model.capture().read("tests")!.content)).tests;
    assert.deepEqual(
      tests.map((test: { name: string; room: number }) => [test.name, test.room]),
      retry
        ? [
            ["Echo", 5],
            ["Change", 6],
            ["Creator", 1],
            ["During queue", 1],
            ["Added", 1],
          ]
        : [
            ["Echo", 3],
            ["Change", 4],
            ["Creator", 1],
            ["Added", 1],
          ],
    );
  });

test("Tests merge by name: game document changes still refuse a stale background Agent", async () => {
  const f = fixture();
  executeAgentTool(f.state, "write_game_tests", {
    mode: "replace",
    names: null,
    tests: [entry("Added")],
  });
  f.apply(
    f.model.propose(f.model.capture(), "Game edit", [
      { key: "notes", content: "Creator game note" },
    ]),
  );
  await assert.rejects(
    submitAgentState({
      session: f.session,
      base: f.base,
      state: f.state,
      profileId: "2.936",
      label: "Tests",
    }),
    /project changed/,
  );
});

for (const queued of [false, true])
  test(`Only the creator changes existing tests: direct Agent additions refuse a creator's same-name collision (${queued ? "queued" : "before submit"})`, async () => {
    const f = fixture();
    executeAgentTool(f.state, "write_game_tests", {
      mode: "merge",
      names: null,
      tests: [entry("New", 2)],
    });
    if (!queued) f.save([entry("Echo"), entry("Change"), entry("New", 3)]);
    else
      f.session.submit = async (edit) => {
        f.save([entry("Echo"), entry("Change"), entry("New", 3)]);
        edit.beforeCommit?.();
        f.apply(edit.proposal);
        return { status: "committed", diagnostics: [] };
      };
    await assert.rejects(
      submitAgentState({
        session: f.session,
        base: f.base,
        state: f.state,
        profileId: "2.936",
        label: "Tests",
      }),
      /creator review/i,
    );
    const tests = JSON.parse(String(f.model.capture().read("tests")!.content)).tests;
    assert.equal(tests.find((test: { name: string; room: number }) => test.name === "New").room, 3);
  });

for (const preparedRoom of [false, true])
  test(`Only the creator changes existing tests: the real ${preparedRoom ? "prepared room" : "normal"} queue refuses a late same-name collision`, async () => {
    const f = fixture();
    const session = openProjectSession({
      data: {
        projectId: requireProjectId(`real-collision-${preparedRoom}`),
        title: "Tests",
        authoredAt: "",
        files: Object.fromEntries(f.base.lastAdmissibleBuild!.files()),
        words: [],
        workspace: writeProjectWorkspace(f.base.documents()),
        roomGeneration: true,
      },
      lifetime: "test",
      admission: {
        runToken: "test",
        admit: async () => ({
          status: "committed",
          expected: null,
          current: null,
          patchGeneration: 0,
        }),
      },
      write: async (request) => ({
        commitId: request.commitId,
        workspaceId: request.workspaceId,
        candidateHash: "a",
        documents: request.documents,
        saved: {
          ...request.expected!,
          generation: request.expected!.generation + 1,
          buildId: request.buildId,
        },
      }),
    });
    try {
      await session.ready;
      const base = session.model.capture();
      executeAgentTool(f.state, "write_game_tests", {
        mode: "merge",
        names: null,
        tests: [entry("New", 2)],
      });
      const creator = session.submit({
        proposal: session.model.propose(base, "Creator tests", [
          { key: "tests", content: document([entry("Echo"), entry("Change"), entry("New", 3)]) },
        ]),
        label: "Creator tests",
        author: "creator",
        origin: "guided",
      });
      const attempted = submitAgentState({
        session,
        base,
        state: f.state,
        profileId: "2.936",
        label: "Added tests",
        preparedRoom,
      });
      await creator;
      await assert.rejects(attempted, /creator review/i);
      const tests = JSON.parse(String(session.model.capture().read("tests")!.content)).tests;
      assert.equal(
        tests.find((test: { name: string; room: number }) => test.name === "New").room,
        3,
      );
    } finally {
      session.dispose();
    }
  });
