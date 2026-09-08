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
import { fixtureSkip } from "./fixtures.ts";
import { loadGame } from "./game-fixture.ts";

/**
 * Optional King's Quest IV 3.002.086 fixture tests. Available-resource
 * parsing, complete-volume coverage and opening behavior are checked separately.
 */
const SLUG = "kq4";
const skip = fixtureSkip(SLUG, ["AGIDATA.OVL"]);

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
  randomWord(): number {
    // Logic 140 deals the copy protection with random(1, 79, v115) and sends
    // the run to room 141/142/143 by thirds (disassembly-verified). 40 lands
    // v115 at 41, the room-142 third; kq4-regressions uses 66 for room 143.
    return 40;
  }
}

test(
  `${SLUG}: combined container, 3.002.086 profile, available resources`,
  {
    skip: fixtureSkip(SLUG, ["AGIDATA.OVL"], { checkVolumes: false }),
  },
  (t) => {
    const { container, files } = loadGame(SLUG, { interpreterFiles: true, checkVolumes: false });
    assert.deepEqual(detectContainerFormat(files), { kind: "v3-combined", prefix: "KQ4" });
    assert.equal(detectVersionString(files), "3.002.086");
    const profile = detectProfile(files);
    assert.equal(profile.id, "3.002.086");
    const counts = { logic: 0, picture: 0, view: 0, sound: 0 };
    const unavailable: string[] = [];
    let decoded = 0;
    for (let n = 0; n < 256; n++) {
      for (const kind of ["logic", "picture", "view", "sound"] as const) {
        let payload: Uint8Array | null;
        try {
          payload = container.getResource(kind, n);
        } catch (error) {
          assert.match(String(error), /points to missing VOL\.\d+$/, `${kind} ${n}`);
          counts[kind]++;
          unavailable.push(`${kind} ${n}`);
          continue;
        }
        if (!payload) continue;
        if (kind === "logic")
          assert.ok(parseLogicResource(payload).code.length > 0, `logic ${n} has bytecode`);
        if (kind === "picture") renderPicture(payload, createPictureSurface(), { profile });
        if (kind === "view") assert.ok(parseView(payload).loops.length > 0, `view ${n} has a loop`);
        if (kind === "sound") parseSound(payload);
        counts[kind]++;
        decoded++;
      }
    }
    assert.deepEqual(counts, { logic: 177, picture: 148, view: 243, sound: 96 });
    assert.ok(decoded > 0, "the fixture supplied readable resources");
    if (unavailable.length) t.diagnostic(`Unavailable resources: ${unavailable.join(", ")}`);
  },
);

test(`${SLUG}: every declared resource is readable`, { skip }, () => {
  const { container } = loadGame(SLUG);
  for (let n = 0; n < 256; n++)
    for (const kind of ["logic", "picture", "view", "sound"] as const)
      assert.doesNotThrow(() => container.getResource(kind, n), `${kind} ${n}`);
});

test(
  `${SLUG}: the opening deals the copy-protection question in room 142`,
  { skip: fixtureSkip(SLUG, ["AGIDATA.OVL"], { checkVolumes: false }) },
  () => {
    const { container, dict, files } = loadGame(SLUG, {
      interpreterFiles: true,
      checkVolumes: false,
    });
    const host = new Host();
    const engine = new Engine(container, host, dict, { profile: detectProfile(files) });
    const rooms: number[] = [];
    for (let i = 0; i < 300 && !engine.textRow(6).includes("legal"); i++) {
      engine.advanceClock(50);
      engine.soundTick();
      engine.tick();
      if (rooms[rooms.length - 1] !== engine.vars[0]) rooms.push(engine.vars[0]!);
    }
    assert.equal(rooms.at(-1), 142, "the opening deals the question in room 142");
    assert.match(
      host.prints[0] ?? "",
      /legal ownership.*King's Quest IV manual.*On page 5, what is the seventh word in the fifth paragraph\?/s,
      "the room-142 manual question window is up",
    );
  },
);
