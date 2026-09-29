/**
 * A resumed autosave keeps the game's save namespace. The game signature
 * rides block 1 of the image (spec "Save names and signatures"); a game such
 * as KQ1 issues set.game.id only on its first pass, so a resume that dropped
 * the signature could neither see the game's slots nor write signed saves.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { gameContainer } from "./worker-ctx.ts";
import { base64ToBytes } from "../src/project/bytes.ts";
import { createWorkerContext, type WorkerPorts } from "../src/worker/context.ts";
import { createEngineHost } from "../src/worker/host.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import type {
  WorkerControl,
  WorkerInbound,
  WorkerPresentation,
} from "../src/worker/workerProtocol.ts";

const PICTURE_1 = new Uint8Array([
  0xf0, 0x01, 0xf6, 10, 10, 60, 10, 60, 40, 10, 40, 10, 10, 0xf8, 30, 20, 0xf1, 0xf2, 0x05, 0xf6, 0,
  150, 159, 150, 0xf3, 0xff,
]);

// The KQ1 shape: set.game.id runs once, in the boot pass only.
const GAME = gameContainer(
  [
    `if (!isset(f200)) { set(f200); set.game.id("DEMO"); assignn(v0, 1); new.room.v(v0); }
     call.v(v0);
     if (isset(f208)) { reset(f208); save.game(); }
     return;`,
    `if (isset(f5)) { assignn(v50, 1); load.pic(v50); draw.pic(v50); show.pic(); accept.input(); } return;`,
  ],
  (c) => c.putResource("picture", 1, PICTURE_1),
);

function boot(restoreImage?: string) {
  const control: WorkerControl[] = [];
  const presentation: WorkerPresentation[] = [];
  let now = 0;
  const ports: WorkerPorts = {
    control: (message) => control.push(message),
    presentation: (message) => presentation.push(message),
    now: () => now,
    seedWord: () => 0x1234,
    schedule: (fn, ms) => ({ fn, ms }),
    cancelSchedule: () => {},
  };
  const ctx = createWorkerContext(ports);
  ctx.host = createEngineHost(ctx);
  const send = (msg: WorkerInbound): void => onWorkerMessage(ctx, msg);
  send({
    type: "boot",
    files: Object.fromEntries(GAME.files),
    words: [],
    ...(restoreImage !== undefined ? { restoreImage } : {}),
  });
  ctx.fns.stopTimers();
  const tick = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      now += 1000 / 60;
      ctx.fns.hostTick();
    }
  };
  const answered = new Set<number>();
  const request = (op: string) => {
    for (let i = 0; i < 40; i++) {
      const req = control.find(
        (m) => m.type === "hostRequest" && m.op === op && !answered.has(m.id),
      );
      if (req?.type === "hostRequest") {
        answered.add(req.id);
        return req;
      }
      tick();
    }
    return assert.fail(`host request ${op} never posted`);
  };
  const answer = (op: string, response: string) =>
    send({ type: "hostAnswer", id: request(op).id, response });
  /** Open the save selector with `slots` in storage and return the rendered list rows. */
  const openSave = (slots: { slot: number; image: string }[]) => {
    send({ type: "debugWrite", id: 0, flags: [[208, 1]] });
    answer("saveList", JSON.stringify(slots));
    return [3, 4, 5].map((row) => ctx.engine!.textRow(row).trim());
  };
  return { ctx, control, presentation, send, tick, request, answer, openSave };
}

const signatureOf = (image: string) => [...base64ToBytes(image).subarray(33, 40)];
// "DEMO" then three NULs: bytes 33..39 are the first seven block-1 bytes,
// after the 31-byte description header and the 2-byte block length.
const DEMO = [0x44, 0x45, 0x4d, 0x4f, 0, 0, 0];

test("a resumed autosave lists the game's slots and writes signed saves", () => {
  // Fresh boot: save slot 1 as "Courtyard".
  const live = boot();
  live.tick(4);
  assert.deepEqual(live.openSave([]).slice(0, 2), ["1. <empty>", "2. <empty>"]);
  live.send({ type: "key", code: 13 });
  live.answer("saveDescription", JSON.stringify({ value: "Courtyard" }));
  live.send({ type: "key", code: 13 });
  const first = live.request("saveWrite");
  const courtyard = String(first.context["image"]);
  assert.deepEqual(signatureOf(courtyard), DEMO, "the fresh boot signs its save");
  live.send({ type: "hostAnswer", id: first.id, response: "true" });
  live.tick(2);

  // Leave: the page keeps the autosave.
  live.ctx.cycle.cycleCount++;
  assert.equal(live.ctx.fns.autosave(true), true);
  const autosave = live.presentation.find((m) => m.type === "autosave");
  assert.ok(autosave?.type === "autosave");

  // Click the card: a new worker resumes that image, then F5.
  const resumed = boot(autosave.image);
  assert.ok(resumed.control.some((m) => m.type === "restored" && m.ok));
  assert.equal(resumed.ctx.engine!.gameSignature, "DEMO");
  resumed.tick(2);
  assert.deepEqual(resumed.openSave([{ slot: 1, image: courtyard }]).slice(0, 2), [
    "1. Courtyard",
    "2. <empty>",
  ]);
  // Overwrite slot 1: the replacement carries the game's signature.
  resumed.send({ type: "key", code: 13 });
  resumed.send({ type: "key", code: 13 });
  const second = resumed.request("saveWrite");
  assert.deepEqual(signatureOf(String(second.context["image"])), DEMO);
});
