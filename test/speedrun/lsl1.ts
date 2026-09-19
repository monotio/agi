import assert from "node:assert/strict";
import { KNOWN_GAME_HASH } from "../../src/games/knownGames.ts";
import { AGI_KEY } from "../../src/runtime/keys.ts";
import type { Speedrun } from "./runner.ts";
import type { Walkthrough } from "./route.ts";

/** Inventory numbers from the OBJECT file. */
const ITEM = {
  wallet: 1,
  spray: 2,
  lint: 3,
  watch: 4,
  apple: 5,
  ring: 6,
  whiskey: 7,
  remote: 8,
  rose: 9,
  condom: 10,
  usedCondom: 11,
  candy: 12,
  doll: 13,
  pass: 14,
  knife: 15,
  wine: 16,
  magazine: 17,
  hammer: 18,
  pills: 19,
  rope: 20,
} as const;

const flag = (run: Speedrun, index: number): boolean => run.engine.flags[index] !== 0;

/** v90 is Larry's cash; logic 58 caps slot winnings at $250. */
const money = (run: Speedrun): number => run.engine.vars[90]!;

/**
 * Logic 0 parks every death in v30 == 1 (after f50); rooms 8, 9 and 19 are the
 * body shop, the dark alley mugging and the sunrise ending.
 */
function alive(run: Speedrun, label: string): void {
  const room = run.state().room;
  assert.ok(
    run.engine.vars[30] !== 1 && run.engine.flags[50] === 0 && ![8, 9, 19].includes(room),
    `Larry died: ${label} (room ${room})`,
  );
}

/**
 * A timed message window opening mid-word swallows a letter and leaves a
 * mangled line; like a player, erase it with Backspace and type it again.
 */
function say(run: Speedrun, text: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      run.command(text);
      break;
    } catch (error) {
      const mangled = error instanceof Error && error.message.includes("Input row diverged");
      if (!mangled || attempt >= 3) throw error;
      run.dismiss();
      for (let n = 0; run.engine.inputEdit !== "" && n < 80; n++) {
        run.key(AGI_KEY.BACKSPACE);
        run.advance(6);
        run.dismiss();
      }
      assert.equal(run.engine.inputEdit, "", "input line erased");
    }
  }
  alive(run, text);
}

/**
 * The apple seller outside the casino shows up on a one-in-three roll per
 * visit, so his 3 points arrive at a different moment on hosts whose RNG
 * position differs; every other milestone is fixed.
 */
function score(run: Speedrun, expected: number, label: string): void {
  const apple = run.engine.itemLocation(ITEM.apple) === 32 ? 0 : 3;
  assert.equal(run.state().score, expected + apple, label);
}

/**
 * The age quiz draws five of 53 questions from one of three random logics.
 * Only the questions this seed asks are listed; an unknown question fails the
 * route with the screen text so the table can be extended.
 */
const QUIZ: Record<string, string> = {
  "Where's the": "c",
  "Kennedy drove": "a",
  "Mohammed Ali": "c",
  "not a mass murderer": "d",
  "not an astronaut": "a",
};

function ageQuiz(run: Speedrun): void {
  run.advance(60);
  run.checkpoint("Title screen", { room: 1, score: 0 });
  run.answerNumber(30);
  run.key(AGI_KEY.ENTER);
  run.until(() => run.state().room === 6, 600, "age check begins");
  for (let asked = 0; run.state().room === 6;) {
    run.until(
      () =>
        run.state().room !== 6 ||
        run.engine.modalKind !== null ||
        run.engine.textRow(23).includes("Please answer"),
      1200,
      "next quiz prompt",
    );
    if (run.state().room !== 6) break;
    if (run.engine.modalKind !== null) {
      run.dismiss();
      continue;
    }
    const text = run.state().text;
    const entry = Object.entries(QUIZ).find(([fragment]) => text.includes(fragment));
    assert.ok(entry, `Unknown quiz question:\n${text}`);
    assert.ok(++asked <= 6, "quiz asks at most five questions plus one retry");
    run.key(entry[1].charCodeAt(0));
    run.until(
      () => !run.engine.textRow(23).includes("Please answer") || run.engine.modalKind !== null,
      600,
      "answer accepted",
    );
  }
  run.wait(() => run.state().room === 11 && run.engine.inputEnabled, "outside Lefty's");
  run.checkpoint("Proved his age", { room: 11, score: 0 });
}

/**
 * Walk into a rectangle of ego anchor positions, routing around furniture.
 * Passers-by talk in modal windows; a player reads them and keeps walking.
 */
function goTo(run: Speedrun, x0: number, y0: number, x1 = x0, y1 = y0): void {
  for (let attempt = 0; attempt < 8; attempt++) {
    const { outcome } = run.navigate({
      kind: "position",
      target: { x0, y0, x1, y1 },
      planned: true,
    });
    if (outcome.status === "needs_input") {
      run.dismiss();
      continue;
    }
    assert.equal(outcome.status, "reached", JSON.stringify(outcome));
    run.direction(0);
    alive(run, `walk to ${x0},${y0}`);
    return;
  }
  assert.fail(`too many interruptions walking to ${x0},${y0}`);
}

