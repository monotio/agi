import assert from "node:assert/strict";
import { test } from "node:test";
import { saveTests } from "../src/authoring/saveTests.ts";
import { authoringFingerprint } from "../src/project/gameStorage.ts";
import { openProjectSession } from "../src/project/projectSession.ts";
import {
  compileProjectDocuments,
  type ProjectDocumentsCompile,
} from "../../src/authoring/projectDocuments.ts";
import { createContainer } from "../../src/container/container.ts";
import { writeProjectWorkspace } from "../../src/authoring/projectWorkspace.ts";
import { requireProjectId } from "../../src/gameIdentity.ts";
import { installWebLocksFixture } from "./webLocksFixture.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { parseGameTests } from "../../src/agent/gameTestFormat.ts";
import { PROFILES } from "../../src/runtime/profile.ts";

installWebLocksFixture();
installIndexedDbFixture();
const scenario = (name: string) => ({ name, room: 1, steps: [], expect: null });
const op = { kind: "merge", tests: [scenario("recorded")] } as const;
function fixture(
  source: "created" | "catalog" | "installed" = "created",
  admissionStatus: "committed" | "restartRequired" | "deferred" = "committed",
  preparedRoom = false,
) {
  const documents = { "logic:0": "return;", "logic:1": "return;" };
  const compiled = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents,
    profileId: "2.936",
  });
  const original = requireProjectId(`save-tests-${source}`);
  let reject = false;
  let written = 0;
  let savedFiles: Record<string, Uint8Array> = {};
  let forks = 0;
  let savedProject = original;
  let nextAdmissionStatus = admissionStatus;
  let admittedTests: string | Uint8Array | undefined;
  let restartCommit: (() => void) | undefined;
  const boundary = Promise.withResolvers<void>();
  async function admit(image: ProjectDocumentsCompile) {
    admittedTests = image.documents()["tests"];
    return {
      status: nextAdmissionStatus,
      expected: null,
      current: null,
      patchGeneration: 1,
      reason: "A loaded view needs a restart.",
    };
  }
  const session = openProjectSession({
    data: {
      projectId: original,
      title: "Tests",
      authoredAt: "",
      files: Object.fromEntries(compiled.files()),
      words: [],
      workspace: writeProjectWorkspace(documents),
      library: {
        version: 1,
        source: source === "catalog" ? "catalog" : source === "installed" ? "folder" : "authored",
        revision: compiled.build.identity.revision,
        validation: { status: "ready", message: "Ready" },
        ...(source === "catalog" ? { catalog: { id: "tests", version: "1" } } : {}),
      },
    },
    lifetime: "initial",
    ...(source === "installed"
      ? { forkParent: { project: original, revision: compiled.build.identity.revision } }
      : {}),
    admission: {
      runToken: `tests-${source}`,
      admit: preparedRoom
        ? async () => assert.fail("A prepared room must keep its adoption path.")
        : admit,
      ...(preparedRoom ? { admitPreparedRoom: admit } : {}),
      restart: async (image) => {
        restartCommit?.();
        return admit(image);
      },
    },
    ...(admissionStatus === "deferred" ? { boundary: () => boundary.promise } : {}),
    forked() {
      forks++;
    },
    async write(request) {
      written++;
      savedFiles = request.data.files;
      savedProject = request.projectId;
      if (reject) throw new Error("Disk is full. Free space and try again.");
      return {
        commitId: request.commitId,
        workspaceId: request.workspaceId,
        candidateHash: "a",
        documents: request.documents,
        saved: {
          projectId: request.projectId,
          lifetime: "saved",
          generation: written,
          revision: compiled.build.identity.revision,
          authoring: authoringFingerprint(undefined, request.data.workspace),
          buildId: request.buildId,
        },
      };
    },
  });
  return {
    session,
    original,
    releaseBoundary: () => boundary.resolve(),
    get admittedTests() {
      return admittedTests;
    },
    set onRestart(commit: () => void) {
      restartCommit = commit;
    },
    set admissionStatus(value: typeof admissionStatus) {
      nextAdmissionStatus = value;
    },
    get files() {
      return savedFiles;
    },
    get written() {
      return written;
    },
    get forks() {
      return forks;
    },
    get savedProject() {
      return savedProject;
    },
    set reject(value: boolean) {
      reject = value;
    },
  };
}
for (const source of ["created", "catalog", "installed"] as const)
  test(`${source} game test saves use project history and Undo removes the test`, async () => {
    const f = fixture(source);
    try {
      await saveTests(f.session, op);
      assert.equal(
        parseGameTests(
          new TextEncoder().encode(String(f.session.model.capture().read("tests")!.content)),
          PROFILES["2.936"],
        ).tests[0]!.name,
        "recorded",
      );
      assert.equal(f.forks, source === "created" ? 0 : 1);
      assert.equal(f.savedProject === f.original, source === "created");
      await f.session.undo();
      assert.equal(f.session.model.capture().read("tests"), undefined);
    } finally {
      f.session.dispose();
    }
  });

