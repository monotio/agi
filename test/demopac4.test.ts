import { test } from "node:test";
import assert from "node:assert/strict";
import { detectContainerFormat } from "../src/container/container.ts";
import { parseLogicResource } from "../src/logic/resource.ts";
import { renderPicture } from "../src/picture/renderer.ts";
import { parseSound } from "../src/sound/sound.ts";
import { parseView } from "../src/view/view.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { detectProfile } from "../src/runtime/profile.ts";
import { createPictureSurface } from "../src/types.ts";
import { fixtureSkip, KNOWN_GAME_HASH } from "./fixtures.ts";
import { loadGame } from "./game-fixture.ts";

/**
 * Optional Sierra demo-pack fixture: supply DMDIR, DMVOL.0-1 and the
 * 3.002.102 interpreter under games/demopac4/. The suite checks compressed
 * resource expansion, message decoding and completion of all six demos.
 */
const GAME_ID = "demopac4";
const TARGET_HASH = KNOWN_GAME_HASH.DEMOPAC4;
const skip = fixtureSkip(TARGET_HASH, ["AGIDATA.OVL"]);

/** Sound numbers the bytecode loads (load.sound operands in logics 51..201). */
const REFERENCED_SOUNDS = [
  51, 52, 61, 62, 63, 64, 65, 66, 67, 121, 122, 123, 151, 152, 153, 154, 155, 156, 157, 161, 162,
  163, 165, 201, 202, 203, 204, 205,
];

class Host implements EngineHost {
  keys: number[] = [];
  prints: string[] = [];
  print(text: string): void {
    this.prints.push(text);
  }
  displayAt(): void {}
  statusLine(): void {}
  takeInputLine(): string | null {
    return null;
  }
  takeKeys(): number[] {
    return this.keys.splice(0);
  }
}

function boot(): { engine: Engine; host: Host } {
  const { container, dict, files } = loadGame(TARGET_HASH, { interpreterFiles: true });
  const host = new Host();
  const engine = new Engine(container, host, dict, { profile: detectProfile(files) });
  return { engine, host };
}

/** One host cycle: 50 ms of clock, three sound ticks, one interpreter cycle, modal windows acknowledged. */
function cycle(engine: Engine, host: Host): void {
  engine.advanceClock(50);
  for (let i = 0; i < 3; i++) engine.soundTick();
  engine.tick();
  if (host.prints.length) {
    host.prints.length = 0;
    engine.ackPrint();
  }
}

test(`${GAME_ID}: combined container, 3.002.102 profile and resource census`, { skip }, () => {
  const { container, files } = loadGame(TARGET_HASH, { interpreterFiles: true });
  assert.deepEqual(detectContainerFormat(files), { kind: "v3-combined", prefix: "DM" });
  assert.equal(detectProfile(files).id, "3.002.102");
  const counts = { logic: 0, picture: 0, view: 0, sound: 0 };
  for (let n = 0; n < 256; n++) {
    const logic = container.getResource("logic", n);
    if (logic) {
      assert.ok(parseLogicResource(logic).code.length > 0, `logic ${n} has bytecode`);
      counts.logic++;
    }
    const picture = container.getResource("picture", n);
    if (picture) {
      renderPicture(picture, createPictureSurface(), { profile: detectProfile(files) });
      counts.picture++;
    }
    const view = container.getResource("view", n);
    if (view) {
      assert.ok(parseView(view).loops.length > 0, `view ${n} has a loop`);
      counts.view++;
    }
    if (container.getResource("sound", n)) counts.sound++;
  }
  assert.deepEqual(counts, { logic: 16, picture: 47, view: 65, sound: 41 });
  // Every sound the bytecode loads is a four-channel stream. The eleven
  // unreferenced sounds 209..226 begin 01 01 and are not in the spec's format.
  for (const n of REFERENCED_SOUNDS) parseSound(container.getResource("sound", n)!);
});

test(`${GAME_ID}: dictionary-compressed logic text decodes as plain messages`, { skip }, () => {
  const { container } = loadGame(TARGET_HASH);
  const menu = parseLogicResource(container.getResource("logic", 1)!).messages;
  assert.equal(menu[10], "Hi.  Which of our games");
  assert.equal(menu[12], "Press number of demo to select/deselect");
  const boot = parseLogicResource(container.getResource("logic", 0)!).messages;
  assert.equal(boot[0], "Sound now Off");
  assert.equal(boot[3], "Demonstration Paused");
  assert.match(parseLogicResource(container.getResource("logic", 61)!).messages[0]!, /^GOLD RUSH!/);
});

test(`${GAME_ID}: every demonstration runs to completion and returns to the menu`, { skip }, () => {
  const { engine, host } = boot();
  const rooms: number[] = [];
  const visit = (): void => {
    if (rooms[rooms.length - 1] !== engine.vars[0]) rooms.push(engine.vars[0]!);
  };
  // Cold boot: logic 0 maps the keys and enters room 1, whose intro animation
  // waits on have.key with "Press any key..." at (24,22) (logic 1, message 40).
  for (let i = 0; i < 50; i++) {
    cycle(engine, host);
    visit();
  }
  assert.equal(engine.textRow(24).slice(22, 38), "Press any key...");
  host.keys.push(0x20);
  for (let i = 0; i < 10; i++) cycle(engine, host);
  assert.equal(engine.textRow(7).slice(1, 24), "Hi.  Which of our games");
  assert.equal(engine.textRow(0).slice(1, 40), "Press number of demo to select/deselect");
  // Select every demonstration (keys '1'..'6' map to controllers 1..6) and run.
  for (const key of [0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x0d]) {
    host.keys.push(key);
    cycle(engine, host);
    cycle(engine, host);
  }
  // Observed run: rooms 61 at cycle ~160, 62 ~1310, 51 ~2100, 159 ~3600,
  // 161 ~4700, 201 ~5700, 121 ~6800 and the menu again at ~8080. The Gold
  // Rush room 61 walks ego along a trigger line to exactly (67,128) before
  // it can hand over to room 62.
  for (let i = 0; i < 9000 && rooms[rooms.length - 1] !== 121; i++) {
    cycle(engine, host);
    visit();
  }
  for (let i = 0; i < 2000 && engine.vars[0] !== 1; i++) {
    cycle(engine, host);
    visit();
  }
  assert.deepEqual(rooms, [1, 61, 62, 51, 159, 161, 201, 121, 1]);
  assert.equal(engine.modalKind, null);
});
