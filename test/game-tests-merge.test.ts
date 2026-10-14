import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeAgentTestChanges, sameNonTestDocuments } from "../src/authoring/projectTestsMerge.ts";
import { parseGameTests, GAME_TESTS_FORMAT } from "../src/agent/gameTestFormat.ts";
import { captureAgentWorkspace } from "../src/authoring/projectAgentCandidate.ts";
import { ProjectDraft } from "../src/authoring/projectDraft.ts";
import { createStarterProject } from "../src/authoring/starterProject.ts";
import { readProjectDocuments } from "../src/authoring/projectDocuments.ts";
import { executeAgentTool } from "../src/agent/tools.ts";
import { PROFILES } from "../src/runtime/profile.ts";

const profile = PROFILES["2.936"];
const document = (tests: readonly unknown[]) =>
  JSON.stringify({ format: GAME_TESTS_FORMAT, tests });
const entry = (name: string, score = 1) => ({ name, room: 1, steps: [], expect: { score } });
function merged(
  base: readonly unknown[],
  current: readonly unknown[],
  candidate: readonly unknown[],
) {
  const result = mergeAgentTestChanges(
    { tests: document(base) },
    { tests: document(current) },
    [{ key: "tests", content: document(candidate) }],
    profile,
  );
  const content = result.find((change) => change.key === "tests")?.content ?? document(current);
  return parseGameTests(
    typeof content === "string" ? new TextEncoder().encode(content) : content,
    profile,
  ).tests;
}

test("Tests merge by name: additions, changes and removals preserve creator additions and echoed names", () => {
  const base = [entry("Echo"), entry("Change"), entry("Remove")];
  const current = [entry("Echo", 9), entry("Change", 8), entry("Remove", 7), entry("Creator")];
  const actual = merged(base, current, [base[0], entry("Change", 2), entry("Renamed")]);
  assert.deepEqual(
    actual.map((test) => [test.name, test.expect?.["score"]]),
    [
      ["Echo", 9],
      ["Change", 2],
      ["Creator", 1],
      ["Renamed", 1],
    ],
  );
});

test("Tests merge by name: deletion removes only base names while concurrent additions survive", () => {
  const result = mergeAgentTestChanges(
    { tests: document([entry("Old")]) },
    { tests: document([entry("Old", 2), entry("New")]) },
    [{ key: "tests", content: null }],
    profile,
  );
  const content = String(result[0]!.content);
  assert.deepEqual(
    parseGameTests(new TextEncoder().encode(content)).tests.map((test) => test.name),
    ["New"],
  );
});

test("Tests merge by name: an unchanged echoed definition never overwrites a concurrent deletion", () => {
  const actual = merged([entry("Echo")], [], [entry("Echo"), entry("Added")]);
  assert.deepEqual(
    actual.map((test) => test.name),
    ["Added"],
  );
});

test("Tests merge by name: object key order is an untouched definition", () => {
  const base = [
    {
      name: "Echo",
      room: 1,
      steps: [{ action: "wait", ticks: 1, until: { room: 1, flag: { id: 2, value: true } } }],
    },
  ];
  const candidate = [
    {
      name: "Echo",
      room: 1,
      steps: [{ until: { flag: { value: true, id: 2 }, room: 1 }, ticks: 1, action: "wait" }],
    },
    entry("Added"),
  ];
  const actual = merged(base, [{ ...base[0], room: 2 }], candidate);
  assert.equal(actual[0]!.room, 2);
});

test("Tests merge by name: supported replacement repairs an unchanged opaque document", () => {
  const changes = [{ key: "tests", content: document([entry("Repaired")]) }];
  assert.deepEqual(
    mergeAgentTestChanges({ tests: "{" }, { tests: "{" }, changes, profile),
    changes,
  );
  assert.throws(
    () =>
      mergeAgentTestChanges({ tests: "{" }, { tests: "other opaque content" }, changes, profile),
    /tests file changed.*repaired/,
  );
});

test("Tests are documents: test saves and Undo never stale a game edit or review", () => {
  assert.equal(
    sameNonTestDocuments({ notes: "Game", tests: "old" }, { notes: "Game", tests: "new" }),
    true,
  );
  assert.equal(
    sameNonTestDocuments({ notes: "Game", tests: "old" }, { notes: "Changed", tests: "new" }),
    false,
  );
});

test("Tests are documents: an Agent can propose tests before a broken game builds", () => {
  const files = Object.fromEntries(createStarterProject("starter").files());
  const documents = {
    ...readProjectDocuments({ files, profileId: "2.936" }).documents,
    "logic:1": "not valid AGI logic",
  };
  const workspace = captureAgentWorkspace({
    draft: new ProjectDraft(documents),
    files,
    profileId: "2.936",
  });
  assert.equal(workspace.compilable, false);
  const proposal = workspace.propose("Tests first", [
    { key: "tests", content: document([entry("Future", 1)]) },
  ]);
  assert.deepEqual(
    proposal.changes().map((change) => change.key),
    ["tests"],
  );
  assert.throws(
    () => workspace.propose("Invalid tests", [{ key: "tests", content: "{" }]),
    /valid JSON/,
  );
});

test("Tests are documents: an Agent write never resurrects a deleted document from old worker files", () => {
  const files = Object.fromEntries(createStarterProject("starter").files());
  const documents = { ...readProjectDocuments({ files, profileId: "2.936" }).documents };
  files["TESTS.JSON"] = new TextEncoder().encode(document([entry("Deleted")]));
  const candidate = captureAgentWorkspace({
    draft: new ProjectDraft(documents),
    files,
    profileId: "2.936",
  }).openToolState();
  const write = executeAgentTool(candidate.state, "write_game_tests", {
    mode: "merge",
    names: null,
    tests: [entry("Added")],
  });
  assert.equal(write.success, true);
  const content = candidate
    .finish("Add test")
    .changes()
    .find((change) => change.key === "tests")!.content;
  assert.deepEqual(
    parseGameTests(new TextEncoder().encode(String(content))).tests.map((test) => test.name),
    ["Added"],
  );
});
