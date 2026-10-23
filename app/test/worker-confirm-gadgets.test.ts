import { loadAppearance } from "../src/render/appearance.ts";
// These synchronous state-machine tests begin after platform assets are ready.
await Promise.all(["amiga-2.082", "amiga-2.202", "amiga-2.310"].map((id) => loadAppearance(id)));

/**
 * Amiga restart/quit confirmations offer two Intuition gadgets (Restart /
 * Cancel, Quit / Continue; docs/fidelity.md F-persistence-05). Each gadget
 * is a selectable target: a mouse click or a touch tap on its label performs
 * that choice, Enter and Escape keep their key meanings, and PC profiles keep
 * their keyboard-only prompts. The engine owns the gadget layout
 * (test/original-lifecycle.test.ts pins the cells); this test drives the
 * worker's message paths with fake ports and a real Engine.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ProfileId } from "../../src/runtime/profile.ts";
import { collectSegments, gameContainer, replayHistorySegment } from "./worker-ctx.ts";
import { createWorkerContext, type WorkerContext } from "../src/worker/context.ts";
import { createEngineHost } from "../src/worker/host.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import type {
  WorkerControl,
  WorkerInbound,
  WorkerPresentation,
} from "../src/worker/workerProtocol.ts";

const AMIGA: readonly ProfileId[] = [
  "amiga-2.082",
  "amiga-2.176",
  "amiga-2.202",
  "amiga-2.310",
  "amiga-2.316",
  "amiga-2.333",
];

/** F1 asks to restart, F2 to quit (recorded keys, so a replay asks too); f6 marks the restarted pass. */
const CONFIRM_LOGIC = `
  if (isset(f6)) { assignn(v90, 1); return; }
  if (!isset(f200)) { set(f200); configure.screen(1, 22, 0); set.key(0, 59, 1); set.key(0, 60, 2); }
  if (controller(c1)) { restart.game(); assignn(v81, 1); return; }
  if (controller(c2)) { quit(0); assignn(v82, 1); return; }
  return;
`;
const F1 = 0x3b00;
const F2 = 0x3c00;

// Gadget centres from the engine's layout: the gadget line is text row 12
// (y 96..103); Restart spans x 88..143 and Cancel x 176..223; Quit spans
// x 48..79 and Continue x 200..263.
const RESTART = { x: 115, y: 99 };
const CANCEL = { x: 199, y: 99 };
const QUIT = { x: 63, y: 99 };
const CONTINUE = { x: 231, y: 99 };
/** On the gadget line, between the two gadgets of either window. */
const BETWEEN = { x: 160, y: 99 };

function confirmSession(profile: ProfileId) {
  const container = gameContainer([CONFIRM_LOGIC]);
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
  send({ type: "boot", profile, files: Object.fromEntries(container.files), words: [] });
  ctx.fns.stopTimers();
  const tick = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      now += 1000 / 60;
      ctx.fns.hostTick();
    }
  };
  const engine = () => ctx.run.engine!;
  /** Type a command, then open the confirmation and park on its wait. */
  const open = (action: 1 | 2, typed = "look"): void => {
    tick(1);
    send({ type: "edit", text: typed });
    send({ type: "key", code: action === 1 ? F1 : F2 });
    tick(1);
    assert.equal(engine().modalKind, "print", `${profile} confirmation window is open`);
    assert.equal(engine().awaitingKey, true, `${profile} confirmation waits for its answer`);
    assert.equal(engine().inputEdit, typed, `${profile} typed line before the confirmation`);
  };
  const causes = () => ctx.history.open.events.map((e) => e.cause);
  /** The recorded causes once a quit closed the segment. */
  const recordedCauses = () =>
    collectSegments(control).flatMap((s) => s.events.map((e) => e.cause));
  const quitPosted = () => presentation.some((m) => m.type === "quit");
  return { ctx, control, send, tick, engine, open, causes, recordedCauses, quitPosted };
}

