import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { executeAgentTool } from "../src/agent/tools.ts";
import {
  AgentCandidateError,
  captureAgentWorkspace,
  describeWorkspaceDefects,
  type AgentWorkspace,
} from "../src/authoring/projectAgentCandidate.ts";
import { compileProjectLogic } from "../src/authoring/projectLogic.ts";
import { ProjectDraft } from "../src/authoring/projectDraft.ts";
import {
  compileProjectDocuments,
  readProjectDocuments,
} from "../src/authoring/projectDocuments.ts";
import { createStarterProject, type StarterProject } from "../src/authoring/starterProject.ts";
import { containerFromResources, openContainer } from "../src/container/container.ts";
import { buildWordsTok } from "../src/logic/words.ts";
import { PROFILES, type ProfileId } from "../src/runtime/profile.ts";

const PROFILE_ID: ProfileId = "2.936";
const PROFILE = PROFILES[PROFILE_ID]!;

function filesRecord(project: StarterProject): Record<string, Uint8Array> {
  return Object.fromEntries(project.files());
}

/** The authored claims a fresh project can prove against its own bytes. */
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

/** A draft holding the complete authored document set of a real project. */
function authoredDraft(project: StarterProject): {
  draft: ProjectDraft;
  documents: Record<string, string | Uint8Array>;
} {
  const read = readProjectDocuments({
    files: filesRecord(project),
    profileId: project.profileId,
    sources: claimedSources(project),
    bindings: project.bindings,
  });
  assert.deepEqual(read.diagnostics, []);
  return { draft: new ProjectDraft(read.documents), documents: { ...read.documents } };
}

function capture(
  project: StarterProject,
  draft: ProjectDraft,
  options: { files?: Record<string, Uint8Array>; allowMissingRooms?: boolean } = {},
): AgentWorkspace {
  return captureAgentWorkspace({
    draft,
    files: options.files ?? filesRecord(project),
    profileId: PROFILE_ID,
    ...(options.allowMissingRooms ? { allowMissingRooms: true } : {}),
  });
}

function editDraft(draft: ProjectDraft, key: string, content: string | Uint8Array | null): void {
  draft.edit(key, content, draft.capture().version(key));
}

/** assert.throws does not return the error on this Node — capture it directly. */
function thrown<T extends Error>(fn: () => unknown, ctor: new (...args: never[]) => T): T {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ctor, `expected ${ctor.name}, got ${String(error)}`);
    return error;
  }
  assert.fail(`expected ${ctor.name} to be thrown`);
}

function assertFilesEqual(
  actual: ReadonlyMap<string, Uint8Array>,
  expected: ReadonlyMap<string, Uint8Array>,
): void {
  assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort());
  for (const [name, bytes] of expected)
    assert.deepEqual([...actual.get(name)!], [...bytes], `${name} bytes differ`);
}

// Hand-written native SOUND stream bytes, laid out directly — the four-lane
// header plus contiguous streams; nothing calls the encoder under test.
function toneRecord(lane: number, ticks: number, divisor: number, attenuation: number): number[] {
  return [
    ticks & 0xff,
    (ticks >> 8) & 0xff,
    (divisor >> 4) & 0x3f,
    0x80 | (lane << 5) | (divisor & 0x0f),
    0x90 | (lane << 5) | attenuation,
  ];
}
const END = [0xff, 0xff];
function payload(streams: readonly (readonly number[])[]): Uint8Array {
  const lengths = streams.map((s) => s.length);
  const offsets = [
    8,
    8 + lengths[0]!,
    8 + lengths[0]! + lengths[1]!,
    8 + lengths[0]! + lengths[1]! + lengths[2]!,
  ];
  const out: number[] = [];
  for (const off of offsets) out.push(off & 0xff, (off >> 8) & 0xff);
  for (const stream of streams) out.push(...stream);
  return new Uint8Array(out);
}

// Lane 0 holds two tone events; lanes 1-3 are bare terminators.
const TWO_TONE_PAYLOAD = payload([
  [...toneRecord(0, 30, 226, 4), ...toneRecord(0, 20, 380, 9), ...END],
  [...END],
  [...END],
  [...END],
]);

function envelopeText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format: "agi.sound-document",
    version: 1,
    profileId: PROFILE_ID,
    payload: [...TWO_TONE_PAYLOAD],
    eventIds: [["e7", "e9"], [], [], []],
    nextEventId: 10,
    ...overrides,
  });
}

function withSoundFiles(
  base: Record<string, Uint8Array>,
  sounds: ReadonlyMap<number, Uint8Array>,
): Record<string, Uint8Array> {
  return { ...base, ...Object.fromEntries(containerFromResources({ sound: sounds }).files) };
}

