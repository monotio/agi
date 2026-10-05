import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { BUNDLE_GRAPH_PATH } from "../bundle-graph.config.ts";
import type { Route } from "@playwright/test";
import { expect, test } from "./test.ts";
import { isolateStorage, waitForRoom } from "./engineProbe.ts";
import { createContainer } from "../../src/container/container.ts";
import { compileProjectLogic } from "../../src/authoring/projectLogic.ts";
import { PROFILES, type ProfileId } from "../../src/runtime/profile.ts";

/**
 * The execution controller is a lazy worker feature: a normal Play boot
 * fetches the engine worker but never the debugger's module, and the first
 * isolated-Test boot pulls it through the dynamic import before its stopped
 * admission completes. Asserted on the wire, both ways — the exact requests
 * the browser made, and the worker's replies proving the entry stop latched
 * before any logic ran. The cancelled leg posts the same frozen boot to a
 * worker terminated mid-import: the held fetch proves the load was in
 * flight, nothing attaches, and the replacement worker admits a clean run.
 */

const PROFILE: ProfileId = "2.411";

/** Modules only the execution controller reaches — off the Play boot path. */
const DEBUGGER_MODULES = [
  /^app\/src\/worker\/(debugController|previewAdmission|projectAdmission)\.ts$/,
  /^src\/runtime\/(debugExpression|debugBreakpoints|debugStep|debugWatchpoints)\.ts$/,
];
/** Request paths carrying controller code — dev modules or the built chunk. */
const DEBUGGER_REQUEST =
  /debugController|debugExpression|debugBreakpoints|debugStep|debugWatchpoints|\/src\/worker\/(?:previewAdmission|projectAdmission)\.ts/;

const repository = join(import.meta.dirname, "..", "..");
const app = join(repository, "app");

/**
 * The source modules a requested script carries, relative to the repository
 * root — lazy-authoring.spec.ts's mapping, extended to look inside worker
 * bundles: their chunks (a lazily split controller among them) record under
 * `workers` in the same graph file.
 */
function modulesOf(url: URL): readonly string[] {
  const path = decodeURIComponent(url.pathname);
  if (path.startsWith("/assets/")) {
    const graph = JSON.parse(readFileSync(BUNDLE_GRAPH_PATH, "utf8")) as {
      chunks: { file: string; modules: string[] }[];
      workers?: Record<string, { file: string; modules: string[] }[]>;
    };
    const file = path.slice(1);
    const main = graph.chunks.find((chunk) => chunk.file === file);
    if (main !== undefined) return main.modules;
    for (const chunks of Object.values(graph.workers ?? {})) {
      const found = chunks.find((chunk) => chunk.file === file);
      if (found !== undefined) return found.modules;
    }
    return [];
  }
  if (path.startsWith("/@fs/")) return [relative(repository, path.slice("/@fs".length))];
  const prebundled = path.match(/^\/node_modules\/\.vite\/deps\/([^/]+)$/)?.[1];
  if (prebundled) {
    const { optimized } = JSON.parse(
      readFileSync(join(app, "node_modules", ".vite", "deps", "_metadata.json"), "utf8"),
    ) as { optimized: Record<string, { file: string }> };
    return Object.entries(optimized)
      .filter(([, entry]) => entry.file === prebundled)
      .map(([id]) => `app/node_modules/${id}/`);
  }
  return [`app${path}`];
}

/** A tiny run: set a counter, count, return — one breakpointable statement per line. */
function makeGame(): {
  files: Record<string, number[]>;
  sources: Record<string, string>;
  sourceBindings: Record<string, { kind: "variable"; num: number }>;
  bindings: Record<string, { kind: "variable"; num: number }>;
} {
  const source = "assignn(count, 1);\nincrement(count);\nreturn;";
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    compileProjectLogic(source, {
      profile: PROFILES[PROFILE],
      dictionary: new Map(),
      bindings: { count: { num: 41 } },
    }).assembly.payload,
  );
  return {
    files: Object.fromEntries(
      Object.entries(Object.fromEntries(container.files)).map(([name, bytes]) => [
        name,
        Array.from(bytes),
      ]),
    ),
    sources: { "0": source },
    sourceBindings: { count: { kind: "variable", num: 41 } },
    bindings: { count: { kind: "variable", num: 41 } },
  };
}

type Game = ReturnType<typeof makeGame>;

interface Outbound {
  type: string;
  id?: number;
  epoch?: number;
  stopId?: number;
  code?: string;
  ok?: boolean;
  value?: unknown;
  reasons?: { kind: string; id?: string }[];
  state?: { vars: number[] };
}

interface DriveResult {
  beforeBooted: string[];
  evalAtEntry: unknown;
  evalHeld: unknown;
  staleCode: string | null;
  breakReasons: { kind: string; id?: string }[];
  breakVars41: number;
  evalAtBreak: unknown;
}

/**
 * Drive one engine worker at the protocol level — the wire the session
 * layer sends: the frozen-test boot, stopped evaluations, a stale-epoch
 * refusal, then resume into the armed line-1 breakpoint's stop.
 */
