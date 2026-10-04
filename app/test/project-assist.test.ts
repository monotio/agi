import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { providerSse } from "../../test/provider-stream.ts";
import type { AgentToolResult } from "../../src/agent/agentState.ts";
import type { LlmConfig, LlmTurnResult, UnifiedConversation } from "../src/agent/llmClient.ts";
import {
  createProjectAssist,
  type ProjectAssistProposal,
  type ProjectAssistWorkspace,
} from "../src/agent/projectAssist.ts";
import { ProjectDraft } from "../../src/authoring/projectDraft.ts";
import { readProjectDocuments } from "../../src/authoring/projectDocuments.ts";
import { createStarterProject, type StarterProject } from "../../src/authoring/starterProject.ts";
import type { ProfileId } from "../../src/runtime/profile.ts";

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

function editDraft(draft: ProjectDraft, key: string, content: string | Uint8Array | null): void {
  draft.edit(key, content, draft.capture().version(key));
}

function room1Key(project: StarterProject): string {
  return `logic:${project.bindings["first_room"]!.num}`;
}

/** Grumble-response coordinated change: room, dictionary, binding and a new room. */
function grumbleChanges(project: StarterProject): { key: string; content: string }[] {
  const room1num = project.bindings["first_room"]!.num;
  const room1 = project.sources.logics.get(room1num)!;
  const edited = room1.replace(
    'if (said("die"))',
    'if (said("grumble")) { print("The clearing grumbles back."); }\nif (said("die"))',
  );
  assert.notEqual(edited, room1);
  const nextId = Math.max(...project.sources.words.values()) + 1;
  const words = JSON.stringify([...project.sources.words, ["grumble", nextId]]);
  const bindings = JSON.stringify({
    ...project.bindings,
    grumble_room: { kind: "logic", num: 14 },
  });
  const room14 =
    '// The grumble room.\nif (said("grumble")) {\n  print(m1);\n}\nif (said("look")) {\n  assignn(v0, first_room);\n  call.v(v0);\n}\nreturn;';
  return [
    { key: room1Key(project), content: edited },
    { key: "logic:14", content: room14 },
    { key: "bindings", content: bindings },
    { key: "words", content: words },
  ];
}

interface FakeTurn {
  readonly text?: string;
  readonly tools?: readonly { name: string; input?: Record<string, unknown> }[];
}
type FakeStep = FakeTurn | { hold: FakeTurn };

