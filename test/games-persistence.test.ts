import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { decodeSave, SAVE_DESCRIPTION_BYTES } from "../src/runtime/persistence.ts";
import { detectProfile } from "../src/runtime/profile.ts";
import { fixtureSkip, KNOWN_GAME_HASH } from "./fixtures.ts";
import { loadGame } from "./game-fixture.ts";

/**
 * Optional save/restore tests for the King's Quest editions below.
 *
 * The block dimensions below are the spec's own per-game tables from "Rooms,
 * Replay, and Persistence", not values read back from this encoder:
 *
 * - KQ1 (profile 2.917): 0x05e1, 0x0306, 0x0148, 0x00c8, variable.
 * - KQ2 (profile 2.411): 0x05df, 0x02db, 0x0256, 0x0078, variable.
 * - KQ3 (profile 2.936): 0x05e1, 0x02db, 0x0307, 0x00fe, variable.
 *
 * Blocks 2, 3 and 4 are game-data properties: block 2 is (maximum drawable
 * object index + 1) records of 0x2b bytes, block 3 is the decoded OBJECT file
 * minus its three-byte header, and block 4 is twice the replay-pair capacity
 * the game configures with script.size.
 */

interface PersistenceCase {
  hash: string;
  alias: string;
  profile: string;
  /** First playable room a restarted boot lands in. */
  firstRoom: number;
  /** Spec block lengths: block 1..4. Block 5 is variable. */
  blocks: readonly [number, number, number, number];
  /** Replay-pair capacity the game configures (block 4 / 2). */
  replayCapacity: number;
  /** Drawable-object records in block 2 (block 2 / 0x2b). */
  objectRecords: number;
  /** Three-byte inventory entries at the head of block 3. */
  inventoryEntries: number;
  maximumScore: number;
}

const GAMES: readonly PersistenceCase[] = [
  {
    hash: KNOWN_GAME_HASH.KQ1,
    alias: "kq1",
    profile: "2.917",
    firstRoom: 1,
    blocks: [0x05e1, 0x0306, 0x0148, 0x00c8],
    replayCapacity: 100,
    objectRecords: 18,
    inventoryEntries: 27,
    maximumScore: 158,
  },
  {
    hash: KNOWN_GAME_HASH.KQ2,
    alias: "kq2",
    profile: "2.411",
    firstRoom: 1,
    blocks: [0x05df, 0x02db, 0x0256, 0x0078],
    replayCapacity: 60,
    objectRecords: 17,
    inventoryEntries: 85,
    maximumScore: 185,
  },
  {
    hash: KNOWN_GAME_HASH.KQ3,
    alias: "kq3",
    profile: "2.936",
    firstRoom: 7,
    blocks: [0x05e1, 0x02db, 0x0307, 0x00fe],
    replayCapacity: 127,
    objectRecords: 17,
    inventoryEntries: 55,
    maximumScore: 210,
  },
];

class QuietHost implements EngineHost {
  keys: number[] = [];
  saved: Uint8Array | null = null;
  print(): void {}
  displayAt(): void {}
  statusLine(): void {}
  takeInputLine(): string | null {
    return null;
  }
  takeKeys(): number[] {
    const keys = this.keys;
    this.keys = [];
    return keys;
  }
  statusScreen(): void {}
  saveGame(bytes: Uint8Array): void {
    this.saved = bytes;
  }
  restoreGame(): Uint8Array | null {
    return this.saved;
  }
}

/** Storage adapter used only by the real game's interactive restore path. */
class SelectorHost extends QuietHost {
  scans = 0;
  restoredSlots: (number | undefined)[] = [];
  selectorKeys = [0x4800, 13];

  listSaveGames(): { slot: number; bytes: Uint8Array }[] {
    this.scans++;
    return this.saved
      ? [
          { slot: 1, bytes: this.saved },
          { slot: 9, bytes: this.saved },
        ]
      : [];
  }
  waitKey(): number {
    // Startup screens can wait for a raw key before save selection begins.
    return this.scans === 0 ? 13 : (this.selectorKeys.shift() ?? 27);
  }
  override restoreGame(slot?: number): Uint8Array | null {
    this.restoredSlots.push(slot);
    return this.saved;
  }
}

