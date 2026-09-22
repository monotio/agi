/**
 * The original RNG contract (docs/fidelity.md, "Original RNG and wander
 * countdown"): vectors executed against nine Sierra interpreter builds —
 * the 16-bit step, the zero-state BIOS-clock reseed, the random(n,m,v)
 * remainder mapping and the wander countdown's while-reroll.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { RETURN } from "../src/logic/opcodes.ts";
import { buildLogicResource } from "../src/logic/resource.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { PROFILES } from "../src/runtime/profile.ts";
import { rngDraw } from "../src/runtime/rng.ts";
import { buildView } from "../src/view/view.ts";

const hostDefaults: EngineHost = {
  print() {},
  displayAt() {},
  statusLine() {},
  takeInputLine: () => null,
  takeKeys: () => [],
};

/** A host lane running the original step; `state` is inspectable per draw. */
function rngHost(state = 1, reseed = 0x1234): { host: EngineHost; rng: { state: number } } {
  const rng = { state };
  return {
    rng,
    host: {
      ...hostDefaults,
      randomByte: () => {
        const draw = rngDraw(rng.state, () => reseed);
        rng.state = draw.state;
        return draw.byte;
      },
    },
  };
}

function game(source: string, engineHost: EngineHost = hostDefaults, extra?: string): Engine {
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic(source, { dictionary: new Map(), profile: PROFILES["2.936"] }).payload,
  );
  if (extra !== undefined)
    container.putResource(
      "logic",
      1,
      assembleLogic(extra, { dictionary: new Map(), profile: PROFILES["2.936"] }).payload,
    );
  container.putResource(
    "view",
    1,
    buildView({ loops: [{ cels: [{ width: 2, height: 1, pixels: [1, 1] }] }] }),
  );
  return new Engine(container, engineHost, undefined, { profile: "2.936" });
}

test("the 16-bit step reproduces the original's stream from state 1", () => {
  // Executed on all nine verified builds (fidelity.md): state, returned byte.
  const expected = [
    [31822, 50],
    [11127, 92],
    [46796, 122],
    [52061, 150],
    [14074, 204],
    [41267, 146],
    [12376, 104],
    [10873, 83],
    [25190, 4],
    [175, 175],
  ];
  let state = 1;
  const reseeds: number[] = [];
  for (const [wantState, wantByte] of expected) {
    const draw = rngDraw(state, () => {
      reseeds.push(state);
      return 0x55;
    });
    assert.equal(draw.state, wantState);
    assert.equal(draw.byte, wantByte);
    state = draw.state;
  }
  assert.equal(reseeds.length, 0, "no zero-state entry — the clock is never read");
});

test("a zero-state draw reads the clock word, and the next draw can reseed again", () => {
  // Executed: state 58235 advances to zero and returns zero; the following
  // draw reads BIOS DX. DX=0x1234 → state 43429, byte 12; DX=0 → 1, 1.
  let draw = rngDraw(58235, () => {
    throw new Error("reseed must not run — state is nonzero on entry");
  });
  assert.deepEqual(draw, { state: 0, byte: 0 });

  let reads = 0;
  const clock = () => {
    reads++;
    return 0x1234;
  };
  draw = rngDraw(draw.state, clock);
  assert.deepEqual(draw, { state: 43429, byte: 12 });
  draw = rngDraw(draw.state, clock);
  assert.equal(reads, 1, "one reseed per zero entry — not per draw");
  assert.deepEqual(draw, { state: 62114, byte: 80 }, "the reseeded stream advances");

  draw = rngDraw(0, () => 0);
  assert.deepEqual(draw, { state: 1, byte: 1 }, "a zero clock word still steps");
});

test("random(n,m,v) takes the byte's unsigned remainder and consumes the draw at n=m", () => {
  // Executed on 3.002.149, each case starting at state 1: (0,255)→50,
  // (10,20)→16, (42,42)→42 — equal bounds still draw.
  for (const [lo, hi, want] of [
    [0, 255, 50],
    [10, 20, 16],
    [42, 42, 42],
  ] as const) {
    const { host, rng } = rngHost(1);
    const engine = game(`random(${lo},${hi},v50);return;`, host);
    engine.execute(0);
    assert.equal(engine.vars[50], want, `random(${lo},${hi})`);
    assert.equal(rng.state, 31822, "one draw consumed");
  }
  // In sequence the equal-bounds call visibly consumed its draw: the next
  // call takes the stream's second byte, not a repeat of the first.
  const { host } = rngHost(1);
  const engine = game("random(42,42,v50);random(0,255,v51);return;", host);
  engine.execute(0);
  assert.equal(engine.vars[50], 42);
  assert.equal(engine.vars[51], 92);
});