test("a rejected test write retains the edit and reports the cause for Retry", async () => {
  const f = fixture();
  try {
    f.reject = true;
    await assert.rejects(saveTests(f.session, op), /Disk is full/);
    assert.match(String(f.session.model.capture().read("tests")!.content), /recorded/);
    f.reject = false;
    await saveTests(f.session, op);
    assert.equal(f.session.saveStatus().state, "saved");
  } finally {
    f.session.dispose();
  }
});

test("test edits refuse a session closed by another tab, and refuse without a session", async () => {
  await assert.rejects(saveTests(null, op), /Open Create/);
  const f = fixture();
  try {
    f.session.stopWrites();
    await assert.rejects(saveTests(f.session, op), /Editing is paused/);
    assert.equal(f.session.model.capture().read("tests"), undefined);
  } finally {
    f.session.dispose();
  }
});

test("a stale test snapshot retries once and merges the other writer's test", async () => {
  const f = fixture();
  const submit = f.session.submit;
  let submissions = 0;
  f.session.submit = async (edit) => {
    submissions++;
    if (submissions === 1)
      await submit({
        ...edit,
        proposal: f.session.model.propose(f.session.model.capture(), "Other test", [
          {
            key: "tests",
            content: JSON.stringify({ format: "monotio.agi.tests.v2", tests: [scenario("other")] }),
          },
        ]),
      });
    return submit(edit);
  };
  try {
    const result = await saveTests(f.session, op);
    assert.equal(submissions, 2);
    assert.deepEqual(
      result.tests.map((test) => test.name),
      ["other", "recorded"],
    );
  } finally {
    f.session.dispose();
  }
});

test("Tests are documents: a broken game never blocks saving, deleting or Undo", async () => {
  const f = fixture();
  try {
    await f.session.submit({
      proposal: f.session.model.propose(f.session.model.capture(), "Broken room", [
        { key: "logic:1", content: "broken source" },
      ]),
      label: "Broken room",
      origin: "logic",
      author: "creator",
    });
    const diagnostics = f.session.capture().diagnostics;
    assert.ok(diagnostics.some((entry) => entry.severity === "error"));
    await saveTests(f.session, {
      kind: "merge",
      tests: [{ ...scenario("future room"), room: 99 }],
    });
    assert.match(String(f.session.model.capture().read("tests")!.content), /future room/);
    assert.deepEqual(f.session.capture().diagnostics, diagnostics);
    const undone = await f.session.undo();
    assert.equal(undone?.status, "committed", "broken game diagnostics do not apply to test Undo");
    assert.equal(f.session.model.capture().read("tests"), undefined);
    assert.equal(f.session.model.capture().read("logic:1")!.content, "broken source");
    await f.session.redo();
    await saveTests(f.session, { kind: "remove", names: ["future room"] });
    await f.session.undo();
    assert.match(String(f.session.model.capture().read("tests")!.content), /future room/);
  } finally {
    f.session.dispose();
  }
});

