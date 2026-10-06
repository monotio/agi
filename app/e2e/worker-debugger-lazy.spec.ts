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
 * `debug*` command — the attach the workspace debugger sends — pulls it
 * through the dynamic import. Asserted on the wire, both ways — the exact
 * requests the browser made, and the worker's replies proving the armed
 * breakpoint stops the running game with its state pinned. The cancelled
 * leg attaches a worker terminated mid-import: the held fetch proves the
 * load was in flight, nothing attaches, and the replacement worker admits a
 * clean session.
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
  order: string[];
  evalAtBreak: unknown;
  evalHeld: unknown;
  staleCode: string | null;
  breakReasons: { kind: string; id?: string }[];
  breakVars41: number;
}

/**
 * Drive one engine worker at the protocol level — the wire the workspace
 * debugger sends: a plain boot, then attach, configure the line-1
 * breakpoint and let the running game stop on it. The pinned stop holds its
 * state across real wall time, a stale epoch is refused, and the stop's own
 * report matches what the evaluator reads.
 */
async function driveDebugger(
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
  }
  return page.evaluate(
    async ({ workerUrl, game, profile }: Args) => {
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
        });
        await until((m) => m.type === "booted", "plain boot");

        w.postMessage({
          type: "debugAttach",
          id: 1,
          sources: game.sources,
          sourceBindings: game.sourceBindings,
          bindings: game.bindings,
        });
        const attached = await until((m) => m.type === "debugAttached", "attach");
        const epoch = attached.epoch!;

        w.postMessage({
          type: "debugConfigure",
          id: 2,
          epoch,
          revision: 1,
          breakpoints: [{ id: "b-entry", enabled: true, logic: 0, line: 1, mode: "statement" }],
        });
        await until((m) => m.type === "debugConfigured", "configure");

        // The running game reaches the armed line-1 breakpoint on its own.
        const breakStop = await until(
          (m) => m.type === "debugStopped",
          "the armed breakpoint's stop",
        );
        w.postMessage({
          type: "debugEvaluate",
          id: 3,
          epoch,
          stopId: breakStop.stopId,
          expression: "count",
        });
        const evalAtBreak = await until(
          (m) => m.type === "debugEvaluation" && m.id === 3,
          "breakpoint evaluation",
        );
        // wall-clock: the worker owns real timers in a separate realm from page.clock.
        await new Promise((resolve) => setTimeout(resolve, 350));
        w.postMessage({
          type: "debugEvaluate",
          id: 4,
          epoch,
          stopId: breakStop.stopId,
          expression: "count",
        });
        const evalHeld = await until(
          (m) => m.type === "debugEvaluation" && m.id === 4,
          "held evaluation",
        );

        // An epoch that never existed is refused, never applied.
        w.postMessage({ type: "debugPause", id: 5, epoch: epoch + 99 });
        const stale = await until((m) => m.type === "debugError" && m.id === 5, "stale refusal");

        return {
          order: out.map((m) => m.type),
          evalAtBreak: evalAtBreak.value,
          evalHeld: evalHeld.value,
          staleCode: stale.code ?? null,
          breakReasons: breakStop.reasons ?? [],
          breakVars41: breakStop.state?.vars[41] ?? -1,
        };
      } finally {
        w.terminate();
      }
    },
    { workerUrl, game, profile: PROFILE },
  );
}

test("the execution debugger loads on first use: Play never fetches it, an attach does @webkit-desktop", async ({
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

  // The first actual debug use — an attach at the real worker, the wire the
  // workspace debugger sends — pulls the controller module.
  const game = makeGame();
  const workerUrl = new URL(engineWorkerPath!, origin).href;
  const result = await driveDebugger(page, workerUrl, game);
  expect(
    debuggerRequests().length,
    `the attach fetched the controller on demand: ${debuggerRequests().join(", ")}`,
  ).toBeGreaterThan(0);
  expect(debuggerModules()).toContain("app/src/worker/debugController.ts");

  // The session's own wire order: attach → configure → the armed stop.
  const session = result.order.filter((type) =>
    ["debugAttached", "debugConfigured", "debugStopped"].includes(type),
  );
  expect(session).toEqual(["debugAttached", "debugConfigured", "debugStopped"]);
  expect(result.breakReasons.some((reason) => reason.kind === "breakpoint")).toBe(true);
  // The pinned stop holds across real wall time: both evaluations read the
  // stop's own reported counter.
  expect(result.evalAtBreak).toBe(result.breakVars41);
  expect(result.evalHeld).toBe(result.evalAtBreak);
  expect(result.staleCode).toBe("staleEpoch");

  // A cancelled load leaves nothing: where the fetch can be held the
  // terminated worker's late import attaches nowhere; either way the
  // replacement worker admits a clean new session.
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
    async ({ workerUrl, game, profile }: { workerUrl: string; game: Game; profile: ProfileId }) => {
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
      });
      w.postMessage({
        type: "debugAttach",
        id: 1,
        sources: game.sources,
        sourceBindings: game.sourceBindings,
        bindings: game.bindings,
      });
      // Terminate after the actual import request is held in flight.
      await (
        window as unknown as { waitForDebuggerImport(): Promise<void> }
      ).waitForDebuggerImport();
      const attached = out.some((m) => m.type === "debugAttached");
      w.terminate();
      return attached;
    },
    { workerUrl, game, profile: PROFILE },
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
  const recovery = await driveDebugger(page, workerUrl, game);
  expect(recovery.order).toContain("debugAttached");

  expect(offOrigin, "provider or cross-origin requests").toEqual([]);
});
