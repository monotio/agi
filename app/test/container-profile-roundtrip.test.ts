// The declared profile must govern container interpretation end to end:
// import reads the boot resource under the declared absence policy, the Game
// export carries the declared id in GAME.JSON, and the worker boots — and
// rebuilds replay engines — on the same decision. See docs/fidelity.md,
// "Amiga directory absence".

import assert from "node:assert/strict";
import { test } from "node:test";
import { openContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { requireResourceRevision } from "../../src/gameIdentity.ts";
import { readGameFiles, readGameZip } from "../src/archive/gameZip.ts";
import { buildPublicGameZip } from "../src/archive/projectArchive.ts";
import { createWorkerContext, type WorkerPorts } from "../src/worker/context.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import { createEngineHost } from "../src/worker/host.ts";
import type { WorkerControl, WorkerInbound } from "../src/worker/workerProtocol.ts";
import type { ResourceKind } from "../../src/types.ts";
import type { ProfileId } from "../../src/runtime/profile.ts";

const bootLogic = assembleLogic("return;", { dictionary: new Map() }).payload;
const roomLogic = assembleLogic("return;", { dictionary: new Map() }).payload;
const wordsTok = new Uint8Array(52);

// v3 seven-byte volume record: magic, volume/metadata byte, length, stored length.
function volumeRecord(volume: number, payload: Uint8Array, metadata?: number): Uint8Array {
  const bytes = new Uint8Array(7 + payload.length);
  bytes.set([
    0x12,
    0x34,
    metadata ?? volume & 0xff,
    payload.length & 0xff,
    payload.length >>> 8,
    payload.length & 0xff,
    payload.length >>> 8,
  ]);
  bytes.set(payload, 7);
  return bytes;
}

const SECTION_OFFSET: Record<ResourceKind, number> = {
  logic: 8,
  picture: 776,
  view: 1544,
  sound: 2312,
};

/** A four-section combined directory of 256 entries each, initially absent. */
function combinedDirectory(
  entries: readonly (readonly [ResourceKind, number, number, number, number])[],
): Uint8Array {
  const dir = new Uint8Array(8 + 4 * 256 * 3).fill(0xff);
  const kinds: ResourceKind[] = ["logic", "picture", "view", "sound"];
  for (let i = 0; i < 4; i++) {
    const at = SECTION_OFFSET[kinds[i]!]!;
    dir[i * 2] = at & 0xff;
    dir[i * 2 + 1] = at >> 8;
  }
  for (const [kind, num, b0, b1, b2] of entries) {
    const p = SECTION_OFFSET[kind] + num * 3;
    dir[p] = b0;
    dir[p + 1] = b1;
    dir[p + 2] = b2;
  }
  return dir;
}

function gameJson(fields: Record<string, unknown> = {}): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ format: "monotio.agi", version: 1, ...fields }));
}

/**
 * A v3 combined game: logic 0 at VOL.0:0, picture 0 and logic 5 spelled
 * f0 00 00 — a real VOL.15 reference under the DOS rule, absent under the
 * Amiga high-nibble-f rule. Which of the two the entry is depends on the
 * declared profile alone.
 */
function combinedGameFiles(bootEntry: readonly [number, number, number]): Map<string, Uint8Array> {
  const vol0 = new Uint8Array(7 + bootLogic.length + 3);
  vol0.set(volumeRecord(0, bootLogic), 0);
  return new Map<string, Uint8Array>([
    [
      "XDIR",
      combinedDirectory([
        ["logic", 0, bootEntry[0], bootEntry[1], bootEntry[2]],
        ["picture", 0, 0xf0, 0x00, 0x00],
        ["logic", 5, 0xf0, 0x00, 0x00],
      ]),
    ],
    ["XVOL.0", vol0],
    ["XVOL.15", volumeRecord(15, roomLogic)],
    ["WORDS.TOK", wordsTok],
  ]);
}

test("import applies the declared profile before reading the boot resource", () => {
  // logic 0 spelled f0 00 00: a valid VOL.15 reference under DOS, absent
  // under the Amiga rule — the declared metadata decides.
  const files = combinedGameFiles([0xf0, 0x00, 0x00]);

  const dos = readGameFiles(new Map([...files, ["GAME.JSON", gameJson({ profile: "3.002.149" })]]));
  assert.equal(dos.profile, "3.002.149");
  assert.deepEqual(dos.files["XDIR"], files.get("XDIR"));

  assert.throws(
    () => readGameFiles(new Map([...files, ["GAME.JSON", gameJson({ profile: "amiga-2.333" })]])),
    /starting logic/,
    "the declared Amiga profile reads the same bytes as absence",
  );

  // No declared profile: byte fallback keeps VOL.15 reachable and imports.
  const undetected = readGameFiles(new Map([...files, ["GAME.JSON", gameJson()]]));
  assert.equal(undetected.profile, undefined);
});

