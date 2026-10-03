import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { compactContainer, openContainer } from "../src/container/container.ts";
import { parseWordsTok } from "../src/logic/words.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import {
  detectProfile,
  detectProfileDecision,
  PROFILES,
  type DirectoryAbsence,
} from "../src/runtime/profile.ts";
import type { ResourceKind } from "../src/types.ts";
import { findFixture, fixtureSkip } from "./fixtures.ts";

/**
 * The profile-derived directory absence policy (docs/fidelity.md, "Amiga
 * directory absence"): the Amiga 2.31x combined-directory loader treats any
 * entry whose first byte's high nibble is f as absent, whatever its tail
 * holds; the DOS v3 rule absents only the exact ff ff ff and keeps VOL.15
 * usable. The container resolves the rule once at open, through the same
 * detection pipeline the engine uses, and packs within its volume ceiling.
 */

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

/** A v3 volume record: magic, volume/metadata byte, length and stored length. */
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

function image(
  entries: readonly (readonly [ResourceKind, number, number, number, number])[],
  volumes: Readonly<Record<number, Uint8Array>>,
  extra: Readonly<Record<string, Uint8Array>> = {},
): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  files.set("XDIR", combinedDirectory(entries));
  files.set("XVOL.0", volumes[0] ?? new Uint8Array(0));
  for (const [n, bytes] of Object.entries(volumes))
    if (Number(n) !== 0) files.set(`XVOL.${n}`, bytes);
  for (const [name, bytes] of Object.entries(extra)) files.set(name, bytes);
  return files;
}

/** Every absent spelling the probes established, VOL.15 reachable or not. */
const NIBBLE_F_ENTRIES: readonly (readonly [number, number, number])[] = [
  [0xf0, 0x00, 0x00],
  [0xf0, 0xab, 0xcd],
  [0xf1, 0x23, 0x45],
  [0xfe, 0xff, 0xff],
  [0xff, 0xff, 0xfc],
  [0xff, 0xff, 0xff],
];

const NATIVE_PROFILES = ["amiga-2.310", "amiga-2.316", "amiga-2.333"] as const;
const VOL15_RECORD = volumeRecord(15, Uint8Array.of(0xff));

for (const profile of NATIVE_PROFILES) {
  test(`${profile}: every high-nibble-f entry is absent, even with a valid VOL.15`, () => {
    for (const [b0, b1, b2] of NIBBLE_F_ENTRIES) {
      const files = image([["picture", 0, b0, b1, b2]], { 15: VOL15_RECORD });
      const container = openContainer(files, { profile });
      assert.equal(
        container.getResource("picture", 0),
        null,
        `entry ${[b0, b1, b2].map((b) => b.toString(16)).join(" ")} must be absent`,
      );
    }
  });
}

test("binary detection picks the same rule: Amiga executables mark nibble-f entries absent", () => {
  for (const [name, id] of [
    ["PQ", "amiga-2.310"],
    ["GR", "amiga-2.316"],
    ["MH2", "amiga-2.333"],
  ] as const) {
    const files = image(
      [["picture", 0, 0xf0, 0x00, 0x00]],
      { 15: VOL15_RECORD },
      { [name]: Uint8Array.of(0, 0, 3, 0xf3) },
    );
    assert.equal(detectProfile(files).id, id);
    assert.equal(openContainer(files).getResource("picture", 0), null);
  }
});

test("the dirs fallback selects amiga-2.333 as a fallback, not a build identity", () => {
  const files = new Map<string, Uint8Array>([
    ["dirs", combinedDirectory([["picture", 0, 0xff, 0xff, 0xfc]])],
    ["vol.0", new Uint8Array(0)],
  ]);
  const decision = detectProfileDecision(files);
  assert.deepEqual([decision.profile.id, decision.kind], ["amiga-2.333", "default"]);
  assert.equal(openContainer(files).getResource("picture", 0), null);
});

test("DOS combined directory: exact ff ff ff is absent, nibble-f spellings reach VOL.15", () => {
  const absent = image([["picture", 0, 0xff, 0xff, 0xff]], { 15: VOL15_RECORD });
  assert.equal(openContainer(absent).getResource("picture", 0), null);
  const loaded = image([["picture", 0, 0xf0, 0x00, 0x00]], { 15: VOL15_RECORD });
  assert.deepEqual(openContainer(loaded).getResource("picture", 0), Uint8Array.of(0xff));
  // A nibble-f tail the DOS rule does not absent really reaches the volume:
  // the read fails on bounds inside XVOL.15, not on absence.
  const deep = image([["picture", 0, 0xf0, 0xab, 0xcd]], { 15: VOL15_RECORD });
  assert.throws(() => openContainer(deep).getResource("picture", 0), /out of bounds|missing/);
});