/** Leave across a screen edge and wait until the next room has been drawn. */
function leave(run: Speedrun, direction: "N" | "E" | "S" | "W", room: number): void {
  for (let attempt = 0; attempt < 8; attempt++) {
    const outcome = run.traverse(
      {
        passage: {
          kind: "exit",
          direction: { N: 1, E: 3, S: 5, W: 7 }[direction],
          room,
          planned: true,
        },
        passageOptions: { avoidTriggers: false, geometry: "current" },
        landing: { label: `room ${room}`, test: (e) => e.vars[0] === room },
      },
      { budgets: { hostPolls: 10000, movementUpdates: 1000 } },
    );
    if (outcome.status === "needs_input") {
      run.dismiss();
      if (run.state().room === room) break;
      continue;
    }
    assert.equal(outcome.status, "reached", JSON.stringify(outcome));
    break;
  }
  assert.equal(run.state().room, room, `left ${direction} into room ${room}`);
  alive(run, `enter room ${room}`);
}

/** Walk onto a doorway rectangle whose logic switches rooms on arrival. */
function enter(
  run: Speedrun,
  target: { x0: number; y0: number; x1: number; y1: number },
  room: number,
): void {
  for (let attempt = 0; attempt < 8; attempt++) {
    const outcome = run.traverse({
      passage: { kind: "position", planned: true, target },
      expectedRoom: room,
      passageOptions: { avoidTriggers: false, geometry: "current" },
      landing: { label: `room ${room}`, test: (e) => e.vars[0] === room },
    });
    if (outcome.status === "needs_input") {
      run.dismiss();
      if (run.state().room === room) break;
      continue;
    }
    assert.equal(outcome.status, "reached", JSON.stringify(outcome));
    break;
  }
  assert.equal(run.state().room, room, `walked into room ${room}`);
  alive(run, `enter room ${room}`);
}

function leftysBar(run: Speedrun): void {
  // Room 11: the door answers inside posn(50,131,75,136).
  goTo(run, 55, 132, 70, 135);
  say(run, "open door");
  run.waitForRoom(15, "inside Lefty's");
  // The middle stool is posn(85,0,99,136); sitting sets v30 = 7.
  goTo(run, 87, 129, 97, 135);
  say(run, "sit");
  assert.equal(run.engine.vars[30], 7, "seated at the bar");
  run.take("order whiskey", ITEM.whiskey, "Lefty pours the whiskey");
  score(run, 1, "first whiskey");
  say(run, "stand");
  assert.equal(run.engine.vars[30], 0, "off the stool");
  run.checkpoint("Bought a whiskey at Lefty's", { room: 15, score: 1 });
}

function backHallway(run: Speedrun): void {
  leave(run, "N", 14);
  // The rose lies on the table inside posn(40,114,58,134).
  goTo(run, 42, 116, 56, 132);
  run.take("take rose", ITEM.rose);
  score(run, 2, "rose");
  // The drunk trades within posn(90,125,150,150); the remote follows 5 s later.
  goTo(run, 106, 128, 125, 140);
  say(run, "give whiskey to man");
  run.waitForItem(ITEM.remote, "drunk hands over the remote control");
  score(run, 4, "remote control");
  run.checkpoint("Traded the whiskey for a remote control", { room: 14, score: 4 });

  // Bathroom door: posn(95,110,104,127).
  goTo(run, 96, 123, 103, 126);
  say(run, "open door");
  run.waitForRoom(13, "bathroom");
  run.wait(() => run.engine.movementControlEnabled, "bathroom door closes");
  // The fourth reading of the graffiti reveals the password (f57, 2 points).
  for (let n = 0; n < 4; n++) say(run, "read wall");
  assert.equal(run.engine.flags[57], 1, "password learned");
  score(run, 6, "graffiti");
  // Toilet: posn(65,125,84,131). Flushing floods the room, so Larry only sits.
  goTo(run, 67, 126, 82, 130);
  say(run, "sit");
  assert.equal(run.engine.vars[30], 9, "seated");
  score(run, 7, "toilet");
  say(run, "stand");
  assert.equal(run.engine.vars[30], 0, "standing again");
  // Sink: posn(89,129,110,160).
  goTo(run, 91, 131, 108, 150);
  run.take("take ring", ITEM.ring);
  score(run, 10, "diamond ring");
  run.checkpoint("Found a diamond ring in the sink", { room: 13, score: 10 });
  goTo(run, 52, 133, 58, 139);
  say(run, "open door");
  run.waitForRoom(14, "hallway again");
  run.wait(() => run.engine.movementControlEnabled, "back in the hallway");
  leave(run, "S", 15);
}

function pimpAndHooker(run: Speedrun): void {
  // Peephole door: posn(132,137,149,154); the doorman asks three seconds after the knock.
  goTo(run, 134, 139, 147, 152);
  say(run, "knock on door");
  run.wait(() => run.engine.vars[206] === 3, "doorman asks for the password", 2000);
  say(run, "ken sent me");
  run.waitForRoom(16, "back room");
  run.wait(() => run.engine.movementControlEnabled, "door closes behind Larry");
  // The remote works anywhere above y 145; the pimp leaves for channel 21.
  say(run, "use remote control");
  assert.equal(run.engine.flags[56], 1, "television on");
  score(run, 13, "television on");
  for (let n = 0; n < 7; n++) {
    run.wait(() => run.engine.vars[200] === 0, "programme settles", 3000);
    say(run, "change channel");
  }
  assert.equal(run.engine.vars[82], 21, "the pimp's favourite channel");
  run.waitForFlag(90, "pimp glued to the television", 3000);
  score(run, 21, "pimp distracted");
  run.checkpoint("Distracted the pimp with television", { room: 16, score: 21 });
  leave(run, "N", 17);
  // Candy on the table: posn(124,138,139,155).
  goTo(run, 126, 140, 137, 153);
  run.take("take candy", ITEM.candy);
  score(run, 23, "box of candy");
  // Window: posn(116,118,137,139).
  goTo(run, 118, 120, 135, 137);
  say(run, "open window");
  run.waitForFlag(64, "window open", 1000);
  say(run, "climb out window");
  run.waitForRoom(12, "fire escape");
  run.checkpoint("Climbed out onto the fire escape", { room: 12, score: 23 });
}