describe("captureAgentWorkspace: capture and the invalid-draft contract", () => {
  test("an uncompilable draft is preserved exactly with diagnostics; tools refuse honestly", () => {
    const project = createStarterProject("starter");
    const { draft } = authoredDraft(project);
    const key = `logic:${project.bindings["first_room"]!.num}`;
    const broken = "if (isset(f5)) {\n  print(m1);";
    editDraft(draft, key, broken);

    const files = filesRecord(project);
    const workspace = capture(project, draft, { files });
    assert.equal(workspace.compilable, false);
    assert.ok(
      workspace.diagnostics.some((d) => d.key === key && d.severity === "error"),
      "capture reports the failing document",
    );
    // The exact broken text is readable — not replaced by decompiled kept bytes.
    assert.equal(workspace.documents()[key], broken);

    const error = thrown(() => workspace.openToolState(), AgentCandidateError);
    assert.ok(
      error.diagnostics.some((d) => d.key === key),
      "tool refusal names the uncompiled document",
    );
    assert.equal(workspace.documents()[key], broken, "the refusal changed nothing");
  });

  test("a direct proposal can repair an invalid base; an invalid replacement refuses", () => {
    const project = createStarterProject("starter");
    const { draft } = authoredDraft(project);
    const key = `logic:${project.bindings["first_room"]!.num}`;
    const broken = "if (isset(f5)) {\n  print(m1);";
    editDraft(draft, key, broken);
    const filesBefore = new Map(Object.entries(filesRecord(project)).map(([k, v]) => [k, v]));
    const workspace = capture(project, draft);

    // A change set that does not repair the base still refuses.
    assert.throws(
      () => workspace.propose("unrelated", [{ key: "logic:9", content: "return;\n" }]),
      AgentCandidateError,
    );
    // A malformed replacement refuses with document scope.
    const bad = thrown(
      () => workspace.propose("worse", [{ key, content: "if (isset(" }]),
      AgentCandidateError,
    );
    assert.ok(bad.diagnostics.some((d) => d.key === key));

    const proposal = workspace.propose("repair room", [{ key, content: "return;\n" }]);
    // Nothing touched the draft or the kept files before apply.
    assert.equal(draft.capture().read(key)!.content, broken);
    assertFilesEqual(project.files(), filesBefore);

    const transaction = draft.apply(proposal);
    assert.deepEqual(transaction.keys, [key]);
    assert.equal(draft.capture().read(key)!.content, "return;\n");
    assertFilesEqual(project.files(), filesBefore);
  });

  test("capture detaches the caller's files record and the returned readbacks", () => {
    const project = createStarterProject("starter");
    const { draft } = authoredDraft(project);
    const files = filesRecord(project);
    const workspace = capture(project, draft, { files });

    // Corrupt every buffer the caller handed in; the workspace compiled from copies.
    for (const bytes of Object.values(files)) bytes.fill(0);
    const proposal = workspace.propose("still compiles", [
      { key: "logic:9", content: "return;\n" },
    ]);
    assert.equal(proposal.changes().length, 1);

    // Mutating a returned document copy cannot corrupt the workspace either.
    const docs = workspace.documents();
    for (const content of Object.values(docs)) {
      if (content instanceof Uint8Array) content.fill(0);
    }
    assert.equal(workspace.documents()["logic:0"], project.sources.logics.get(0));
    assert.equal(workspace.compilable, true);
  });

  test("case-varied and duplicate authored words hydrate to the compiled dictionary", () => {
    const project = createStarterProject("blank");
    const files = filesRecord(project);
    const read = readProjectDocuments({
      files,
      profileId: project.profileId,
      bindings: project.bindings,
    });
    const draft = new ProjectDraft(read.documents);
    // Valid authored vocabulary: case folding and an exact duplicate entry the
    // real codec accepts; the document text stays authoritative, byte-exact.
    const wordsDoc = '[["LOOK", 2],["look", 2],["north", 3]]';
    editDraft(draft, "words", wordsDoc);
    const workspace = capture(project, draft, { files });
    assert.equal(workspace.compilable, true);

    const candidate = workspace.openToolState();
    // The tool dictionary is the compiled dictionary — folded, sorted and
    // deduplicated — never raw document pairs overlaid on native words.
    assert.deepEqual(
      [...candidate.state.sources.words].sort(([a], [b]) => (a < b ? -1 : 1)),
      [
        ["look", 2],
        ["north", 3],
      ],
    );
    // A real said() lookup compiles through that normalized dictionary.
    assert.equal(
      executeAgentTool(candidate.state, "write_logic", {
        room: 9,
        source: 'if (said("look")) { set(f6); }\nreturn;',
      }).success,
      true,
    );
    const proposal = candidate.finish("said room");
    assert.deepEqual(
      proposal.changes().map((c) => c.key),
      ["logic:9"],
      "the exact authored words document survives a no-op vocabulary",
    );
    assert.equal(workspace.documents()["words"], wordsDoc);
  });

  test("a byte-only document set hydrates and every readback is an owned copy", () => {
    const project = createStarterProject("starter");
    // No source claims: every document reads back as retained native bytes.
    const read = readProjectDocuments({
      files: filesRecord(project),
      profileId: project.profileId,
    });
    assert.deepEqual(read.diagnostics, []);
    const draft = new ProjectDraft(read.documents);
    const workspace = capture(project, draft);
    assert.equal(workspace.compilable, true);

    const candidate = workspace.openToolState();
    const proposal = candidate.finish("no-op");
    assert.deepEqual(proposal.changes(), [], "untouched bytes emit no changes");
    const docs = workspace.documents();
    const picture = docs["picture:1"];
    assert.ok(picture instanceof Uint8Array, "byte-only picture stays byte-only");
    const staged = openContainer(candidate.state.getFiles());
    assert.deepEqual([...staged.getResource("picture", 1)!], [...picture]);
  });
});