test("random with reversed bounds uses the 16-bit span; a zero span is a fault", () => {
  // Executed on 3.002.149 from state 1: (20,10) → 20 + 50 % 65527 = 70;
  // (1,0) raised a CPU divide error — the engine surfaces a thrown fault
  // instead of normalizing bounds or emulating a machine crash. Shipped code
  // leans on the machine behavior (kq2 logic 167 rolls random(30,0,v) =
  // 30 + byte, wrapped to a byte), so the assembler accepts it and the
  // bytes here are built directly: 0x82 lo hi var, then return.
  const raw = (lo: number, hi: number, host: EngineHost): Engine => {
    const container = createContainer();
    container.putResource(
      "logic",
      0,
      buildLogicResource(new Uint8Array([0x82, lo, hi, 50, RETURN]), []),
    );
    return new Engine(container, host, undefined, { profile: "2.936" });
  };
  const { host, rng } = rngHost(1);
  const engine = raw(20, 10, host);
  engine.execute(0);
  assert.equal(engine.vars[50], 70);
  assert.equal(rng.state, 31822, "the draw was consumed");

  assert.throws(() => raw(1, 0, rngHost(1).host).execute(0), /zero range/);
});

test("wander decrements first and rerolls the count only while below six", () => {
  // The five rows executed on all nine verified builds: each starts at RNG
  // state 1 with object direction 0. (old count, stationary) → new
  // direction, new count, final RNG state.
  const rows: [number, boolean, number, number, number][] = [
    [0, false, 5, 255, 31822], // wraps to 255 — kept, one draw
    [1, false, 0, 0, 1], // count nonzero and moving: no draw at all
    [1, true, 5, 41, 11127], // direction, then 92 % 51 = 41 ≥ 6
    [8, true, 5, 7, 31822], // decremented to 7 — kept, no reroll
    [255, true, 5, 254, 31822], // decremented to 254 — kept
  ];
  for (const [oldCount, stationary, wantDir, wantCount, wantState] of rows) {
    const { host, rng } = rngHost(1);
    const engine = game(
      `if (!isset(f200)) { set(f200); load.view(1); animate.obj(o0); set.view(o0, 1);
       position(o0, 20, 100); draw(o0); stop.cycling(o0); ignore.objs(o0);
       assignn(v60, 1); step.size(o0, v60); step.time(o0, v60); wander(o0); } return;`,
      host,
    );
    engine.tick();
    const o = engine.screenObjects[0]!;
    o.paramBank[0] = oldCount; // the wander countdown is the bank's first byte
    o.stationary = stationary;
    o.direction = 0;
    rng.state = 1; // each executed row started at RNG state 1
    engine.tick();
    assert.equal(
      o.direction,
      wantDir,
      `old ${oldCount} stationary ${stationary}: direction ${o.direction} ≠ ${wantDir}`,
    );
    assert.equal(o.paramBank[0], wantCount, `old ${oldCount}: count`);
    assert.equal(rng.state, wantState, `old ${oldCount}: rng state (draw count)`);
    assert.equal(engine.vars[6], o.direction, "ego direction mirrors to v6");
  }
});

test("restart preserves the RNG stream — no draw, no reseed", () => {
  // The save/restart audit: accepted restart leaves the host's RNG word
  // untouched; the next draw continues the same stream — it does not
  // restart at the seed. From state 1 the stream's first bytes are 50, 92.
  const { host, rng } = rngHost(1);
  const engine = game("random(0,255,v50);return;", host, "set(f16);restart.game();return;");
  engine.execute(0);
  assert.equal(engine.vars[50], 50);
  try {
    engine.execute(1); // the restart's ContinuationAbort unwinds the pass
  } catch {
    /* the abort is the restart's own control flow */
  }
  assert.equal(rng.state, 31822, "restart consumed no draw and no reseed");
  engine.execute(0);
  assert.equal(engine.vars[50], 92, "the stream continued across the restart");
  assert.equal(rng.state, 11127);
});