test("identical bytes, explicit profiles: the same layout follows each policy", () => {
  const files = image([["picture", 0, 0xf0, 0x00, 0x00]], { 15: VOL15_RECORD });
  for (const profile of NATIVE_PROFILES)
    assert.equal(openContainer(files, { profile }).getResource("picture", 0), null, profile);
  assert.deepEqual(
    openContainer(files, { profile: "3.002.149" }).getResource("picture", 0),
    Uint8Array.of(0xff),
  );
});

test("explicit AgiProfile object matches its id, and a v2 profile keeps nibble-f", () => {
  const files = image([["picture", 0, 0xf0, 0x00, 0x00]], { 15: VOL15_RECORD });
  assert.equal(
    openContainer(files, { profile: PROFILES["amiga-2.333"] }).getResource("picture", 0),
    null,
  );
  const split = new Map<string, Uint8Array>([
    ["PICDIR", Uint8Array.of(0xf0, 0x00, 0x00)],
    ["VOL.0", new Uint8Array(0)],
    // A v2 five-byte record: magic, volume, payload length.
    ["VOL.15", Uint8Array.of(0x12, 0x34, 15, 0x01, 0x00, 0xff)],
  ]);
  assert.equal(
    openContainer(split, { profile: "2.936" }).getResource("picture", 0),
    null,
    "v2 split absence is unchanged",
  );
  assert.deepEqual(
    openContainer(split, { profile: "3.002.149" }).getResource("picture", 0),
    Uint8Array.of(0xff),
    "a real VOL.15 reference under DOS stays a read, not an absent entry",
  );
});

test("the absence decision freezes at open: a mutated caller profile cannot reinterpret bytes", () => {
  const override = { ...PROFILES["amiga-2.333"] };
  const files = image([["picture", 0, 0xff, 0xff, 0xfc]], { 15: VOL15_RECORD });
  const container = openContainer(files, { profile: override });
  (override as { directoryAbsence: DirectoryAbsence }).directoryAbsence = "exact-fff";
  assert.equal(container.getResource("picture", 0), null);
});

test("a missing real volume still fails under either rule", () => {
  const files = image([["picture", 0, 0xe0, 0x00, 0x00]], {});
  for (const profile of ["amiga-2.333", "3.002.149"] as const)
    assert.throws(
      () => openContainer(files, { profile }).getResource("picture", 0),
      /missing VOL.14/,
      profile,
    );
});

test("pack and reopen preserve absence semantics and stored record bytes", () => {
  // XVOL.0: a plain record at 0, three pad bytes, a picture-compressed record
  // (0x80 metadata; nibbles 00 00 ff ff decode to one black pixel, then end).
  const vol0 = new Uint8Array(19);
  vol0.set(volumeRecord(0, Uint8Array.of(0xaa, 0xbb, 0xcc)), 0);
  vol0.set(volumeRecord(0, Uint8Array.of(0x00, 0xff), 0x80), 10);
  const files = image(
    [
      ["logic", 0, 0x00, 0x00, 0x00],
      ["picture", 0, 0xff, 0xff, 0xfc],
      ["picture", 1, 0x00, 0x00, 0x0a],
    ],
    { 0: vol0 },
    { MH2: Uint8Array.of(0, 0, 3, 0xf3) },
  );
  const container = openContainer(files);
  assert.equal(container.getResource("picture", 0), null);
  container.putResource("view", 9, Uint8Array.of(1, 2, 3, 4));
  const reopened = openContainer(container.files);
  assert.equal(reopened.getResource("picture", 0), null, "absent stays absent after packing");
  assert.deepEqual(reopened.getResource("logic", 0), Uint8Array.of(0xaa, 0xbb, 0xcc));
  assert.deepEqual(reopened.getResource("picture", 1), Uint8Array.of(0x00, 0xff));
  const repacked0 = container.files.get("XVOL.0")!;
  // The compressed record survives byte-for-byte (volume 0 keeps 0x80).
  assert.deepEqual(repacked0.subarray(10, 19), volumeRecord(0, Uint8Array.of(0x00, 0xff), 0x80));
});

