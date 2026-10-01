import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { testProjectId } from "./identity.ts";
import { requireResourceRevision } from "../../src/gameIdentity.ts";
import { openContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildSound } from "../../src/sound/build.ts";
import { SOUND_DOCUMENT_FORMAT } from "../../src/sound/document.ts";
import { AgentSession } from "../src/agent/agentSession.ts";
import {
  buildProjectZip,
  buildPublicGameZip,
  readProjectContext,
} from "../src/archive/projectArchive.ts";
import { readGameZip } from "../src/archive/gameZip.ts";
import { buildZip } from "../src/archive/zip.ts";

const CONFIG = { provider: "stub", model: "offline-stub", apiKey: "" } as const;

// Hand-computed four-stream SOUND payloads (header: four u16le stream
// offsets; records: duration u16le | toneLow | toneHigh | control).
//
// CUE: lane 0 holds a 30-tick tone (divisor 226 → toneLow (226>>4)&0x3f=0x0e,
// toneHigh 0x80|(226&0x0f)=0x82, control 0x90|4=0x94) and a 10-tick canonical
// rest (0x00, 0x80, 0x9f); lanes 1–3 are bare terminators.
// Lane 0 spans [8, 20); offsets 8/20/22/24.
const CUE_BYTES = new Uint8Array([
  8, 0, 20, 0, 22, 0, 24, 0, 30, 0, 0x0e, 0x82, 0x94, 10, 0, 0x00, 0x80, 0x9f, 0xff, 0xff, 0xff,
  0xff, 0xff, 0xff, 0xff, 0xff,
]);

// RAW: lane 0 holds one structurally valid but noncanonical record
// (toneHigh 0x01 misses the 0x8 latch nibble, so it decodes as a raw event);
// lanes 1–3 terminate. Lane 0 spans [8, 15); offsets 8/15/17/19.
const RAW_BYTES = new Uint8Array([
  8, 0, 15, 0, 17, 0, 19, 0, 6, 0, 0x55, 0x01, 0x02, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
]);

// OPAQUE: three bytes is shorter than the 8-byte offset header, so the
// payload is retained opaque — inspectable and byte-exact, never editable.
const OPAQUE_BYTES = Uint8Array.of(0xde, 0xad, 0xbe);

const CUE_ENVELOPE = {
  format: SOUND_DOCUMENT_FORMAT,
  version: 1,
  profileId: "2.936",
  payload: [...CUE_BYTES],
  // Retained ids with an allocator gap: e4/e7 survive, cursor continues at 9.
  eventIds: [["e4", "e7"], [], [], []],
  nextEventId: 9,
};

const RAW_ENVELOPE = {
  format: SOUND_DOCUMENT_FORMAT,
  version: 1,
  profileId: "2.936",
  payload: [...RAW_BYTES],
  eventIds: [["e2"], [], [], []],
  nextEventId: 5,
};

const OPAQUE_ENVELOPE = {
  format: SOUND_DOCUMENT_FORMAT,
  version: 1,
  profileId: "2.936",
  payload: [...OPAQUE_BYTES],
  eventIds: null,
  nextEventId: 3,
};

// A still-valid four-stream claim whose bytes differ from the stored cue:
// the two lane-0 records are swapped (rest first, tone second).
const DIFFERENT_CUE = {
  ...CUE_ENVELOPE,
  payload: [
    8, 0, 20, 0, 22, 0, 24, 0, 10, 0, 0x00, 0x80, 0x9f, 30, 0, 0x0e, 0x82, 0x94, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff,
  ],
};

const TRACKS = [{ notes: [{ duration: 30, freqDivisor: 226, attenuation: 4 }] }];

function gameFiles(): Record<string, Uint8Array> {
  const container = openContainer(new Map());
  container.putFile("WORDS.TOK", new Uint8Array(52));
  container.putResource("logic", 0, assembleLogic("return;", { dictionary: new Map() }).payload);
  container.putResource("sound", 5, CUE_BYTES);
  container.putResource("sound", 6, RAW_BYTES);
  container.putResource("sound", 7, buildSound(TRACKS));
  container.putResource("sound", 8, OPAQUE_BYTES);
  return Object.fromEntries(container.files);
}

