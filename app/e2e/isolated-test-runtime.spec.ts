import { test, expect } from "@playwright/test";
import { createContainer } from "../../src/container/container.ts";
import { compileProjectLogic } from "../../src/authoring/projectLogic.ts";
import { captureProjectBuild } from "../../src/authoring/projectBuild.ts";
import { PROFILES, type ProfileId } from "../../src/runtime/profile.ts";
import type { SourceBindingKind } from "../src/worker/workerProtocol.ts";

/**
 * The isolated Test runtime against the REAL engine worker: createTestSession
 * runs in the page, its worker is the Vite-served engine.worker.ts — the same
 * module Play boots — wrapped only to record the outbound wire order. No UI
 * mounting here (that is the later frontend packet); this spec proves the
 * runtime seam itself: admission ordering, the pre-first-tick freeze, the
 * ephemeral save store's build-identity lifecycle, generation pinned off,
 * and the pause lease released exactly once.
 */

const PROFILE: ProfileId = "2.411";

type Bindings = Record<string, { kind: SourceBindingKind; num: number }>;

/** Flags live at >=32 — low numbers collide with reserved interpreter flags. */
const SAVE_LOGIC = `
if (!isset(inited)) {
  set(inited);
  assignn(checkpoint_value, 40);
}
increment(count);
if (isset(save_me)) {
  reset(save_me);
  save.game();
}
if (isset(restore_me)) {
  reset(restore_me);
  restore.game();
}
return;
`;

const SAVE_BINDINGS: Bindings = {
  save_me: { kind: "flag", num: 32 },
  restore_me: { kind: "flag", num: 33 },
  inited: { kind: "flag", num: 34 },
  checkpoint_value: { kind: "variable", num: 40 },
  count: { kind: "variable", num: 41 },
};

interface SerializedGame {
  files: Record<string, number[]>;
  sources: Record<string, string>;
  sourceBindings: Bindings;
  buildId: string;
}

function makeGame(
  logics: { num: number; source: string }[],
  bindings: Bindings = {},
): SerializedGame {
  const container = createContainer();
  const projected = Object.fromEntries(
    Object.entries(bindings).map(([name, b]) => [name, { num: b.num }]),
  );
  const sources: Record<string, string> = {};
  for (const { num, source } of logics) {
    sources[String(num)] = source;
    container.putResource(
      "logic",
      num,
      compileProjectLogic(source, {
        profile: PROFILES[PROFILE],
        dictionary: new Map(),
        bindings: projected,
      }).assembly.payload,
    );
  }
  const files = Object.fromEntries(container.files);
  const buildId = captureProjectBuild({
    files,
    profileId: PROFILE,
    sources,
    bindings: projected,
  }).identity.buildId;
  return {
    files: Object.fromEntries(
      Object.entries(files).map(([name, bytes]) => [name, Array.from(bytes)]),
    ),
    sources,
    sourceBindings: bindings,
    buildId,
  };
}

