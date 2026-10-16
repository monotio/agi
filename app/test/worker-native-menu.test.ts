import { loadAppearance } from "../src/render/appearance.ts";
// These synchronous state-machine tests begin after platform assets are ready.
await loadAppearance("amiga-2.202");

/**
 * The worker's side of the Amiga menu strip: pointer events reach the
 * engine, only the ones that changed something are recorded, the frame
 * carries the strip and its availability, and a history replay reproduces
 * the released item (docs/fidelity.md "Original native menu dispatch").
 * Fake ports and a real Engine, booted like the app boots a game.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { OperationRecorder } from "../../src/agent/recordedReplay.ts";
import { collectSegments, gameContainer, replayHistorySegment } from "./worker-ctx.ts";
import { createWorkerContext, type WorkerContext } from "../src/worker/context.ts";
import { createEngineHost } from "../src/worker/host.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import type {
  WorkerControl,
  WorkerInbound,
  WorkerPresentation,
} from "../src/worker/workerProtocol.ts";

const MENU_LOGIC = `
  if (!isset(f200)) {
    set(f200);
    configure.screen(1, 22, 0);
    load.pic(v250); draw.pic(v250); show.pic();
    set.menu("File");
    set.menu.item("Save     <F5>", 3);
    set.menu.item("Restore  <F7>", 5);
    set.menu("Speed");
    set.menu.item("Normal ", 24);
    submit.menu();
    set(f14);
    status.line.on();
    set.key(0, 59, 3);
  }
  if (controller(3)) { save.game(); }
  if (controller(5)) { assignn(v100, 5); }
  if (controller(24)) { assignn(v100, 24); }
  if (isset(f201)) { reset(f14); }
  return;
`;

function session() {
  const container = gameContainer([MENU_LOGIC], (c) =>
    c.putResource("picture", 0, Uint8Array.of(0xff)),
  );
  const control: WorkerControl[] = [];
  const presentation: WorkerPresentation[] = [];
  let now = 0;
  const ctx: WorkerContext = createWorkerContext({
    control: (message) => control.push(message),
    presentation: (message) => presentation.push(message),
    now: () => now,
  });
  ctx.host = createEngineHost(ctx);
  const send = (msg: WorkerInbound): void => onWorkerMessage(ctx, msg);
  send({
    type: "boot",
    profile: "amiga-2.202",
    files: Object.fromEntries(container.files),
    words: [],
  });
  ctx.fns.stopTimers();
  const tick = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      now += 1000 / 60;
      ctx.fns.hostTick();
    }
  };
  tick(8);
  const engine = () => ctx.run.engine!;
  const frame = () => {
    const last = presentation.filter((m) => m.type === "frame").at(-1);
    assert.ok(last && last.type === "frame");
    return last;
  };
  const causes = () => ctx.history.open.events.map((e) => e.cause);
  /** Answer the latest host request of `op` as the main thread would. */
  const answer = (op: string, response: string): void => {
    const request = control.filter((m) => m.type === "hostRequest" && m.op === op).at(-1);
    assert.ok(request && request.type === "hostRequest", `a ${op} request went to the host`);
    send({ type: "hostAnswer", generation: request.generation, id: request.id, response });
  };
  return { ctx, control, send, tick, engine, frame, causes, answer };
}

test("the strip's pointer events drive the engine, record once per change and replay from history", () => {
  const s = session();
  s.ctx.run.recording.recording = {
    tape: new OperationRecorder(),
    events: [],
    printed: [],
    tainted: null,
  };
  assert.equal(s.frame().menuAvailable, true, "the frame offers the strip");
  s.send({ type: "menu", op: "open", x: 10, y: 3 });
  assert.equal(s.frame().menu?.titles[0]?.highlighted, true);
  assert.equal(s.frame().statusBar, null, "the strip replaces the title bar");
  assert.equal(s.frame().modal, "menu");
  s.send({ type: "menu", op: "move", x: 12, y: 3 });
  s.send({ type: "menu", op: "move", x: 12, y: 25 });
  assert.equal(s.frame().menu?.pulldown?.highlighted, 1);
  s.send({ type: "menu", op: "release", x: 12, y: 25 });
  assert.equal(s.engine().modalKind, null);
  s.tick(2);
  assert.equal(s.engine().vars[100], 5, "Restore's controller reached the logic");
  assert.deepEqual(
    s.causes().flatMap((c) => (c.kind === "menu" ? [[c.op, c.x, c.y, c.sticky]] : [])),
    [
      ["open", 10, 3, false],
      ["move", 12, 25, false],
      ["release", 12, 25, false],
    ],
    "the move that changed nothing is not recorded",
  );
  assert.deepEqual(
    s.ctx.run.recording.recording.tape.operations.filter((op) => op[0] === "menu"),
    [
      ["menu", ["open", 10, 3, 0]],
      ["menu", ["move", 12, 25, 0]],
      ["menu", ["release", 12, 25, 0]],
    ],
  );
  // The history segment replays to the same controller.
  s.send({ type: "pause", paused: true });
  const [segment] = collectSegments(s.control);
  assert.ok(segment);
  const outcome = replayHistorySegment(segment);
  assert.equal(outcome.error, null);
  assert.equal(outcome.diverged, null, "every sync mark held");
  assert.equal(outcome.ctx.run.engine!.vars[100], 5, "the replayed release chose Restore");
});

