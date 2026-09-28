/**
 * The "Started over." note lasts until the player has actually started the
 * new run: it waits out the title and intro screens for the first input,
 * then counts ten seconds of running game time — interpreter cycles at the
 * game's own cycle delay, so a pause (no cycles) freezes it — and closes
 * sooner when the player enters another room.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { START_OVER_NOTE_MS, useStartOverNote } from "../src/history/useStartOverNote.ts";

/** Heartbeats every 250 ms; the tutorial's delay of one runs 20 cycles a second. */
function harness(delay = 1) {
  const state = { startOverNote: false };
  const note = useStartOverNote(state);
  let cycle = 0;
  /** Heartbeats covering `seconds` of running game time. */
  const run = (seconds: number): void => {
    const perBeat = 250 / (delay * 50);
    for (let beat = 0; beat < seconds * 4; beat++) {
      cycle += perBeat;
      note.observeCycle({ cycle, delay });
    }
  };
  /** Heartbeats while the game is paused: time passes, no cycle completes. */
  const paused = (seconds: number): void => {
    for (let beat = 0; beat < seconds * 4; beat++) note.observeCycle({ cycle, delay });
  };
  return { state, note, run, paused };
}

test("the note waits through the title with no input, then closes ten game seconds after it", () => {
  const { state, note, run } = harness();
  note.show();
  run(120);
  assert.equal(state.startOverNote, true, "two minutes at the title close nothing");
  note.noteInput();
  run(START_OVER_NOTE_MS / 1000 - 0.25);
  assert.equal(state.startOverNote, true);
  run(0.25);
  assert.equal(state.startOverNote, false);
});

test("a pause of any length freezes the countdown, which resumes after it", () => {
  const { state, note, run, paused } = harness();
  note.show();
  run(1);
  note.noteInput();
  run(6);
  paused(600);
  assert.equal(state.startOverNote, true, "ten minutes paused are no game time");
  run(3.75);
  assert.equal(state.startOverNote, true);
  run(0.25);
  assert.equal(state.startOverNote, false);
});

test("game time follows the game's cycle delay", () => {
  // At a delay of four a cycle is a fifth of a second: 50 cycles are 10 s.
  const { state, note, run } = harness(4);
  note.show();
  run(1);
  note.noteInput();
  run(9.75);
  assert.equal(state.startOverNote, true);
  run(0.25);
  assert.equal(state.startOverNote, false);
});

test("entering another room after the first input closes the note", () => {
  const { state, note, run } = harness();
  note.show();
  // Rooms the title and intro pass through before any input keep it.
  note.observeRoom({ from: null, to: 1, cause: "boot" });
  note.observeRoom({ from: 1, to: 2, cause: "logic" });
  run(1);
  assert.equal(state.startOverNote, true);
  note.noteInput();
  // A remix re-entering the room is no room change.
  note.observeRoom({ from: 2, to: 2, cause: "reenter" });
  run(1);
  assert.equal(state.startOverNote, true);
  // EAST at once, before any heartbeat reports the new room.
  note.observeRoom({ from: 2, to: 3, cause: "logic" });
  assert.equal(state.startOverNote, false);
});

test("a replaced worker's last heartbeat is no baseline for the next game", () => {
  const { state, note, run } = harness();
  run(0.25); // the old game's heartbeat: cycle 5
  note.hide(); // the worker is replaced
  note.show();
  note.noteInput();
  // The new game's first heartbeat, a while into its boot.
  note.observeCycle({ cycle: 100, delay: 1 });
  note.observeCycle({ cycle: 295, delay: 1 });
  assert.equal(state.startOverNote, true, "195 cycles are 9.75 s");
  note.observeCycle({ cycle: 300, delay: 1 });
  assert.equal(state.startOverNote, false);
});