function dumpster(run: Speedrun): void {
  // Walking off the west end of the landing, posn(53,60,54,64), drops Larry into the bin.
  run.walkToUntil(53, 64, () => run.engine.vars[30] !== 0, "step off the fire escape");
  run.wait(() => run.engine.vars[30] === 14 && run.engine.inputEnabled, "sitting in the garbage");
  run.take("take hammer", ITEM.hammer);
  score(run, 26, "hammer");
  say(run, "climb out");
  run.wait(
    () => run.engine.vars[30] === 0 && run.engine.movementControlEnabled,
    "out of the dumpster",
  );
  run.checkpoint("Dug a hammer out of the dumpster", { room: 12, score: 26 });
  leave(run, "W", 11);
}

/** Street rooms share logic 57: v64 is the cab's script step, v235 the kerb line. */
type Destination = "bar" | "casino" | "store" | "disco" | "chapel";
const DESTINATION_ROOM: Record<Destination, number> = {
  bar: 11,
  casino: 32,
  store: 22,
  disco: 23,
  chapel: 33,
};

function taxi(run: Speedrun, destination: Destination): void {
  assert.ok(!run.carried(ITEM.wine), "the cabbie drinks carried wine and crashes");
  const street = run.state().room;
  const kerb = run.engine.vars[235]!;
  // The cab stops with its door at posn(70,kerb-11..kerb); hailing needs y above the kerb line.
  goTo(run, 72, kerb - 9, 88, kerb - 2);
  say(run, "taxi");
  run.wait(() => run.engine.vars[64] === 4, "cab pulls up", 3000);
  say(run, "enter taxi");
  run.waitForRoom(10, "inside the cab");
  // v65 == 2: the flag is down and the cabbie waits for an address; naming it
  // earlier races the two-second boarding timer for the same script step.
  run.wait(() => run.engine.vars[65] === 2, "meter running", 1000);
  say(run, destination);
  // v65 == 5: parked at the destination with the meter total in v200.
  run.wait(() => run.engine.vars[65] === 5, `ride from ${street} to the ${destination}`, 3000);
  const fare = run.engine.vars[200]!;
  assert.ok(money(run) >= fare, `fare $${fare} exceeds $${money(run)}`);
  say(run, "pay driver");
  run.wait(() => run.engine.vars[65] === 6, "fare paid", 1000);
  say(run, "get out");
  run.waitForRoom(DESTINATION_ROOM[destination], `arrived at the ${destination}`);
  run.wait(() => run.engine.movementControlEnabled, "cab door closes");
  alive(run, `taxi to the ${destination}`);
}

function rideToCasino(run: Speedrun): void {
  taxi(run, "casino");
  // The first fare ever paid scores a point (f100).
  assert.equal(run.state().score, 27, "first cab ride");
  run.checkpoint("Took a cab to the casino", { room: 32, score: 27 });
  buyAppleIfOffered(run);
}

/**
 * One pull of the slot machine (logic 37): F8 starts the reels and f201 is
 * clear while they spin. Returns the payout multiplier from the cash change,
 * or null when logic 58's $250 house limit ended the session.
 */
function pull(run: Speedrun): number | null {
  const bet = run.engine.vars[200]!;
  const stake = money(run) - bet;
  run.key(AGI_KEY.F8);
  run.wait(() => run.engine.flags[201] === 0 || run.state().room !== 37, "reels spin", 300);
  run.wait(() => run.engine.flags[201] === 1 || run.state().room !== 37, "reels stop", 3000);
  return run.state().room === 37 ? (money(run) - stake) / bet : null;
}

/** F4 and F6 step the bet (v200) one dollar per interpreter cycle. */
function setBet(run: Speedrun, bet: number): void {
  for (let n = 0; run.engine.vars[200] !== bet; n++) {
    assert.ok(n < 40, `bet stuck at ${run.engine.vars[200]}`);
    const before = run.engine.vars[200]!;
    run.key(before < bet ? AGI_KEY.F6 : AGI_KEY.F4);
    run.wait(() => run.engine.vars[200] !== before, "bet changes", 120);
  }
}

/** Sit down at a free machine on the casino floor: posn(106,137,140,143). */
function sitAtSlots(run: Speedrun): void {
  assert.equal(run.state().room, 31, "casino floor");
  goTo(run, 108, 138, 138, 142);
  say(run, "play slots");
  run.waitForRoom(37, "at a slot machine");
  run.wait(() => run.engine.flags[201] === 1 && run.engine.modalKind === null, "machine ready");
}

/** Payouts of the coming pulls up to the next one that pays double or better, if Larry lasts. */
function scoutStreak(run: Speedrun): number[] {
  const scout = run.fork();
  setBet(scout, 1);
  const payouts: number[] = [];
  // Stop scouting with a dollar left: a streak that long is unaffordable anyway.
  while (payouts.length < 60 && money(scout) > 1) {
    const payout = pull(scout);
    assert.ok(payout !== null, "a one dollar bet never reaches the house limit");
    payouts.push(payout);
    if (payout >= 2) return payouts;
  }
  return payouts;
}

