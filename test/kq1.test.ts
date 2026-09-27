import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { fixtureSkip, KNOWN_GAME_HASH } from "./fixtures.ts";
import { loadGame } from "./game-fixture.ts";

/**
 * Optional King's Quest 1 fixture tests for v2 containers, bytecode,
 * vector pictures, views and dictionary handling. See CONTRIBUTING.md
 * for the required edition and setup.
 */
const TARGET_HASH = KNOWN_GAME_HASH.KQ1;

class QuietHost implements EngineHost {
  prints: string[] = [];
  statusItems: { num: number; name: string }[][] = [];
  print(text: string): void {
    this.prints.push(text);
  }
  statusScreen(items: { num: number; name: string }[]): void {
    this.statusItems.push(items);
  }
  displayAt(): void {}
  statusLine(): void {}
  takeInputLine(): string | null {
    return null;
  }
  takeKeys(): number[] {
    return [];
  }
  ackPrint(): void {}
  prompt(): void {}
}

test(
  "authentic KQ1 boots and runs room 1 for 30 cycles (restarted mode)",
  { skip: fixtureSkip(TARGET_HASH) },
  () => {
    const { container, dict } = loadGame(TARGET_HASH);
    const engine = new Engine(container, new QuietHost(), dict, { restarted: true });
    for (let i = 0; i < 30; i++) engine.tick();

    assert.equal(engine.vars[0], 1, "restarted room is 1");

    // Room 1's picture (the castle courtyard) was decoded by the authentic
    // vector renderer: a hand-authored AGI picture has rich color variety and
    // distinct priority bands for depth sorting.
    const colors = new Set(engine.surface.visual);
    const priorities = new Set(engine.surface.priority);
    assert.ok(colors.size >= 8, `expected >= 8 distinct visual colors, got ${colors.size}`);
    assert.ok(
      priorities.size >= 5,
      `expected >= 5 distinct priority values, got ${priorities.size}`,
    );
  },
);

test(
  "authentic KQ1 cold boot loads room 83 (title screen), handles Tab inventory and Alt+D debug",
  { skip: fixtureSkip(TARGET_HASH) },
  () => {
    const { container, dict } = loadGame(TARGET_HASH);
    class KeyHost extends QuietHost {
      pendingKeys: number[] = [];
      override takeKeys(): number[] {
        const k = this.pendingKeys;
        this.pendingKeys = [];
        return k;
      }
    }
    const host = new KeyHost();
    // Cold boot: flags[6] is 0, so KQ1 starts in room 83 (title screen)
    const engine = new Engine(container, host, dict);
    engine.tick();
    assert.equal(engine.vars[0], 83, "cold boot enters room 83 (title screen)");

    // Pressing Enter (0x000d) or Space (0x0020) advances past the title screen into Room 1
    host.pendingKeys.push(0x000d);
    engine.tick();
    assert.equal(engine.vars[0], 1, "dismissing title screen transitions to room 1");

    // Test sending Tab (0x0009 -> controller 4: status / inventory)
    host.pendingKeys.push(0x0009);
    engine.tick();
    assert.equal(host.statusItems.length, 1, "statusScreen called on Tab");

    // Dismiss the status modal
    engine.ackPrint();
    engine.tick(); // finish the interrupted inventory call before new input

    // Test sending Alt+D (0x2000 -> controller 10: debug mode)
    host.pendingKeys.push(0x2000);
    engine.tick();
    assert.ok(
      host.prints.some((p) => p.includes("VERSION")),
      "Alt+D triggers debug and prints version",
    );
  },
);

test(
  "authentic KQ1 keeps its save slots across a host resume",
  { skip: fixtureSkip(TARGET_HASH) },
  () => {
    const { container, dict } = loadGame(TARGET_HASH);
    // KQ1 runs set.game.id only while v0 is 0, on its boot pass; a resumed
    // image must carry the signature itself (spec "Save names and signatures").
    class SlotHost extends QuietHost {
      engine?: Engine;
      keys: number[] = [];
      dialogKeys: number[] = [];
      slots = new Map<number, Uint8Array>();
      /** The selector's first list row, read when it first waits for a key. */
      firstRow: string | null = null;
      override takeKeys(): number[] {
        return this.keys.splice(0);
      }
      waitKey(): number {
        this.firstRow ??= this.engine!.textRow(3).trim();
        return this.dialogKeys.shift() ?? 0x1b;
      }
      listSaveGames() {
        return [...this.slots].map(([slot, bytes]) => ({ slot, bytes }));
      }
      saveGame(bytes: Uint8Array, slot = 1): void {
        this.slots.set(slot, bytes.slice());
      }
    }
    const F5 = 0x3f00;
    const ENTER = 0x0d;
    const KQ1 = [0x4b, 0x51, 0x31, 0, 0, 0, 0];

    const host = new SlotHost();
    const live = new Engine(container, host, dict);
    host.engine = live;
    live.tick();
    host.keys.push(ENTER); // past the title screen into room 1
    live.tick();
    assert.equal(live.gameSignature, "KQ1");
    // F5, slot 1, "Courtyard", accept, confirm.
    host.dialogKeys.push(ENTER, ..."Courtyard".split("").map((c) => c.charCodeAt(0)), ENTER, ENTER);
    host.keys.push(F5);
    live.tick();
    const courtyard = host.slots.get(1);
    assert.ok(courtyard, "slot 1 written");
    assert.deepEqual(Array.from(courtyard.subarray(33, 40)), KQ1);
    const autosave = live.autosaveImage();
    assert.ok(autosave);

    const resumedHost = new SlotHost();
    resumedHost.slots = host.slots;
    const resumed = new Engine(container, resumedHost, dict);
    resumedHost.engine = resumed;
    resumed.restoreImage(autosave);
    assert.equal(resumed.gameSignature, "KQ1");
    resumedHost.dialogKeys.push(ENTER, ENTER); // replace slot 1
    resumedHost.keys.push(F5);
    resumed.tick();
    assert.equal(resumedHost.firstRow, "1. Courtyard");
    assert.deepEqual(Array.from(host.slots.get(1)!.subarray(33, 40)), KQ1);
    assert.notEqual(host.slots.get(1), courtyard, "the replacement was written");
  },
);