function fakeConversation(steps: readonly FakeStep[]) {
  const queue = [...steps];
  const sent: string[] = [];
  const resultsSeen: { name: string; result: AgentToolResult }[] = [];
  const interruptions: string[] = [];
  const pending: { resolve: (turn: LlmTurnResult) => void; turn: FakeTurn }[] = [];
  const names = new Map<string, string>();
  let seq = 0;
  let allowed: readonly string[] | undefined;
  const mk = (t: FakeTurn): LlmTurnResult => ({
    ...(t.text !== undefined ? { text: t.text } : {}),
    toolCalls: (t.tools ?? []).map((tool) => {
      const id = `f${++seq}`;
      names.set(id, tool.name);
      return { id, name: tool.name, input: tool.input ?? {} };
    }),
  });
  const next = (): Promise<LlmTurnResult> => {
    const step = queue.shift();
    if (step === undefined) return Promise.resolve(mk({ text: "(script exhausted)" }));
    if ("hold" in step)
      return new Promise<LlmTurnResult>((resolve) => pending.push({ resolve, turn: step.hold }));
    return Promise.resolve(mk(step));
  };
  const conversation: UnifiedConversation = {
    setAvailableTools(toolNames) {
      allowed = toolNames === undefined ? undefined : [...toolNames];
    },
    sendUserMessage(text) {
      sent.push(text);
      return next();
    },
    appendToolResults(results) {
      for (const r of results)
        resultsSeen.push({ name: names.get(r.toolCallId) ?? r.toolCallId, result: r.result });
    },
    complete() {
      return next();
    },
    getTranscript() {
      return [];
    },
    recordInterruption(text) {
      interruptions.push(text);
    },
  };
  return {
    conversation,
    sent,
    resultsSeen,
    interruptions,
    allowed: () => allowed,
    hasPendingHold: () => pending.length > 0,
    release: () => pending.shift()?.resolve(mk(pending.shift === undefined ? {} : {})),
    releaseHold: () => {
      const p = pending.shift();
      assert.ok(p, "no deferred provider turn is pending");
      p.resolve(mk(p.turn));
    },
  };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function createAssist(options: {
  project?: StarterProject;
  draft?: ProjectDraft;
  conversationFactory?: (config: LlmConfig) => UnifiedConversation;
  autoApproveEligible?: boolean;
  onEvent?: (kind: string, detail: string, data?: unknown) => void;
  events?: { kind: string; detail: string; data?: unknown }[];
}) {
  const project = options.project ?? createStarterProject("starter");
  const draft = options.draft ?? authoredDraft(project);
  const files = filesRecord(project);
  const captured: { factory?: LlmConfig } = {};
  const current: { workspace: ProjectAssistWorkspace } = {
    workspace: {
      draft,
      files,
      profileId: PROFILE_ID,
      ...(options.autoApproveEligible === false ? {} : { autoApproveEligible: true }),
    },
  };
  const events = options.events ?? [];
  const assist = createProjectAssist({
    workspace: () => current.workspace,
    onEvent: (kind, detail, data) => events.push({ kind, detail, data }),
    ...(options.conversationFactory
      ? {
          conversationFactory: (config, run) => {
            captured.factory = config;
            void run;
            return options.conversationFactory!(config);
          },
        }
      : {}),
  });
  return { assist, project, draft, files, current, events, captured };
}

/** A real provider name so the injected fake conversation drives the loop. */
function testConfig(): LlmConfig {
  return { provider: "openai", apiKey: "placeholder", model: "gpt-6-sol" };
}

describe("projectAssist: review lifecycle", () => {
  test("a coordinated logic+words+bindings+new-room request reaches review and applies once", async () => {
    const { assist, project, draft, captured } = createAssist({
      conversationFactory: () =>
        fakeConversation([
          { tools: [{ name: "read_project_context" }] },
          { tools: [{ name: "read_document", input: { key: room1Key(project) } }] },
          {
            tools: [
              {
                name: "propose_changes",
                input: { label: "add grumble room", changes: grumbleChanges(project) },
              },
            ],
          },
          { text: "Added a grumble response." },
        ]).conversation,
    });
    assist.connect(testConfig());
    const result = await assist.request({ instruction: "make the clearing grumble" });

    assert.equal(result.outcome, "review");
    assert.ok(result.requestId.length > 0);
    assert.equal(result.text, "Added a grumble response.");
    assert.deepEqual(
      [...result.keys].sort(),
      ["bindings", room1Key(project), "logic:14", "words"].sort(),
    );
    assert.equal(result.profileId, PROFILE_ID);
    assert.equal(result.proposals, 1);
    assert.ok(result.proposal);
    // The caller's config stays owned by the session.
    assert.equal(captured.factory?.provider, "openai");
    // Nothing reached the draft before acceptance.
    assert.equal(draft.capture().read("logic:14"), undefined);

    const accept = assist.acceptProposal(result.proposal!);
    assert.equal(accept.ok, true);
    assert.ok(accept.ok);
    assert.equal(draft.capture().read("logic:14")!.content, grumbleChanges(project)[1]!.content);
    // One coordinated undo group reverts the whole transaction.
    draft.undo(accept.transaction.id);
    assert.equal(draft.capture().read("logic:14"), undefined);
    assert.equal(
      draft.capture().read("words")!.content,
      JSON.stringify([...project.sources.words]),
    );
  });

  test("a broken draft stays readable and is repaired by a direct proposal", async () => {
    const { assist, project, draft } = createAssist({});
    const key = room1Key(project);
    const broken = "if (isset(f5)) {\n  print(m1);";
    editDraft(draft, key, broken);
    const fake = fakeConversation([
      { tools: [{ name: "read_document", input: { key } }] },
      {
        tools: [
          {
            name: "propose_changes",
            input: { label: "fix", changes: [{ key, content: "return;\n" }] },
          },
        ],
      },
      { text: "Repaired." },
    ]);
    const { assist: a2 } = createAssist({
      project,
      draft,
      conversationFactory: () => fake.conversation,
    });
    void assist;
    a2.connect(testConfig());
    const result = await a2.request({ instruction: "fix the broken room" });
    assert.equal(result.outcome, "review");
    // The model actually saw the exact broken authored text.
    const readResult = fake.resultsSeen.find((r) => r.name === "read_document")!;
    assert.equal(readResult.result.success, true);
    assert.match(readResult.result.message!, /print\(m1\);$/);
    const accept = a2.acceptProposal(result.proposal!);
    assert.equal(accept.ok, true);
    assert.equal(draft.capture().read(key)!.content, "return;\n");
  });

  test("reject releases the issued proposal; accept afterwards refuses", async () => {
    const { assist, project } = createAssist({
      conversationFactory: () =>
        fakeConversation([
          {
            tools: [
              {
                name: "propose_changes",
                input: { label: "temp", changes: [{ key: "logic:9", content: "return;\n" }] },
              },
            ],
          },
          { text: "Staged." },
        ]).conversation,
    });
    assist.connect(testConfig());
    const result = await assist.request({ instruction: "stage a change" });
    assert.equal(result.outcome, "review");
    assert.equal(assist.rejectProposal(result.proposal!), true);
    const second = assist.acceptProposal(result.proposal!);
    assert.equal(second.ok, false);
    assert.equal(second.ok ? undefined : second.reason, "rejected");
    void project;
  });

  test("withdrawal inside the request ends without a proposal", async () => {
    const { assist } = createAssist({
      conversationFactory: () =>
        fakeConversation([
          {
            tools: [
              {
                name: "propose_changes",
                input: { label: "temp", changes: [{ key: "logic:9", content: "return;\n" }] },
              },
            ],
          },
          { tools: [{ name: "withdraw_changes", input: { reason: "not worth it" } }] },
          { text: "Withdrew." },
        ]).conversation,
    });
    assist.connect(testConfig());
    const result = await assist.request({ instruction: "try something" });
    assert.equal(result.outcome, "none");
    assert.equal(result.proposals, 1);
    assert.equal(assist.state().pendingProposal, null);
  });

  test("unknown provider tool names are denied and surfaced in the tool result", async () => {
    const fake = fakeConversation([
      { tools: [{ name: "write_view", input: { view: 42 } }] },
      { text: "Nothing changed." },
    ]);
    const { assist, draft } = createAssist({ conversationFactory: () => fake.conversation });
    assist.connect(testConfig());
    const result = await assist.request({ instruction: "do something" });
    assert.equal(result.outcome, "none");
    assert.equal(fake.resultsSeen[0]!.result.success, false);
    assert.match(fake.resultsSeen[0]!.result.error!, /not available in this phase/);
    assert.equal(draft.capture().read("view:42"), undefined);
  });
});

describe("projectAssist: cancellation, epochs and stale results", () => {
  test("disconnect during a provider wait cancels and a late turn cannot land", async () => {
    const fake = fakeConversation([{ hold: { text: "late answer" } }]);
    const { assist, events } = createAssist({ conversationFactory: () => fake.conversation });
    assist.connect(testConfig());
    const request = assist.request({ instruction: "hello" });
    await settle();
    assert.equal(assist.state().phase, "running");
    assist.disconnect();
    const result = await request;
    assert.equal(result.outcome, "cancelled");
    assert.equal(fake.interruptions.length > 0, true, "the pending turn was interrupted once");
    // The ignored-abort late completion is swallowed — no response event.
    fake.releaseHold();
    await settle();
    assert.equal(events.filter((e) => e.kind === "response").length, 0);
    assert.equal(assist.state().pendingProposal, null);
  });

  test("stop parks at the next checkpoint; resume continues; cancel ends the request", async () => {
    const fake = fakeConversation([
      { hold: { tools: [{ name: "read_project_context" }] } },
      { text: "after" },
    ]);
    const { assist } = createAssist({ conversationFactory: () => fake.conversation });
    assist.connect(testConfig());
    const request = assist.request({ instruction: "hello" });
    await settle();
    assist.stop();
    fake.releaseHold(); // the provider turn lands after stop — parks before executing
    await settle();
    assert.equal(assist.state().phase, "paused");

    assist.cancel();
    const result = await request;
    assert.equal(result.outcome, "cancelled");
  });

  test("stop then resume completes the request normally", async () => {
    const fake = fakeConversation([
      {
        tools: [
          {
            name: "propose_changes",
            input: { label: "one", changes: [{ key: "logic:9", content: "return;\n" }] },
          },
        ],
      },
      { hold: { text: "done" } },
    ]);
    const { assist } = createAssist({ conversationFactory: () => fake.conversation });
    assist.connect(testConfig());
    const request = assist.request({ instruction: "add room" });
    await settle();
    assist.stop();
    await settle();
    fake.releaseHold();
    await settle();
    // Terminal turn queued while stopped — the loop parks before consuming it.
    assist.resume();
    const result = await request;
    assert.equal(result.outcome, "review");
    assert.deepEqual(result.keys, ["logic:9"]);
  });

  test("typing during generation leaves a stale reviewable proposal", async () => {
    const project = createStarterProject("starter");
    const draft = authoredDraft(project);
    const fake = fakeConversation([
      {
        hold: {
          tools: [
            {
              name: "propose_changes",
              input: { label: "typed-over", changes: [{ key: "logic:9", content: "return;\n" }] },
            },
          ],
        },
      },
      { text: "Staged." },
    ]);
    const { assist } = createAssist({
      project,
      draft,
      conversationFactory: () => fake.conversation,
    });
    assist.connect(testConfig());
    const request = assist.request({ instruction: "add room" });
    await settle();
    editDraft(draft, "world", '{"typed":true}');
    fake.releaseHold();
    const result = await request;
    assert.equal(result.outcome, "stale");
    const proposal = result.proposal!;
    assert.equal(proposal.stale(), true);
    // The retained diff stays reviewable, but apply refuses.
    assert.deepEqual(
      proposal.changes().map((c) => c.key),
      ["logic:9"],
    );
    const accept = assist.acceptProposal(proposal);
    assert.equal(accept.ok, false);
    assert.equal(accept.ok ? undefined : accept.reason, "stale");
    assert.equal(draft.capture().read("logic:9"), undefined);
  });

  test("a newer request supersedes; the old turn cannot apply or update state", async () => {
    const fake1 = fakeConversation([{ hold: { text: "late" } }]);
    let which = 0;
    const fakes = [
      fake1,
      fakeConversation([
        {
          tools: [
            {
              name: "propose_changes",
              input: { label: "second", changes: [{ key: "logic:9", content: "return;\n" }] },
            },
          ],
        },
        { text: "Second done." },
      ]),
    ];
    const { assist } = createAssist({ conversationFactory: () => fakes[which++]!.conversation });
    assist.connect(testConfig());
    const first = assist.request({ instruction: "first" });
    await settle();
    const second = assist.request({ instruction: "second" });
    const [r1, r2] = await Promise.all([first, second]);
    assert.equal(r1.outcome, "cancelled");
    assert.equal(r2.outcome, "review");
    assert.notEqual(r1.requestId, r2.requestId);
    // The abandoned conversation's late turn lands into nothing.
    fake1.releaseHold();
    await settle();
    assert.equal(assist.state().lastResult?.requestId, r2.requestId);
  });

  test("a replaced workspace ends the request and refuses the issued handle", async () => {
    const project = createStarterProject("starter");
    const fake = fakeConversation([{ hold: { text: "late" } }]);
    const { assist, draft, current } = createAssist({
      project,
      conversationFactory: () => fake.conversation,
    });
    assist.connect(testConfig());
    const epoch = assist.state().workspaceEpoch;
    const request = assist.request({ instruction: "hello" });
    await settle();
    // The host reopened a different workspace under the same accessor; the next
    // state poll detects it and ends the request before the late turn lands.
    const other = createStarterProject("starter");
    current.workspace = {
      draft: authoredDraft(other),
      files: filesRecord(other),
      profileId: PROFILE_ID,
    };
    assist.state();
    const result = await request;
    assert.equal(result.outcome, "cancelled");
    assert.ok(assist.state().workspaceEpoch > epoch);
    fake.releaseHold();
    await settle();
    assert.equal(assist.state().pendingProposal, null);
    void draft;
  });

  test("foreign and fake handles are refused without touching the draft", async () => {
    const mk = () =>
      createAssist({
        conversationFactory: () =>
          fakeConversation([
            {
              tools: [
                {
                  name: "propose_changes",
                  input: { label: "x", changes: [{ key: "logic:9", content: "return;\n" }] },
                },
              ],
            },
            { text: "done" },
          ]).conversation,
      });
    const a = mk();
    const b = mk();
    a.assist.connect(testConfig());
    b.assist.connect(testConfig());
    const ra = await a.assist.request({ instruction: "a" });
    const rb = await b.assist.request({ instruction: "b" });
    const foreign = a.assist.acceptProposal(rb.proposal!);
    assert.equal(foreign.ok, false);
    assert.equal(foreign.ok ? undefined : foreign.reason, "foreign");
    const fake = a.assist.acceptProposal({
      requestId: ra.requestId,
    } as unknown as ProjectAssistProposal);
    assert.equal(fake.ok, false);
    // The genuine handle still accepts.
    assert.equal(a.assist.acceptProposal(ra.proposal!).ok, true);
  });

  test("a refused revision keeps the earlier valid proposal reviewable", async () => {
    const project = createStarterProject("starter");
    const { assist, draft } = createAssist({
      project,
      conversationFactory: () =>
        fakeConversation([
          {
            tools: [
              {
                name: "propose_changes",
                input: { label: "good", changes: [{ key: "logic:9", content: "return;\n" }] },
              },
            ],
          },
          {
            tools: [
              {
                name: "propose_changes",
                input: {
                  label: "bad",
                  changes: [{ key: room1Key(project), content: "if (isset(" }],
                },
              },
            ],
          },
          { text: "One valid proposal stands." },
        ]).conversation,
    });
    assist.connect(testConfig());
    const result = await assist.request({ instruction: "change things" });
    assert.equal(result.outcome, "review");
    assert.equal(result.refusals, 1);
    assert.equal(result.diagnostics.length > 0, true);
    assert.deepEqual(result.keys, ["logic:9"]);
    assert.equal(assist.acceptProposal(result.proposal!).ok, true);
    assert.equal(draft.capture().read("logic:9")!.content, "return;\n");
  });
});

describe("projectAssist: approval modes", () => {
  const proposeThenDone = () =>
    [
      {
        tools: [
          {
            name: "propose_changes",
            input: { label: "auto", changes: [{ key: "logic:9", content: "return;\n" }] },
          },
        ],
      },
      { text: "Done." },
    ] as const;

  test("review is the default even on an eligible workspace", async () => {
    const { assist } = createAssist({
      conversationFactory: () => fakeConversation([...proposeThenDone()]).conversation,
    });
    assist.connect(testConfig());
    assert.equal(assist.state().approval.mode, "review");
    const result = await assist.request({ instruction: "x" });
    assert.equal(result.outcome, "review");
  });

  test("explicit scoped auto-approval applies one atomic transaction, kept bytes untouched", async () => {
    const project = createStarterProject("starter");
    const { assist, draft } = createAssist({
      project,
      conversationFactory: () => fakeConversation([...proposeThenDone()]).conversation,
    });
    const filesBefore = filesRecord(project);
    assist.connect(testConfig());
    assist.setApprovalMode({ mode: "auto", scope: ["logic:9"] });
    const result = await assist.request({ instruction: "add a stub room" });
    assert.equal(result.outcome, "applied");
    assert.equal(draft.capture().read("logic:9")!.content, "return;\n");
    assert.equal(result.transaction !== undefined, true);
    if (result.transaction) {
      draft.undo(result.transaction.id);
      assert.equal(draft.capture().read("logic:9"), undefined);
    }
    for (const [name, bytes] of Object.entries(filesBefore))
      assert.deepEqual(filesRecord(project)[name], bytes, name);
  });

  test("deletions always stay in review, even inside an auto scope", async () => {
    const { assist, draft } = createAssist({
      conversationFactory: () =>
        fakeConversation([
          {
            tools: [
              {
                name: "propose_changes",
                input: {
                  label: "remove",
                  changes: [
                    { key: "logic:9", content: "return;\n" },
                    { key: "logic:10", content: null },
                  ],
                },
              },
            ],
          },
          { text: "Done." },
        ]).conversation,
    });
    // Seed a document to delete.
    draft.edit("logic:10", "return;\n", draft.capture().version("logic:10"));
    assist.connect(testConfig());
    assist.setApprovalMode({ mode: "auto", scope: ["logic:9", "logic:10"] });
    const result = await assist.request({ instruction: "remove ten" });
    assert.equal(result.outcome, "review", "a deletion must never auto-apply");
    assert.deepEqual(result.deletions, ["logic:10"]);
  });

  test("auto scope narrower than the change set falls back to review", async () => {
    const { assist, draft, project } = createAssist({
      conversationFactory: (config) => {
        void config;
        const words = JSON.stringify([...project.sources.words, ["floop", 99]]);
        return fakeConversation([
          {
            tools: [
              {
                name: "propose_changes",
                input: {
                  label: "wide",
                  changes: [
                    { key: "logic:9", content: "return;\n" },
                    { key: "words", content: words },
                  ],
                },
              },
            ],
          },
          { text: "Done." },
        ]).conversation;
      },
    });
    assist.connect(testConfig());
    assist.setApprovalMode({ mode: "auto", scope: ["logic:9"] });
    const result = await assist.request({ instruction: "x" });
    assert.equal(result.outcome, "review", "words is outside the scope");
    assert.equal(
      draft.capture().read("words")!.content,
      JSON.stringify([...project.sources.words]),
    );
  });

  test("auto -> review mid-flight prevents the apply", async () => {
    const fake = fakeConversation([
      {
        hold: {
          tools: [
            {
              name: "propose_changes",
              input: { label: "x", changes: [{ key: "logic:9", content: "return;\n" }] },
            },
          ],
        },
      },
      { text: "Done." },
    ]);
    const { assist, draft } = createAssist({ conversationFactory: () => fake.conversation });
    assist.connect(testConfig());
    assist.setApprovalMode({ mode: "auto", scope: ["logic:9"] });
    const request = assist.request({ instruction: "x" });
    await settle();
    assist.setApprovalMode({ mode: "review" });
    fake.releaseHold();
    const result = await request;
    assert.equal(result.outcome, "review");
    assert.equal(draft.capture().read("logic:9"), undefined);
  });

  test("review -> auto mid-flight applies when the scope covers the change", async () => {
    const fake = fakeConversation([
      {
        hold: {
          tools: [
            {
              name: "propose_changes",
              input: { label: "x", changes: [{ key: "logic:9", content: "return;\n" }] },
            },
          ],
        },
      },
      { text: "Done." },
    ]);
    const { assist, draft } = createAssist({ conversationFactory: () => fake.conversation });
    assist.connect(testConfig());
    const request = assist.request({ instruction: "x" });
    await settle();
    assist.setApprovalMode({ mode: "auto", scope: ["logic:9"] });
    fake.releaseHold();
    const result = await request;
    assert.equal(result.outcome, "applied");
    assert.equal(draft.capture().read("logic:9")!.content, "return;\n");
  });

  test("a mutated caller scope array cannot widen authority", async () => {
    const scope = ["logic:9"];
    const { assist, project } = createAssist({
      conversationFactory: (config) => {
        void config;
        const words = JSON.stringify([...project.sources.words, ["floop", 99]]);
        return fakeConversation([
          {
            tools: [
              {
                name: "propose_changes",
                input: {
                  label: "wide",
                  changes: [
                    { key: "logic:9", content: "return;\n" },
                    { key: "words", content: words },
                  ],
                },
              },
            ],
          },
          { text: "Done." },
        ]).conversation;
      },
    });
    assist.connect(testConfig());
    assist.setApprovalMode({ mode: "auto", scope });
    scope.push("words");
    const result = await assist.request({ instruction: "x" });
    assert.equal(result.outcome, "review", "the session owns its scope copy");
  });

  test("a caller-mutated config object cannot rewrite the connected session", async () => {
    const { assist, captured } = createAssist({
      conversationFactory: () => fakeConversation([{ text: "ok" }]).conversation,
    });
    const cfg: LlmConfig = { provider: "openai", apiKey: "key-1", model: "m1", effort: "high" };
    assist.connect(cfg);
    cfg.apiKey = "";
    cfg.model = "changed";
    cfg.effort = "low";
    await assist.request({ instruction: "x" });
    assert.equal(captured.factory!.apiKey, "key-1");
    assert.equal(captured.factory!.model, "m1");
    assert.equal(captured.factory!.effort, "high");
  });

  test("auto-approval refuses on a workspace not declared eligible", async () => {
    const { assist, draft } = createAssist({
      autoApproveEligible: false,
      conversationFactory: () =>
        fakeConversation([
          {
            tools: [
              {
                name: "propose_changes",
                input: { label: "x", changes: [{ key: "logic:9", content: "return;\n" }] },
              },
            ],
          },
          { text: "Done." },
        ]).conversation,
    });
    assist.connect(testConfig());
    assist.setApprovalMode({ mode: "auto", scope: ["logic:9"] });
    const result = await assist.request({ instruction: "x" });
    assert.equal(result.outcome, "review");
    assert.equal(draft.capture().read("logic:9"), undefined);
  });

  test("reconnect resets approval to review and bumps the epoch", async () => {
    const { assist } = createAssist({});
    assist.connect(testConfig());
    const epoch = assist.state().connectionEpoch;
    assist.setApprovalMode({ mode: "auto", scope: ["logic:9"] });
    assist.disconnect();
    assist.connect(testConfig());
    assert.equal(assist.state().approval.mode, "review");
    assert.ok(assist.state().connectionEpoch > epoch);
  });
});

describe("projectAssist: guard rails", () => {
  test("closed sessions refuse work; disconnect refuses accept but keeps the diff readable", async () => {
    const { assist, draft } = createAssist({
      conversationFactory: () =>
        fakeConversation([
          {
            tools: [
              {
                name: "propose_changes",
                input: { label: "x", changes: [{ key: "logic:9", content: "return;\n" }] },
              },
            ],
          },
          { text: "Done." },
        ]).conversation,
    });
    assist.connect(testConfig());
    const result = await assist.request({ instruction: "x" });
    assert.equal(result.outcome, "review");
    const proposal = result.proposal!;
    assist.disconnect();
    const refused = assist.acceptProposal(proposal);
    assert.equal(refused.ok, false);
    assert.equal(refused.ok ? undefined : refused.reason, "closed");
    // The retained diff is still viewable.
    assert.deepEqual(
      proposal.changes().map((c) => c.key),
      ["logic:9"],
    );
    assert.equal(draft.capture().read("logic:9"), undefined);

    assist.close();
    assert.equal(assist.state().closed, true);
    await assert.rejects(assist.request({ instruction: "again" }), /closed/i);
    assert.throws(() => assist.connect(testConfig()), /closed/i);
  });

  test("a budget stop pauses the next provider request; resume lets it through", async (t) => {
    const requests: Record<string, unknown>[] = [];
    t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      const count = requests.length;
      return new Response(
        providerSse(
          "openai",
          count === 1
            ? {
                id: "one",
                status: "completed",
                usage: { input_tokens: 50000, output_tokens: 100 },
                output: [
                  {
                    type: "function_call",
                    call_id: "c1",
                    name: "read_project_context",
                    arguments: "{}",
                  },
                ],
              }
            : {
                id: "two",
                status: "completed",
                usage: { input_tokens: 10, output_tokens: 5 },
                output: [
                  {
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: "Read only." }],
                  },
                ],
              },
        ),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const { assist } = createAssist({});
    // No injected factory: the request goes through the real OpenAI transport.
    assist.connect({
      provider: "openai",
      apiKey: "placeholder",
      model: "gpt-6-sol",
      budgetUsd: 0.32,
    });
    const request = assist.request({ instruction: "inspect" });
    for (let i = 0; i < 8 && requests.length < 1; i++) await settle();
    for (let i = 0; i < 8 && assist.state().phase !== "paused"; i++) await settle();
    assert.equal(assist.state().phase, "paused");
    assert.match(assist.state().run?.reason ?? "", /Budget/i);
    assert.equal(requests.length, 1, "the second provider request waits for resume");
    assist.resume();
    const result = await request;
    assert.equal(requests.length, 2);
    assert.equal(result.outcome, "none");
    assert.equal(result.text, "Read only.");
  });

  test("the deterministic stub produces a read-only request without network", async () => {
    const { assist, draft, captured } = createAssist({});
    assist.connect({ provider: "stub", apiKey: "", model: "stub" });
    // No injected factory: the production default must wire the stub itself.
    const result = await assist.request({ instruction: "look around" });
    assert.equal(result.outcome, "none");
    assert.match(result.text, /look around/);
    assert.equal(captured.factory, undefined, "stub must not need the injected factory");
    assert.deepEqual(draft.dirtyKeys(), []);
    void captured;
  });
});

test("project assist completes after more than eight distinct tool rounds", async () => {
  const fake = fakeConversation([
    ...Array.from({ length: 12 }, (_, i) => ({
      tools: [{ name: "read_document", input: { key: `logic:${i}` } }],
    })),
    { text: "Inspection complete." },
  ]);
  const { assist } = createAssist({ conversationFactory: () => fake.conversation });
  assist.connect(testConfig());
  const result = await assist.request({ instruction: "Inspect the project." });
  assert.equal(result.text, "Inspection complete.");
  assert.equal(fake.resultsSeen.length, 12);
  assert.deepEqual(fake.interruptions, []);
});