test("Committed tests are exported even when the game's build is older", async () => {
  const f = fixture();
  const data = f.session.model.capture().lastAdmissibleBuild!;
  try {
    const save = f.session.model.capture();
    await saveTests(f.session, op);
    assert.equal(f.session.model.capture().lastAdmissibleBuild, data);
    assert.equal(save.read("tests"), undefined);
    assert.match(new TextDecoder().decode(f.files["TESTS.JSON"]), /recorded/);
    await f.session.undo();
    await f.session.flush();
    assert.equal(f.files["TESTS.JSON"], undefined);
  } finally {
    f.session.dispose();
  }
});

test("Retry after a rejected deletion saves the accepted edit once", async () => {
  const f = fixture();
  try {
    await saveTests(f.session, op);
    f.reject = true;
    const remove = { kind: "remove", names: ["recorded"] } as const;
    await assert.rejects(saveTests(f.session, remove), /Could not save/);
    const cursor = f.session.history.capture().cursor;
    f.reject = false;
    const saved = await saveTests(f.session, remove);
    assert.deepEqual(saved.tests, []);
    assert.equal(f.session.history.capture().cursor, cursor, "Retry creates no second edit");
  } finally {
    f.session.dispose();
  }
});

test("saving tests preserves a resource edit that still needs a restart", async () => {
  const f = fixture("created", "restartRequired");
  try {
    const result = await f.session.submit({
      proposal: f.session.model.propose(f.session.model.capture(), "Resource", [
        { key: "logic:1", content: "assignn(v40,1);return;" },
      ]),
      label: "Resource",
      origin: "logic",
      author: "creator",
    });
    assert.equal(result.status, "restartRequired");
    const restart = f.session.pendingRestart;
    assert.ok(restart);
    await saveTests(f.session, op);
    assert.deepEqual(
      f.session.pendingRestart,
      restart,
      "test metadata cannot dismiss a pending resource restart",
    );
  } finally {
    f.session.dispose();
  }
});

test("saving tests keeps deferred resource admission pending", async () => {
  const f = fixture("created", "deferred");
  try {
    await f.session.submit({
      proposal: f.session.model.propose(f.session.model.capture(), "Resource", [
        { key: "logic:1", content: "assignn(v40,1);return;" },
      ]),
      label: "Resource",
      origin: "logic",
      author: "creator",
    });
    assert.equal(f.session.capture().pendingAdmission, true);
    await saveTests(f.session, op);
    assert.equal(f.session.capture().pendingAdmission, true);
    f.admissionStatus = "committed";
    f.releaseBoundary();
    const { waitUntil } = await import("./async.ts");
    await waitUntil(
      () => !f.session.capture().pendingAdmission,
      "the resource edit admits at the next boundary",
    );
    assert.equal(
      f.admittedTests,
      undefined,
      "a test document save never changes a queued game image",
    );
  } finally {
    f.session.dispose();
    f.releaseBoundary();
  }
});

test("saving tests keeps a deferred prepared room on its adoption path", async () => {
  const f = fixture("created", "deferred", true);
  try {
    await f.session.submitPreparedRoom({
      proposal: f.session.model.propose(f.session.model.capture(), "Room", [
        { key: "logic:1", content: "assignn(v40,1);return;" },
      ]),
      label: "Room",
      origin: "agent",
      author: "agent",
    });
    assert.equal(f.session.capture().pendingAdmission, true);
    await saveTests(f.session, op);
    assert.equal(f.session.capture().pendingAdmission, true);
    f.admissionStatus = "committed";
    f.releaseBoundary();
    const { waitUntil } = await import("./async.ts");
    await waitUntil(
      () => !f.session.capture().pendingAdmission,
      "the prepared room adopts at the next boundary",
    );
    assert.equal(f.session.pendingRestart, null);
    assert.equal(f.admittedTests, undefined, "tests stay outside prepared-room adoption");
  } finally {
    f.session.dispose();
    f.releaseBoundary();
  }
});