function projectData(sounds: [number, unknown][], extra?: Record<string, unknown>) {
  return {
    projectId: testProjectId("sound-archive"),
    title: "Sound archive",
    authoredAt: "2026-01-01",
    files: gameFiles(),
    words: [] as [string, number][],
    authoringState: {
      authoring: { version: 1, bindings: {}, world: { rooms: {}, facts: {}, quests: {} } },
      sources: { logics: [[0, "return;"]], sounds: structuredClone(sounds) },
    },
    // The authored game pins its interpreter choice; GAME.JSON carries it and
    // the archive reader resolves the same target — never the claim's pin.
    library: {
      version: 1 as const,
      revision: requireResourceRevision("c".repeat(64)),
      source: "authored" as const,
      profile: "2.936" as const,
      validation: { status: "unverified" as const, message: "" },
    },
    ...extra,
  };
}

function soundsOf(authoringState: Record<string, unknown> | undefined): [number, unknown][] {
  return (authoringState?.["sources"] as { sounds: [number, unknown][] }).sounds;
}

function archiveWithProject(project: unknown, extraEntries: { name: string; data: string }[] = []) {
  return buildZip([
    ...Object.entries(gameFiles()).map(([name, data]) => ({ name, data })),
    ...extraEntries,
    { name: "PROJECT.JSON", data: JSON.stringify(project) },
  ]);
}

const soundsOnly = (sounds: unknown) => ({ authoringState: { sources: { sounds } } });

test("a project archive round-trips sound document sources beside legacy tracks", async () => {
  const opened = await readGameZip(
    await buildProjectZip(
      projectData([
        [5, CUE_ENVELOPE],
        [6, RAW_ENVELOPE],
        [8, OPAQUE_ENVELOPE],
        [7, TRACKS],
      ]),
    ),
  );
  assert.equal(opened.profile, "2.936", "GAME.JSON carried the declared profile");
  assert.deepEqual(soundsOf(opened.project?.authoringState), [
    [5, CUE_ENVELOPE],
    [6, RAW_ENVELOPE],
    [8, OPAQUE_ENVELOPE],
    [7, TRACKS],
  ]);

  // The restored snapshot rehydrates a real session with no provider key:
  // the envelope survives as its owned serialized form — retained event ids
  // and allocator cursor, raw record and opaque payload untouched — beside
  // the legacy track body, which keeps its own validation.
  const session = AgentSession.fromAuthoredData(
    CONFIG,
    () => {},
    opened.files,
    opened.words,
    undefined,
    undefined,
    opened.project!.authoringState,
    opened.profile,
  );
  assert.deepEqual(session.state.sources.sounds.get(5), CUE_ENVELOPE);
  assert.deepEqual(session.state.sources.sounds.get(6), RAW_ENVELOPE);
  assert.deepEqual(session.state.sources.sounds.get(8), OPAQUE_ENVELOPE);
  assert.deepEqual(session.state.sources.sounds.get(7), TRACKS);
  assert.equal(session.state.sources.logics.get(0), "return;");
});

test("the project writer refuses sound document claims its reader cannot admit", async () => {
  // The claim's pinned profile is not the archived game's resolved profile.
  await assert.rejects(
    buildProjectZip(projectData([[5, { ...CUE_ENVELOPE, profileId: "2.089" }]])),
    /pinned to profile '2\.089'.*selects '2\.936'/,
  );
  // The claimed sound:N has no native SOUND resource.
  await assert.rejects(buildProjectZip(projectData([[9, CUE_ENVELOPE]])), /missing native SOUND/);
  // The claim's payload does not reproduce the stored native bytes.
  await assert.rejects(
    buildProjectZip(projectData([[5, DIFFERENT_CUE]])),
    /does not reproduce the native SOUND bytes/,
  );
  // A nested format/version/field the strict reader does not know.
  await assert.rejects(
    buildProjectZip(projectData([[5, { ...CUE_ENVELOPE, version: 2 }]])),
    /version 2/,
  );
  await assert.rejects(
    buildProjectZip(projectData([[5, { ...CUE_ENVELOPE, extra: true }]])),
    /exactly the fields/,
  );
  // A claim on an entry with an out-of-range resource number is malformed too.
  await assert.rejects(buildProjectZip(projectData([[300, CUE_ENVELOPE]])), /source entry/);
  // The input is only read: a refused claim leaves the caller's state intact.
});