for (const profile of AMIGA) {
  test(`${profile}: clicking Quit quits, Continue resumes with the typed line kept`, () => {
    const quit = confirmSession(profile);
    quit.open(2);
    quit.send({ type: "click", ...QUIT });
    assert.equal(quit.engine().readState().terminated, true, "Quit ends the game");
    assert.equal(quit.quitPosted(), true, "the player is sent Home");
    // The quit closes the history after the click that chose it.
    assert.deepEqual(quit.recordedCauses().slice(-2), [
      { kind: "click", ...QUIT },
      { kind: "end", reason: "quit" },
    ]);

    const go = confirmSession(profile);
    go.open(2);
    go.send({ type: "click", ...CONTINUE });
    assert.equal(go.engine().modalKind, null, "Continue closes the window");
    assert.equal(go.engine().awaitingKey, false);
    assert.equal(go.engine().vars[82], 1, "Continue resumes after quit(0)");
    assert.equal(go.engine().readState().terminated, false);
    assert.equal(go.quitPosted(), false);
    assert.equal(go.engine().inputEdit, "look", "the typed line survives");
    assert.deepEqual(go.causes().at(-1), { kind: "click", ...CONTINUE });
  });

  test(`${profile}: clicking Restart restarts, Cancel resumes with the typed line kept`, () => {
    const restart = confirmSession(profile);
    restart.open(1);
    restart.send({ type: "click", ...RESTART });
    assert.equal(restart.engine().modalKind, null, "Restart closes the window");
    assert.equal(restart.engine().vars[90], 1, "logic 0 ran its restart pass (f6)");
    assert.equal(restart.engine().vars[81], 0, "the old pass never resumed");
    assert.equal(restart.engine().inputEdit, "", "an accepted restart clears the line");

    const cancel = confirmSession(profile);
    cancel.open(1);
    cancel.send({ type: "click", ...CANCEL });
    assert.equal(cancel.engine().modalKind, null, "Cancel closes the window");
    assert.equal(cancel.engine().vars[90], 0, "no restart pass ran");
    assert.equal(cancel.engine().vars[81], 1, "Cancel resumes after restart.game");
    assert.equal(cancel.engine().inputEdit, "look", "the typed line survives");
  });

  test(`${profile}: a tap on a gadget performs its choice; a tap elsewhere still cancels`, () => {
    const quit = confirmSession(profile);
    quit.open(2);
    quit.send({ type: "dismissPrint", ...QUIT });
    assert.equal(quit.engine().readState().terminated, true, "tapping Quit ends the game");
    assert.deepEqual(
      quit.recordedCauses().at(-2),
      { kind: "click", ...QUIT },
      "recorded as the click",
    );

    const restart = confirmSession(profile);
    restart.open(1);
    restart.send({ type: "dismissPrint", ...RESTART });
    assert.equal(restart.engine().vars[90], 1, "tapping Restart restarts");

    const go = confirmSession(profile);
    go.open(2);
    go.send({ type: "dismissPrint", ...CONTINUE });
    assert.equal(go.engine().vars[82], 1, "tapping Continue resumes");
    assert.equal(go.engine().inputEdit, "look");

    const cancel = confirmSession(profile);
    cancel.open(1);
    cancel.send({ type: "dismissPrint", ...CANCEL });
    assert.equal(cancel.engine().vars[81], 1, "tapping Cancel resumes");
    assert.equal(cancel.engine().inputEdit, "look");

    // A touch player has no keyboard: a tap beside the gadgets keeps the
    // safe answer, cancelling the restart, and records as a dismissal.
    const beside = confirmSession(profile);
    beside.open(1);
    beside.send({ type: "dismissPrint", ...BETWEEN });
    assert.equal(beside.engine().modalKind, null, "the window closed");
    beside.tick(1);
    assert.equal(beside.engine().vars[81], 1, "the restart was cancelled");
    assert.equal(beside.engine().inputEdit, "look");
    assert.deepEqual(beside.causes().at(-1), { kind: "dismiss" });
  });

  test(`${profile}: a click beside the gadgets is dropped and the keys keep their meaning`, () => {
    const s = confirmSession(profile);
    s.open(2);
    const before = s.causes().length;
    s.send({ type: "click", ...BETWEEN });
    assert.equal(s.engine().awaitingKey, true, "the confirmation still waits");
    assert.equal(s.engine().modalKind, "print");
    assert.equal(s.causes().length, before, "nothing recorded");
    s.send({ type: "key", code: 27 });
    assert.equal(s.engine().vars[82], 1, "Escape continues");
    assert.equal(s.engine().inputEdit, "look");

    const enter = confirmSession(profile);
    enter.open(2);
    enter.send({ type: "key", code: 13 });
    assert.equal(enter.engine().readState().terminated, true, "Enter quits");
  });
}

