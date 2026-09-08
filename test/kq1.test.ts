import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { fixtureSkip } from "./fixtures.ts";
import { loadGame } from "./game-fixture.ts";

/**
 * Optional King's Quest 1 fixture tests for v2 containers, bytecode,
 * vector pictures, views and dictionary handling. See CONTRIBUTING.md
 * for the required edition and setup.
 */

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
  { skip: fixtureSkip("kq1") },
  () => {
    const { container, dict } = loadGame("kq1");
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
  { skip: fixtureSkip("kq1") },
  () => {
    const { container, dict } = loadGame("kq1");
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