/**
 * The reels are driven only by the interpreter's RNG, whose position differs
 * between hosts that linger on message windows and hosts that do not, so no
 * fixed betting script survives both. The route scouts the coming pulls on an
 * in-memory fork and then plays them for real: a single dollar on every pull
 * that loses, the $20 table limit (or all Larry has) on the one that pays
 * double or better. Every recorded input is an ordinary F4/F6/F8 key press.
 * Going broke is fatal (logic 0), so a losing streak Larry cannot afford is
 * sat out: he leaves the machine until the floor's idle animations have
 * drawn from the RNG, which realigns the reels, and sits down again.
 */
function playSlots(run: Speedrun, target: number): void {
  sitAtSlots(run);
  for (let streaks = 0; money(run) < target && run.state().room === 37; streaks++) {
    assert.ok(streaks < 60, `slots never reached $${target}`);
    const payouts = scoutStreak(run);
    const losses = payouts.filter((payout) => payout === 0).length;
    const affordable = money(run) - losses >= Math.min(20, Math.ceil(money(run) / 2));
    if (payouts.at(-1)! < 2 || !affordable) {
      say(run, "leave");
      run.waitForRoom(31, "back on the casino floor");
      // Room 31's gamblers draw a random delay every few seconds of cycles.
      run.advance(240);
      sitAtSlots(run);
      continue;
    }
    for (const [index, payout] of payouts.entries()) {
      const last = index === payouts.length - 1;
      if (last) setBet(run, Math.min(20, money(run)));
      else if (payout === 0) setBet(run, 1);
      const paid = pull(run);
      if (paid === null) break;
      assert.equal(paid, payout, "the scouted pull repeats");
      assert.ok(money(run) > 0, "never broke");
    }
  }
  // Logic 58 stops paying at $250 and sends Larry away; otherwise he gets up himself.
  // (The machine's advertised "stop" shares a word group with logic 0's quit prompt.)
  if (run.state().room === 37) say(run, "leave");
  run.waitForRoom(31, "back on the casino floor");
  run.wait(() => run.engine.movementControlEnabled, "free to walk");
}

/** The glass doors part while Larry stands inside posn(63,100,86,113). */
function enterCasino(run: Speedrun): void {
  assert.equal(run.state().room, 32, "casino forecourt");
  goTo(run, 72, 112, 78, 116);
  run.walkDirection("N", () => run.state().room === 31, "through the casino doors");
  alive(run, "casino floor");
}

/**
 * Room 32 rolls random(1,3) on entry; on a 1 the barrel man arrives within
 * seven seconds (v201), follows Larry and makes his pitch (v200 == 3).
 */
function buyAppleIfOffered(run: Speedrun): void {
  assert.equal(run.state().room, 32, "casino forecourt");
  if (run.engine.itemLocation(ITEM.apple) !== 32) return;
  if (run.engine.vars[201] === 0 && run.engine.flags[205] === 0) return;
  const before = run.state().score;
  run.wait(() => run.engine.vars[200] === 3, "apple seller makes his pitch", 3000);
  run.take("buy apple", ITEM.apple);
  assert.equal(run.state().score, before + 3, "apple");
}

function firstFortune(run: Speedrun): void {
  enterCasino(run);
  playSlots(run, 250);
  assert.equal(money(run), 250, "wallet full");
  run.checkpoint("Won a fortune at the slot machines", { room: 31 });
}

function lobbyAndCabaret(run: Speedrun): void {
  leave(run, "N", 35);
  // The ashtray by the south wall holds a disco pass: posn(62,155,87,163).
  goTo(run, 64, 156, 85, 162);
  run.take("take pass", ITEM.pass);
  score(run, 28, "disco pass");
  // The cabaret entrance is the strip posn(131,101,132,106).
  enter(run, { x0: 131, y0: 101, x1: 132, y1: 106 }, 36);
  // Front table: posn(100,145,114,163); sitting through the fanfare scores once (f117).
  goTo(run, 102, 147, 112, 161);
  say(run, "sit");
  run.waitForFlag(117, "seated for the show", 1000);
  score(run, 29, "cabaret seat");
  run.checkpoint("Took a seat in the cabaret", { room: 36 });
  say(run, "stand");
  assert.equal(run.engine.vars[30], 0, "up from the table");
  leave(run, "S", 35);
  leave(run, "S", 31);
  leave(run, "S", 32);
  buyAppleIfOffered(run);
}

function flasher(run: Speedrun): void {
  leave(run, "E", 33);
  // The man in the raincoat opens up inside posn(120,129,142,144) (f203).
  goTo(run, 122, 131, 140, 143);
  run.waitForFlag(203, "flasher reveals himself", 1000);
  say(run, "talk to man");
  assert.equal(run.engine.flags[103], 1, "flasher's tip heard");
  score(run, 30, "flasher");
  run.checkpoint("Chatted with the chapel flasher", { room: 33 });
}

/** Pay phone on the pole outside the store: posn(52,126,69,150). */
function atPhone(run: Speedrun): void {
  goTo(run, 54, 128, 67, 148);
}

