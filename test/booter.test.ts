import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeBooter } from "../src/container/booter.ts";
import { createContainer, openContainer } from "../src/container/container.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { detectProfile } from "../src/runtime/profile.ts";
import { fixtureDir, fixtureFiles, fixtureSkip } from "./fixtures.ts";
import { readFileSync } from "node:fs";
import { parseWordsTok } from "../src/logic/words.ts";
import { buildLogicResource } from "../src/logic/resource.ts";

class QuietHost implements EngineHost {
  print(): void {}
  displayAt(): void {}
  statusLine(): void {}
  takeInputLine(): string | null {
    return null;
  }
  takeKeys(): number[] {
    return [];
  }
}
/** Entirely original synthetic disk: one resource in each family and raw metadata. */
function disk(): Uint8Array {
  const image = new Uint8Array(368640);
  image.set(
    Array.from("BOOT v2.0", (character) => character.charCodeAt(0)),
    6,
  );
  image.fill(255, 512, 512 + 48);
  const native = Uint8Array.from("Version 2.001", (character) => character.charCodeAt(0));
  const records: [number, number, Uint8Array][] = [
    [6, 2048, native],
    [8, 2560, Uint8Array.of(3, 0, 1, 63, 0)],
    [9, 3072, new Uint8Array(52)],
    [10, 3584, Uint8Array.of(0, 0, 0, 255, 255, 255)],
    [11, 4096, Uint8Array.of(0, 0, 8)],
    [12, 4608, Uint8Array.of(0, 0, 14)],
    [13, 5120, Uint8Array.of(0, 0, 24)],
  ];
  for (const [slot, offset, bytes] of records) {
    image.set([0x10 | (offset >> 16), (offset >> 8) & 255, offset & 255], 512 + slot * 3);
    image.set([0x12, 0x34, 0, bytes.length & 255, bytes.length >> 8], offset);
    image.set(bytes, offset + 5);
  }
  image.set([0, 0x18, 0], 512 + 14 * 3);
  image.set(
    [
      0x12, 0x34, 0, 3, 0, 1, 0, 0, 0x12, 0x34, 0, 1, 0, 255, 0x12, 0x34, 0, 5, 0, 1, 1, 0, 0, 0,
      0x12, 0x34, 0, 3, 0, 0x90, 0, 0,
    ],
    6144,
  );
  return image;
}

test("extracts raw booter resources and preserves interpreter evidence separately", () => {
  const image = disk();
  const before = image.slice();
  const decoded = decodeBooter(image);
  assert.deepEqual([...decoded.files.keys()].sort(), [
    "LOGDIR",
    "OBJECT",
    "PICDIR",
    "SNDDIR",
    "VIEWDIR",
    "VOL.0",
    "WORDS.TOK",
  ]);
  assert.deepEqual(decoded.files.get("OBJECT"), Uint8Array.of(3, 0, 1, 63, 0));
  assert.deepEqual(decoded.files.get("LOGDIR"), Uint8Array.of(0, 0, 0, 255, 255, 255));
  assert.equal(decoded.files.get("VOL.0")!.length, 32);
  assert.deepEqual(decoded.files.get("VOL.0")!.subarray(29), Uint8Array.of(0x90, 0, 0));
  assert.equal(decoded.evidence.format, "pc-booter-2.001");
  assert.equal(decoded.evidence.interpreterVersion, "2.001");
  assert.equal(decoded.evidence.imageBytes, 368640);
  assert.deepEqual(decoded.evidence.fileTable["VOL.0"], { slot: 14, offset: 6144, bytes: 32 });
  assert.deepEqual(
    decoded.evidence.interpreterData,
    Uint8Array.from("Version 2.001", (character) => character.charCodeAt(0)),
  );
  assert.deepEqual(image, before);
  decoded.files.get("OBJECT")![0] = 0;
  decoded.evidence.interpreterData[0] = 0;
  assert.deepEqual(image, before, "returned files and evidence own their bytes");
});

