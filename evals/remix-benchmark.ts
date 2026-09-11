#!/usr/bin/env node
/**
 * Remix/Ask benchmark lane.
 *
 * Drives the production AgentSession and provider adapters against a real
 * engine paused at a live checkpoint, so measured requests are exactly what
 * the app sends. Loads a game directory — or restores a frozen cycle from a
 * host image — runs the named cases, and reports cost, latency, cache
 * behavior and acceptance per run.
 *
 *   node --experimental-strip-types scripts/eval-remix.ts \
 *     --game games/gr --case keys-help,recolor --provider openai --model gpt-6-astra \
 *     [--checkpoint autosave.bin] [--warm] [--repeats 3] [--out evals/results/remix]
 *
 * --warm runs the keyboard-help Ask first inside the same session so Remix
 * cases measure warm-prefix behavior; cold runs start a fresh session per
 * case. Live provider runs are billed to the key's account; --provider stub
 * exercises the whole harness offline.
 */

import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseWordsTok } from "../src/logic/words.ts";
import { Simulation } from "../src/agent/playtest.ts";
import { AgentSession } from "../app/src/agent/agentSession.ts";
import { MODEL_CAPABILITIES } from "../src/agent/modelEffort.ts";
import type { AgentFrame } from "../src/agent/frames.ts";
import type { LlmConfig, LlmUsage } from "../app/src/agent/llmClient.ts";

interface BenchmarkCase {
  id: string;
  mode: "ask" | "remix";
  instruction: string;
}

/**
 * The release-gate case list. Instructions stay deliberately generic so any
 * installed game can run them; the frozen Gold Rush room-8 checkpoint is the
 * reference fixture for release measurements.
 */
const CASES: Record<string, BenchmarkCase> = {
  "keys-help": {
    id: "keys-help",
    mode: "ask",
    instruction: "What keys do I press to play this game?",
  },
  recolor: {
    id: "recolor",
    mode: "remix",
    instruction: "Recolor the main character's outfit to bright red.",
  },
  multicel: {
    id: "multicel",
    mode: "remix",
    instruction:
      "Pick the animated prop in this room and redraw its animation cels so it visibly changes.",
  },
  collision: {
    id: "collision",
    mode: "remix",
    instruction:
      "Change the room picture so a decorative object now blocks walking, matching its priority.",
  },
  persistence: {
    id: "persistence",
    mode: "remix",
    instruction:
      "Add a small persistent object: a keepsake the player can pick up here and still carry after leaving and re-entering the room.",
  },
};

interface Args {
  game: string;
  checkpoint?: string;
  cases: string[];
  provider: string;
  model?: string;
  effort?: LlmConfig["effort"];
  warm: boolean;
  repeats: number;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    game: "",
    cases: [],
    provider: "stub",
    warm: false,
    repeats: 1,
    out: "evals/results/remix",
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]!;
    if (key === "--warm") {
      args.warm = true;
      continue;
    }
    const value = argv[++i];
    if (key === "--game") args.game = value!;
    else if (key === "--checkpoint") args.checkpoint = value!;
    else if (key === "--case") args.cases = value!.split(",");
    else if (key === "--provider") args.provider = value!;
    else if (key === "--model") args.model = value!;
    else if (key === "--effort") args.effort = value as LlmConfig["effort"];
    else if (key === "--repeats") args.repeats = Number(value);
    else if (key === "--out") args.out = value!;
    else throw new Error(`Unknown option ${key}`);
  }
  if (!args.game) throw new Error("--game <dir> is required (a directory of AGI game files).");
  if (!Number.isInteger(args.repeats) || args.repeats < 1 || args.repeats > 5)
    throw new Error("--repeats must be an integer from 1 to 5.");
  if (args.cases.length === 0 || args.cases.includes("all")) args.cases = Object.keys(CASES);
  for (const id of args.cases)
    if (!CASES[id]) throw new Error(`Unknown case ${id}; known: ${Object.keys(CASES).join(", ")}.`);
  return args;
}

