import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { sha256Hex } from "../../src/crypto.ts";
import {
  captureAgentWorkspace,
  type AgentWorkspace,
} from "../../src/authoring/projectAgentCandidate.ts";
import { ProjectDraft } from "../../src/authoring/projectDraft.ts";
import { readProjectDocuments } from "../../src/authoring/projectDocuments.ts";
import { createStarterProject, type StarterProject } from "../../src/authoring/starterProject.ts";
import type { ProfileId } from "../../src/runtime/profile.ts";
import {
  createProjectAssistDriver,
  PROJECT_ASSIST_TOOLS,
  PROJECT_ASSIST_TOOL_NAMES,
} from "../src/agent/projectAssistTools.ts";

const PROFILE_ID: ProfileId = "2.936";

function filesRecord(project: StarterProject): Record<string, Uint8Array> {
  return Object.fromEntries(project.files());
}

function claimedSources(project: StarterProject): Record<string, string> {
  const sources: Record<string, string> = {};
  for (const [num, source] of project.sources.logics) sources[`logic:${num}`] = source;
  for (const [num, source] of project.sources.pictures) sources[`picture:${num}`] = source;
  for (const [num, input] of project.sources.views) sources[`view:${num}`] = JSON.stringify(input);
  for (const [num, tracks] of project.sources.sounds)
    sources[`sound:${num}`] = JSON.stringify(tracks);
  sources["words"] = JSON.stringify([...project.sources.words]);
  sources["inventory"] = JSON.stringify(project.sources.objects);
  return sources;
}

function authoredDraft(project: StarterProject): ProjectDraft {
  const read = readProjectDocuments({
    files: filesRecord(project),
    profileId: project.profileId,
    sources: claimedSources(project),
    bindings: project.bindings,
  });
  assert.deepEqual(read.diagnostics, []);
  return new ProjectDraft(read.documents);
}

function capture(project: StarterProject, draft: ProjectDraft): AgentWorkspace {
  return captureAgentWorkspace({ draft, files: filesRecord(project), profileId: PROFILE_ID });
}

function editDraft(draft: ProjectDraft, key: string, content: string | Uint8Array | null): void {
  draft.edit(key, content, draft.capture().version(key));
}

function room1Key(project: StarterProject): string {
  return `logic:${project.bindings["first_room"]!.num}`;
}

describe("read_project_context / read_document", () => {
  test("context lists the complete captured set with profile and diagnostics", () => {
    const project = createStarterProject("starter");
    const draft = authoredDraft(project);
    const driver = createProjectAssistDriver(capture(project, draft));
    const result = driver.execute("read_project_context", {});
    assert.equal(result.success, true);
    const details = result.details!;
    assert.equal(details["profileId"], PROFILE_ID);
    assert.equal(details["compilable"], true);
    const docs = details["documents"] as { key: string; kind: string; size: number }[];
    assert.ok(docs.length > 3);
    assert.ok(docs.some((d) => d.key === "logic:0" && d.kind === "text"));
    assert.ok(docs.some((d) => d.key === "words"));
    // Variable-driven references are reported as warnings, never hidden.
    assert.ok(
      (details["diagnostics"] as { severity: string }[]).every((d) => d.severity === "warning"),
    );
    assert.equal(details["pendingProposal"], null);
  });

  test("context reports an uncompilable draft honestly; the broken text stays readable", () => {
    const project = createStarterProject("starter");
    const draft = authoredDraft(project);
    const key = room1Key(project);
    const broken = "if (isset(f5)) {\n  print(m1);";
    editDraft(draft, key, broken);
    const driver = createProjectAssistDriver(capture(project, draft));

    const context = driver.execute("read_project_context", {});
    assert.equal(context.details!["compilable"], false);
    assert.ok(
      (context.details!["diagnostics"] as { key: string | null; severity: string }[]).some(
        (d) => d.key === key && d.severity === "error",
      ),
    );

    const read = driver.execute("read_document", { key, offset: null, limit: null });
    assert.equal(read.success, true);
    assert.ok(read.message!.includes(broken), "exact broken source is returned");
    assert.equal(read.details!["length"], broken.length);
  });

  test("read_document pages text by UTF-16 offset with truthful bounds", () => {
    const project = createStarterProject("starter");
    const draft = authoredDraft(project);
    const key = room1Key(project);
    const source = project.sources.logics.get(project.bindings["first_room"]!.num)!;
    const driver = createProjectAssistDriver(capture(project, draft));

    const first = driver.execute("read_document", { key, offset: 0, limit: 40 });
    assert.equal(first.success, true);
    assert.equal(first.details!["kind"], "text");
    assert.equal(first.details!["length"], source.length);
    assert.ok(first.message!.endsWith(source.slice(0, 40)));
    assert.equal(first.details!["nextOffset"], 40);
    assert.equal(first.details!["sha256"], sha256Hex(new TextEncoder().encode(source)));

    const rest = driver.execute("read_document", { key, offset: 40, limit: null });
    assert.equal(rest.details!["nextOffset"], null);
    assert.ok(rest.message!.endsWith(source.slice(40)));
  });

  test("read_document on a byte document returns hash, length and a bounded window", () => {
    const project = createStarterProject("starter");
    // No source claims: the picture document is retained native bytes.
    const read = readProjectDocuments({
      files: filesRecord(project),
      profileId: project.profileId,
      bindings: project.bindings,
    });
    const draft = new ProjectDraft(read.documents);
    const docs = read.documents;
    const byteKey = Object.keys(docs).find((k) => docs[k] instanceof Uint8Array)!;
    assert.ok(byteKey, "expected a byte document");
    const bytes = docs[byteKey] as Uint8Array;
    const driver = createProjectAssistDriver(capture(project, draft));

    const result = driver.execute("read_document", { key: byteKey, offset: 0, limit: 2048 });
    assert.equal(result.success, true);
    assert.equal(result.details!["kind"], "bytes");
    assert.equal(result.details!["length"], bytes.byteLength);
    assert.equal(result.details!["sha256"], sha256Hex(bytes));
    const window = String(result.details!["base64"]);
    // Explicit windows retain their requested length within the read allowance.
    assert.ok(window.length <= Math.ceil(2048 / 3) * 4);
  });

  test("read_document rejects invalid and absent keys without throwing", () => {
    const project = createStarterProject("starter");
    const driver = createProjectAssistDriver(capture(project, authoredDraft(project)));
    assert.equal(driver.execute("read_document", { key: "nonsense" }).success, false);
    const absent = driver.execute("read_document", { key: "logic:200", offset: 0, limit: 10 });
    assert.equal(absent.success, false);
    assert.match(absent.error!, /No document 'logic:200'/);
  });
});

