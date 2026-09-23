import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { openContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { parseLogicResource } from "../src/logic/resource.ts";
import { parseWordsTok } from "../src/logic/words.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { detectProfileDecision, type ProfileId } from "../src/runtime/profile.ts";
import type { SoundOutput } from "../src/sound/sound.ts";
import { findFixture, fixtureSkip } from "./fixtures.ts";

/**
 * Optional platform-port fixture tests. Amiga and Apple IIgs editions ship
 * the same resource containers as the PC releases under their own file
 * spellings (lowercase split files and volumes, `dirs` for the v3 combined
 * directory). Each suite opens the edition under its on-disk names, counts
 * the indexed logics and boots into the first room under the catalogued
 * port profile.
 */

interface PortCase {
  folder: string;
  profile: ProfileId;
  /** Logic records the directory indexes and the container decodes. */
  logics: number;
  /** Indexed logic entries whose records do not decode (dangling pointers). */
  corrupt: number;
  /** Room v0 holds after a restarted boot settles. */
  firstRoom: number;
}

const PORTS: readonly PortCase[] = [
  { folder: "sq1-amiga", profile: "amiga-2.082", logics: 102, corrupt: 0, firstRoom: 2 },
  { folder: "kq2-amiga", profile: "amiga-2.176", logics: 125, corrupt: 0, firstRoom: 1 },
  { folder: "sq2-amiga", profile: "amiga-2.202", logics: 118, corrupt: 1, firstRoom: 2 },
  { folder: "pq1-amiga", profile: "amiga-2.310", logics: 118, corrupt: 0, firstRoom: 6 },
  { folder: "goldrush-amiga", profile: "amiga-2.316", logics: 183, corrupt: 0, firstRoom: 129 },
  { folder: "mh2-amiga", profile: "amiga-2.333", logics: 96, corrupt: 0, firstRoom: 153 },
  { folder: "sq2-iigs", profile: "iigs-1.014", logics: 119, corrupt: 1, firstRoom: 2 },
];

class QuietHost implements EngineHost {
  prints: string[] = [];
  outputs: SoundOutput[] = [];
  keys: number[] = [];
  played: number[] = [];
  stopped = 0;
  print(text: string): void {
    this.prints.push(text);
  }
  soundOutput(output: SoundOutput): void {
    this.outputs.push(output);
  }
  playSound(soundNum: number): void {
    this.played.push(soundNum);
  }
  stopSound(): void {
    this.stopped++;
  }
  displayAt(): void {}
  statusLine(): void {}
  takeInputLine(): string | null {
    return null;
  }
  takeKeys(): number[] {
    return this.keys.splice(0);
  }
  ackPrint(): void {}
  prompt(): void {}
  statusScreen(): void {}
}

/**
 * Read the installation under its on-disk file names: the container, not the
 * test loader, owns the port spellings (`logdir`, `vol.0`, `dirs`).
 */
function loadPort(folder: string): {
  container: ReturnType<typeof openContainer>;
  dict: ReadonlyMap<string, number>;
  files: ReadonlyMap<string, Uint8Array>;
} {
  const fixture = findFixture(folder)!;
  const files = new Map<string, Uint8Array>();
  let dict = new Map<string, number>();
  for (const actual of fixture.files.values()) {
    const path = join(fixture.dir, actual);
    if (!statSync(path).isFile()) continue;
    const bytes = new Uint8Array(readFileSync(path));
    if (actual.toLowerCase() === "words.tok") {
      dict = new Map(parseWordsTok(bytes).map((e) => [e.word, e.id]));
    }
    files.set(actual, bytes);
  }
  return { container: openContainer(files), dict, files };
}

for (const port of PORTS) {
  // The mh2-amiga directory indexes picture 106 in a VOL.15 the release
  // never shipped (UNSHIPPED_VOLUMES in fixtures.ts); "shipped" exempts it.
  const skip = fixtureSkip(port.folder, [], { checkVolumes: "shipped" });

  test(`${port.folder}: resolves to its own catalog pair and indexes its logics`, { skip }, () => {
    const fixture = findFixture(port.folder);
    assert.equal(fixture?.known?.alias, port.folder);
    const { container } = loadPort(port.folder);
    let logics = 0;
    let corrupt = 0;
    for (let n = 0; n < 256; n++) {
      try {
        const payload = container.getResource("logic", n);
        if (payload) {
          assert.ok(parseLogicResource(payload).code.length > 0, `logic ${n} has bytecode`);
          logics++;
        }
      } catch {
        corrupt++;
      }
    }
    assert.equal(logics, port.logics);
    assert.equal(corrupt, port.corrupt);
  });

  test(
    `${port.folder}: detection names the build from the executable, else the catalog`,
    { skip },
    () => {
      const { files } = loadPort(port.folder);
      const shipped = detectProfileDecision(files);
      assert.deepEqual([shipped.profile.id, shipped.kind], [port.profile, "binary"]);
      // A copy without the interpreter executable (a data-only ZIP) still
      // resolves through the catalogued WORDS.TOK + OBJECT pair.
      const dataOnly = new Map(
        [...files].filter(([name]) => !/^(sierra|kq2|sq2|pq|gr|mh2|.*\.sys16)$/i.test(name)),
      );
      const stripped = detectProfileDecision(dataOnly);
      assert.deepEqual([stripped.profile.id, stripped.kind], [port.profile, "catalog"]);
    },
  );

  test(
    `${port.folder}: restarted boot reaches room ${port.firstRoom} without an exception`,
    { skip },
    () => {
      const { container, dict } = loadPort(port.folder);
      const host = new QuietHost();
      const engine = new Engine(container, host, dict, {
        restarted: true,
        profile: port.profile,
      });
      for (let i = 0; i < 60; i++) {
        engine.tick();
        if (host.prints.length > 0) engine.ackPrint();
      }
      assert.equal(engine.profile.id, port.profile);
      assert.equal(engine.vars[0], port.firstRoom);
    },
  );
}

// docs/fidelity.md "Original Amiga sound player": Gold Rush's sound 1 notes
// decode under the h197 formulas into the periods and volumes below.
test(
  "goldrush-amiga: sound 1 drives the Paula path with the driver's envelope",
  { skip: fixtureSkip("goldrush-amiga") },
  () => {
    const { container, dict } = loadPort("goldrush-amiga");
    const host = new QuietHost();
    const engine = new Engine(container, host, dict, {
      restarted: true,
      profile: "amiga-2.316",
    });
    engine.patchResource(
      "logic",
      0,
      assembleLogic("set(f9);load.sound(1);sound(1,f60);return;", { dictionary: dict }).payload,
    );
    engine.tick();
    const ticks: SoundOutput[][] = [];
    for (let t = 0; t < 60; t++) {
      const start = host.outputs.length;
      engine.soundTick();
      ticks.push(host.outputs.slice(start));
    }
    const at = (tick: number, channel: number) =>
      ticks[tick - 1]!.find(
        (event): event is Extract<SoundOutput, { kind: "paula" }> =>
          event.kind === "paula" && event.channel === channel,
      );

    // Each tone channel opens on a rest (control & 0xf = 15) at period 0; the
    // noise voice's stream is just the terminator, so it silences on tick 1.
    assert.deepEqual(ticks[0], [
      { kind: "paula", channel: 0, period: 0, volume: 0 },
      { kind: "paula", channel: 1, period: 0, volume: 0 },
      { kind: "paula", channel: 2, period: 0, volume: 0 },
      { kind: "paula", channel: 3, period: null, volume: 0 },
    ]);
    // Tick 13 decodes channel 0's second note: tone 0x8e0b -> divisor
    // (0x0b&0x3f)<<4 | (0x8e&0xf) = 0xbe -> period 4*190, attenuation 0 with
    // envelope offset table[0] = 2 -> volume ((15-2)<<6)/15 = 55.
    assert.equal(at(13, 0)?.period, 4 * 0xbe);
    assert.equal(at(13, 0)?.volume, 55);
    // table[2] = 0 returns the note to full volume; table[6] = 1 attenuates.
    assert.equal(at(15, 0)?.volume, 64);
    assert.equal(at(19, 0)?.volume, 59);
    // Tick 21 decodes the third note: tone 0x8a0a -> divisor 0xaa -> period
    // 4*170; the tone envelope cursor restarts at table[0].
    assert.equal(at(21, 0)?.period, 4 * 0xaa);
    assert.equal(at(21, 0)?.volume, 55);
    // Channel 1's 29-tick rest ends at tick 30: tone 0xad17 -> divisor 0x17d.
    assert.equal(at(30, 1)?.period, 4 * 0x17d);
    assert.equal(at(30, 1)?.volume, 55);
    // Channel 2's 47-tick rest ends at tick 48: tone 0xce0f -> divisor 0xfe.
    assert.equal(at(48, 2)?.period, 4 * 0xfe);
    assert.equal(at(48, 2)?.volume, 55);
    // The noise voice only ever emitted its termination.
    assert.equal(
      ticks.flat().filter((event) => event.kind === "paula" && event.channel === 3).length,
      1,
    );
    assert.equal(engine.flags[60], 0, "the sound still plays at tick 60");
  },
);

// docs/fidelity.md "Apple IIgs interpreter": SQ2 IIgs boots its intro logic
// (which uses the IIgs-only action 0xb0), leaves it on a key, reaches room 2
// and plays its first sound — a type-0x02 stream whose 0xfc terminator must
// complete the sound-done flag within bounded ticks.
test(
  "sq2-iigs: key leaves the intro, room 2's first sound completes its done flag",
  { skip: fixtureSkip("sq2-iigs") },
  () => {
    const { container, dict } = loadPort("sq2-iigs");
    const host = new QuietHost();
    // Keep an Enter waiting for the intro's have.key poll.
    host.keys.push(0x0d);
    const engine = new Engine(container, host, dict, {
      restarted: true,
      profile: "iigs-1.014",
    });
    // Three sound ticks per interpreter tick matches the 60 Hz heartbeat
    // against the ~20 Hz game pass.
    const step = () => {
      engine.tick();
      for (let i = 0; i < 3; i++) engine.soundTick();
      if (host.prints.length > 0) engine.ackPrint();
      if (host.keys.length === 0) host.keys.push(0x0d);
    };
    for (let i = 0; i < 600 && (engine.vars[0] !== 2 || host.played.length === 0); i++) step();
    assert.equal(engine.vars[0], 2, "the intro releases to room 2");
    assert.ok(host.played.length > 0, "the game called sound() by room 2");
    // The done flag the logic passed goes 0 at the sound call and 1 when the
    // stream's terminator executes; bound the wait far past any decoded
    // resource length.
    let doneFlags: number[] = [];
    let spuriousStops = 0;
    let ticks = 0;
    for (; ticks < 40000 && doneFlags.length === 0; ticks++) {
      const before = Uint8Array.from(engine.flags);
      const stopsBefore = host.stopped;
      engine.soundTick();
      if (host.stopped === stopsBefore) continue;
      // A flag set on the same sound tick as the stop is the done flag; a
      // stop without one is the game's own stop.sound/discard.sound.
      const flipped: number[] = [];
      for (let f = 0; f < 256; f++) if (before[f] === 0 && engine.flags[f] === 1) flipped.push(f);
      if (flipped.length > 0) doneFlags = flipped;
      else spuriousStops++;
    }
    assert.ok(
      doneFlags.length > 0,
      `done flag after ${ticks} sound ticks (${spuriousStops} game-initiated stops)`,
    );
  },
);
