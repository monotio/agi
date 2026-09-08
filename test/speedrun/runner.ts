import assert from "node:assert/strict";
import { Engine, type EngineHost } from "../../src/runtime/engine.ts";
import { CycleClock } from "../../src/runtime/cycleClock.ts";
import { detectProfile } from "../../src/runtime/profile.ts";
import { DIRECTION_KEYS, directionForDelta, randomSource } from "../../src/agent/gameTestSteps.ts";
import { loadGame } from "../game-fixture.ts";

// The step vocabulary is shared with stored game tests (src/agent/gameTestSteps.ts)
// so speedrun proofs and TESTS.JSON can never disagree; re-export the pieces
// this module has always provided.
export { DIRECTION_KEYS, randomSource };

export type Action =
  | { kind: "key"; code: number }
  | { kind: "command"; text: string }
  | { kind: "advance"; ticks: number }
  | { kind: "answer"; text: string }
  | { kind: "checkpoint"; label: string; room: number; score: number; x: number; y: number };
/** Local-only input driver. No writes to game variables, objects, flags or resources. */
export class Speedrun {
  readonly engine: Engine;
  readonly actions: Action[] = [];
  readonly messages: string[] = [];
  readonly seed: number;
  readonly slug: string;
  ticks = 0;
  cycles = 0;
  private readonly clock = new CycleClock(0);
  private readonly keys: number[] = [];
  private line: string | null = null;
  private readonly answers: string[] = [];

  constructor(slug = "kq1", seed = 1) {
    this.seed = seed;
    this.slug = slug;
    const { container, dict, files } = loadGame(slug, { interpreterFiles: true });
    const host: EngineHost = {
      print: (text) => this.messages.push(text),
      displayAt() {},
      statusLine() {},
      // A cold boot has no manual saves, matching a fresh browser profile.
      listSaveGames: () => [],
      takeKeys: () => this.keys.splice(0),
      takeInputLine: () => {
        const line = this.line;
        this.line = null;
        return line;
      },
      waitKey: () => {
        this.actions.push({ kind: "key", code: 13 });
        return 13;
      },
      promptString: () => {
        const answer = this.answers.shift();
        assert.notEqual(answer, undefined, "Walkthrough must supply an explicit prompt answer");
        this.actions.push({ kind: "answer", text: answer! });
        return answer!;
      },
      randomWord: randomSource(seed),
    };
    this.engine = new Engine(container, host, dict, {
      profile: detectProfile(files),
      instructionBudget: 1_000_000,
    });
    // Match the app's initial user sound preference before executing game logic.
    this.engine.setSoundEnabled(true);
  }

  state() {
    const ego = this.engine.screenObjects[0]!;
    return {
      room: this.engine.vars[0]!,
      score: this.engine.vars[3]!,
      x: ego.x,
      y: ego.y,
      direction: this.engine.vars[6]!,
      modal: this.engine.modalKind,
      control: this.engine.inputEnabled,
      text: Array.from({ length: 25 }, (_, row) => this.engine.textRow(row)).join("\n"),
    };
  }

  key(code: number): void {
    this.actions.push({ kind: "key", code });
    this.keys.push(code);
  }

  answer(text: string): void {
    this.answers.push(text);
  }

  advance(ticks = 1): void {
    assert.ok(Number.isInteger(ticks) && ticks > 0);
    for (let i = 0; i < ticks; i++) {
      const previous = this.actions.at(-1);
      if (previous?.kind === "advance") previous.ticks++;
      else this.actions.push({ kind: "advance", ticks: 1 });
      this.ticks++;
      this.engine.advanceClock(1000 / 60);
      this.engine.soundTick();
      if (this.engine.modalKind !== null || this.engine.continuationPending) this.engine.tick();
      else if (this.clock.poll((this.ticks * 1000) / 60, this.engine.vars[10]!)) {
        this.engine.tick();
        this.cycles++;
      }
      if (this.slug === "kq1" && this.engine.flags[63] !== 0)
        assert.fail(`Graham died: ${JSON.stringify(this.state())}`);
    }
  }

  dismiss(): void {
    for (let n = 0; this.engine.modalKind !== null || this.engine.continuationPending; n++) {
      assert.ok(n < 100, `Unsettled modal: ${this.state().text}`);
      if (this.engine.modalKind !== null) this.key(13);
      this.advance();
    }
  }

  command(text: string): void {
    this.dismiss();
    this.wait(() => this.engine.inputEnabled, `Parser available for ${text}`);
    assert.equal(this.line, null, "Previous command must be consumed");
    this.actions.push({ kind: "command", text });
    this.line = text;
    for (let n = 0; this.line !== null; n++) {
      assert.ok(n < 1000, `Command not consumed: ${text}`);
      this.advance();
    }
    this.dismiss();
  }

  direction(dir: number): void {
    const current = this.state().direction;
    if (current === dir) return;
    this.key(DIRECTION_KEYS[dir || current]!);
    const from = this.cycles;
    for (let n = 0; this.cycles === from; n++) {
      assert.ok(n < 1000, "Direction input did not reach a cycle");
      this.dismiss();
      this.advance();
    }
  }

  wait(predicate: () => boolean, label: string, max = 30000): void {
    for (let n = 0; n < max; n++) {
      this.dismiss();
      if (predicate()) return;
      this.advance();
    }
    throw new Error(`Timed out: ${label}; ${JSON.stringify(this.state())}`);
  }

  walkTo(x: number, y: number, max = 3000): void {
    const room = this.state().room;
    for (let n = 0; n < max; n++) {
      this.dismiss();
      const state = this.state();
      assert.equal(state.room, room, `Unexpected room while walking to ${x},${y}`);
      const dx = Math.sign(x - state.x);
      const dy = Math.sign(y - state.y);
      if (!dx && !dy) {
        this.direction(0);
        return;
      }
      this.direction(directionForDelta(dx, dy));
      this.advance();
    }
    throw new Error(`Walk blocked at ${JSON.stringify(this.state())}, target ${x},${y}`);
  }

  exit(dir: "N" | "E" | "S" | "W", room: number, max = 10000): void {
    const from = this.state().room;
    const dirs = { N: 1, E: 3, S: 5, W: 7 };
    for (let n = 0; n < max && this.state().room === from; n++) {
      this.dismiss();
      this.direction(dirs[dir]);
      this.advance();
    }
    assert.equal(this.state().room, room, `Exit ${dir} from ${from}`);
    this.direction(0);
    this.dismiss();
  }

  checkpoint(label: string, expected: { room?: number; score?: number }): void {
    const state = this.state();
    if (expected.room !== undefined) assert.equal(state.room, expected.room, label);
    if (expected.score !== undefined) assert.equal(state.score, expected.score, label);
    this.actions.push({
      kind: "checkpoint",
      label,
      room: state.room,
      score: state.score,
      x: state.x,
      y: state.y,
    });
    process.stdout.write(
      `${label}: room ${state.room}, score ${state.score}, (${state.x},${state.y}), ${this.ticks} ticks\n`,
    );
  }
}