function loadGame(dir: string): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (const entry of readdirSync(dir, { withFileTypes: true }))
    if (entry.isFile()) files.set(entry.name.toUpperCase(), readFileSync(join(dir, entry.name)));
  return files;
}

function configFor(args: Args): LlmConfig {
  const provider = args.provider as LlmConfig["provider"];
  const apiKey =
    provider === "openai"
      ? (process.env["OPENAI_API_KEY"] ?? "")
      : provider === "anthropic"
        ? (process.env["ANTHROPIC_API_KEY"] ?? "")
        : "";
  return {
    provider,
    apiKey,
    model: args.model ?? (provider === "anthropic" ? "claude-fable-5" : "gpt-6-astra"),
    ...(args.effort !== undefined ? { effort: args.effort } : {}),
  };
}

/** Cost in USD for cumulative usage; the same formula as AgentRun.recordUsage. */
function costUsd(
  model: string,
  usage: { input: number; cachedInput: number; cacheWriteInput: number; output: number },
): number | null {
  const rate = MODEL_CAPABILITIES[model]?.price;
  if (!rate) return null;
  const long = rate.longContext && usage.input > 272000;
  const input = rate.input * (long ? 2 : 1);
  const cacheRead = (rate.cacheRead ?? rate.input * 0.1) * (long ? 2 : 1);
  const output = rate.output * (long ? 1.5 : 1);
  const reads = Math.min(usage.input, usage.cachedInput);
  const writes = Math.min(usage.input - reads, usage.cacheWriteInput);
  return (
    ((usage.input - reads - writes) * input + reads * cacheRead + writes * input * 1.25) / 1e6 +
    (usage.output * output) / 1e6
  );
}

interface RunReport {
  case: string;
  repeat: number;
  warm: boolean;
  ok: boolean;
  error?: string;
  wallMs: number;
  requests: number;
  telemetry: unknown[];
  usage?: LlmUsage;
  costUsd?: number | null;
  patched?: string[];
  text?: string;
}

/**
 * One case on a fresh session and engine. The engine boots (or restores the
 * frozen checkpoint) to the interactive pause the app offers, then serves the
 * session's runtime deps — the same FrameSource/EngineStateSource/checkpoint
 * contract the worker provides.
 */