test("ignores a trailing partial directory entry and entries beyond slot 255", () => {
  // A directory whose length is not a multiple of three ends in a partial
  // entry that cannot name a resource; the observed disks hold only complete
  // entries, so the tail is inert padding.
  const partial = disk();
  partial.set([0x12, 0x34, 0, 4, 0, 0, 0, 0, 0x99], 3584);
  const decodedPartial = decodeBooter(partial);
  assert.deepEqual(decodedPartial.files.get("LOGDIR"), Uint8Array.of(0, 0, 0, 0x99));
  assert.equal(decodedPartial.files.get("VOL.0")!.length, 32, "volume end from complete entries");

  // Directory entries address resources 0..255; a longer directory's extra
  // entries are outside the resource-id range and never consulted.
  const overlong = disk();
  const snddir = new Uint8Array(257 * 3).fill(255);
  snddir.set([0, 0, 24], 0); // sound 0 -> VOL.0:24
  snddir.set([0x10, 0, 0], 256 * 3); // slot 256: would be an unavailable volume if read
  overlong.set([0x12, 0x34, 0, snddir.length & 255, snddir.length >> 8], 5120);
  overlong.set(snddir, 5125);
  const decodedOverlong = decodeBooter(overlong);
  assert.equal(decodedOverlong.files.get("SNDDIR")!.length, 257 * 3, "raw bytes preserved");
  assert.equal(decodedOverlong.evidence.fileTable["VOL.0"]!.bytes, 32);
});

test("decoded files open as a v2-split container and detect the native 2.001 profile", () => {
  const decoded = decodeBooter(disk());
  const files = new Map(decoded.files);
  // The native interpreter bytes ride along as AGIDATA.OVL so the identity
  // survives import and reload (no fabricated or relabeled version).
  files.set("AGIDATA.OVL", decoded.evidence.interpreterData);
  const container = openContainer(files);
  assert.deepEqual(container.getResource("logic", 0), Uint8Array.of(1, 0, 0));
  assert.deepEqual(container.getResource("sound", 0), Uint8Array.of(0x90, 0, 0));
  assert.equal(container.getResource("picture", 1), null);
  assert.equal(detectProfile(files).id, "2.001");
  assert.equal(detectProfile(openContainer(files).files).id, "2.001", "identity survives reload");
});

test("2.001 action 0x8f configures max animated objects without touching signature", () => {
  // docs/fidelity.md pc-booter-action-0x8f: in 2.001, action 0x8f is max.drawn.objects(count).
  // Boot logic passes count (e.g. 25) without looking up a message. In 2.089+, 0x8f is set.game.id(msg).
  const container = createContainer();
  container.putResource("logic", 0, buildLogicResource(new Uint8Array([0x8f, 25, 0x00]), []));
  const engine = new Engine(container, new QuietHost(), undefined, { profile: "2.001" });
  engine.tick();
  assert.equal(engine.maxDrawnObjects, 25);
  assert.equal(engine.gameSignature, "");

  const rejecting = createContainer();
  rejecting.putResource("logic", 0, buildLogicResource(new Uint8Array([0x8f, 25, 0x00]), []));
  assert.throws(
    () => new Engine(rejecting, new QuietHost(), undefined, { profile: "2.936" }).tick(),
    /message 25 out of range/,
  );
});

test("rejects unknown disk geometry, boot signatures, and interpreter versions", () => {
  assert.throws(() => decodeBooter(new Uint8Array(512)), /disk image size/i);
  const signature = disk();
  signature[6] = 0;
  assert.throws(() => decodeBooter(signature), /boot signature/i);
  const version = disk();
  version[2048 + 5 + 12] = 50;
  assert.throws(() => decodeBooter(version), /interpreter version/i);
});

test("rejects absent, overlapping, and out-of-bounds master records", () => {
  const absent = disk();
  absent.fill(255, 512 + 10 * 3, 512 + 11 * 3);
  assert.throws(() => decodeBooter(absent), /LOGDIR.*master/i);
  const outside = disk();
  outside.set([0x1f, 255, 255], 512 + 8 * 3);
  assert.throws(() => decodeBooter(outside), /OBJECT.*outside/i);
  const overlap = disk();
  overlap.set([0x10, 0x08, 0], 512 + 8 * 3);
  assert.throws(() => decodeBooter(overlap), /overlap/i);
  const magic = disk();
  magic[2560] = 0;
  assert.throws(() => decodeBooter(magic), /OBJECT.*magic/i);
});