test("an unchanged test save flushes pending persistence and a closed session still refuses it", async () => {
  const f = fixture();
  try {
    const { editGameTests } = await import("../../src/agent/gameTestsEdit.ts");
    const edited = editGameTests(
      { document: undefined, profile: PROFILES["2.936"], words: undefined },
      op,
    );
    await f.session.submit({
      proposal: f.session.model.propose(f.session.model.capture(), "Tests", [
        { key: "tests", content: new TextDecoder().decode(edited.payload) },
      ]),
      label: "Tests",
      origin: "guided",
      author: "creator",
    });
    assert.equal(f.session.saveStatus().state, "pending");
    f.reject = true;
    await assert.rejects(
      saveTests(f.session, op),
      /Disk is full/,
      "an empty proposal must still flush the accepted pending edit",
    );
    assert.equal(f.session.saveStatus().state, "failed");
    f.reject = false;
    await saveTests(f.session, op);
    assert.equal(f.session.saveStatus().state, "saved");
    f.session.stopWrites();
    await assert.rejects(saveTests(f.session, op), /Editing is paused/);
  } finally {
    f.session.dispose();
  }
});

test("Tests are documents: a test commit during restart cannot abort it or lose the tests", async () => {
  const f = fixture("created", "restartRequired");
  try {
    await f.session.submit({
      proposal: f.session.model.propose(f.session.model.capture(), "Room", [
        { key: "logic:1", content: "assignn(v40,1);return;" },
      ]),
      label: "Room",
      origin: "logic",
      author: "creator",
    });
    f.admissionStatus = "committed";
    f.onRestart = () => {
      // The document publication races the physical restart's acknowledgement.
      const proposed = f.session.model.propose(f.session.model.capture(), "Tests", [
        {
          key: "tests",
          content: JSON.stringify({
            format: "monotio.agi.tests.v2",
            tests: [scenario("during restart")],
          }),
        },
      ]);
      f.session.model.apply(f.session.model.issueApplication(proposed));
    };
    const result = await f.session.restartWithChanges();
    assert.equal(result?.status, "committed");
    assert.equal(f.session.pendingRestart, null);
    await f.session.flush();
    assert.match(String(f.session.model.capture().read("tests")!.content), /during restart/);
    assert.match(new TextDecoder().decode(f.files["TESTS.JSON"]), /during restart/);
  } finally {
    f.session.dispose();
  }
});

test("Tests save when well formed: a mixed game edit cannot publish malformed tests", async () => {
  const f = fixture();
  try {
    const before = f.session.model.capture();
    await assert.rejects(
      f.session.submit({
        proposal: f.session.model.propose(before, "Game and tests", [
          { key: "logic:1", content: "assignn(v40,1);return;" },
          { key: "tests", content: "{broken tests" },
        ]),
        label: "Game and tests",
        origin: "guided",
        author: "creator",
      }),
      /JSON|test/i,
    );
    assert.equal(
      f.session.model.capture().read("logic:1")!.content,
      before.read("logic:1")!.content,
    );
    assert.equal(f.session.model.capture().read("tests"), undefined);
    // Retained opaque imports never hold back an unrelated game edit.
    const imported = f.session.model.propose(f.session.model.capture(), "Imported tests", [
      { key: "tests", content: "{broken tests" },
    ]);
    f.session.model.apply(f.session.model.issueApplication(imported));
    const edited = await f.session.update([{ key: "logic:1", content: "assignn(v40,1);return;" }]);
    assert.equal(edited.status, "committed");
    assert.equal(f.session.model.capture().read("tests")!.content, "{broken tests");
  } finally {
    f.session.dispose();
  }
});

for (const path of ["update", "prepared room"] as const) {
  test(`Tests are documents: tests-only ${path} writes preserve the game's build`, async () => {
    const f = fixture("created", "committed", true);
    try {
      const build = f.session.model.capture().lastAdmissibleBuild;
      const changes = [
        {
          key: "tests",
          content: JSON.stringify({
            format: "monotio.agi.tests.v2",
            tests: [scenario("document")],
          }),
        },
      ];
      if (path === "update") await f.session.update(changes);
      else
        await f.session.submitPreparedRoom({
          proposal: f.session.model.propose(f.session.model.capture(), "Tests", changes),
          label: "Tests",
          origin: "agent",
          author: "agent",
        });
      assert.equal(f.session.model.capture().lastAdmissibleBuild, build);
      assert.match(String(f.session.model.capture().read("tests")!.content), /document/);
    } finally {
      f.session.dispose();
    }
  });
}
