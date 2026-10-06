import { test } from "node:test";
import assert from "node:assert/strict";
import { gameContainer, workerHarness } from "./worker-ctx.ts";
import { Engine } from "../../src/runtime/engine.ts";
import { PROFILES } from "../../src/runtime/profile.ts";
import { buildSound } from "../../src/sound/build.ts";

for (const profileId of ["2.936", "amiga-2.202"] as const) {
  test(`${profileId} batches catch-up heartbeats without merging voices or completion`, () => {
    const container = gameContainer(
      ["if (!isset(f201)) { set(f201); set(f9); load.sound(0); sound(0,f200); } return;"],
      (container) =>
        container.putResource(
          "sound",
          0,
          buildSound([
            { notes: [{ freqDivisor: 226, duration: 2, attenuation: 0 }] },
            { notes: [{ freqDivisor: 300, duration: 2, attenuation: 0 }] },
          ]),
        ),
    );
    const { ctx, presentation } = workerHarness(container);
    const profile = PROFILES[profileId];
    ctx.run.engine = new Engine(container, ctx.host!, new Map(), { profile });
    ctx.fns.tickEngine();
    ctx.fns.stepHostTick(100);
    const packets = presentation.filter((message) => message.type === "soundTick");
    assert.ok(packets.length >= 3, "every discharged heartbeat carries its own position");
    assert.deepEqual(
      packets.map(({ tick }) => tick),
      packets.map((_, tick) => tick),
    );
    assert.equal(new Set(packets.map(({ stream }) => stream)).size, 1);
    assert.equal(packets.at(-1)!.complete, true);
    assert.equal(ctx.run.engine.flags[200], 1, "completion remains interpreter-owned");
    if (profileId === "amiga-2.202") {
      const first = packets[0]!.outputs;
      assert.ok(
        first.some(
          (output) => output.kind === "paula" && output.channel === 0 && output.period !== null,
        ),
      );
      assert.ok(
        first.some(
          (output) => output.kind === "paula" && output.channel === 1 && output.period !== null,
        ),
      );
    }
    const oldStream = packets[0]!.stream;
    ctx.run.engine.flags[201] = 0;
    ctx.fns.tickEngine();
    ctx.run.engine.soundTick();
    const next = presentation.filter((message) => message.type === "soundTick").at(-1)!;
    assert.notEqual(next.stream, oldStream);
    assert.equal(next.tick, 0);
  });
}