function storeAndPhone(run: Speedrun): void {
  taxi(run, "store");
  run.checkpoint("Rode to the convenience store", { room: 22 });
  atPhone(run);
  say(run, "look at phone");
  assert.equal(run.engine.flags[112], 1, "graffiti number read");
  score(run, 31, "number on the phone");
  // 555-6969 is the sex survey: five free-text answers, then f78 arms a call back.
  for (const reply of ["555-6969", "eve", "smile", "dance", "suit", "apple"]) run.answer(reply);
  say(run, "dial phone");
  run.waitForFlag(78, "survey finished", 6000);
  run.wait(() => run.engine.vars[65] === 0 && run.engine.movementControlEnabled, "hung up");
  score(run, 33, "survey");
  run.checkpoint("Answered a telephone survey", { room: 22 });

  // The door is the north edge right of x 30.
  leave(run, "N", 21);
  // Magazine rack: posn(55,150,85,157).
  goTo(run, 57, 151, 83, 156);
  run.take("take magazine", ITEM.magazine);
  say(run, "read magazine");
  assert.equal(run.engine.flags[120], 1, "magazine read");
  score(run, 35, "magazine");
  // Wine on the back shelf: posn(50,112,81,116).
  goTo(run, 60, 113, 79, 115);
  run.take("take wine", ITEM.wine);
  score(run, 36, "wine");
  // The counter is the water-priority floor in front of the clerk (f0).
  goTo(run, 40, 128, 46, 136);
  assert.equal(run.engine.flags[0], 1, "at the counter");
  say(run, "buy condom");
  // The clerk's five questions take any of his two offered words each.
  for (const choice of ["smooth", "colored", "lubricated", "striped", "spearmint"]) {
    run.wait(() => run.engine.inputEnabled && run.engine.modalKind === null, "clerk asks");
    say(run, choice);
  }
  run.waitForItem(ITEM.condom, "condom handed over", 6000);
  run.dismiss();
  // The same sale rings up the magazine and the wine; leaving unpaid (v200) is fatal.
  assert.equal(run.engine.vars[200], 0, "nothing left unpaid");
  score(run, 40, "condom");
  run.checkpoint("Bought wine, a magazine and protection", { room: 21 });
  leave(run, "S", 22);
}

function bumAndCalls(run: Speedrun): void {
  // Back outside the survey calls back (v65 210..215 while ringing).
  atPhone(run);
  run.wait(() => run.engine.vars[65]! >= 211, "telephone rings", 3000);
  say(run, "answer phone");
  run.waitForFlag(114, "prize call taken", 3000);
  run.wait(() => run.engine.inputEnabled && run.engine.modalKind === null, "hung up");
  score(run, 45, "call back");
  // The bum shuffles over within 15 seconds (v203 == 2 once he begs).
  // He begs twice, nine seconds apart (v203 2 then 3); typing starts after the second window.
  run.wait(() => run.engine.vars[203] === 3 && run.engine.flags[202] === 1, "bum begs", 6000);
  say(run, "give wine to man");
  run.waitForItem(ITEM.knife, "bum trades his pocket knife");
  assert.ok(!run.carried(ITEM.wine), "wine gone before the next cab ride");
  score(run, 50, "pocket knife");
  run.checkpoint("Traded the wine for a pocket knife", { room: 22 });
  // Sierra's own number from the wallet card is worth five points.
  atPhone(run);
  run.answer("209 683-6858");
  say(run, "dial phone");
  run.waitForFlag(121, "Sierra's answering machine", 6000);
  run.wait(() => run.engine.vars[65] === 0 && run.engine.movementControlEnabled, "hung up");
  score(run, 55, "Sierra call");
  run.checkpoint("Phoned Sierra On-Line", { room: 22 });
}

/**
 * Ten game minutes after the last spray Larry's breath turns (v72, f66) and
 * every close-up says so; a player freshens up before meeting someone.
 */
function freshenBreath(run: Speedrun): void {
  say(run, "use breath spray");
  assert.equal(run.engine.flags[66], 1, "fresh breath");
  run.wait(() => run.engine.inputEnabled && run.engine.movementControlEnabled, "spray put away");
}

/** Fawn's table in the disco: the free chair is posn(112,121,123,124). */
function sitWithFawn(run: Speedrun): void {
  goTo(run, 113, 121, 122, 124);
  say(run, "sit");
  assert.equal(run.engine.vars[30], 17, "seated beside Fawn");
  // Looking at her switches to the close-up, room 25, where she listens.
  say(run, "look at girl");
  run.waitForRoom(25, "face to face with Fawn");
}

function disco(run: Speedrun): void {
  leave(run, "E", 23);
  // The bouncer checks passes inside posn(65,120,91,127), then steps aside.
  goTo(run, 70, 122, 86, 126);
  say(run, "show pass to man");
  assert.equal(run.engine.flags[202], 1, "bouncer steps aside");
  score(run, 60, "membership shown");
  // He now stands at x 73..80 and the passage narrows twice: x 82 clears him,
  // x 81 clears the door frame above y 84.
  goTo(run, 82, 122, 82, 126);
  run.walkDirection("N", () => run.state().y <= 90, "past the bouncer");
  run.walkTo(81, run.state().y);
  run.walkDirection("N", () => run.state().room === 24, "into the disco");
  alive(run, "disco");
  freshenBreath(run);
  sitWithFawn(run);
  score(run, 61, "joined Fawn");
  // The close-up scores its own first look (f95).
  say(run, "look at girl");
  score(run, 62, "admired Fawn");
  say(run, "talk to girl");
  score(run, 63, "first line");
  run.checkpoint("Met Fawn at the disco", { room: 25 });
  // Asking for a dance returns to the floor view; she waits on the lit squares (f0 water).
  say(run, "dance with girl");
  run.waitForRoom(24, "back at the table");
  run.wait(() => run.engine.vars[65] === 6, "Fawn reaches the dance floor", 3000);
  say(run, "stand");
  // The first step onto the floor starts the routine (v65 7..21), which takes control.
  const { outcome } = run.navigate({
    kind: "position",
    target: { x0: 60, y0: 112, x1: 72, y1: 120 },
    planned: true,
  });
  assert.ok(
    outcome.status === "movement_control_unavailable" || outcome.status === "reached",
    JSON.stringify(outcome),
  );
  run.wait(() => run.engine.vars[65]! >= 7, "dancing", 600);
  run.waitForFlag(74, "the dance ends", 6000);
  run.wait(() => run.engine.movementControlEnabled && run.engine.inputEnabled, "music stops");
  score(run, 68, "dance");
  run.checkpoint("Danced with Fawn", { room: 24 });
  sitWithFawn(run);
  // Three presents plus the dance make her propose (f97); the loan must follow within 30 s.
  say(run, "give rose to girl");
  say(run, "give candy to girl");
  say(run, "give ring to girl");
  run.waitForFlag(97, "Fawn asks for a hundred dollars", 2000);
  score(run, 83, "presents");
  assert.ok(money(run) >= 100, "a hundred dollars to lend");
  say(run, "give money to girl");
  assert.equal(run.engine.flags[79], 1, "Fawn leaves for the chapel");
  score(run, 90, "loan");
  run.waitForRoom(24, "Fawn walks out");
  run.wait(() => run.engine.inputEnabled && run.engine.modalKind === null, "alone at the table");
  run.checkpoint("Lent Fawn a hundred dollars for the wedding", { room: 24 });
  say(run, "stand");
  leave(run, "S", 23);
  // Back out through the same narrow doorway, around the bouncer.
  run.walkTo(81, run.state().y);
  run.walkDirection("S", () => run.state().y >= 86, "down the doorway");
  run.walkTo(82, run.state().y);
  run.walkDirection("S", () => run.state().y >= 126, "past the bouncer");
}