describe("captureAgentWorkspace: isolated tool candidate", () => {
  test("a coordinated logic+words+binding transaction compiles once and keeps stable ids", () => {
    const project = createStarterProject("starter");
    const { draft } = authoredDraft(project);
    const workspace = capture(project, draft);
    assert.equal(workspace.compilable, true);

    const candidate = workspace.openToolState();
    assert.equal(
      executeAgentTool(candidate.state, "write_words", { words: ["grumble"] }).success,
      true,
    );
    assert.equal(
      executeAgentTool(candidate.state, "reserve_name", {
        bindings: null,
        name: "maze_room",
        kind: "logic",
        id: 14,
      }).success,
      true,
    );
    const room14 = `// The maze entrance.\nif (said("grumble")) {\n  assignn(v0, maze_room);\n  call.v(v0);\n}\nreturn;`;
    assert.equal(
      executeAgentTool(candidate.state, "write_logic", { room: 14, source: room14 }).success,
      true,
    );

    const proposal = candidate.finish("add maze room");
    const changes = proposal.changes();
    assert.deepEqual(
      changes.map((c) => c.key),
      ["bindings", "logic:14", "words"],
      "only the intended documents changed",
    );
    const bindings = JSON.parse(String(changes[0]!.content)) as Record<
      string,
      { kind: string; num: number }
    >;
    assert.deepEqual(bindings["maze_room"], { kind: "logic", num: 14 });
    const written = candidate.state.sources.logics.get(14)!;
    assert.equal(changes[1]!.content, written, "the emitted text is the verified authored claim");

    // The emitted source reproduces the staged bytes under the final
    // dictionary and bindings — hand-compiled against the same context.
    const numBindings = Object.fromEntries(
      Object.entries(candidate.state.authoring.bindings).map(([name, b]) => [name, { num: b.num }]),
    );
    const expected = compileProjectLogic(written, {
      profile: PROFILE,
      bindings: numBindings,
      dictionary: candidate.state.sources.words,
    }).assembly.payload;
    assert.deepEqual([...candidate.state.container.getResource("logic", 14)!], [...expected]);

    // The opaque base is exactly the draft-issued snapshot; apply works.
    assert.equal(proposal.base, workspace.base);
    const transaction = draft.apply(proposal);
    assert.deepEqual(transaction.keys, ["bindings", "logic:14", "words"]);
  });

  test("an untouched run emits no changes; a comment-only edit still emits", () => {
    const project = createStarterProject("starter");
    const { draft } = authoredDraft(project);
    const workspace = capture(project, draft);
    const untouched = workspace.openToolState();
    assert.deepEqual(untouched.finish("nothing").changes(), []);

    const candidate = workspace.openToolState();
    const original = project.sources.logics.get(1)!;
    const commented = `// A room header the player never sees.\n${original}`;
    assert.equal(
      executeAgentTool(candidate.state, "write_logic", {
        room: 1,
        source: commented,
      }).success,
      true,
    );
    const proposal = candidate.finish("comment");
    const changes = proposal.changes();
    assert.deepEqual(
      changes.map((c) => c.key),
      ["logic:1"],
    );
    assert.equal(changes[0]!.content, candidate.state.sources.logics.get(1));
    // The comment changed no compiled byte.
    const baseImage = openContainer(candidate.state.getFiles());
    const baseline = openContainer(project.files());
    assert.deepEqual(
      [...baseImage.getResource("logic", 1)!],
      [...baseline.getResource("logic", 1)!],
      "comment-only source compiles to identical bytes",
    );
    assert.equal(proposal.base.read("logic:1")!.content, original);
  });

  test("a stale or forged source claim refuses finish instead of replacing native bytes", () => {
    const project = createStarterProject("starter");
    const { draft } = authoredDraft(project);
    const workspace = capture(project, draft);

    // A forged claim that cannot reproduce the stored resource.
    const forged = workspace.openToolState();
    forged.state.sources.logics.set(1, "return; // not the room\n");
    const forgedError = thrown(() => forged.finish("sneaky"), AgentCandidateError);
    assert.ok(forgedError.diagnostics.some((d) => d.key === "logic:1"));

    // Native bytes swapped out from under an unchanged authored claim.
    const swapped = workspace.openToolState();
    const replacement = compileProjectLogic("return;", {
      profile: PROFILE,
      bindings: {},
      dictionary: swapped.state.sources.words,
    }).assembly.payload;
    swapped.state.container.putResource("logic", 1, replacement);
    assert.throws(() => swapped.finish("sneaky"), AgentCandidateError);
    // Nothing reached the draft.
    assert.equal(draft.capture().read("logic:1")!.content, project.sources.logics.get(1));
  });

  test("vocabulary drift that strands a said() reference refuses until coordinated", () => {
    const project = createStarterProject("starter");
    const { draft } = authoredDraft(project);
    const workspace = capture(project, draft);
    const candidate = workspace.openToolState();

    // Rewrite the dictionary without the word the room still says — staged as
    // a coherent candidate edit (map plus payload), since write_words only adds.
    candidate.state.sources.words.delete("look");
    candidate.state.wordsPayload = buildWordsTok(
      [...candidate.state.sources.words].map(([word, id]) => ({ word, id })),
    );
    thrown(() => candidate.finish("drop look"), AgentCandidateError);

    // Coordinating the reference rewrite lets the same candidate finish.
    const room = project.sources.logics.get(1)!;
    const fixed = room
      .split("\n")
      .filter((line) => !line.startsWith('if (said("look"'))
      .join("\n");
    assert.notEqual(fixed, room);
    assert.equal(
      executeAgentTool(candidate.state, "write_logic", { room: 1, source: fixed }).success,
      true,
    );
    const proposal = candidate.finish("drop look");
    assert.deepEqual(
      proposal.changes().map((c) => c.key),
      ["logic:1", "words"],
    );
    draft.apply(proposal);
  });

  test("a dangling reference refuses finish; allowMissingRooms narrows only new.room", () => {
    const project = createStarterProject("starter");
    const { draft } = authoredDraft(project);
    const workspace = capture(project, draft);
    const candidate = workspace.openToolState();
    assert.equal(
      executeAgentTool(candidate.state, "write_logic", {
        room: 9,
        source: "call(10);\nreturn;",
      }).success,
      true,
    );
    const error = thrown(() => candidate.finish("dangle"), AgentCandidateError);
    assert.ok(error.diagnostics.some((d) => d.key === "logic:9"));

    // The missing-room exception is about new.room only.
    const rooms = workspace.openToolState();
    assert.equal(
      executeAgentTool(rooms.state, "write_logic", {
        room: 9,
        source: "new.room(42);\nreturn;",
      }).success,
      true,
    );
    assert.throws(() => rooms.finish("missing room"), AgentCandidateError);

    const permissive = capture(project, draft, { allowMissingRooms: true }).openToolState();
    assert.equal(
      executeAgentTool(permissive.state, "write_logic", {
        room: 9,
        source: "new.room(42);\nreturn;",
      }).success,
      true,
    );
    const proposal = permissive.finish("missing room allowed");
    assert.deepEqual(
      proposal.changes().map((c) => c.key),
      ["logic:9"],
    );
  });

  test("world metadata, inventory and tests edits surface as document changes", () => {
    const project = createStarterProject("starter");
    const { draft } = authoredDraft(project);
    const workspace = capture(project, draft);
    const candidate = workspace.openToolState();

    assert.equal(
      executeAgentTool(candidate.state, "update_plan", {
        rooms: [{ num: 1, title: "Clearing", description: "First room.", exits: [] }],
        facts: [],
        quests: [],
      }).success,
      true,
    );
    assert.equal(
      executeAgentTool(candidate.state, "write_objects", {
        objects: [{ name: "Brass Key", startingRoom: 1 }],
      }).success,
      true,
    );
    const proposal = candidate.finish("metadata");
    const keys = proposal.changes().map((c) => c.key);
    assert.deepEqual(keys, ["inventory", "world"]);
    const world = JSON.parse(String(proposal.changes()[1]!.content)) as {
      rooms: Record<string, { title: string }>;
    };
    assert.equal(world.rooms["1"]!.title, "Clearing");
    const inventory = JSON.parse(String(proposal.changes()[0]!.content)) as {
      name: string;
      startingRoom: number;
    }[];
    assert.deepEqual(inventory, [{ name: "Brass Key", startingRoom: 1 }]);
    draft.apply(proposal);
  });

  test("world launches hydrate and survive a tool run that changes the plan", () => {
    const project = createStarterProject("starter");
    const { draft } = authoredDraft(project);
    const launches = {
      "1": {
        selected: "launch-1",
        entries: [
          {
            id: "launch-1",
            name: "Vacuum death",
            cameFrom: { room: 2, edge: 3 },
            seed: 4242,
          },
        ],
      },
    };
    editDraft(draft, "world", JSON.stringify({ rooms: {}, facts: {}, quests: {}, launches }));

    const workspace = capture(project, draft);
    const candidate = workspace.openToolState();
    assert.deepEqual(candidate.state.authoring.world.launches, launches);

    assert.equal(
      executeAgentTool(candidate.state, "update_plan", {
        rooms: [{ num: 1, title: "Clearing", description: "First room.", exits: [] }],
        facts: [],
        quests: [],
      }).success,
      true,
    );
    const proposal = candidate.finish("metadata");
    const change = proposal.changes().find((entry) => entry.key === "world");
    assert.ok(change, "the plan edit emits the world document");
    const emitted = JSON.parse(String(change.content)) as {
      launches?: Record<string, { entries: { name: string; seed: number }[] }>;
    };
    assert.equal(emitted.launches?.["1"]?.entries[0]?.name, "Vacuum death");
    assert.equal(emitted.launches?.["1"]?.entries[0]?.seed, 4242);
  });

  test("an envelope sound document hydrates and survives finish untouched", () => {
    const project = createStarterProject("starter");
    const files = withSoundFiles(filesRecord(project), new Map([[5, TWO_TONE_PAYLOAD]]));
    const { draft } = authoredDraft(project);
    const text = envelopeText();
    editDraft(draft, "sound:5", text);

    const workspace = capture(project, draft, { files });
    assert.equal(workspace.compilable, true);
    const candidate = workspace.openToolState();
    // The envelope hydrated as an authored source, profile pinned.
    const stored = candidate.state.sources.sounds.get(5)!;
    assert.ok(!Array.isArray(stored), "envelope body, not legacy tracks");
    assert.equal(stored.format, "agi.sound-document");
    assert.equal(stored.profileId, PROFILE_ID);

    const proposal = candidate.finish("untouched sound");
    assert.deepEqual(proposal.changes(), []);
    // Opaque payload bytes are exactly the staged native bytes.
    assert.deepEqual(stored.payload, [...TWO_TONE_PAYLOAD]);
  });

  test("a byte-only sound keeps its native bytes through a tool run", () => {
    const project = createStarterProject("starter");
    const files = withSoundFiles(filesRecord(project), new Map([[7, TWO_TONE_PAYLOAD]]));
    const { draft } = authoredDraft(project);
    editDraft(draft, "sound:7", new Uint8Array(TWO_TONE_PAYLOAD));
    const workspace = capture(project, draft, { files });
    const candidate = workspace.openToolState();
    assert.equal(candidate.state.sources.sounds.has(7), false, "no invented claim");
    assert.equal(
      executeAgentTool(candidate.state, "write_logic", { room: 9, source: "return;" }).success,
      true,
    );
    const proposal = candidate.finish("new room only");
    assert.deepEqual(
      proposal.changes().map((c) => c.key),
      ["logic:9"],
    );
    assert.deepEqual(
      [...candidate.state.container.getResource("sound", 7)!],
      [...TWO_TONE_PAYLOAD],
    );
  });

  test("a music document hydrates authored tempo and survives an untouched run", () => {
    const project = createStarterProject("blank");
    const files = withSoundFiles(filesRecord(project), new Map([[9, TWO_TONE_PAYLOAD]]));
    const { draft } = authoredDraft(project);
    editDraft(draft, "sound:9", new Uint8Array(TWO_TONE_PAYLOAD));
    const musicDoc = '{"9":{"revision":"21-abcdef12","tempo":120}}';
    editDraft(draft, "music", musicDoc);

    const workspace = capture(project, draft, { files });
    assert.equal(workspace.compilable, true);
    const candidate = workspace.openToolState();
    assert.equal(candidate.state.authoring.music?.["9"]?.tempo, 120);
    assert.equal(candidate.state.authoring.music?.["9"]?.revision, "21-abcdef12");
    assert.deepEqual(candidate.finish("untouched").changes(), []);
    assert.equal(workspace.documents()["music"], musicDoc, "exact text preserved");
  });

  test("write_music emits a sound document plus an explicit tempo document change", () => {
    const project = createStarterProject("blank");
    const { draft } = authoredDraft(project);
    const workspace = capture(project, draft);
    const candidate = workspace.openToolState();
    const result = executeAgentTool(candidate.state, "write_music", {
      num: 9,
      tempo: 120,
      tracks: [{ channel: "melody", volume: 15, events: [{ note: "A4", beats: 1, repeat: 1 }] }],
    });
    assert.equal(result.success, true);

    const proposal = candidate.finish("new cue");
    const keys = proposal.changes().map((c) => c.key);
    assert.ok(keys.includes("sound:9"), "the compiled SOUND is a document change");
    assert.ok(keys.includes("music"), "the authored tempo is a document change");
    const music = JSON.parse(
      String(proposal.changes().find((c) => c.key === "music")!.content),
    ) as Record<string, { revision: string; tempo: number }>;
    assert.equal(music["9"]!.tempo, 120);
    assert.match(music["9"]!.revision, /^\d{1,6}-[0-9a-f]{8}$/);
    draft.apply(proposal);
    const emitted = proposal.changes().find((c) => c.key === "music")!.content;
    assert.equal(draft.capture().read("music")!.content, emitted);
  });

  test("a tempo-only metadata change emits the music document alone", () => {
    const project = createStarterProject("blank");
    const files = withSoundFiles(filesRecord(project), new Map([[9, TWO_TONE_PAYLOAD]]));
    const { draft } = authoredDraft(project);
    editDraft(draft, "sound:9", new Uint8Array(TWO_TONE_PAYLOAD));
    const musicDoc = '{"9":{"revision":"21-abcdef12","tempo":120}}';
    editDraft(draft, "music", musicDoc);
    const candidate = capture(project, draft, { files }).openToolState();

    candidate.state.authoring.music!["9"] = { revision: "21-abcdef12", tempo: 90 };
    const proposal = candidate.finish("slower");
    assert.deepEqual(
      proposal.changes().map((c) => c.key),
      ["music"],
    );
    assert.equal(proposal.changes()[0]!.content, '{"9":{"revision":"21-abcdef12","tempo":90}}');
  });

  test("an invalid music document is a scoped compile diagnostic repairable directly", () => {
    const project = createStarterProject("blank");
    const { draft } = authoredDraft(project);
    editDraft(draft, "music", '{"9":{"revision":"bogus","tempo":120}}');
    const workspace = capture(project, draft);
    assert.equal(workspace.compilable, false);
    assert.ok(
      workspace.diagnostics.some((d) => d.key === "music"),
      "the refusal names the music document",
    );
    thrown(() => workspace.openToolState(), AgentCandidateError);
    const proposal = workspace.propose("fix tempo record", [
      { key: "music", content: '{"9":{"revision":"21-abcdef12","tempo":120}}' },
    ]);
    draft.apply(proposal);
    assert.equal(
      draft.capture().read("music")!.content,
      '{"9":{"revision":"21-abcdef12","tempo":120}}',
    );
  });

  test("a discarded candidate leaves the draft and the kept files identical", () => {
    const project = createStarterProject("starter");
    const { draft } = authoredDraft(project);
    const files = filesRecord(project);
    const baseline = new Map(Object.entries(files).map(([k, v]) => [k, new Uint8Array(v)]));
    const workspace = capture(project, draft, { files });
    const revision = draft.capture().revision;

    const candidate = workspace.openToolState();
    executeAgentTool(candidate.state, "write_logic", { room: 9, source: "return;" });
    // Never finish: the isolated writes stay inside the candidate.
    assert.equal(draft.capture().revision, revision);
    assert.equal(draft.capture().read("logic:9"), undefined);
    assertFilesEqual(project.files(), baseline);
    // And the workspace's own base still reads the pre-tool document set.
    assert.equal(workspace.base.read("logic:9"), undefined);
  });
});