async function runIsolatedTest(
  page: {
    evaluate: <T, A>(fn: (arg: A) => Promise<T>, arg: A) => Promise<T>;
  },
  workerUrl: string,
  game: Game,
): Promise<DriveResult> {
  interface Args {
    workerUrl: string;
    game: Game;
    profile: ProfileId;
    id: number;
  }
  return page.evaluate(
    async ({ workerUrl, game, profile, id }: Args) => {
      const w = new Worker(workerUrl, { type: "module" });
      const out: Outbound[] = [];
      const waiters = new Set<() => void>();
      w.onmessage = (event) => {
        out.push(event.data as Outbound);
        for (const check of waiters) check();
      };
      const until = async (
        predicate: (m: Outbound) => boolean,
        what: string,
      ): Promise<Outbound> => {
        // wall-clock: bounds a missing worker reply; success resolves on the matching event.
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            waiters.delete(check);
            reject(
              new Error(`timed out waiting for ${what}; worker replies: ${JSON.stringify(out)}`),
            );
          }, 10_000);
          const check = () => {
            const found = out.find(predicate);
            if (found === undefined) return;
            clearTimeout(timeout);
            waiters.delete(check);
            resolve(found);
          };
          waiters.add(check);
          check();
        });
      };
      try {
        w.postMessage({
          type: "boot",
          files: Object.fromEntries(
            Object.entries(game.files).map(([name, bytes]) => [name, new Uint8Array(bytes)]),
          ),
          words: [],
          profile,
          frozenTest: {
            id,
            sources: game.sources,
            sourceBindings: game.sourceBindings,
            bindings: game.bindings,
            breakpoints: [{ id: "b-entry", enabled: true, logic: 0, line: 1, mode: "statement" }],
          },
        });
        await until((m) => m.type === "booted", "frozen admission");
        const beforeBooted = out
          .slice(
            0,
            out.findIndex((m) => m.type === "booted"),
          )
          .map((m) => m.type);
        const attached = out.find((m) => m.type === "debugAttached")!;
        const entryStop = out.find((m) => m.type === "debugStopped")!;
        const epoch = attached.epoch!;
        const stopId = entryStop.stopId!;

        // The entry stop pins count at 0 — and stays pinned across real wall
        // time, since the latched stop holds the engine's cycles.
        w.postMessage({ type: "debugEvaluate", id: 1, epoch, stopId, expression: "count" });
        const evalAtEntry = await until(
          (m) => m.type === "debugEvaluation" && m.id === 1,
          "entry evaluation",
        );
        // wall-clock: the frozen worker owns real timers in a separate realm from page.clock.
        await new Promise((resolve) => setTimeout(resolve, 350));
        w.postMessage({ type: "debugEvaluate", id: 2, epoch, stopId, expression: "count" });
        const evalHeld = await until(
          (m) => m.type === "debugEvaluation" && m.id === 2,
          "held evaluation",
        );

        // An epoch that never existed is refused, never applied.
        w.postMessage({ type: "debugPause", id: 3, epoch: epoch + 99 });
        const stale = await until((m) => m.type === "debugError" && m.id === 3, "stale refusal");

        // Resume: the armed line-1 breakpoint stops before statement 1 — the
        // run executed no gameplay between release and the stop.
        w.postMessage({ type: "debugResume", id: 4, epoch, stopId, action: "continue" });
        const breakStop = await until(
          (m) => m.type === "debugStopped" && m.stopId !== stopId,
          "the armed breakpoint's stop",
        );
        w.postMessage({
          type: "debugEvaluate",
          id: 5,
          epoch,
          stopId: breakStop.stopId,
          expression: "count",
        });
        const evalAtBreak = await until(
          (m) => m.type === "debugEvaluation" && m.id === 5,
          "breakpoint evaluation",
        );

        return {
          beforeBooted,
          evalAtEntry: evalAtEntry.value,
          evalHeld: evalHeld.value,
          staleCode: stale.code ?? null,
          breakReasons: breakStop.reasons ?? [],
          breakVars41: breakStop.state?.vars[41] ?? -1,
          evalAtBreak: evalAtBreak.value,
        };
      } finally {
        w.terminate();
      }
    },
    { workerUrl, game, profile: PROFILE, id: 91 },
  );
}