/** Hotel lifts (rooms 35, 40, 42) take a floor word while Larry stands in the car doorway. */
function lift(run: Speedrun, floor: "one" | "four" | "eight", room: number): void {
  const here = run.state().room;
  const doorway: Record<number, [number, number, number, number]> = {
    35: [71, 111, 82, 119],
    40: [74, 120, 82, 126],
    42: [74, 122, 82, 126],
  };
  const [x0, y0, x1, y1] = doorway[here]!;
  goTo(run, x0, y0, x1, y1);
  say(run, floor);
  run.waitForRoom(room, `lift to floor ${floor}`, 6000);
  // v30 == 18 while riding; the arrival script hands control back at the landing.
  run.wait(() => run.engine.vars[30] === 0 && run.engine.movementControlEnabled, "lift arrives");
  alive(run, `floor ${floor}`);
}

/** Floor four: the heart door, posn(6,126,15,135), opens to a knock once Larry is married. */
function enterSuite(run: Speedrun): void {
  goTo(run, 7, 127, 14, 134);
  say(run, "knock on door");
  run.waitForRoom(41, "honeymoon suite");
  run.wait(() => run.engine.movementControlEnabled && run.engine.modalKind === null, "inside");
}

function leaveSuite(run: Speedrun): void {
  // Door handle: posn(116,129,125,136).
  goTo(run, 117, 130, 124, 135);
  say(run, "open door");
  run.waitForRoom(40, "fourth floor hallway");
  run.wait(() => run.engine.movementControlEnabled && run.engine.modalKind === null, "hallway");
}

function wedding(run: Speedrun): void {
  taxi(run, "chapel");
  // Chapel door: posn(80,115,105,120).
  goTo(run, 82, 116, 103, 119);
  say(run, "open door");
  run.waitForRoom(34, "inside the chapel");
  // Beside the bride: posn(61,114,94,130). The minister wants $100 (f110) and the vows set f82.
  assert.ok(money(run) >= 100, "the minister's fee");
  goTo(run, 80, 121, 92, 128);
  say(run, "marry fawn");
  run.waitForFlag(82, "pronounced man and wife", 12000);
  run.wait(() => run.engine.inputEnabled && run.engine.movementControlEnabled, "ceremony over");
  score(run, 102, "married");
  run.checkpoint("Married Fawn at the quickie chapel", { room: 34 });
  leave(run, "S", 33);
  leave(run, "W", 32);
  buyAppleIfOffered(run);
}

function suiteRadio(run: Speedrun): void {
  enterCasino(run);
  // Two more cab rides precede Fawn's robbery; their meters cannot exceed $19 each.
  if (money(run) < 45) playSlots(run, 45);
  leave(run, "N", 35);
  lift(run, "four", 40);
  enterSuite(run);
  // Radio on the shelf: posn(50,117,60,125). The liquor jingle plays 5..15 s later (f104).
  goTo(run, 51, 118, 59, 124);
  say(run, "turn on radio");
  run.waitForFlag(104, "Ajax Liquor jingle", 3000);
  run.dismiss();
  score(run, 103, "liquor store number");
  run.checkpoint("Heard the liquor store jingle in the honeymoon suite", { room: 41 });
  leaveSuite(run);
  lift(run, "one", 35);
  leave(run, "S", 31);
  leave(run, "S", 32);
  buyAppleIfOffered(run);
}

function wineDelivery(run: Speedrun): void {
  taxi(run, "store");
  atPhone(run);
  // Ajax delivers only wine; the order and the address are parsed like commands.
  for (const reply of ["555-8039", "wine", "honeymoon suite"]) run.answer(reply);
  say(run, "dial phone");
  run.waitForFlag(80, "wine on its way", 6000);
  run.wait(() => run.engine.vars[65] === 0 && run.engine.movementControlEnabled, "hung up");
  score(run, 108, "wine ordered");
  run.checkpoint("Ordered wine for the honeymoon suite", { room: 22 });
  taxi(run, "casino");
  buyAppleIfOffered(run);
}

