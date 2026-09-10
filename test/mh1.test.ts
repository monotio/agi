import { test } from "node:test";
import assert from "node:assert/strict";
import { detectContainerFormat } from "../src/container/container.ts";
import { parseLogicResource } from "../src/logic/resource.ts";
import { renderPicture } from "../src/picture/renderer.ts";
import { parseSound } from "../src/sound/sound.ts";
import { parseView } from "../src/view/view.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { detectProfile, detectVersionString } from "../src/runtime/profile.ts";
import { createPictureSurface } from "../src/types.ts";
import { fixtureSkip, KNOWN_GAME_HASH } from "./fixtures.ts";
import { loadGame } from "./game-fixture.ts";

/**
 * Optional Manhunter: New York 3.002.107 fixture tests. The specification
 * maps this build to profile 3.002.102. The suite covers compressed and
 * directly stored logic and clock waits. Walkthrough coverage uses the shared suite.
 */
const GAME_ALIAS = "mh1";
const TARGET_HASH = KNOWN_GAME_HASH.MH1;
const skip = fixtureSkip(TARGET_HASH, ["AGIDATA.OVL"]);

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

function printable(text: string): number {
  let ok = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if ((code >= 32 && code < 127) || code === 10) ok++;
  }
  return text.length ? ok / text.length : 1;
}

test(`${GAME_ALIAS}: combined container, 3.002.107 build, resource census`, { skip }, () => {
  const { container, files } = loadGame(TARGET_HASH, { interpreterFiles: true });
  assert.deepEqual(detectContainerFormat(files), { kind: "v3-combined", prefix: "MH" });
  assert.equal(detectVersionString(files), "3.002.107");
  const profile = detectProfile(files);
  assert.equal(profile.id, "3.002.102");
  const counts = { logic: 0, picture: 0, view: 0, sound: 0 };
  for (let n = 0; n < 256; n++) {
    const logic = container.getResource("logic", n);
    if (logic) {
      const parsed = parseLogicResource(logic);
      assert.ok(parsed.code.length > 0, `logic ${n} has bytecode`);
      // Compressed records store plain text and the direct record encrypted
      // text; the container hands both to the decoder in one layout.
      const text = parsed.messages.filter((m) => m !== null).join("");
      assert.ok(printable(text) > 0.99, `logic ${n} messages decode as text`);
      counts.logic++;
    }
    const picture = container.getResource("picture", n);
    if (picture) {
      renderPicture(picture, createPictureSurface(), { profile });
      counts.picture++;
    }
    const view = container.getResource("view", n);
    if (view) {
      assert.ok(parseView(view).loops.length > 0, `view ${n} has a loop`);
      counts.view++;
    }
    // Directory entries 136 and 138 point at bytes that are not records; no
    // logic loads either sound, so the corruption stays reportable and inert.
    if (n === 136 || n === 138) {
      assert.throws(() => container.getResource("sound", n), /bad record magic/);
      continue;
    }
    const sound = container.getResource("sound", n);
    if (sound) {
      parseSound(sound);
      counts.sound++;
    }
  }
  assert.deepEqual(counts, { logic: 66, picture: 237, view: 138, sound: 99 });
});

test(
  `${GAME_ALIAS}: the title screen skips through its clock busy-wait into the opening`,
  { skip },
  () => {
    const { container, dict, files } = loadGame(TARGET_HASH, { interpreterFiles: true });
    const host = new Host();
    const engine = new Engine(container, host, dict, { profile: detectProfile(files) });
    const cycle = (): void => {
      engine.advanceClock(50);
      for (let i = 0; i < 3; i++) engine.soundTick();
      engine.tick();
      if (host.prints.length && engine.modalKind === "print") engine.ackPrint();
    };
    const rooms: number[] = [];
    const visit = (): void => {
      if (rooms[rooms.length - 1] !== engine.vars[0]) rooms.push(engine.vars[0]!);
    };
    for (let i = 0; i < 100; i++) {
      cycle();
      visit();
    }
    assert.equal(engine.vars[0], 153, "the title screen");
    assert.ok(engine.textRow(10).includes("The Orbs invaded New York"), engine.textRow(10));
    // Enter maps to the skip controller: logic 153 zeroes v11 and spins on
    // greaterv(v49, v11) inside one invocation before new.room(104). Parked at
    // the loop head, the pass completes once the host clock has moved a second.
    host.keys.push(0x0d);
    let parked = false;
    for (let i = 0; i < 60 && engine.vars[0] === 153; i++) {
      cycle();
      parked ||= engine.continuationPending;
      visit();
    }
    assert.equal(parked, true, "the busy-wait was parked between host ticks");
    assert.equal(engine.vars[0], 104, "the skip lands in the opening room");
    // Keep pressing Enter through the opening until the MAD tracker room.
    for (let i = 0; i < 1500 && engine.vars[0] !== 101; i++) {
      if (i % 300 === 0) host.keys.push(0x0d);
      cycle();
      visit();
    }
    assert.deepEqual(rooms, [153, 104, 117, 101]);
    const printed = host.prints.join("\n");
    assert.match(printed, /Attention Manhunter!/);
    assert.match(printed, /explosion\n at Bellevue Hospital!/);
  },
);