describe("captureAgentWorkspace: proposal authority and staleness", () => {
  test("typing during a run makes the proposal stale but keeps its before image", () => {
    const project = createStarterProject("starter");
    const { draft } = authoredDraft(project);
    const workspace = capture(project, draft);
    const candidate = workspace.openToolState();
    executeAgentTool(candidate.state, "write_logic", { room: 9, source: "return;" });
    const proposal = candidate.finish("new room");

    // Human typing after the capture.
    const typed = "return; // typed meanwhile\n";
    editDraft(draft, "logic:1", typed);

    assert.throws(() => draft.apply(proposal), /Stale proposal/);
    // The proposal still carries its exact consulted base for review.
    assert.equal(proposal.base, workspace.base);
    assert.equal(proposal.base.read("logic:1")!.content, project.sources.logics.get(1));
    assert.deepEqual(
      proposal.changes().map((c) => c.key),
      ["logic:9"],
    );
  });

  test("foreign snapshots, foreign proposals and structural lookalikes hold no authority", () => {
    const project = createStarterProject("starter");
    const { draft, documents } = authoredDraft(project);
    const other = new ProjectDraft(documents);
    const otherProposal = capture(project, other).propose("elsewhere", [
      { key: "logic:9", content: "return;\n" },
    ]);
    assert.throws(() => draft.apply(otherProposal), /another workspace/);

    // A structural lookalike of the real snapshot is not the issued object.
    const real = draft.capture();
    const lookalike = {
      revision: real.revision,
      keys: real.keys,
      read: (key: string) => real.read(key),
      version: (key: string) => real.version(key),
    };
    assert.throws(
      () => draft.propose(lookalike, "forged", [{ key: "logic:9", content: "return;\n" }]),
      /another workspace/,
    );

    // The genuine path still works.
    const proposal = capture(project, draft).propose("genuine", [
      { key: "logic:9", content: "return;\n" },
    ]);
    draft.apply(proposal);
    assert.equal(draft.capture().read("logic:9")!.content, "return;\n");
  });
});

