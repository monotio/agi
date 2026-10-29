/** Save-list transports must deliver the native description and signature to the real selector. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Engine } from "../../src/runtime/engine.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { PROFILES } from "../../src/runtime/profile.ts";
import { loadAppearance } from "../src/render/appearance.ts";
import { base64ToBytes, bytesToBase64 } from "../src/project/bytes.ts";
import { useSaveSlotController } from "../src/saves/useSaveSlotController.ts";
import { createWorkerContext } from "../src/worker/context.ts";
import { createDebugController } from "../src/worker/debugController.ts";
import { installDebugController } from "../src/worker/debugLoader.ts";
import { createEngineHost } from "../src/worker/host.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import type { WorkerControl, WorkerInbound } from "../src/worker/workerProtocol.ts";
import { testProjectId, testRevision } from "./identity.ts";

await Promise.all(["amiga-2.202", "iigs-1.014"].map((profile) => loadAppearance(profile)));

for (const profile of ["2.936", "amiga-2.202", "iigs-1.014"] as const) {
  const game = createContainer();
  game.putResource("picture", 0, Uint8Array.of(0xff));
  game.putResource(
    "logic",
    0,
    assembleLogic(
      `
    if (!isset(f200)) { set(f200); set.game.id("DEMO"); load.pic(v0); draw.pic(v0); show.pic(); }
    if (isset(f12)) { assignn(v101, 1); display(10, 0, "RESTORED"); return; }
    if (isset(f208)) { reset(f208); save.game(); }
    if (isset(f209)) { reset(f209); restore.game(); }
    return;`,
      { dictionary: new Map(), profile: PROFILES[profile] },
    ).payload,
  );

  test(`${profile}: durable save controller lists a visible native save and restores it`, async () => {
    const values = new Map<string, string>();
    const controller = useSaveSlotController({
      storage: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => void values.set(key, value),
      },
      getBootedGame: () => ({
        installed: false,
        projectId: testProjectId("native-selector"),
        title: "Native selector",
        revision: testRevision("native-selector"),
        historyLifetime: "initial",
        files: {},
        words: [],
      }),
    });
    const rows: string[] = [];
    const reads: number[] = [];
    const engine: Engine = new Engine(
      game,
      {
        print() {},
        displayAt() {},
        statusLine() {},
        takeInputLine: () => null,
        takeKeys: () => [],
        listSaveGames: () =>
          (
            JSON.parse(controller.handleSaveSlotRequest("saveList", {}) as string) as {
              slot: number;
              image: string;
            }[]
          ).map((entry) => ({ slot: entry.slot, bytes: base64ToBytes(entry.image) })),
        waitKey() {
          rows.push(Array.from({ length: 25 }, (_, row) => engine.textRow(row)).join("\n"));
          return 13;
        },
        restoreGame(slot = 1) {
          reads.push(slot);
          // This controller returns the complete image asynchronously; preload that exact response below.
          return base64ToBytes(stored);
        },
      },
      new Map(),
      { profile },
    );
    for (let step = 0; step < 40; step++) {
      engine.advanceClock(100);
      engine.tick();
    }
    const image = engine.serialize();
    const description = "Courtyard";
    image.fill(0, 0, 31);
    image.set(new TextEncoder().encode(description));
    const full = bytesToBase64(image);
    assert.equal(
      await controller.handleSaveSlotRequest("saveWrite", { slot: 1, image: full }),
      "true",
    );
    if (profile === "iigs-1.014") {
      const truncated = image.slice(0, 97); // One byte short of the block-2 signature.
      truncated.fill(0, 0, 31);
      truncated.set(new TextEncoder().encode("Truncated"));
      const oversized = new Uint8Array(31 + 2 + 0xffff + 2 + 7);
      oversized.set(image);
      oversized.fill(0, 0, 31);
      oversized.set(new TextEncoder().encode("Oversized"));
      oversized.fill(0xff, 31, 33); // Untrusted lead length cannot grow a list reply.
      oversized.set(image.subarray(91, 98), oversized.length - 7);
      for (const [index, malformed] of [truncated, oversized].entries())
        assert.equal(
          await controller.handleSaveSlotRequest("saveWrite", {
            slot: index + 2,
            image: bytesToBase64(malformed),
          }),
          "true",
        );
    }
    const stored = await controller.handleSaveSlotRequest("restore", { slot: 1 });
    assert.equal(stored, full);
    const candidates = JSON.parse(controller.handleSaveSlotRequest("saveList", {}) as string) as {
      image: string;
    }[];
    for (const candidate of candidates)
      assert.ok(
        base64ToBytes(candidate.image).length <= 98,
        "malformed lengths keep the same bound",
      );
    const prefix = base64ToBytes(candidates[0]!.image);
    assert.ok(
      prefix.length <= 98,
      "the largest supported prefix ends after the IIgs block-2 signature",
    );
    assert.ok(prefix.length < image.length, "list transport omits the save body");
    engine.vars[80] = 7;
    engine.flags[209] = 1;
    engine.tick();
    assert.match(rows[0] ?? "", /Courtyard/, "the real selector shows the stored description");
    assert.doesNotMatch(
      rows[0] ?? "",
      /Truncated|Oversized/,
      "malformed signature lengths stay out",
    );
    assert.deepEqual(reads, [1]);
    for (let step = 0; step < 40 && engine.vars[101] === 0; step++) {
      engine.advanceClock(100);
      engine.tick();
    }
    assert.equal(engine.vars[80], 0, "selection restored the saved state");
    assert.match(engine.textRow(10), /RESTORED/);
  });

  test(`${profile}: Create scratch saves list their description and restore through the worker`, async (t) => {
    let now = 0;
    const control: WorkerControl[] = [];
    const scheduled: (() => void)[] = [];
    const ctx = createWorkerContext({
      control: (message) => control.push(message),
      presentation() {},
      now: () => now,
      schedule(fn, ms) {
        if (ms === 0) scheduled.push(fn);
        return fn;
      },
      cancelSchedule(fn) {
        const at = scheduled.indexOf(fn as () => void);
        if (at >= 0) scheduled.splice(at, 1);
      },
    });
    installDebugController(ctx, createDebugController(ctx));
    ctx.host = createEngineHost(ctx);
    t.after(() => ctx.fns.stopTimers());
    const send = (msg: WorkerInbound) => onWorkerMessage(ctx, msg);
    const tick = () => {
      now += 100;
      ctx.fns.hostTick();
    };
    const drain = () => {
      for (let step = 0; scheduled.length && step < 10; step++) scheduled.shift()!();
    };
    send({
      type: "boot",
      files: Object.fromEntries(game.files),
      words: [],
      profile,
      projectMode: "create",
    });
    await ctx.projectLoader.loading;
    ctx.fns.stopTimers();
    for (let step = 0; step < 40; step++) tick();
    send({ type: "debugWrite", id: 1, flags: [[208, 1]], vars: [[80, 99]] });
    tick();
    drain();
    // Amiga opens its directory window before the slot list.
    for (
      let step = 0;
      step < 4 && !control.some((m) => m.type === "hostRequest" && m.op === "saveDescription");
      step++
    )
      send({ type: "key", code: 13 });
    const describe = control.findLast(
      (m) => m.type === "hostRequest" && m.op === "saveDescription",
    );
    assert.ok(describe?.type === "hostRequest");
    send({
      type: "hostAnswer",
      generation: ctx.run.generation,
      id: describe.id,
      response: '{"value":"Courtyard"}',
    });
    send({ type: "key", code: 13 });
    drain();
    assert.ok(ctx.run.scratchSlots["1"], "save.game wrote the scratch slot");
    send({ type: "debugWrite", id: 2, flags: [[209, 1]], vars: [[80, 7]] });
    tick();
    drain();
    if (profile.startsWith("amiga")) send({ type: "key", code: 13 });
    const rows = Array.from({ length: 25 }, (_, row) => ctx.run.engine!.textRow(row)).join("\n");
    assert.match(rows, /Courtyard/, "the real selector sees the scratch description");
    send({ type: "key", code: 13 });
    if (profile.startsWith("amiga")) send({ type: "key", code: 13 });
    drain();
    for (let step = 0; step < 40 && ctx.run.engine!.vars[101] === 0; step++) tick();
    assert.equal(ctx.run.engine!.vars[80], 99, "restore.game read the full scratch save");
    assert.match(ctx.run.engine!.textRow(10), /RESTORED/);
    assert.equal(
      control.some(
        (m) => m.type === "hostRequest" && ["saveList", "saveWrite", "restore"].includes(m.op),
      ),
      false,
      "scratch slots stay inside the worker",
    );
  });
}
