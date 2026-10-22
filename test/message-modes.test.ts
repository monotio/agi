import { test } from "node:test";
import assert from "node:assert/strict";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { Engine } from "../src/runtime/engine.ts";
import { PROFILES, type ProfileId } from "../src/runtime/profile.ts";

function game(source: string, profile: ProfileId = "2.936") {
  const container = createContainer();
  container.putResource("picture", 0, Uint8Array.of(255));
  container.putResource(
    "logic",
    0,
    assembleLogic(source, { profile: PROFILES[profile], dictionary: new Map() }).payload,
  );
  return new Engine(
    container,
    {
      print() {},
      displayAt() {},
      statusLine() {},
      takeKeys: () => [],
      takeInputLine: () => null,
    },
    undefined,
    { profile },
  );
}

test("timed print closes after half-second units and resumes the same invocation", () => {
  const e = game('increment(v200);assignn(v21,2);print("A moment.");increment(v201);return;');
  e.tick();
  e.advanceClock(999);
  e.tick();
  assert.equal(e.modalKind, "print");
  assert.equal(e.vars[201], 0);
  e.advanceClock(1);
  assert.equal(e.modalKind, null);
  e.tick();
  assert.deepEqual(Array.from(e.vars.slice(200, 202)), [1, 1]);
  assert.equal(e.vars[11], 1, "timer services continue while the script waits");
  assert.ok(
    !Array.from({ length: 25 }, (_, row) => e.textRow(row))
      .join(" ")
      .includes("A moment."),
  );
});

test("timed windows also accept early acknowledgement; an untimed window never expires", () => {
  const e = game(
    'assignn(v21,20);print("First.");assignn(v21,0);print("Second.");increment(v200);return;',
  );
  e.tick();
  e.advanceClock(100);
  e.modalKey(13);
  e.tick();
  e.advanceClock(60000);
  assert.equal(e.modalKind, "print");
  assert.equal(e.vars[200], 0);
  e.ackPrint();
  e.tick();
  assert.equal(e.vars[200], 1);
});

test("persistent print continues logic and clocks until close.window restores its rectangle", () => {
  const e = game(
    'if(!isset(f200)){set(f200);set(f15);assignn(v21,1);print("Still here.");}increment(v200);if(equaln(v200,3)){close.window();}return;',
  );
  const before = e.textCells.slice();
  e.tick();
  assert.equal(e.modalKind, null);
  assert.equal(e.vars[200], 1);
  assert.ok(
    Array.from({ length: 25 }, (_, row) => e.textRow(row))
      .join(" ")
      .includes("Still here."),
  );
  e.advanceClock(1000);
  e.tick();
  assert.equal(e.vars[11], 1);
  assert.notDeepEqual(e.textCells, before);
  e.tick();
  assert.equal(e.vars[200], 3);
  assert.deepEqual(e.textCells, before);
});

test("replacing a persistent window restores the original cells when the modal closes", () => {
  const e = game(
    'set(f15);print("Persistent.");reset(f15);print.at("Modal.",2,3,20);increment(v200);return;',
  );
  const before = e.textCells.slice();
  e.tick();
  // print.at's row is relative to the display base (picTop = 1 added on the
  // override path too), so row 2's window text starts at text row 3.
  assert.ok(e.textRow(3).includes("Modal."));
  assert.ok(
    !Array.from({ length: 25 }, (_, row) => e.textRow(row))
      .join(" ")
      .includes("Persistent."),
  );
  e.ackPrint();
  e.tick();
  assert.deepEqual(e.textCells, before);
  assert.equal(e.vars[200], 1);
});

for (const profile of ["2.936", "3.002.149"] as const) {
  test(`${profile}: a non-blocking print consumes f15, so the next print blocks again`, () => {
    // The verified 2.411-3.002.149 print handlers reset f15 as they open the
    // non-blocking window; without the reset every later print would stay
    // non-blocking (the KQ4 intro re-sets f15 for each window it wants kept).
    const e = game('set(f15);print("First.");print("Second.");increment(v200);return;', profile);
    e.tick();
    assert.equal(e.modalKind, "print", "the second print blocks once f15 was consumed");
    assert.ok(
      Array.from({ length: 25 }, (_, row) => e.textRow(row))
        .join(" ")
        .includes("Second."),
      "the blocking window shows the second message",
    );
    e.ackPrint();
    e.tick();
    assert.equal(e.vars[200], 1);
  });
}