function honeymoon(run: Speedrun): void {
  enterCasino(run);
  leave(run, "N", 35);
  lift(run, "four", 40);
  enterSuite(run);
  // The bucket stands inside posn(92,117,103,126); Fawn warms up after two glasses (f201).
  goTo(run, 93, 118, 102, 125);
  say(run, "pour wine");
  assert.equal(run.engine.flags[201], 1, "Fawn is ready");
  // Beside the bed, posn(54,117,98,140), her rope trick starts; she leaves Larry $10.
  goTo(run, 60, 128, 90, 138);
  say(run, "lie on bed");
  run.wait(() => run.engine.vars[30] === 19 && run.engine.inputEnabled, "tied to the bed", 12000);
  assert.equal(money(run), 10, "Fawn leaves ten dollars");
  say(run, "cut rope with knife");
  assert.equal(run.engine.flags[81], 1, "ropes cut");
  score(run, 118, "cut free");
  run.take("take rope", ITEM.rope);
  score(run, 121, "rope");
  run.checkpoint("Cut himself free and kept the rope", { room: 41 });
  leaveSuite(run);
  lift(run, "one", 35);
  leave(run, "S", 31);
}

function backToLeftys(run: Speedrun): void {
  // Cab fares top out at $20 and $21 for the sixth and seventh rides; a zero balance is fatal.
  playSlots(run, 45);
  run.checkpoint("Won cab fare back at the slots", { room: 31 });
  leave(run, "S", 32);
  buyAppleIfOffered(run);
  taxi(run, "bar");
  goTo(run, 55, 132, 70, 135);
  say(run, "open door");
  run.waitForRoom(15, "inside Lefty's");
  goTo(run, 134, 139, 147, 152);
  say(run, "knock on door");
  run.wait(() => run.engine.vars[206] === 3, "doorman asks for the password", 2000);
  say(run, "ken sent me");
  run.waitForRoom(16, "back room");
  run.wait(() => run.engine.movementControlEnabled, "door closes behind Larry");
  assert.equal(run.engine.flags[90], 1, "pimp still watching television");
  leave(run, "N", 17);
}

function hooker(run: Speedrun): void {
  // Foot of the bed: posn(11,144,48,151).
  goTo(run, 14, 145, 46, 150);
  say(run, "undress");
  run.wait(() => run.engine.vars[30] === 26, "undressed", 1000);
  // Unprotected sex sets f89 and ends the game outside; the condom scores 10 (f91).
  say(run, "wear condom");
  assert.equal(run.engine.flags[62], 1, "protected");
  score(run, 131, "condom on");
  say(run, "get on bed");
  run.waitForFlag(63, "no longer a virgin", 6000);
  run.wait(() => run.engine.inputEnabled && run.engine.modalKind === null, "dressed again");
  assert.equal(run.engine.flags[89], 0, "no disease");
  score(run, 142, "hooker");
  // Wearing it outside gets Larry arrested (room 11, f62).
  say(run, "remove condom");
  assert.equal(run.engine.flags[62], 0, "condom disposed of");
  score(run, 143, "tidy");
  run.checkpoint("Lost his virginity, safely", { room: 17 });
  goTo(run, 118, 120, 135, 137);
  assert.equal(run.engine.flags[64], 1, "window still open");
  say(run, "climb out window");
  run.waitForRoom(12, "fire escape");
}

function pills(run: Speedrun): void {
  // The pills sit behind the neighbour's window, reachable from posn(82,60,99,64).
  // Both knots (f208 waist, f209 railing) freeze Larry, so he walks there first.
  run.wait(() => run.engine.movementControlEnabled, "on the landing");
  goTo(run, 84, 61, 92, 63);
  say(run, "tie rope to me");
  say(run, "tie rope to railing");
  assert.deepEqual([flag(run, 208), flag(run, 209)], [true, true], "roped to the railing");
  say(run, "get pills");
  assert.equal(run.engine.vars[30], 13, "leaning out over the alley");
  say(run, "use hammer");
  run.waitForFlag(65, "window smashed", 1000);
  run.wait(() => run.engine.inputEnabled, "glass settles");
  run.take("get pills", ITEM.pills);
  score(run, 151, "pills");
  say(run, "climb back");
  assert.equal(run.engine.vars[30], 0, "back on the landing");
  say(run, "untie rope");
  assert.deepEqual([flag(run, 208), flag(run, 209)], [false, false], "untied");
  run.checkpoint("Smashed a window for the bottle of pills", { room: 12 });
  run.walkToUntil(53, 64, () => run.engine.vars[30] !== 0, "step off the fire escape");
  run.wait(() => run.engine.vars[30] === 14 && run.engine.inputEnabled, "sitting in the garbage");
  say(run, "climb out");
  run.wait(
    () => run.engine.vars[30] === 0 && run.engine.movementControlEnabled,
    "out of the dumpster",
  );
  leave(run, "W", 11);
  taxi(run, "casino");
  buyAppleIfOffered(run);
}