test("a stale open after the gate closed is ignored and leaves no record", () => {
  const s = session();
  s.ctx.run.recording.recording = {
    tape: new OperationRecorder(),
    events: [],
    printed: [],
    tainted: null,
  };
  s.engine().flags[201] = 1;
  s.tick(2);
  assert.equal(s.frame().menuAvailable, false, "f14 clear: the frame withdraws the strip");
  s.send({ type: "menu", op: "open", x: 10, y: 3 });
  assert.equal(s.engine().modalKind, null);
  assert.equal(
    s.causes().some((c) => c.kind === "menu"),
    false,
  );
  assert.equal(
    s.ctx.run.recording.recording.tape.operations.some((op) => op[0] === "menu"),
    false,
  );
});

test("host access: a sticky open stays without the button; taps, arrows and Enter drive it", () => {
  const s = session();
  s.send({ type: "menu", op: "open", x: -1, y: -1, sticky: true });
  assert.equal(s.engine().modalKind, "menu");
  s.send({ type: "menu", op: "release", x: 300, y: 150 });
  assert.equal(s.engine().modalKind, "menu", "no button: a release does nothing");
  s.send({ type: "menu", op: "tap", x: 60, y: 3 });
  assert.equal(s.frame().menu?.titles[1]?.highlighted, true);
  s.send({ type: "direction", dir: 5 });
  assert.equal(s.frame().menu?.pulldown?.highlighted, 0);
  s.send({ type: "key", code: 0x0d });
  s.tick(2);
  assert.equal(s.engine().modalKind, null);
  assert.equal(s.engine().vars[100], 24);
  assert.deepEqual(
    s.causes().flatMap((c) => (c.kind === "menu" ? [[c.op, c.sticky]] : [])),
    [
      ["open", true],
      ["tap", false],
    ],
  );
});

test("the describe window's Cancel gadget withdraws the description prompt and saves nothing", () => {
  const s = session();
  // F1 is bound to controller 3; the game saves on it.
  s.send({ type: "key", code: 0x3b00 });
  s.tick(2);
  s.answer("saveList", "[]");
  s.tick(2);
  assert.equal(s.engine().modalKind, "save");
  // Enter on slot 1 opens the describe window, whose description is a host prompt.
  s.send({ type: "key", code: 0x0d });
  s.tick(2);
  assert.equal(s.engine().hostInteraction?.kind, "saveDialog");
  const describe = s.control.filter((m) => m.type === "hostRequest" && m.op === "saveDescription");
  assert.equal(describe.length, 1, "the description prompt went to the host");
  // A click beside the gadgets changes nothing; the Cancel gadget (x 224..279,
  // y 107..118 at picture top 1) withdraws the prompt and ends the dialog.
  s.send({ type: "click", x: 100, y: 112 });
  assert.equal(s.engine().modalKind, "save");
  s.send({ type: "click", x: 250, y: 112 });
  assert.equal(
    s.control.some((m) => m.type === "interactionCancelled"),
    true,
    "the host's prompt is told to close",
  );
  s.tick(2);
  assert.equal(s.engine().modalKind, null);
  assert.equal(
    s.control.some((m) => m.type === "hostRequest" && m.op === "saveWrite"),
    false,
    "nothing was written",
  );
  assert.equal(s.engine().vars[100], 0);
});