function boot(
  gameRef: string,
  options: { restarted: boolean; cycles: number },
  host: QuietHost = new QuietHost(),
) {
  const { container, dict, files } = loadGame(gameRef, { interpreterFiles: true });
  const profile = detectProfile(files);
  const engine = new Engine(container, host, dict, {
    profile,
    restarted: options.restarted,
  });
  for (let i = 0; i < options.cycles; i++) {
    if (i % 40 === 0) host.keys.push(13); // dismiss intro windows on a cold boot
    engine.tick();
    engine.ackPrint();
  }
  return { engine, host, container, dict, files, profile };
}

/** Block lengths of a save image, in order. */
function blockLengths(image: Uint8Array, count: number): number[] {
  const lengths: number[] = [];
  let at = SAVE_DESCRIPTION_BYTES;
  for (let i = 0; i < count; i++) {
    const length = image[at]! | (image[at + 1]! << 8);
    lengths.push(length);
    at += 2 + length;
  }
  assert.equal(at, image.length, "the blocks account for every byte of the file");
  return lengths;
}

for (const game of GAMES) {
  const skip = fixtureSkip(game.hash, ["AGIDATA.OVL"]);

  describe(`${game.alias} persistence`, { skip }, () => {
    test(`save blocks match the spec's ${game.profile} ${game.alias} dimensions`, (t) => {
      // A cold boot runs the intro, which is where these games configure their
      // replay-pair capacity with script.size.
      const { engine } = boot(game.hash, { restarted: false, cycles: 400 });
      assert.equal(engine.profile.id, game.profile);
      assert.equal(engine.vars[0], game.firstRoom, "reached the first playable room");

      const image = engine.serialize();
      const lengths = blockLengths(image, engine.profile.saveBlocks);
      assert.deepEqual(lengths.slice(0, 4), [...game.blocks]);

      // The block dimensions are derived, not asserted twice: block 2 is one
      // 0x2b-byte record per drawable object, block 4 is twice the capacity.
      assert.equal(game.blocks[1], game.objectRecords * 0x2b);
      assert.equal(game.blocks[3], game.replayCapacity * 2);

      const state = decodeSave(image, engine.profile);
      assert.equal(state.objects.length, game.objectRecords);
      assert.equal(state.replayCapacity, game.replayCapacity);
      assert.equal(state.replay.length, game.replayCapacity);
      // Block 3's inventory entries are three bytes each, before the name pool.
      assert.ok(
        state.inventory.length > game.inventoryEntries * 3,
        "block 3 holds the entries and a name pool",
      );
      // Every entry's name offset selects a zero-terminated name in the pool.
      for (let item = 0; item < game.inventoryEntries; item++) {
        const offset = state.inventory[item * 3]! | (state.inventory[item * 3 + 1]! << 8);
        assert.ok(
          offset >= game.inventoryEntries * 3 && offset < state.inventory.length,
          `item ${item}'s name offset ${offset} points into the name pool`,
        );
      }
      // Block 5 is (cached logics + 2) four-byte records.
      if (engine.profile.saveBlocks === 5) {
        assert.equal(lengths[4], (state.logicResume.length + 2) * 4);
      }
      t.diagnostic(
        `${game.alias}: blocks ${lengths.map((l) => `0x${l.toString(16)}`).join(" ")}, ` +
          `${state.replayActive} active replay pairs, ${state.logicResume.length} cached logics`,
      );
    });

    test("the status line uses the maximum score declared by the game", () => {
      const { engine } = boot(game.hash, { restarted: false, cycles: 400 });
      assert.equal(engine.vars[7], game.maximumScore);
      assert.equal(
        engine.textRow(0).slice(1, 18).trimEnd(),
        `Score: ${engine.vars[3]} of ${game.maximumScore}`,
      );
    });

    test("restoring into a fresh engine reproduces state and the rendered screen", (t) => {
      const { engine } = boot(game.hash, { restarted: true, cycles: 30 });
      assert.equal(engine.vars[0], game.firstRoom);

      const beforeVars = Array.from(engine.vars);
      const beforeFlags = Array.from(engine.flags);
      const beforeVisual = Array.from(engine.surface.visual);
      const beforePriority = Array.from(engine.surface.priority);
      const beforeObjects = engine.readObjects();
      const ego = beforeObjects.find((o) => o.num === 0);
      assert.ok(ego, "ego is animated in the first room");
      // A blank screen would make the buffer comparison vacuous.
      const colors = new Set(beforeVisual);
      assert.ok(colors.size > 4, `the first room really drew a picture (${colors.size} colours)`);

      const image = engine.serialize();

      // A fresh engine that never ran this room: everything visible after the
      // restore has to come from the save image and its replay sequence.
      const { container, dict } = loadGame(game.hash);
      const freshHost = new QuietHost();
      const fresh = new Engine(container, freshHost, dict, { profile: engine.profile });
      assert.equal(new Set(fresh.surface.visual).size, 1, "the fresh surface is blank");

      // Restore aborts the current logic continuation, exactly as it does when
      // restore.game runs inside a cycle.
      assert.throws(() => fresh.applyRestore(image));

      assert.deepEqual(Array.from(fresh.vars), beforeVars, "v0..v255");
      assert.deepEqual(Array.from(fresh.flags), beforeFlags, "f0..f255");
      assert.equal(fresh.vars[0], game.firstRoom, "the restored room");
      assert.equal(fresh.horizon, engine.horizon);
      const restoredEgo = fresh.readObjects().find((o) => o.num === 0);
      assert.deepEqual(
        { x: restoredEgo?.x, y: restoredEgo?.y, view: restoredEgo?.view, loop: restoredEgo?.loop },
        { x: ego.x, y: ego.y, view: ego.view, loop: ego.loop },
        "ego position and view selection",
      );
      assert.deepEqual(
        fresh.readObjects().map((o) => o.num),
        beforeObjects.map((o) => o.num),
        "the same objects are animated",
      );

      // The replayed resource sequence rebuilt the exact same picture surface.
      assert.deepEqual(Array.from(fresh.surface.visual), beforeVisual, "visual buffer");
      assert.deepEqual(Array.from(fresh.surface.priority), beforePriority, "priority buffer");
      t.diagnostic(
        `${game.alias}: ${colors.size} visual colours and ` +
          `${new Set(beforePriority).size} priority bands reproduced exactly`,
      );
    });

    test("the game's F7 restore action selects a slot and replays the saved room", () => {
      const host = new SelectorHost();
      const { engine } = boot(game.hash, { restarted: false, cycles: 400 }, host);
      host.saved = engine.serialize();
      const beforeVisual = Array.from(engine.surface.visual);

      // Mutate visible state, then let the game's own restore.game path run.
      engine.vars[220] = 0xab;
      engine.surface.visual.fill(0);
      host.keys.push(0x4100); // F7 is restore in each installed game's own set.key table.
      engine.tick();

      assert.equal(host.scans, 1, "the game's restore opcode opened the selector");
      assert.deepEqual(host.restoredSlots, [9], "Up wraps from the first candidate to slot 9");
      assert.equal(engine.modalKind, null, "successful restore closes the selector");
      assert.equal(engine.vars[220], 0, "the saved variables replaced the mutation");
      assert.deepEqual(Array.from(engine.surface.visual), beforeVisual);
    });
  });
}

test(
  "KQ3's game-written clock survives status refresh with two-digit minutes and seconds",
  {
    skip: fixtureSkip(KNOWN_GAME_HASH.KQ3, ["AGIDATA.OVL"]),
  },
  () => {
    const { engine } = boot(KNOWN_GAME_HASH.KQ3, { restarted: false, cycles: 400 });
    // Logic 0 displays its clock at column 20 using %v117:%v116|2:%v115|2.
    assert.equal(engine.textRow(0).slice(20, 28), "0:00:00 ");
    engine.tick();
    assert.equal(engine.textRow(0).slice(20, 28), "0:00:00 ");
  },
);