function penthouse(run: Speedrun): void {
  // Eve only wants the apple; keep revisiting the forecourt until the seller shows up.
  for (let visit = 0; !run.carried(ITEM.apple); visit++) {
    assert.ok(visit < 30, "apple seller never appeared");
    enterCasino(run);
    leave(run, "S", 32);
    buyAppleIfOffered(run);
  }
  assert.equal(run.state().score, 154, "everything below the penthouse");
  enterCasino(run);
  leave(run, "N", 35);
  lift(run, "eight", 42);
  freshenBreath(run);
  // Faith guards the penthouse lift from her desk: posn(117,133,141,156).
  goTo(run, 119, 135, 139, 154);
  say(run, "look at girl");
  assert.equal(run.engine.flags[206], 1, "Faith's close-up");
  say(run, "give pills to girl");
  run.waitForFlag(76, "Faith rushes off to her boyfriend", 3000);
  run.wait(() => run.engine.vars[65] === 0 && run.engine.inputEnabled, "desk unattended", 6000);
  assert.equal(run.state().score, 159, "pills delivered");
  run.checkpoint("Sent Faith running with the pills", { room: 42 });
  say(run, "push button");
  assert.equal(run.engine.flags[202], 1, "penthouse lift open");
  // Inside posn(126,112,150,127) the open door's block line is ignored; the car,
  // posn(146,111,149,120), then closes on Larry and rides up (f77, 5 points).
  goTo(run, 133, 121, 136, 122);
  run.walkToUntil(147, 117, () => run.engine.vars[65]! >= 250, "into the penthouse lift");
  run.waitForRoom(44, "penthouse living room", 3000);
  assert.equal(run.state().score, 164, "private lift");
  // The car door's block line is ignored while it stands open (f203); it shuts behind Larry.
  run.waitForFlag(203, "lift door opens", 600);
  run.walkTo(118, 127);
  run.wait(() => run.engine.flags[203] === 0 && run.engine.vars[65] === 0, "lift closes", 600);
  // The bedroom doorway is posn(113,93,114,106).
  enter(run, { x0: 113, y0: 93, x1: 114, y1: 106 }, 45);
  // Closet handle: posn(105,121,117,136).
  goTo(run, 106, 123, 116, 134);
  say(run, "open closet");
  run.waitForFlag(202, "closet open", 600);
  // Inside the closet, posn(117,121,129,131); left of x 122 a nail pops the doll unscored.
  // The doorway's block line is ignored once the door stands open, so walk straight in.
  run.walkTo(124, run.state().y);
  run.take("take doll", ITEM.doll);
  assert.equal(run.state().score, 169, "doll");
  say(run, "inflate doll");
  assert.equal(run.engine.flags[217], 1, "doll inflated");
  assert.equal(run.state().score, 174, "inflated");
  // The game asks for confirmation once (f215); the second request scores and bursts her.
  say(run, "use doll");
  say(run, "use doll");
  assert.equal(run.state().score, 182, "doll");
  run.checkpoint("Chased a runaway inflatable doll", { room: 45 });
  // Larry runs after her by himself through the living room onto the terrace.
  run.waitForRoom(43, "rooftop terrace", 6000);
  run.wait(() => run.engine.vars[30] === 0 && run.engine.inputEnabled, "doll out of reach", 6000);
  say(run, "get in tub");
  run.waitForFlag(200, "in the hot tub with Eve", 6000);
  run.wait(() => run.engine.inputEnabled && run.engine.modalKind === null, "settled in");
  say(run, "look at girl");
  assert.equal(run.engine.flags[204], 1, "Eve's close-up");
  say(run, "give apple to girl");
  run.wait(() => run.state().score === 197, "Eve accepts the apple", 600);
  run.checkpoint("Tempted Eve with the apple", { room: 43, score: 197 });
  run.waitForRoom(45, "Eve leads Larry to the bedroom", 12000);
  run.wait(() => run.state().score === 222, "fireworks", 3000);
  run.checkpoint("Spent the night with Eve", { room: 45, score: 222 });
  // Credits: Ken Williams' pitch, then quit(1) ends the interpreter at v65 == 10.
  run.wait(() => run.engine.readState().terminated, "credits finish", 12000);
}

const STAGES: readonly ((run: Speedrun) => void)[] = [
  ageQuiz,
  leftysBar,
  backHallway,
  pimpAndHooker,
  dumpster,
  rideToCasino,
  firstFortune,
  lobbyAndCabaret,
  flasher,
  storeAndPhone,
  bumAndCalls,
  disco,
  wedding,
  suiteRadio,
  wineDelivery,
  honeymoon,
  backToLeftys,
  hooker,
  pills,
  penthouse,
];

/** Stage list for scratch experiments; the catalog runs them all. */
export const lsl1Stages = STAGES;

export function lsl1Complete(run: Speedrun): void {
  for (const stage of STAGES) stage(run);
}

/**
 * Leisure Suit Larry in the Land of the Lounge Lizards, complete game. The
 * logics award exactly 222 points (the sum of every addn(v3, n)), matching
 * the status line's maximum, and the route collects all of them before the
 * penthouse bedroom's quit(1) ends the interpreter during the credits.
 *
 * Seed 1 is the default; it only fixes which five age-quiz questions are
 * asked (the QUIZ table). Cab fares, the apple seller, the bum and the slot
 * machines are all handled from observed state, so the same route succeeds
 * whether or not the host lingers on message windows.
 */
export const lsl1Walkthrough: Walkthrough = {
  hash: KNOWN_GAME_HASH.LSL1,
  alias: "lsl1",
  label: "spent the night with Eve in the penthouse with the maximum score",
  coverage: "complete-game",
  seed: 1,
  route: lsl1Complete,
  expected: {
    room: 45,
    score: 222,
    // v65 == 10 is the credits' final step; v30 == 23 is Larry following Eve.
    vars: { 30: 23, 65: 10 },
    // f63 hooker, f76 Faith gone, f84/f88 Eve took the apple, f110 wedding fee paid.
    flags: { 63: 1, 76: 1, 84: 1, 88: 1, 110: 1 },
    carriedExactly: [
      ITEM.wallet,
      ITEM.spray,
      ITEM.lint,
      ITEM.watch,
      ITEM.remote,
      ITEM.pass,
      ITEM.knife,
      ITEM.magazine,
      ITEM.hammer,
      ITEM.rope,
    ],
    inputEnabled: false,
    egoView: 8,
  },
  requiresAnswer: true,
};