for (const profile of ["2.936", "3.002.149"] as const) {
  test(`${profile}: a timed print clears v21 when its window closes`, () => {
    const e = game('assignn(v21,2);print("A moment.");increment(v200);return;', profile);
    e.tick();
    assert.equal(e.modalKind, "print");
    e.advanceClock(1000);
    assert.equal(e.modalKind, null);
    assert.equal(e.vars[21], 0, "the timeout was consumed");
    e.tick();
    assert.equal(e.vars[200], 1);
  });

  test(`${profile}: an early-acknowledged timed print clears v21 too`, () => {
    const e = game('assignn(v21,20);print("Brief.");increment(v200);return;', profile);
    e.tick();
    assert.equal(e.modalKind, "print");
    e.modalKey(13);
    assert.equal(e.vars[21], 0);
    e.tick();
    assert.equal(e.vars[200], 1);
  });
}

for (const profile of ["2.001", "2.089"] as const) {
  test(`${profile}: prints retain f15 and timed windows retain v21`, () => {
    // PC 2.001 and 2.089 preserve both f15 and v21 across print and window closure.
    const e = game('set(f15);print("First.");print("Second.");increment(v200);return;', profile);
    e.tick();
    assert.equal(e.modalKind, null, "both prints stay non-blocking while f15 is kept");
    assert.equal(e.flags[15], 1);
    assert.equal(e.vars[200], 1, "logic ran straight through both prints");
    assert.ok(
      Array.from({ length: 25 }, (_, row) => e.textRow(row))
        .join(" ")
        .includes("Second."),
    );

    const timed = game('assignn(v21,2);print("A moment.");increment(v200);return;', profile);
    timed.tick();
    assert.equal(timed.modalKind, "print");
    timed.advanceClock(1000);
    assert.equal(timed.modalKind, null, "the timed window still closes on its own");
    assert.equal(timed.vars[21], 2, "v21 is kept in 2.001 and 2.089");
    timed.tick();
    assert.equal(timed.vars[200], 1);
  });
}

test("amiga-2.082: prints retain f15 while timed windows clear v21", () => {
  // Amiga 2.082 WindowNoWait (0x0026EA) tests IsSet(0x0F) without Reset(0x0F),
  // but clears var[0x15] = 0 after WaitAcAb before CloseWndw.
  const e = game(
    'set(f15);print("First.");print("Second.");increment(v200);return;',
    "amiga-2.082",
  );
  e.tick();
  assert.equal(e.modalKind, null);
  assert.equal(e.flags[15], 1, "amiga-2.082 retains f15");

  const timed = game('assignn(v21,2);print("A moment.");increment(v200);return;', "amiga-2.082");
  timed.tick();
  timed.advanceClock(1000);
  assert.equal(timed.modalKind, null);
  assert.equal(timed.vars[21], 0, "amiga-2.082 clears v21 after WaitAcAb");
});

for (const profile of ["2.001", "2.089", "amiga-2.082", "2.936", "3.002.149"] as const) {
  test(`${profile}: show.pic closes persistent windows only in profiles where ShowPic calls Reset(15)`, () => {
    const e = game(
      'set(f15);print("Window.");assignn(v60,0);load.pic(v60);overlay.pic(v60);show.pic();increment(v200);return;',
      profile,
    );
    e.tick();
    assert.equal(e.vars[200], 1);
    const retainsWindow = profile === "2.001" || profile === "2.089" || profile === "amiga-2.082";
    assert.equal(e.flags[15], retainsWindow ? 1 : 0);
    assert.equal(
      Array.from({ length: 25 }, (_, row) => e.textRow(row))
        .join(" ")
        .includes("Window."),
      retainsWindow,
    );
  });
}

test("pause remains blocking even when a game leaves output mode or a timeout enabled", () => {
  const e = game("set(f15);assignn(v21,1);pause();increment(v200);return;");
  e.tick();
  e.advanceClock(2000);
  assert.equal(e.modalKind, "print");
  assert.equal(e.vars[200], 0);
  e.ackPrint();
  e.tick();
  assert.equal(e.vars[200], 1);
});

test("version honours the v21 timeout like any WindowPrint window", () => {
  // Player-visible rule: v21=1 closes the version window after a half second.
  // The 0x8d handler's WindowPrint call is the same routine print uses, with
  // the same winTime path (kq3 2.936 0x733C; v21 clear at 0x1d80).
  const e = game("assignn(v21,1);version();increment(v200);return;");
  e.tick();
  assert.equal(e.modalKind, "print");
  assert.equal(e.vars[200], 0, "the pass is parked");
  e.advanceClock(499);
  e.tick();
  assert.equal(e.modalKind, "print", "still open before the half second");
  e.advanceClock(1);
  assert.equal(e.modalKind, null, "the timeout closed the window");
  assert.equal(e.vars[21], 0, "the timeout was consumed");
  e.tick();
  assert.equal(e.vars[200], 1, "the parked pass resumed");
});