describe("captureAgentWorkspace: defects the game already had carry forward", () => {
  /**
   * A starter image whose directories index three records no reader can
   * load, the way original releases do (docs/testing.md, "Fixture notes"):
   * two entries past the end of VOL.0 and one inside another record's header.
   */
  const DAMAGED: readonly [name: string, kind: "logic" | "picture" | "sound", num: number][] = [
    ["LOGDIR", "logic", 200],
    ["PICDIR", "picture", 200],
    ["SNDDIR", "sound", 254],
  ];
  function damagedFiles(project: StarterProject): Record<string, Uint8Array> {
    const files = filesRecord(project);
    const index = (name: string, num: number, entry: readonly number[]): void => {
      const dir = new Uint8Array(Math.max(files[name]!.length, (num + 1) * 3)).fill(0xff);
      dir.set(files[name]!);
      dir.set(entry, num * 3);
      files[name] = dir;
    };
    index("LOGDIR", 200, [0x00, 0xff, 0xff]);
    index("SNDDIR", 254, [0x01, 0xff, 0xff]);
    index("PICDIR", 200, [0x00, 0x00, 0x02]);
    return files;
  }
  function readFailure(
    container: ReturnType<typeof openContainer>,
    kind: "logic" | "picture" | "sound",
    num: number,
  ): string {
    try {
      container.getResource(kind, num);
    } catch (error) {
      return String(error);
    }
    assert.fail(`${kind} ${num} should be unreadable`);
  }

  test("unreadable directory entries carry forward byte for byte through an unrelated edit", () => {
    const project = createStarterProject("starter");
    const files = damagedFiles(project);
    const read = readProjectDocuments({
      files,
      profileId: PROFILE_ID,
      sources: claimedSources(project),
      bindings: project.bindings,
    });
    assert.deepEqual(
      read.diagnostics.map((d) => d.key),
      ["logic:200", "picture:200", "sound:254"],
    );
    const draft = new ProjectDraft(read.documents);
    const workspace = capture(project, draft, { files });
    assert.equal(workspace.compilable, true);
    assert.deepEqual(
      workspace.defects.map((d) => [d.key, d.cause]),
      [
        ["logic:200", "unreadable"],
        ["picture:200", "unreadable"],
        ["sound:254", "unreadable"],
      ],
    );
    assert.deepEqual(describeWorkspaceDefects(workspace.defects), [
      "One LOGIC in this game (200) cannot be read, so it stays as it is.",
      "One picture in this game (200) cannot be read, so it stays as it is.",
      "One sound in this game (254) cannot be read, so it stays as it is.",
    ]);
    // Nothing changed: nothing to propose.
    assert.deepEqual(workspace.openToolState().finish("nothing").changes(), []);
    assert.deepEqual(workspace.propose("nothing", []).changes(), []);

    const candidate = workspace.openToolState();
    assert.equal(
      executeAgentTool(candidate.state, "write_logic", {
        room: 1,
        source: `// Carried past the damage.\n${project.sources.logics.get(1)}`,
      }).success,
      true,
    );
    const proposal = candidate.finish("comment");
    assert.deepEqual(
      proposal.changes().map((c) => c.key),
      ["logic:1"],
    );
    const documents = { ...workspace.documents() };
    for (const { key, content } of proposal.changes())
      if (content === null) delete documents[key];
      else documents[key] = content;
    const exported = compileProjectDocuments({ files, profileId: PROFILE_ID, documents }).files();
    const before = openContainer(new Map(Object.entries(files)));
    const after = openContainer(exported);
    for (const [name, kind, num] of DAMAGED) {
      assert.deepEqual(
        [...exported.get(name)!.subarray(num * 3, num * 3 + 3)],
        [...files[name]!.subarray(num * 3, num * 3 + 3)],
        `${name}[${num}] keeps its entry`,
      );
      assert.equal(readFailure(after, kind, num), readFailure(before, kind, num));
    }
    assert.deepEqual([...after.getResource("logic", 1)!], [...before.getResource("logic", 1)!]);
  });

  test("a reference to an absent LOGIC carries forward; a new one refuses in plain words", () => {
    const project = createStarterProject("starter");
    const { draft } = authoredDraft(project);
    editDraft(draft, "logic:9", "call(200);\nreturn;\n");
    const workspace = capture(project, draft);
    assert.equal(workspace.compilable, true);
    assert.ok(workspace.diagnostics.some((d) => d.key === "logic:9" && d.severity === "error"));
    assert.deepEqual(describeWorkspaceDefects(workspace.defects), [
      "LOGIC 9 refers to LOGIC 200, which this game does not have. That stays as it is.",
    ]);
    assert.deepEqual(
      workspace.propose("unrelated", [{ key: "logic:8", content: "return;\n" }]).changes(),
      [{ key: "logic:8", content: "return;\n" }],
    );
    const candidate = workspace.openToolState();
    assert.equal(
      executeAgentTool(candidate.state, "write_logic", { room: 8, source: "return;" }).success,
      true,
    );
    assert.deepEqual(
      candidate
        .finish("tool edit")
        .changes()
        .map((c) => c.key),
      ["logic:8"],
    );
    // The dangling logic itself can change while it keeps its old reference.
    assert.deepEqual(
      workspace
        .propose("touch", [
          { key: "logic:9", content: "// Still dangling.\ncall(200);\nreturn;\n" },
        ])
        .changes()
        .map((c) => c.key),
      ["logic:9"],
    );
    const added = thrown(
      () => workspace.propose("worse", [{ key: "logic:8", content: "call(201);\nreturn;\n" }]),
      AgentCandidateError,
    );
    assert.equal(
      added.message,
      "The change refers to a part this game does not have. Add that part or remove the reference, then try again.",
    );
    assert.deepEqual(
      added.diagnostics.map((d) => [d.key, d.message]),
      [["logic:8", "LOGIC 200 is absent."]].map(([key]) => [key, "LOGIC 201 is absent."]),
    );
    // Another use of the same absent target elsewhere is new damage too.
    thrown(
      () => workspace.propose("spread", [{ key: "logic:8", content: "call(200);\nreturn;\n" }]),
      AgentCandidateError,
    );
  });

  test("an edit that corrupts a resource is refused with the part named", () => {
    const project = createStarterProject("starter");
    const { draft } = authoredDraft(project);
    const workspace = capture(project, draft);
    const bad = thrown(
      () => workspace.propose("corrupt", [{ key: "view:5", content: Uint8Array.of(1, 2, 3) }]),
      AgentCandidateError,
    );
    assert.equal(
      bad.message,
      "The change does not build. Fix the part named below, then try again.",
    );
    assert.deepEqual(
      bad.diagnostics.map((d) => d.key),
      ["view:5"],
    );
  });

  test("a TESTS.JSON carried among the native files is not a staged change", () => {
    const project = createStarterProject("starter");
    const { draft } = authoredDraft(project);
    const files = {
      ...filesRecord(project),
      "TESTS.JSON": new TextEncoder().encode('{"format":"agi.game-tests","version":1,"tests":[]}'),
    };
    const workspace = capture(project, draft, { files });
    assert.deepEqual(workspace.openToolState().finish("nothing").changes(), []);
  });
});