describe("propose_project_documents", () => {
  test("a valid coordinated change issues a proposal; nothing is applied", () => {
    const project = createStarterProject("starter");
    const draft = authoredDraft(project);
    const driver = createProjectAssistDriver(capture(project, draft));
    const room = room1Key(project);
    const newSource = "return;\n";
    const result = driver.execute("propose_project_documents", {
      label: "simplify room",
      changes: [
        { key: room, content: newSource },
        { key: "words", content: JSON.stringify([...project.sources.words, ["grumble", 7]]) },
      ],
    });
    assert.equal(result.success, true, result.error ?? "Expected a valid proposal.");
    assert.deepEqual(result.details!["keys"], [room, "words"]);
    assert.equal(driver.proposals, 1);
    const pending = driver.pending()!;
    assert.ok(pending);
    assert.equal(
      draft.capture().read(room)!.content,
      project.sources.logics.get(project.bindings["first_room"]!.num),
      "the draft is untouched until accepted",
    );
  });

  test("a refused change keeps the previously issued proposal", () => {
    const project = createStarterProject("starter");
    const draft = authoredDraft(project);
    const driver = createProjectAssistDriver(capture(project, draft));
    const room = room1Key(project);
    assert.equal(
      driver.execute("propose_project_documents", {
        label: "good",
        changes: [{ key: "logic:9", content: "return;\n" }],
      }).success,
      true,
    );
    const first = driver.pending()!;

    const refused = driver.execute("propose_project_documents", {
      label: "bad",
      changes: [{ key: room, content: "if (isset(" }],
    });
    assert.equal(refused.success, false);
    assert.equal(driver.refusals, 1);
    assert.ok((refused.details!["diagnostics"] as { key: string | null }[]).length > 0);
    assert.equal(driver.pending(), first, "the earlier valid proposal still stands");
  });

  test("a dangling reference returns document-scoped diagnostics and writes nothing", () => {
    const project = createStarterProject("starter");
    const draft = authoredDraft(project);
    const driver = createProjectAssistDriver(capture(project, draft));
    const refused = driver.execute("propose_project_documents", {
      label: "dangle",
      changes: [{ key: "logic:9", content: "call(10);\nreturn;" }],
    });
    assert.equal(refused.success, false);
    assert.ok(
      (refused.details!["diagnostics"] as { key: string | null }[]).some(
        (d) => d.key === "logic:9",
      ),
      JSON.stringify(refused.details),
    );
  });

  test("no-op changes and malformed arguments refuse before validation", () => {
    const project = createStarterProject("starter");
    const draft = authoredDraft(project);
    const driver = createProjectAssistDriver(capture(project, draft));
    const room = room1Key(project);
    const current = project.sources.logics.get(project.bindings["first_room"]!.num)!;

    const noop = driver.execute("propose_project_documents", {
      label: "same",
      changes: [{ key: room, content: current }],
    });
    assert.equal(noop.success, false);
    assert.match(noop.error!, /no difference/);

    const dup = driver.execute("propose_project_documents", {
      label: "dup",
      changes: [
        { key: room, content: "return;\n" },
        { key: room, content: "return;\n" },
      ],
    });
    assert.equal(dup.success, false);
    assert.match(dup.error!, /Duplicate/);

    const coordinated = driver.execute("propose_project_documents", {
      label: "flood",
      changes: Array.from({ length: 41 }, (_, i) => ({
        key: `logic:${i + 10}`,
        content: "return;\n",
      })),
    });
    assert.equal(coordinated.success, true, coordinated.error ?? "");
  });

  test("a second successful call replaces the pending proposal entirely", () => {
    const project = createStarterProject("starter");
    const draft = authoredDraft(project);
    const driver = createProjectAssistDriver(capture(project, draft));
    driver.execute("propose_project_documents", {
      label: "first",
      changes: [{ key: "logic:9", content: "return;\n" }],
    });
    driver.execute("propose_project_documents", {
      label: "second",
      changes: [{ key: "logic:10", content: "return;\n" }],
    });
    const pending = driver.pending()!;
    assert.equal(pending.label, "second");
    assert.deepEqual(
      pending.changes().map((c) => c.key),
      ["logic:10"],
      "complete-replacement: the earlier change set does not accumulate",
    );
  });
});