test("rejects inaccessible volumes, corrupt resource headers, and truncated payloads", () => {
  const unavailable = disk();
  unavailable[3584 + 5] = 0x10;
  assert.throws(() => decodeBooter(unavailable), /LOGDIR\[0\].*volume 1/i);
  const magic = disk();
  magic[6144] = 0;
  assert.throws(() => decodeBooter(magic), /LOGDIR\[0\].*magic/i);
  const mismatch = disk();
  mismatch[6144 + 2] = 1;
  assert.throws(() => decodeBooter(mismatch), /LOGDIR\[0\].*volume/i);
  const truncated = disk();
  // Resource starts at final complete header but declares two unavailable payload bytes.
  truncated.set([5, 0x87, 0xfb], 3584 + 5);
  truncated.set([0x12, 0x34, 0, 2, 0], 368635);
  // Offset relative to VOL.0: 368635 - 6144 = 362491 = 0x587fb.
  assert.throws(() => decodeBooter(truncated), /LOGDIR\[0\].*outside/i);
});

// Optional compatibility fixture: a locally supplied PC booter disk image at
// games/ddp-booter/ (see docs/testing.md). Skipped explicitly when absent.
test(
  "the supported disk layout cold-boots to the title and a player-chosen difficulty",
  { skip: fixtureSkip("ddp-booter", ["disk1.img"], { resourceFiles: false }) },
  () => {
    const onDisk = fixtureFiles("ddp-booter")!;
    const image = new Uint8Array(readFileSync(fixtureDir("ddp-booter") + onDisk.get("disk1.img")!));
    const decoded = decodeBooter(image);
    const files = new Map(decoded.files);
    files.set("AGIDATA.OVL", decoded.evidence.interpreterData);
    const dict = new Map(parseWordsTok(files.get("WORDS.TOK")!).map((e) => [e.word, e.id]));
    const keys: number[] = [];
    const prints: string[] = [];
    const host: EngineHost = {
      print(text: string) {
        prints.push(text);
      },
      displayAt() {},
      statusLine() {},
      takeInputLine() {
        return null;
      },
      takeKeys() {
        return keys.splice(0);
      },
      waitKey() {
        return keys.shift() ?? 13;
      },
      soundDevice() {
        return 1;
      },
    };
    const engine = new Engine(openContainer(files), host, dict, {
      profile: detectProfile(files),
    });
    assert.equal(engine.profile.id, "2.001");
    engine.flags[9] = 1; // browser sessions start with sound enabled
    const ENTER = 13;
    const UP = 0x4800;
    const roomAt: Record<number, number> = {};
    let printsBeforeRoom3 = 0;
    for (let i = 0; i < 1200 && engine.vars[0] !== 7; i++) {
      if (i === 20 || i === 60) keys.push(ENTER); // leave the title screen
      if (engine.vars[0] === 3 && printsBeforeRoom3 === 0) {
        printsBeforeRoom3 = prints.length;
        keys.push(ENTER); // acknowledge the continuation prompt
      }
      if (engine.vars[0] === 3 && i > 40 && engine.vars[6] !== 1) keys.push(UP);
      engine.tick();
      engine.soundTick();
      engine.advanceClock(50);
      roomAt[engine.vars[0]!] = i;
    }
    assert.ok(roomAt[1] !== undefined, "reached the title room");
    assert.ok(roomAt[3] !== undefined, "reached difficulty selection");
    assert.ok(printsBeforeRoom3 > 0, "the selection screen prompted the player");
    assert.equal(engine.vars[0], 7, "a doorway choice entered the selected game");
    assert.notEqual(engine.vars[114], 2, "difficulty variables changed from their boot value");
  },
);