test("a project import refuses sound document claims it cannot verify", async () => {
  const project = { format: "monotio.agi.project", version: 1 };
  await assert.rejects(
    readGameZip(
      archiveWithProject({ ...project, ...soundsOnly([[5, { ...CUE_ENVELOPE, version: 2 }]]) }),
    ),
    /version 2/,
  );
  await assert.rejects(
    readGameZip(
      archiveWithProject({ ...project, ...soundsOnly([[5, { ...CUE_ENVELOPE, extra: true }]]) }),
    ),
    /exactly the fields/,
  );
  // The claim's own pin never selects the interpreter: without GAME.JSON the
  // container files resolve 2.936, and a 2.089 pin refuses.
  await assert.rejects(
    readGameZip(
      archiveWithProject({
        ...project,
        ...soundsOnly([[5, { ...CUE_ENVELOPE, profileId: "2.089" }]]),
      }),
    ),
    /pinned to profile '2\.089'.*selects '2\.936'/,
  );
  // The declared GAME.JSON profile is the target: a claim pinned to the
  // detection result refuses under a game that chooses 2.089.
  await assert.rejects(
    readGameZip(
      archiveWithProject({ ...project, ...soundsOnly([[5, CUE_ENVELOPE]]) }, [
        {
          name: "GAME.JSON",
          data: JSON.stringify({ format: "monotio.agi", version: 1, profile: "2.089" }),
        },
      ]),
    ),
    /pinned to profile '2\.936'.*selects '2\.089'/,
  );
  // Byte-source claims never override an absent or different native SOUND.
  await assert.rejects(
    readGameZip(archiveWithProject({ ...project, ...soundsOnly([[9, CUE_ENVELOPE]]) })),
    /missing native SOUND/,
  );
  await assert.rejects(
    readGameZip(archiveWithProject({ ...project, ...soundsOnly([[5, DIFFERENT_CUE]]) })),
    /does not reproduce the native SOUND bytes/,
  );
  // A caller without the game's sound context cannot admit a claim at all.
  assert.throws(
    () =>
      readProjectContext(
        new TextEncoder().encode(
          JSON.stringify({ ...project, ...soundsOnly([[5, CUE_ENVELOPE]]) }),
        ),
        new Map(),
        "",
      ),
    /cannot be verified/,
  );
});

test("project version 1 admits verified sound editing envelopes and the released 1.0 fixture", async () => {
  const v1 = {
    format: "monotio.agi.project",
    version: 1,
    provider: "stub",
    model: "stub",
    conversation: { formatVersion: 1, messages: [] },
    ...soundsOnly([[5, CUE_ENVELOPE]]),
  };
  const extended = await readGameZip(archiveWithProject(v1));
  assert.deepEqual(soundsOf(extended.project?.authoringState), [[5, CUE_ENVELOPE]]);
  const fixture = new Uint8Array(
    readFileSync(new URL("./formats/project-v1.zip", import.meta.url)),
  );
  const opened = await readGameZip(fixture);
  assert.equal(opened.project?.provider, "stub");
  assert.equal((opened.project?.authoringState?.["authoring"] as { version?: number }).version, 1);
});

test("the archive owns the restored envelope; the input claim cannot reach it", async () => {
  const claim = structuredClone(CUE_ENVELOPE);
  const data = projectData([[5, claim]]);
  const zip = await buildProjectZip(data);
  // Mutating the input after export cannot touch the archived copy.
  (claim.payload as number[])[8] = 99;
  const opened = await readGameZip(zip);
  const restored = soundsOf(opened.project?.authoringState)[0]![1];
  assert.deepEqual(restored, CUE_ENVELOPE);
  assert.notEqual(restored, claim);
  // The stored source is the adapter's owned serialized envelope: frozen,
  // sharing no mutable state with the parsed archive.
  assert.equal(Object.isFrozen(restored), true);
  assert.equal(Object.isFrozen((restored as { payload: number[] }).payload), true);
  // And no source claim can touch the native bytes: the SOUND resource stays
  // authoritative.
  const container = openContainer(new Map(Object.entries(opened.files)));
  assert.deepEqual(container.getResource("sound", 5), CUE_BYTES);
});

test("a backup captures the offered bytes and source claims before its first await", async () => {
  const data = projectData([
    [5, CUE_ENVELOPE],
    [7, TRACKS],
  ]);
  const before = structuredClone(data.authoringState);
  const pending = buildProjectZip(data);
  // Mutating the offered objects after the call must not reach the archive:
  // the claim was verified against the offered bytes, and both were captured.
  data.files["VOL.0"]!.fill(0);
  (data.authoringState.sources.sounds[0]![1] as { payload: number[] }).payload[8] = 99;
  data.title = "Changed title";
  const opened = await readGameZip(await pending);
  assert.equal(opened.title, "Sound archive");
  assert.deepEqual(opened.project?.authoringState, before);
  const container = openContainer(new Map(Object.entries(opened.files)));
  assert.deepEqual(container.getResource("sound", 5), CUE_BYTES);
});

