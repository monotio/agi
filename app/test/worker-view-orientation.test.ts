/**
 * Player rule: jumping back in History keeps which way an actor faces on the
 * early PC builds (docs/fidelity.md F-VIEWS-01). Packed 2.230 mirrors whole
 * loops at SetLoop only, so a History anchor records each loaded view's loop
 * orientation; an anchor recorded before 1.2.6 carries none and still
 * replays, its fingerprint checked without it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildView } from "../../src/view/view.ts";
import { PROFILES } from "../../src/runtime/profile.ts";
import { stampAnchor, type HistoryAnchor } from "../../src/agent/history.ts";
import { collectSegments, replayHistorySegment } from "./worker-ctx.ts";
import { createWorkerContext, type WorkerContext } from "../src/worker/context.ts";
import { createEngineHost } from "../src/worker/host.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import type { WorkerControl, WorkerInbound } from "../src/worker/workerProtocol.ts";

const profile = PROFILES["2.230"];
const cel = { width: 3, height: 1, transparentColor: 0, pixels: [1, 2, 0] };

function session() {
  const container = createContainer();
  container.putResource(
    "view",
    1,
    buildView({ loops: [{ cels: [cel] }, { mirrorLoop: 0 }] }, profile),
  );
  container.putResource("picture", 1, Uint8Array.of(0xf0, 15, 0xff));
  container.putResource(
    "logic",
    0,
    assembleLogic(
      `if (!isset(f200)) {
         set(f200); assignn(v50, 1); load.pic(v50); draw.pic(v50); show.pic();
         load.view(1); animate.obj(o0); set.view(o0, 1);
         fix.loop(o0); stop.cycling(o0); position(o0, 20, 80); set.loop(o0, 1); draw(o0);
       }
       increment(v40);
       return;`,
      { dictionary: new Map(), profile },
    ).payload,
  );
  const control: WorkerControl[] = [];
  let now = 0;
  const ctx: WorkerContext = createWorkerContext({
    control: (message) => control.push(message),
    presentation: () => {},
    now: () => now,
  });
  ctx.host = createEngineHost(ctx);
  const send = (msg: WorkerInbound): void => onWorkerMessage(ctx, msg);
  send({ type: "boot", profile: "2.230", files: Object.fromEntries(container.files), words: [] });
  ctx.fns.stopTimers();
  const tick = (n: number): void => {
    for (let i = 0; i < n; i++) {
      now += 1000 / 60;
      ctx.fns.hostTick();
    }
  };
  return { ctx, control, send, tick };
}

const row = (ctx: WorkerContext) => [
  ...ctx.run.engine!.getFrame().visual.slice(80 * 160 + 20, 80 * 160 + 23),
];

test("2.230: History anchors keep a mirrored actor's facing, old anchors included", () => {
  const s = session();
  s.tick(400);
  assert.deepEqual(row(s.ctx), [15, 2, 1], "the actor faces the mirrored way");
  s.send({ type: "pause", paused: true });
  const [segment] = collectSegments(s.control);
  assert.ok(segment && segment.anchors.length > 0, "the session recorded an anchor");
  const anchor = segment.anchors.length - 1;
  const recorded = segment.anchors[anchor]!.replay as { viewCache: { loops?: unknown } };
  assert.ok(recorded.viewCache.loops, "the anchor records the view orientation");

  const replayed = replayHistorySegment(segment, { anchor });
  assert.equal(replayed.error, null);
  assert.deepEqual(row(replayed.ctx), [15, 2, 1], "the replayed actor faces the same way");

  // An anchor written before 1.2.6: no orientation, fingerprinted without it.
  const older = structuredClone(segment);
  const { fingerprint: _fingerprint, ...rest } = older.anchors[anchor]!;
  delete (rest.replay as { viewCache: { loops?: unknown } }).viewCache.loops;
  older.anchors[anchor] = stampAnchor(rest as Omit<HistoryAnchor, "fingerprint">);
  const fromOlder = replayHistorySegment(older, { anchor });
  assert.equal(fromOlder.error, null, "the older anchor still replays");
  assert.deepEqual(row(fromOlder.ctx), [15, 2, 1], "its objects' loops rebind the facing");
  s.ctx.fns.stopTimers();
});