async function runCase(
  bench: BenchmarkCase,
  files: Map<string, Uint8Array>,
  args: Args,
  repeat: number,
): Promise<RunReport> {
  const telemetry: unknown[] = [];
  let usage: LlmUsage | undefined;
  // Per-run byte copies: openContainer copies again, but the session also
  // keeps raw refs to WORDS.TOK/OBJECT/TESTS.JSON as payload fields — hand
  // each run its own buffers so a payload mutation can never reach the master.
  const runFiles = new Map([...files].map(([name, bytes]) => [name, new Uint8Array(bytes)]));
  const session = AgentSession.fromAuthoredData(
    configFor(args),
    (kind, _message, data) => {
      const details = data as Record<string, unknown> | undefined;
      if (kind === "telemetry") telemetry.push(details?.["telemetry"]);
      const total = details?.["totalUsage"] as LlmUsage | undefined;
      if (total) usage = total;
    },
    Object.fromEntries(runFiles),
    [...parseWordsTok(files.get("WORDS.TOK") ?? new Uint8Array())].map(
      ({ word, id }) => [word, id] as [string, number],
    ),
  );

  const t0 = performance.now();
  try {
    const sim = new Simulation(session.state, 1200, 50000, { pressKeys: true });
    const engine = sim.engine;
    if (args.checkpoint) {
      engine.restoreImage(readFileSync(args.checkpoint));
    } else {
      let dismissed = 0;
      for (let i = 0; i < 1200; i++) {
        sim.tick();
        const s = engine.readState();
        if (s.pictureShown && s.inputEnabled) break;
        if (engine.modalKind) {
          engine.ackPrint();
          if (++dismissed > 16) break;
        }
      }
    }

    session.setRuntime({
      frames: {
        read: () => {
          const raw = engine.getFrame();
          const frame: AgentFrame = {
            visual: raw.visual.slice(),
            priority: raw.priority.slice(),
            cycle: sim.cycles,
            picRow: engine.displayBase,
            text: engine.textCells.slice(),
          };
          return [frame];
        },
      },
      engine: { state: () => engine.readState(), objects: () => engine.readObjects() },
      checkpoint: () => engine.autosaveImage(),
    });
    session.setOrientation({ game: basename(args.game), profile: engine.profile.id });

    const room = engine.vars[0] ?? 1;
    // --warm: an Ask turn first so the Remix request measures warm prefixes.
    if (args.warm && bench.mode === "remix")
      await session.runAsk(CASES["keys-help"]!.instruction, room);
    const result =
      bench.mode === "ask"
        ? await session.runAsk(bench.instruction, room)
        : await session.runPowerUp(bench.instruction, room);
    const wallMs = performance.now() - t0;
    const patched =
      typeof result === "string" ? [] : result.patched.map((p) => `${p.kind} ${p.num}`);
    const fileWrites =
      typeof result === "string" ? [] : Object.keys(result.files ?? {});
    // A remix that changes nothing did not do the work — flag it rather than
    // letting "no exception" read as acceptance.
    const changed = patched.length + fileWrites.length;
    const accepted = bench.mode === "ask" || changed > 0;
    return {
      case: bench.id,
      repeat,
      warm: args.warm,
      ok: accepted,
      ...(accepted
        ? {}
        : { error: "Remix finished without patching any resource or file." }),
      wallMs,
      requests: telemetry.length,
      telemetry,
      ...(usage !== undefined ? { usage } : {}),
      costUsd: usage ? costUsd(configFor(args).model, usage) : null,
      patched,
      text: (typeof result === "string" ? result : result.text).slice(0, 400),
    };
  } catch (error) {
    return {
      case: bench.id,
      repeat,
      warm: args.warm,
      ok: false,
      error: String(error),
      wallMs: performance.now() - t0,
      requests: telemetry.length,
      telemetry,
      ...(usage !== undefined ? { usage } : {}),
      costUsd: usage ? costUsd(configFor(args).model, usage) : null,
    };
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const files = loadGame(args.game);
  if (!files.has("WORDS.TOK") || !files.has("OBJECT"))
    console.warn("warning: game directory has no WORDS.TOK/OBJECT; reads may be empty.");
  const reports: RunReport[] = [];
  for (const id of args.cases) {
    for (let r = 0; r < args.repeats; r++) {
      const report = await runCase(CASES[id]!, files, args, r + 1);
      reports.push(report);
      console.log(
        `${report.ok ? "ok" : "FAIL"} ${report.case} r${report.repeat}${report.warm ? " warm" : ""}: ` +
          `${report.requests} req, ${(report.wallMs / 1000).toFixed(1)}s, ` +
          `${report.costUsd == null ? "cost n/a" : `$${report.costUsd.toFixed(4)}`}` +
          (report.error ? ` — ${report.error}` : ""),
      );
    }
  }
  const dir = join(args.out, new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const summary = {
    game: basename(args.game),
    provider: args.provider,
    model: configFor(args).model,
    warm: args.warm,
    runs: reports,
    totals: {
      runs: reports.length,
      ok: reports.filter((r) => r.ok).length,
      requests: reports.reduce((n, r) => n + r.requests, 0),
      costUsd: reports.every((r) => r.costUsd != null)
        ? reports.reduce((n, r) => n + (r.costUsd ?? 0), 0)
        : null,
    },
  };
  const path = join(dir, "report.json");
  writeFileSync(path, JSON.stringify(summary, null, 2) + "\n");
  console.log(`Report: ${path}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
