/**
 * The recording contract's version gate. Version 1 is the released format;
 * version 2 adds the "debugger" end reason a segment sealed for a debugger
 * hiatus carries. The reader accepts both versions and preserves the
 * record's own stamp — reading is not a migration — while applying the
 * reason rules of the version the record was written under: a v1 tape
 * cannot smuggle a reason its released reader never knew, and an unknown
 * version is refused outright instead of being rewritten.
 */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HISTORY_FORMAT_READ_VERSIONS,
  HISTORY_FORMAT_VERSION,
  stampAnchor,
  stampBoot,
  historyBootSemantic,
  historyFingerprint,
  validateHistoryRecording,
  type HistoryEndReason,
} from "../src/agent/history.ts";
import { requireProjectId, requireResourceRevision } from "../src/gameIdentity.ts";

const IDENTITY = {
  project: requireProjectId("format-history"),
  revision: requireResourceRevision("1".repeat(64)),
};

const BOOT = stampBoot({
  files: { "VOL.0": "eA==" },
  dictionary: [],
  authorRooms: false,
  rng: 7,
  soundDevice: 1,
  resourceSet: "rev-1",
  requestSerial: 0,
});

/**
 * A minimal well-formed recording: one segment, an optional end event and
 * optional end metadata, each carrying the given reason verbatim.
 */
function endedRecording(version: unknown, reasons: { event?: unknown; end?: unknown } = {}) {
  return {
    version,
    identity: IDENTITY,
    profile: "2.936",
    resourceSet: "rev-1",
    startedAt: 42,
    segments: [
      {
        id: "s1",
        boot: BOOT,
        anchors: [],
        events:
          reasons.event === undefined
            ? []
            : [{ seq: 0, tick: 1, cycle: 1, cause: { kind: "end", reason: reasons.event } }],
        marks: [],
        sync: [],
        ...(reasons.end === undefined
          ? {}
          : { end: { seq: 1, tick: 1, cycle: 1, reason: reasons.end } }),
      },
    ],
  };
}

test("the writer stamps version 3; the reader accepts versions 1, 2 and 3", () => {
  assert.equal(HISTORY_FORMAT_VERSION, 3);
  assert.deepEqual(HISTORY_FORMAT_READ_VERSIONS, [1, 2, 3]);
});

test("a version 1 recording validates unchanged and keeps its own version stamp", () => {
  const input = endedRecording(1, { event: "quit", end: "quit" });
  const before = structuredClone(input);
  const recording = validateHistoryRecording(input);
  assert.equal(recording.version, 1);
  assert.deepEqual(input, before, "validation must not mutate its input");
  // A record built from known fields re-serializes byte-exact — the
  // released archive's untouched re-export rests on this normalization.
  assert.equal(JSON.stringify(recording), JSON.stringify(input));
});

test("a version 2 recording validates and keeps its own version stamp", () => {
  const input = endedRecording(2, { event: "eject", end: "eject" });
  const recording = validateHistoryRecording(input);
  assert.equal(recording.version, 2);
  assert.equal(JSON.stringify(recording), JSON.stringify(input));
});

test("a version 3 recording validates and keeps its own version stamp", () => {
  const input = endedRecording(3, { event: "debugger", end: "debugger" });
  const recording = validateHistoryRecording(input);
  assert.equal(recording.version, 3);
  assert.equal(JSON.stringify(recording), JSON.stringify(input));
});

test("versions 2 and 3 admit the debugger end reason in the event stream and the segment end", () => {
  for (const version of [2, 3]) {
    const recording = validateHistoryRecording(
      endedRecording(version, { event: "debugger", end: "debugger" }),
    );
    assert.deepEqual(recording.segments[0]?.events[0]?.cause, {
      kind: "end",
      reason: "debugger",
    });
    assert.equal(recording.segments[0]?.end?.reason, "debugger");
  }
});

test("version 1 rejects the debugger reason in the event stream and the segment end", () => {
  for (const input of [
    endedRecording(1, { event: "debugger", end: "quit" }),
    endedRecording(1, { event: "quit", end: "debugger" }),
    endedRecording(1, { event: "debugger", end: "debugger" }),
  ]) {
    const before = structuredClone(input);
    assert.throws(() => validateHistoryRecording(input), /end reason is invalid/);
    assert.deepEqual(input, before, "a refused read must not mutate its input");
  }
});

test("versions 2 and 3 still admit every released end reason", () => {
  const released: HistoryEndReason[] = ["boot", "walkthrough", "resume", "quit", "budget", "eject"];
  for (const version of [2, 3]) {
    for (const reason of released) {
      const recording = validateHistoryRecording(
        endedRecording(version, { event: reason, end: reason }),
      );
      assert.equal(recording.segments[0]?.end?.reason, reason);
      assert.deepEqual(recording.segments[0]?.events[0]?.cause, { kind: "end", reason });
    }
  }
});

test("all supported versions reject a reason no contract knows", () => {
  for (const version of [1, 2, 3]) {
    assert.throws(
      () => validateHistoryRecording(endedRecording(version, { end: "hibernate" })),
      /end reason is invalid/,
    );
  }
});

test("an unknown recording version is refused without rewriting the record", () => {
  for (const version of [0, 4, 5, -1, 1.5, "2", null, undefined]) {
    const input = endedRecording(version, {});
    const before = structuredClone(input);
    assert.throws(() => validateHistoryRecording(input), /unsupported version/);
    assert.deepEqual(input, before);
  }
});