test("the execution debugger loads on first use: Play never fetches it, an isolated Test boot does @webkit-desktop", async ({
  page,
  baseURL,
}) => {
  test.skip(
    process.env["AGI_DEPLOY_URL"] !== undefined,
    "A deployed site omits its chunk graph; the local production run and check:bundle cover the build.",
  );
  const origin = new URL(baseURL!).origin;
  await isolateStorage(page);
  const moduleURLs: URL[] = [];
  const pathnames: string[] = [];
  const offOrigin: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.protocol.startsWith("http")) return;
    if (url.origin !== origin || url.pathname.startsWith("/api/")) offOrigin.push(url.href);
    else {
      pathnames.push(decodeURIComponent(url.pathname));
      moduleURLs.push(url);
    }
  });
  // Vite publishes optimizer metadata during the initial requests; inspect
  // their module inventory after the worker's boot acknowledgement.
  const modules = () => moduleURLs.flatMap((url) => modulesOf(url));
  const debuggerRequests = () => pathnames.filter((path) => DEBUGGER_REQUEST.test(path));
  const debuggerModules = () =>
    modules().filter((module) => DEBUGGER_MODULES.some((pattern) => pattern.test(module)));

  // A cold Home → Play boot: the engine worker starts, the controller stays
  // on the server.
  await page.goto("/");
  await expect(page.getByTestId("catalog-adventure-department").getByRole("img")).toHaveAttribute(
    "src",
    /catalog\/adventure-department\.png$/,
  );
  await page.getByTestId("catalog-play-adventure-department").click();
  await waitForRoom(page, 1, { coldBoot: true });

  const engineWorkerPath = pathnames.find((path) => /engine\.worker/.test(path));
  expect(engineWorkerPath, "the engine worker booted Play").toBeDefined();
  expect(modules()).toContain("app/src/worker/engine.worker.ts");
  expect(debuggerRequests(), "no debugger request from Home to a cold Play").toEqual([]);
  expect(debuggerModules(), "no debugger module fetched from Home to a cold Play").toEqual([]);

  // The first actual debug use — an isolated-test boot at the real worker —
  // pulls the controller module.
  const game = makeGame();
  const workerUrl = new URL(engineWorkerPath!, origin).href;
  const result = await runIsolatedTest(page, workerUrl, game);
  expect(
    debuggerRequests().length,
    `the test boot fetched the controller on demand: ${debuggerRequests().join(", ")}`,
  ).toBeGreaterThan(0);
  expect(debuggerModules()).toContain("app/src/worker/debugController.ts");

  // The admission's own wire order: attach → configure → entry stop → ack →
  // booted (diagnostic traffic may interleave).
  const required = ["debugAttached", "debugConfigured", "debugStopped", "debugAck"];
  expect(result.beforeBooted.filter((type) => required.includes(type))).toEqual(required);
  expect(result.evalAtEntry).toBe(0);
  expect(result.evalHeld).toBe(0);
  expect(result.staleCode).toBe("staleEpoch");
  // The armed line-1 breakpoint published the run's first real stop with the
  // counter still 0: no gameplay ran before the debugger's first boundary.
  expect(result.breakReasons.some((reason) => reason.kind === "breakpoint")).toBe(true);
  expect(result.breakVars41).toBe(0);
  expect(result.evalAtBreak).toBe(0);

  // A cancelled load leaves nothing: where the fetch can be held the
  // terminated worker's late import attaches nowhere; either way the
  // replacement worker admits a clean new run.
  const heldRoutes: Route[] = [];
  const heldUrls: string[] = [];
  let importHeld!: () => void;
  const held = new Promise<void>((resolve) => {
    importHeld = resolve;
  });
  await page.exposeFunction("waitForDebuggerImport", () => held);
  await page.route("**/*debugController*", async (route) => {
    heldRoutes.push(route);
    heldUrls.push(route.request().url());
    importHeld();
    // Held deliberately — released after the worker dies.
  });
  const cancelledAttached = await page.evaluate(
    async ({
      workerUrl,
      game,
      profile,
      id,
    }: {
      workerUrl: string;
      game: Game;
      profile: ProfileId;
      id: number;
    }) => {
      const w = new Worker(workerUrl, { type: "module" });
      const out: { type: string }[] = [];
      w.onmessage = (event) => out.push(event.data as { type: string });
      w.postMessage({
        type: "boot",
        files: Object.fromEntries(
          Object.entries(game.files).map(([name, bytes]) => [name, new Uint8Array(bytes)]),
        ),
        words: [],
        profile,
        frozenTest: {
          id,
          sources: game.sources,
          sourceBindings: game.sourceBindings,
          bindings: game.bindings,
        },
      });
      // Terminate after the actual import request is held in flight.
      await (
        window as unknown as { waitForDebuggerImport(): Promise<void> }
      ).waitForDebuggerImport();
      const attached = out.some((m) => m.type === "debugAttached");
      w.terminate();
      return attached;
    },
    { workerUrl, game, profile: PROFILE, id: 92 },
  );
  const heldCount = heldRoutes.length;
  for (const route of heldRoutes.splice(0)) await route.continue().catch(() => {});
  await page.unroute("**/*debugController*");
  // The held request proves the import was in flight at terminate —
  // a late fulfillment must attach nowhere.
  expect(heldCount, "the cancelled load's fetch was held in flight").toBeGreaterThan(0);
  expect(
    cancelledAttached,
    `a worker terminated mid-import completed no attach (held ${heldUrls.join(", ")})`,
  ).toBe(false);
  const recovery = await runIsolatedTest(page, workerUrl, game);
  expect(recovery.beforeBooted).toContain("debugAttached");
  expect(recovery.evalAtEntry).toBe(0);

  expect(offOrigin, "provider or cross-origin requests").toEqual([]);
});