describe("withdraw and dispatch policy", () => {
  test("withdraw erases the pending proposal exactly once", () => {
    const project = createStarterProject("starter");
    const draft = authoredDraft(project);
    const driver = createProjectAssistDriver(capture(project, draft));
    assert.equal(
      driver.execute("withdraw_proposal", { reason: "nothing yet" }).success,
      false,
      "no pending proposal to withdraw",
    );
    driver.execute("propose_project_documents", {
      label: "temp",
      changes: [{ key: "logic:9", content: "return;\n" }],
    });
    const withdrawn = driver.execute("withdraw_proposal", { reason: "not worth it" });
    assert.equal(withdrawn.success, true);
    assert.equal(driver.pending(), null);
  });

  test("names outside the catalog are denied before dispatch", () => {
    const project = createStarterProject("starter");
    const draft = authoredDraft(project);
    const driver = createProjectAssistDriver(capture(project, draft));
    for (const name of ["write_view", "apply_changes", "keep_project", "read_documentx"]) {
      const result = driver.execute(name, {});
      assert.equal(result.success, false, name);
      assert.match(result.error!, /not available in this phase/);
    }
  });

  test("the reused AGI reference tools answer under the workspace profile", () => {
    const project = createStarterProject("starter");
    const driver = createProjectAssistDriver(capture(project, authoredDraft(project)));
    const commands = driver.execute("read_command_reference", {
      query: "said",
      kind: null,
      offset: null,
    });
    assert.equal(commands.success, true);
    assert.equal(commands.details!["profile"], PROFILE_ID);
    const guide = driver.execute("read_authoring_guide", { topic: null });
    assert.equal(guide.success, true);
    assert.match(guide.message!, /topics/i);
  });

  test("catalog names stay stable and distinct", () => {
    assert.deepEqual(
      [...PROJECT_ASSIST_TOOL_NAMES].sort(),
      [...PROJECT_ASSIST_TOOLS.map((t) => t.name)].sort(),
    );
    assert.ok(new Set(PROJECT_ASSIST_TOOL_NAMES).size === PROJECT_ASSIST_TOOL_NAMES.length);
    for (const name of [
      "read_project_context",
      "read_document",
      "propose_project_documents",
      "withdraw_proposal",
      "read_command_reference",
      "read_authoring_guide",
    ])
      assert.ok(PROJECT_ASSIST_TOOL_NAMES.includes(name), name);
  });
});

test("document reads return complete ordinary text and binary resources", () => {
  const project = createStarterProject("starter");
  const draft = authoredDraft(project);
  const text = "// details\n".repeat(9000) + "return;\n";
  editDraft(draft, "logic:200", text);
  const driver = createProjectAssistDriver(capture(project, draft));
  const result = driver.execute("read_document", { key: "logic:200" });
  assert.equal(result.success, true);
  assert.ok(result.message?.endsWith(text));
  assert.equal(result.details?.["nextOffset"], null);
  const largeProposal = driver.execute("propose_project_documents", {
    label: "Coordinated shared logic",
    changes: Array.from({ length: 41 }, (_, i) => ({
      key: `logic:${i + 100}`,
      content: "return;\n",
    })),
  });
  assert.equal(largeProposal.success, true, largeProposal.error ?? "");
});

test("binary reads default to the whole AGI resource", () => {
  const project = createStarterProject("starter");
  const draft = authoredDraft(project);
  const bytes = new Uint8Array(60000).fill(255);
  editDraft(draft, "picture:200", bytes);
  const driver = createProjectAssistDriver(capture(project, draft));
  const result = driver.execute("read_document", { key: "picture:200" });
  assert.equal(result.success, true, result.error ?? "");
  assert.equal(result.details?.["nextOffset"], null);
  assert.deepEqual(
    new Uint8Array(Buffer.from(String(result.details?.["base64"]), "base64")),
    bytes,
  );
});