test("import rejects unknown metadata before trusting the bytes", () => {
  // Boot is valid under every rule; only the metadata is wrong — so the
  // failure can only come from metadata validation running first.
  const files = combinedGameFiles([0x00, 0x00, 0x00]);
  assert.throws(
    () => readGameFiles(new Map([...files, ["GAME.JSON", gameJson({ profile: "amiga-9.999" })]])),
    /does not know/,
  );
  assert.throws(
    () => readGameFiles(new Map([...files, ["GAME.JSON", gameJson({ version: 7 })]])),
    /newer than this app/,
  );
});

test("exported game archives carry the declared profile into the next import", async () => {
  const files = Object.fromEntries(combinedGameFiles([0x00, 0x00, 0x00]));
  const revision = requireResourceRevision("a".repeat(64));
  const library = {
    version: 1 as const,
    revision,
    source: "zip" as const,
    validation: { status: "unverified" as const, message: "" },
  };
  const opened = await readGameZip(
    buildPublicGameZip({
      title: "Round Trip",
      files,
      roomGeneration: false,
      library: { ...library, profile: "amiga-2.333" },
    }),
  );
  assert.equal(opened.profile, "amiga-2.333");
  const container = openContainer(new Map(Object.entries(opened.files)), {
    profile: opened.profile,
  });
  assert.equal(
    container.getResource("picture", 0),
    null,
    "the nibble-f entry stays absent after export and reimport",
  );

  const dosOpened = await readGameZip(
    buildPublicGameZip({
      title: "Round Trip",
      files,
      roomGeneration: false,
      library: { ...library, profile: "3.002.149" },
    }),
  );
  assert.equal(dosOpened.profile, "3.002.149");
  const dosContainer = openContainer(new Map(Object.entries(dosOpened.files)), {
    profile: dosOpened.profile,
  });
  // Same bytes, DOS rule: the nibble-f entry reads the real VOL.15 record.
  assert.deepEqual(dosContainer.getResource("picture", 0), roomLogic);
});

function bootedContext(profile: ProfileId) {
  const control: WorkerControl[] = [];
  const ports: WorkerPorts = {
    control: (msg) => control.push(msg),
    presentation: () => {},
    now: () => 0,
    seedWord: () => 0x1234,
    schedule: (fn, ms) => ({ fn, ms }),
    cancelSchedule: () => {},
  };
  const ctx = createWorkerContext(ports);
  ctx.host = createEngineHost(ctx);
  const files = Object.fromEntries(combinedGameFiles([0x00, 0x00, 0x00]));
  const msg: WorkerInbound = { type: "boot", profile, files, words: [] };
  onWorkerMessage(ctx, msg);
  ctx.fns.stopTimers();
  const booted = control.find((m) => m.type === "booted");
  assert.ok(booted && booted.type === "booted", "booted message received");
  return { ctx, control };
}

function playHereRoom(
  ctx: ReturnType<typeof createWorkerContext>,
  control: WorkerControl[],
  room: number,
) {
  const before = control.length;
  onWorkerMessage(ctx, { type: "playHere", id: 1, room, x: 80, y: 100 });
  const reply = control.slice(before).find((m) => m.type === "playedHere");
  assert.ok(reply && reply.type === "playedHere", "playedHere reply received");
  return reply;
}

test("worker boot and replay rebuilds keep the declared directory policy", () => {
  const { ctx, control } = bootedContext("amiga-2.333");
  // logic 5 is spelled f0 00 00: absent under the declared Amiga rule even
  // though XVOL.15 ships a valid record.
  const refused = playHereRoom(ctx, control, 5);
  assert.equal(refused.ok, false);
  assert.match(refused.reason ?? "", /no logic/i);

  // resetReplay rebuilds the container from the boot profile; the absence
  // decision survives the session reset.
  onWorkerMessage(ctx, { type: "resetReplay", seed: 1 });
  onWorkerMessage(ctx, { type: "exitReplay" });
  ctx.fns.stopTimers();
  const refusedAfter = playHereRoom(ctx, control, 5);
  assert.equal(refusedAfter.ok, false);
  assert.match(refusedAfter.reason ?? "", /no logic/i);

  const { ctx: dosCtx, control: dosControl } = bootedContext("3.002.149");
  const dosReply = playHereRoom(dosCtx, dosControl, 5);
  assert.doesNotMatch(dosReply.reason ?? "", /no logic/i);
});