test("isolated test runs the real worker: frozen admission, ephemeral saves, generation off @webkit-desktop", async ({
  page,
}) => {
  await page.goto("/");
  const games = {
    save: makeGame([{ num: 0, source: SAVE_LOGIC }], SAVE_BINDINGS),
    variant: makeGame([{ num: 0, source: "increment(count); increment(count);\nreturn;" }], {
      count: { kind: "variable", num: 41 },
    }),
    missing: makeGame([{ num: 0, source: "new.room(7);" }]),
  };
  const observed = await page.evaluate(
    async ({
      games,
      profile,
    }: {
      games: {
        save: SerializedGame;
        variant: SerializedGame;
        missing: SerializedGame;
      };
      profile: ProfileId;
    }) => {
      const { createTestSession } = await import("/src/studio/logic/debug/testSession.ts");
      const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const until = async (predicate: () => boolean, what: string) => {
        const deadline = performance.now() + 5000;
        while (!predicate()) {
          if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
          await sleep(10);
        }
      };
      interface Outbound {
        type: string;
        op?: string;
      }
      const observed: Outbound[] = [];
      const events: string[] = [];
      const leases: { released: boolean }[] = [];
      // Wrap the real production worker to watch the wire; the session sees
      // an ordinary TestWorkerLike and drives it exactly as the default would.
      function recordingWorker() {
        const w = new Worker("/src/worker/engine.worker.ts", {
          type: "module",
        });
        const self = {
          onmessage: null as ((event: { data: unknown }) => void) | null,
          postMessage(message: unknown) {
            w.postMessage(message);
          },
          terminate() {
            w.terminate();
          },
        };
        w.onmessage = (event) => {
          const data = event.data as Outbound;
          observed.push({ type: data.type, ...(data.op ? { op: data.op } : {}) });
          self.onmessage?.({ data: event.data });
        };
        return self;
      }
      const session = createTestSession({
        createWorker: recordingWorker,
        prompts: { saveDescription: () => "e2e save" },
        acquirePauseLease: () => {
          const lease = { released: false };
          leases.push(lease);
          return { release: () => (lease.released = true) };
        },
      });
      session.on((event) => events.push(event.type));
      const toGame = (g: (typeof games)["save"]) => ({
        files: Object.fromEntries(
          Object.entries(g.files).map(([name, bytes]) => [name, new Uint8Array(bytes)]),
        ),
        profile,
        sources: g.sources,
        sourceBindings: g.sourceBindings,
      });

      // --- Admission: attach, configure, pause all land before booted ---
      // A disabled breakpoint exercises the configure leg without firing.
      const run = await session.start(toGame(games.save), {
        breakpoints: [{ id: "bp", enabled: false, logic: 0, line: 1, mode: "statement" }],
      });
      const types = observed.map((m) => m.type);
      const bootedAt = types.indexOf("booted");
      const beforeBooted = types.slice(0, bootedAt);
      const admitted = {
        epoch: run.epoch,
        buildId: run.buildId,
        phase: run.phase,
        beforeBooted,
      };

      // --- Frozen: real timers run in the browser, yet nothing cycles ---
      await sleep(400);
      const frozenCount = (await session.evaluate("count")) as number;
      session.key(0x0d);
      session.input("look");
      session.click(5, 5);
      session.direction(1);
      await sleep(200);
      const stillFrozenCount = (await session.evaluate("count")) as number;

      // --- Continue releases real engine work; pause repins the stop ---
      await session.resume("continue");
      await sleep(300);
      await session.pause();
      const liveCount = (await session.evaluate("count")) as number;

      // --- Ephemeral save through the production selector flow ---
      await session.setValues({ flags: [[32, 1]] });
      await session.resume("continue");
      await until(() => run.waiting === "key", "save slot selector");
      session.key(0x0d); // pick the slot; the description prompt auto-answers
      await until(
        () => run.waiting === "key" && observed.some((m) => m.op === "saveDescription"),
        "save description answer",
      );
      session.key(0x0d); // confirm the description; the write lands
      await until(() => session.saves().length === 1, "save write");
      const slotsAfterSave = session.saves().length;

      // --- Same-build restart keeps the store and restores through it ---
      const epochAtBoot = run.epoch;
      const run2 = await session.restart();
      const slotsAfterRestart = session.saves().length;
      await session.setValues({ flags: [[33, 1]] });
      await session.resume("continue");
      await until(() => run2.waiting === "key", "restore slot selector");
      session.key(0x0d); // select the slot; the read restores the image
      await until(() => run2.epoch !== epochAtBoot, "post-restore epoch");
      await session.pause();
      const restoredCheckpoint = (await session.evaluate("checkpoint_value")) as number;

      // --- A different build owns an empty store ---
      await session.start(toGame(games.variant));
      const slotsAfterNewBuild = session.saves().length;

      // --- Generation pinned off: a missing room faults, never asks a host ---
      await session.start(toGame(games.missing));
      await session.resume("continue");
      await until(() => events.includes("error"), "missing-room engine fault");
      const roomRequests = observed.filter(
        (m) => m.type === "hostRequest" && m.op === "room",
      ).length;

      session.close();
      return {
        admitted,
        frozenCount,
        stillFrozenCount,
        liveCount,
        slotsAfterSave,
        slotsAfterRestart,
        slotsAfterNewBuild,
        restoredCheckpoint,
        epochChanged: run2.epoch !== epochAtBoot,
        roomRequests,
        errorEvents: events.filter((e) => e === "error").length,
        leasesReleased: leases.map((l) => l.released),
        sessions: leases.length,
      };
    },
    { games, profile: PROFILE },
  );

  // Admission ordering: the frozen policy's messages land in order before
  // booted (diagnostic traffic like debugAudio may interleave).
  const required = ["debugAttached", "debugConfigured", "debugStopped", "debugAck"];
  expect(observed.admitted.beforeBooted.filter((t) => required.includes(t))).toEqual(required);
  expect(observed.admitted.phase).toBe("stopped");
  expect(observed.admitted.epoch).toBeGreaterThan(0);
  expect(observed.admitted.buildId).toBe(games.save.buildId);

  // The frozen run does not cycle, and stopped input never reaches the engine.
  expect(observed.frozenCount).toBe(0);
  expect(observed.stillFrozenCount).toBe(0);
  expect(observed.liveCount).toBeGreaterThan(0);

  // The ephemeral store: written in one run, kept across a same-build
  // restart, emptied when a different build is admitted.
  expect(observed.slotsAfterSave).toBe(1);
  expect(observed.slotsAfterRestart).toBe(1);
  expect(observed.epochChanged).toBe(true);
  expect(observed.restoredCheckpoint).toBe(40);
  expect(observed.slotsAfterNewBuild).toBe(0);

  // Room generation is pinned off: the missing room is an engine fault,
  // and no `room` host request ever left a worker.
  expect(observed.roomRequests).toBe(0);
  expect(observed.errorEvents).toBeGreaterThan(0);

  // Every run's pause lease was released exactly once.
  expect(observed.leasesReleased.length).toBe(observed.sessions);
  expect(observed.leasesReleased.every(Boolean)).toBe(true);
});
