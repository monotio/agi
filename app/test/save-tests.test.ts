import assert from "node:assert/strict";
import { test } from "node:test";
import { saveTests } from "../src/authoring/saveTests.ts";
import { authoringFingerprint } from "../src/project/gameStorage.ts";
import { openProjectSession } from "../src/project/projectSession.ts";
import { compileProjectDocuments } from "../../src/authoring/projectDocuments.ts";
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
  let forks = 0;
  let admitted = 0;
  let savedProject = original;
  let nextAdmissionStatus = admissionStatus;
  let admittedTests: string | Uint8Array | undefined;
  const boundary = Promise.withResolvers<void>();
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
      admit: async (image) => {
        admitted++;
        admittedTests = image.documents()["tests"];
        return {
          status: nextAdmissionStatus,
          expected: null,
          current: null,
          patchGeneration: 1,
          reason: "A loaded view needs a restart.",
        };
      },
    },
    ...(admissionStatus === "deferred" ? { boundary: () => boundary.promise } : {}),
    forked() {
      forks++;
    },
    async write(request) {
      written++;
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
    set admissionStatus(value: typeof admissionStatus) {
      nextAdmissionStatus = value;
    },
    get written() {
      return written;
    },
    get forks() {
      return forks;
    },
    get admitted() {
      return admitted;
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
      assert.equal(
        f.admitted,
        0,
        "tests-only commits leave the live engine and recorder untouched",
      );
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

test("test writes wait for an Agent turn and its review, including queued commits", async () => {
  const f = fixture();
  let reason: string | null = "Wait for the Agent to finish before editing tests.";
  try {
    await assert.rejects(
      saveTests(f.session, op, { writeBlockReason: () => reason }),
      /Wait for the Agent/,
    );
    assert.equal(f.session.model.capture().read("tests"), undefined);
    reason = null;
    const submit = f.session.submit;
    f.session.submit = (edit) => {
      reason = "Review the Agent's changes before editing tests.";
      return submit(edit);
    };
    await assert.rejects(
      saveTests(f.session, op, { writeBlockReason: () => reason }),
      /Review the Agent/,
    );
    assert.equal(f.session.model.capture().read("tests"), undefined);
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
    const saved = await saveTests(f.session, op);
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
      new TextDecoder().decode(saved.payload),
      "deferred admission carries the latest tests too",
    );
  } finally {
    f.session.dispose();
    f.releaseBoundary();
  }
});