test("duplicate sound document resource numbers refuse at write and read", async () => {
  const dupClaims = projectData([
    [5, CUE_ENVELOPE],
    [5, { ...CUE_ENVELOPE, eventIds: [["e4", "e7"], [], [], []], nextEventId: 8 }],
  ]);
  await assert.rejects(buildProjectZip(dupClaims), /duplicate/i);
  // A claim sharing its number with a legacy entry is the same ambiguity.
  await assert.rejects(
    buildProjectZip(
      projectData([
        [5, CUE_ENVELOPE],
        [5, TRACKS],
      ]),
    ),
    /duplicate/i,
  );
  const project = { format: "monotio.agi.project", version: 1 };
  await assert.rejects(
    readGameZip(
      archiveWithProject({
        ...project,
        ...soundsOnly([
          [5, TRACKS],
          [5, CUE_ENVELOPE],
        ]),
      }),
    ),
    /duplicate/i,
  );
  await assert.rejects(
    readGameZip(
      archiveWithProject({
        ...project,
        ...soundsOnly([
          [5, CUE_ENVELOPE],
          [5, CUE_ENVELOPE],
        ]),
      }),
    ),
    /duplicate/i,
  );
  // Two legacy entries for one resource keep their existing pass-through.
  const legacy = await readGameZip(
    await buildProjectZip(
      projectData([
        [7, TRACKS],
        [7, TRACKS],
      ]),
    ),
  );
  assert.deepEqual(soundsOf(legacy.project?.authoringState), [
    [7, TRACKS],
    [7, TRACKS],
  ]);
});

test("a maximum-size opaque sound document survives the project archive", async () => {
  const container = openContainer(new Map());
  container.putFile("WORDS.TOK", new Uint8Array(52));
  container.putResource("logic", 0, assembleLogic("return;", { dictionary: new Map() }).payload);
  const maxPayload = new Uint8Array(65_535);
  container.putResource("sound", 5, maxPayload);
  const maxEnvelope = {
    format: SOUND_DOCUMENT_FORMAT,
    version: 1,
    profileId: "2.936",
    payload: [...maxPayload],
    eventIds: null,
    nextEventId: 1,
  };
  const opened = await readGameZip(
    await buildProjectZip(
      projectData([[5, maxEnvelope]], {
        files: Object.fromEntries(container.files),
      }),
    ),
  );
  assert.deepEqual(soundsOf(opened.project?.authoringState), [[5, maxEnvelope]]);
  const reopened = openContainer(new Map(Object.entries(opened.files)));
  assert.deepEqual(reopened.getResource("sound", 5), maxPayload);
});

test("payload accounting stays bounded: over-bound and malformed payloads still refuse", async () => {
  const project = { format: "monotio.agi.project", version: 1 };
  // One element over the envelope codec's 65,535-byte resource bound.
  const overBound = { ...OPAQUE_ENVELOPE, payload: new Array(65_536).fill(0) };
  await assert.rejects(
    readGameZip(archiveWithProject({ ...project, ...soundsOnly([[8, overBound]]) })),
    /65,535|budget/,
  );
  // A payload element that is not a byte is refused by the strict reader.
  const notBytes = { ...OPAQUE_ENVELOPE, payload: ["loud", 0, 0] };
  await assert.rejects(
    readGameZip(archiveWithProject({ ...project, ...soundsOnly([[8, notBytes]]) })),
    /integer in 0\.\.255/,
  );
  // The exemption is positional: a giant array anywhere else still spends
  // the generic node budget.
  const fanned = { ...CUE_ENVELOPE, extra: new Array(30_000).fill(0) };
  await assert.rejects(
    readGameZip(archiveWithProject({ ...project, ...soundsOnly([[5, fanned]]) })),
    /node count/,
  );
});

test("a public Game export carries the exact native sound and no source envelope", async () => {
  const data = projectData([
    [5, CUE_ENVELOPE],
    [7, TRACKS],
  ]);
  const zip = buildPublicGameZip(data);
  const text = new TextDecoder().decode(zip);
  for (const leaked of [
    "PROJECT.JSON",
    SOUND_DOCUMENT_FORMAT,
    "eventIds",
    "nextEventId",
    "profileId",
    "authoringState",
  ])
    assert.equal(text.includes(leaked), false, `${leaked} must not appear in a Game export`);
  const opened = await readGameZip(zip);
  assert.equal(opened.project, undefined);
  assert.equal(opened.profile, "2.936");
  const container = openContainer(new Map(Object.entries(opened.files)));
  assert.deepEqual(container.getResource("sound", 5), CUE_BYTES);
  assert.deepEqual(container.getResource("sound", 7), buildSound(TRACKS));
});