// 15 destination volumes of 15 records each: the 240th record can only land
// on VOL.15 — allowed under the DOS rule, refused under the nibble-f rule.
function fullImage(): Map<string, Uint8Array> {
  const entries: [ResourceKind, number, number, number, number][] = [];
  const volumes: Record<number, Uint8Array> = {};
  for (let v = 0; v < 15; v++) {
    const vol = new Uint8Array(16 * 65542);
    for (let i = 0; i < 16; i++) {
      const num = v * 16 + i;
      const payload = new Uint8Array(0xffff).fill(num & 0xff);
      vol.set(volumeRecord(v, payload), i * 65542);
      const offset = i * 65542;
      entries.push(["logic", num, (v << 4) | (offset >> 16), (offset >> 8) & 0xff, offset & 0xff]);
    }
    volumes[v] = vol;
  }
  return image(entries, volumes);
}

test("DOS packs the 16th volume; the nibble-f rule refuses it atomically", () => {
  const files = fullImage();
  const packed = compactContainer(files);
  assert.ok(packed.has("XVOL.15"), "DOS may write VOL.15");
  assert.ok(!packed.has("XVOL.16"));
  const reopened = openContainer(packed);
  assert.ok(reopened.getResource("logic", 239)!.every((byte) => byte === 239));

  const native = openContainer(files, { profile: "amiga-2.333" });
  const before = new Map(native.files);
  assert.throws(
    () => native.putResource("sound", 0, Uint8Array.of(1)),
    /volume number would exceed 14/,
  );
  assert.deepEqual(native.files, before, "the failed pack mutates nothing");
});

const amigaFixture = findFixture("mh2-amiga");
const amigaSkip = amigaFixture
  ? false
  : "Place the mh2-amiga fixture under games/ to run this test.";

test(
  "mh2-amiga fixture: strict volume readiness, PIC106 absent, boot reaches its room",
  { skip: amigaSkip },
  () => {
    // No unshipped-volume waiver remains for this directory hash.
    assert.equal(fixtureSkip("mh2-amiga", [], { checkVolumes: true }), false);
    const files = new Map<string, Uint8Array>();
    let dict = new Map<string, number>();
    for (const actual of amigaFixture!.files.values()) {
      const path = join(amigaFixture!.dir, actual);
      if (!statSync(path).isFile()) continue;
      const bytes = new Uint8Array(readFileSync(path));
      if (actual.toLowerCase() === "words.tok")
        dict = new Map(parseWordsTok(bytes).map((e) => [e.word, e.id]));
      files.set(actual, bytes);
    }
    const decision = detectProfileDecision(files);
    assert.deepEqual([decision.profile.id, decision.kind], ["amiga-2.333", "binary"]);
    // PIC106's ff ff fc entry is absent, not a missing VOL.15 reference.
    assert.equal(openContainer(files).getResource("picture", 106), null);
    // Without the executable the catalog still resolves the Amiga profile.
    const dataOnly = new Map(
      [...files].filter(([name]) => !/^(sierra|kq2|sq2|pq|gr|mh2)$/i.test(name)),
    );
    assert.deepEqual(
      (() => {
        const d = detectProfileDecision(dataOnly);
        return [d.profile.id, d.kind];
      })(),
      ["amiga-2.333", "catalog"],
    );
    assert.equal(openContainer(dataOnly).getResource("picture", 106), null);
    // A normal boot under the same policy reaches the game's first room.
    const host = new (class implements EngineHost {
      prints: string[] = [];
      print(text: string): void {
        this.prints.push(text);
      }
      displayAt(): void {}
      statusLine(): void {}
      takeInputLine(): string | null {
        return null;
      }
      takeKeys(): number[] {
        return [];
      }
    })();
    const engine = new Engine(openContainer(files), host, dict, {
      restarted: true,
      profile: "amiga-2.333",
    });
    for (let i = 0; i < 60; i++) {
      engine.tick();
      if (host.prints.length > 0) engine.ackPrint();
    }
    assert.equal(engine.vars[0], 153);
  },
);

test("logic 0 absence is never a silent successful boot", () => {
  // Under the Amiga rule the boot logic's nibble-f entry is absent, so the
  // engine reports the missing resource instead of executing nothing.
  const logic = assembleLogic("return;", { dictionary: new Map() }).payload;
  const files = image(
    [
      ["logic", 0, 0xf0, 0x00, 0x00],
      ["logic", 1, 0x00, 0x00, 0x00],
    ],
    { 0: volumeRecord(0, logic), 15: volumeRecord(15, logic) },
    { MH2: Uint8Array.of(0, 0, 3, 0xf3) },
  );
  const container = openContainer(files);
  assert.equal(container.getResource("logic", 0), null);
  const engine = new Engine(container, {
    print() {},
    displayAt() {},
    statusLine() {},
    takeInputLine: () => null,
    takeKeys: () => [],
  });
  assert.throws(() => engine.tick(), /logic resource 0 not in container/);
});