test("amiga-2.316: a gadget click replays through the history drive", () => {
  const s = confirmSession("amiga-2.316");
  s.open(1);
  s.send({ type: "click", ...CANCEL });
  assert.equal(s.engine().vars[81], 1);
  s.tick(2);
  s.send({ type: "pause", paused: true });
  const [segment] = collectSegments(s.control);
  assert.ok(segment);
  const outcome = replayHistorySegment(segment);
  assert.equal(outcome.error, null);
  assert.equal(outcome.diverged, null, "every sync mark held");
  assert.equal(outcome.ctx.run.engine!.vars[81], 1, "the replayed click cancelled the restart");
  assert.equal(outcome.ctx.run.engine!.modalKind, null);
});

test("2.936: the PC prompt has no gadgets; clicks are dropped, a tap cancels, keys answer", () => {
  const click = confirmSession("2.936");
  click.open(2);
  click.send({ type: "click", ...QUIT });
  assert.equal(click.engine().awaitingKey, true, "the click changed nothing");
  assert.equal(
    click.causes().some((c) => c.kind === "click"),
    false,
  );
  click.send({ type: "key", code: 13 });
  assert.equal(click.engine().readState().terminated, true, "Enter quits");

  const tap = confirmSession("2.936");
  tap.open(2);
  tap.send({ type: "dismissPrint", ...QUIT });
  tap.tick(1);
  assert.equal(tap.engine().vars[82], 1, "a tap cancels the quit as before");
  assert.equal(tap.engine().readState().terminated, false);
  assert.deepEqual(tap.causes().at(-1), { kind: "dismiss" });

  const esc = confirmSession("2.936");
  esc.open(1);
  esc.send({ type: "key", code: 27 });
  assert.equal(esc.engine().vars[81], 1, "Escape cancels the restart");
  assert.equal(esc.engine().inputEdit, "look");
});

// Player rule: a restart prompt reached while a timed message is pending (v21)
// accepts when its time runs out, with no key (docs/fidelity.md "Persistence
// verdicts", F-persistence-prompt-modes); a History replay reaches the same
// restart from the recorded clock.
test("2.936: a timed restart prompt accepts when its time runs out, live and in a History replay", () => {
  const container = gameContainer([
    `if (isset(f6)) { assignn(v90, 1); return; }
     if (!isset(f200)) { set(f200); set.key(0, 59, 1); }
     if (controller(c1)) { assignn(v21, 2); restart.game(); assignn(v81, 1); return; }
     return;`,
  ]);
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
  send({ type: "boot", profile: "2.936", files: Object.fromEntries(container.files), words: [] });
  ctx.fns.stopTimers();
  const tick = (n: number): void => {
    for (let i = 0; i < n; i++) {
      now += 1000 / 60;
      ctx.fns.hostTick();
    }
  };
  const engine = () => ctx.run.engine!;
  tick(1);
  send({ type: "key", code: F1 });
  tick(1);
  assert.equal(engine().modalKind, "print", "the prompt shows");
  assert.equal(ctx.run.input.keyWaiting, true, "the page shows the key wait");
  tick(30);
  assert.equal(engine().vars[90], 0, "half the time: still waiting");
  tick(40);
  assert.equal(engine().vars[90], 1, "the timeout restarted the game");
  assert.equal(engine().vars[81], 0, "the old pass never resumed");
  assert.equal(engine().modalKind, null);
  assert.equal(ctx.run.input.keyWaiting, false, "the page no longer waits for a key");
  tick(2);
  send({ type: "pause", paused: true });
  const [segment] = collectSegments(control);
  assert.ok(segment);
  const outcome = replayHistorySegment(segment);
  assert.equal(outcome.error, null);
  assert.equal(outcome.diverged, null, "every sync mark held");
  assert.equal(outcome.ctx.run.engine!.vars[90], 1, "the replay restarted on the same clock");
  ctx.fns.stopTimers();
});
