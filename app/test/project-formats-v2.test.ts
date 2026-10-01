import { writeProjectWorkspace } from "../../src/authoring/projectWorkspace.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { requireResourceRevision } from "../../src/gameIdentity.ts";
import {
  buildProjectZip,
  buildPublicGameZip,
  readProjectContext,
} from "../src/archive/projectArchive.ts";
import { readGameZip } from "../src/archive/gameZip.ts";
import { testProjectId } from "./identity.ts";

function manualProject() {
  const game = createContainer();
  game.putResource("logic", 0, assembleLogic("return;", { dictionary: new Map() }).payload);
  return {
    projectId: testProjectId("manual-v2"),
    title: "My own adventure",
    authoredAt: "2026-01-01",
    files: { ...Object.fromEntries(game.files), "WORDS.TOK": new Uint8Array(52) },
    words: [] as [string, number][],
    authoringState: { sources: { logics: [[0, "return;"]] } },
  };
}
const decode = (value: unknown) =>
  readProjectContext(new TextEncoder().encode(JSON.stringify(value)), new Map(), "");

test("manual project backups contain source without invented assistant context", async () => {
  const data = manualProject();
  const opened = await readGameZip(await buildProjectZip(data));
  assert.ok(opened.project);
  for (const key of ["provider", "model", "sessionId", "transcript", "conversationHistory"])
    assert.equal(Object.hasOwn(opened.project, key), false, key);
  assert.deepEqual(opened.project.authoringState, data.authoringState);
  assert.deepEqual(opened.files, data.files);
  assert.equal((await readGameZip(buildPublicGameZip(data))).project, undefined);
});

test("v1 assistant history is preserved in a subsequent v2 backup", async () => {
  const fixture = new Uint8Array(
    readFileSync(new URL("./formats/project-v1.zip", import.meta.url)),
  );
  const original = await readGameZip(fixture);
  // A project context's creative assets are never restamped into a body's
  // storage marker; the spread drops the context-only field explicitly.
  const { creative: _creativeAssets, ...context } = original.project ?? {};
  const data = {
    ...manualProject(),
    ...context,
    files: original.files,
    words: original.words,
  };
  const migrated = await readGameZip(await buildProjectZip(data));
  assert.deepEqual(migrated.project, original.project);
});

test("recovery travels separately from kept source and never enters a public Game", async () => {
  const recoveryDraft = {
    format: "monotio.agi.recovery-draft" as const,
    version: 1 as const,
    base: {
      revision: requireResourceRevision("a".repeat(64)),
      authoring: "b".repeat(64),
      profileId: "2.936" as const,
    },
    documents: [
      { key: "logic:0", version: 2, content: { type: "text" as const, text: 'print("unfinished' } },
    ],
    operations: [],
  };
  const data = { ...manualProject(), recoveryDraft };
  const reopened = await readGameZip(await buildProjectZip(data));
  assert.deepEqual(reopened.project?.recoveryDraft, recoveryDraft);
  assert.deepEqual(reopened.project?.authoringState, data.authoringState);
  assert.equal(new TextDecoder().decode(buildPublicGameZip(data)).includes("unfinished"), false);
});

test("v2 rejects unknown project, recovery and assistant schemas before dropping their fields", () => {
  const plain = { format: "monotio.agi.project", version: 2, authoringState: {} };
  assert.deepEqual(decode(plain), { authoringState: {} });
  assert.throws(() => decode({ ...plain, version: 999 }), /version/);
  assert.throws(() => decode({ ...plain, futureContent: {} }), /field/);
  assert.throws(
    () =>
      decode({ ...plain, recoveryDraft: { format: "monotio.agi.recovery-draft", version: 999 } }),
    /version/,
  );
  assert.throws(
    () =>
      decode({
        ...plain,
        assistant: {
          provider: "openai",
          model: "example",
          conversation: { formatVersion: 999, messages: [] },
        },
      }),
    /version/,
  );
  assert.throws(
    () =>
      decode({
        ...plain,
        assistant: {
          provider: "openai",
          model: "example",
          conversation: { formatVersion: 1, messages: [] },
          apiKey: "must-not-be-imported",
        },
      }),
    /field/,
  );
  assert.throws(
    () =>
      decode({
        ...plain,
        assistant: { model: "example", conversation: { formatVersion: 1, messages: [] } },
      }),
    /model|provider/,
  );
});

test("the hand-authored v2 fixture separates kept source from unfinished recovery", () => {
  const bytes = new Uint8Array(readFileSync(new URL("./formats/project-v2.json", import.meta.url)));
  const context = readProjectContext(bytes, new Map(), "");
  assert.equal(context.provider, undefined);
  assert.deepEqual(context.authoringState, { sources: { logics: [[0, "return;"]] } });
  assert.deepEqual(context.recoveryDraft?.documents, [
    { key: "logic:0", version: 2, content: { type: "text", text: "if (" } },
  ]);
});

test("kept workspace documents travel in Project backups separately from recovery", async () => {
  const workspace = writeProjectWorkspace({
    "logic:0": "return;",
    words: new Uint8Array(52),
    world: '{"title":"My adventure"}',
  });
  const data = { ...manualProject(), workspace };
  const opened = await readGameZip(await buildProjectZip(data));
  assert.deepEqual(opened.project?.workspace, workspace);
  assert.equal(
    new TextDecoder().decode(buildPublicGameZip(data)).includes("monotio.agi.project-workspace"),
    false,
  );
  assert.throws(
    () =>
      decode({
        format: "monotio.agi.project",
        version: 2,
        workspace: { format: "monotio.agi.project-workspace", version: 999 },
      }),
    /workspace.*version/,
  );
});

test("v2 export refuses invalid assistant session IDs before producing an unreadable backup", async () => {
  for (const sessionId of ["", "legacy/session", "x".repeat(65)]) {
    await assert.rejects(
      buildProjectZip({
        ...manualProject(),
        provider: "openai",
        model: "example",
        transcript: [],
        sessionId,
      }),
      /session/i,
    );
  }
  const sessionId = "valid-session_1";
  const opened = await readGameZip(
    await buildProjectZip({
      ...manualProject(),
      provider: "openai",
      model: "example",
      transcript: [],
      sessionId,
    }),
  );
  assert.equal(opened.project?.sessionId, sessionId);
});