test("atomic project images are admitted by recording versions 2 and 3 and refused by version 1", () => {
  const input = JSON.parse(
    readFileSync(new URL("./formats/history-v2-project-image.json", import.meta.url), "utf8"),
  ) as ReturnType<typeof endedRecording>;
  assert.throws(() => validateHistoryRecording({ ...input, version: 1 }));
  assert.equal(validateHistoryRecording(input).segments[0]!.events[0]!.cause.kind, "projectImage");
  assert.equal(
    validateHistoryRecording({ ...input, version: 3 }).segments[0]!.events[0]!.cause.kind,
    "projectImage",
  );
});

test("a complete window-bearing recording is accepted in v3, rejected in v1/v2, and rejected by the 1.2.4 version gate without mutation", () => {
  const savedWindow = {
    geometry: "pc" as const,
    textTop: 10,
    textLeft: 6,
    textRows: 1,
    textCols: 8,
    x0: 40,
    y0: 72,
    x1: 120,
    y1: 96,
    seq: 1,
    erased: [0, 1],
  };
  const savedRectWithWindow = {
    written: new Array<number>(30).fill(1),
    top: 9,
    left: 5,
    bottom: 11,
    right: 14,
    cells: new Array<number>(60).fill(0x20),
    window: savedWindow,
  };
  const parkedModal = {
    kind: "print" as const,
    saved: savedRectWithWindow,
    remainingMs: null,
    pauseClock: true,
  };
  const replayWithWindow = {
    clockRemainderMs: 0,
    pictureShown: true,
    terminated: false,
    statusRefreshRequested: false,
    priorityBase: 48,
    key: 0,
    egoHidden: 0,
    inputReady: 0,
    saidMatched: 0,
    controllers: new Array<number>(256).fill(0),
    parsedWords: [],
    parsedWordTexts: [],
    parserCount: 0,
    lastInputLine: "",
    editLine: "",
    acceptedLine: "",
    inputWidthCap: null,
    pendingController: null,
    inputQueue: [],
    menu: [],
    menuFinalized: false,
    menuHeading: 0,
    menuRequested: false,
    objectExtras: Array.from({ length: 256 }, () => ({ priority: 0 })),
    viewCache: { loaded: [], order: [] },
    gameSignature: "",
    sound: null,
    patchGeneration: 0,
    continuation: {
      frames: [{ logic: 0, pc: 0, hash: 0 }],
      modals: [parkedModal],
      persistentWindow: { ...savedRectWithWindow },
      keyWait: null,
    },
  };
  const stampedBoot = stampBoot({
    ...BOOT,
    replay: replayWithWindow,
  });
  const stampedAnchor = stampAnchor({
    seq: 0,
    tick: 1,
    cycle: 1,
    reason: "autosave",
    image: "eA==",
    replay: replayWithWindow,
    inputQueue: [],
    directionQueue: [],
    inputLines: [],
    requestSerial: 0,
    rng: 7,
    clock: { remainder: 0, increments: 0, paused: false },
    soundDevice: 1,
    resourceSet: "rev-1",
    patchGeneration: 0,
  });
  const v3WindowRecording = {
    version: 3,
    identity: IDENTITY,
    profile: "2.936",
    resourceSet: "rev-1",
    startedAt: 42,
    segments: [
      {
        id: "s1",
        boot: stampedBoot,
        anchors: [stampedAnchor],
        events: [],
        marks: [],
        sync: [],
      },
    ],
  };

  // Released 1.2.4 reader version check (accepts only versions 1 and 2):
  // rejects version 3 cleanly by version before inspecting any nested field.
  function released124VersionGate(value: unknown): void {
    const s = value as Record<string, unknown>;
    const version = s["version"];
    if (version !== 1 && version !== 2) {
      throw new Error(`History recording has unsupported version ${String(version)}.`);
    }
  }
  const before124 = structuredClone(v3WindowRecording);
  assert.throws(() => released124VersionGate(v3WindowRecording), /unsupported version 3/);
  assert.deepEqual(v3WindowRecording, before124, "1.2.4 reader check must not mutate input");

  // New v3 reader accepts the complete window-bearing recording and preserves saved.window.
  const validated = validateHistoryRecording(v3WindowRecording);
  assert.equal(validated.version, 3);
  assert.deepEqual(
    validated.segments[0]?.boot.replay?.continuation?.modals[0] &&
      "saved" in validated.segments[0].boot.replay.continuation.modals[0]
      ? validated.segments[0].boot.replay.continuation.modals[0].saved.window
      : null,
    savedWindow,
  );
  assert.deepEqual(
    validated.segments[0]?.anchors[0]?.replay.continuation?.persistentWindow?.window,
    savedWindow,
  );

  // Versions 1 and 2 reject saved.window in boot or anchor replay state.
  for (const oldVersion of [1, 2]) {
    const smuggled = structuredClone({ ...v3WindowRecording, version: oldVersion });
    const beforeSmuggled = structuredClone(smuggled);
    assert.throws(
      () => validateHistoryRecording(smuggled),
      /\.window requires recording version 3/,
    );
    assert.deepEqual(smuggled, beforeSmuggled);
  }
});

test("boot fingerprints distinguish PAL while preserving every NTSC semantic value", () => {
  const legacy = historyBootSemantic(BOOT);
  assert.deepEqual(BOOT.fingerprint, { v: 1, hash: "b0a444137a6d189d" });
  assert.equal(Object.hasOwn(legacy, "amigaRegion"), false);
  assert.deepEqual(stampBoot({ ...BOOT, amigaRegion: "ntsc" }).fingerprint, BOOT.fingerprint);
  assert.deepEqual(stampBoot(BOOT).fingerprint, historyFingerprint(legacy));
  assert.notDeepEqual(stampBoot({ ...BOOT, amigaRegion: "pal" }).fingerprint, BOOT.fingerprint);
  const recording = endedRecording(3);
  recording.segments[0]!.boot = { ...BOOT, amigaRegion: "pal" };
  assert.throws(() => validateHistoryRecording(recording), /fingerprint/);
});
