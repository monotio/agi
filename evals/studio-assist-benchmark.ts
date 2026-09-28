#!/usr/bin/env node
/**
 * Studio assist benchmark: the creator's selection in Room Studio or Sprite
 * Studio, one instruction, and a real provider driving read_edit_context and
 * propose_edit through the production AgentSession on the Adventure
 * Department tutorial. Records per run whether a candidate passed its scope
 * (`ok`), how many proposals were refused, rounds, tokens and cost.
 *
 *   npm run eval:studio -- --provider anthropic --model claude-opus-5-5 \
 *     --budget-usd 2 [--case all|plate-horizon,rope-walkable,ledger-depth,robot-eyes] \
 *     [--effort medium] [--repeats 1] [--out evals/results/studio-assist]
 *   npm run eval:studio -- --dry-run      # the deterministic stub, no key, no spend
 *
 * Keys come from ANTHROPIC_API_KEY / OPENAI_API_KEY. A live run refuses to
 * start without --budget-usd, or for a model without a price in
 * MODEL_CAPABILITIES, since spend could not be enforced. The cap covers the
 * whole invocation: each run's session gets the remaining allowance as its
 * task budget, so AgentRun stops before any request the allowance cannot
 * cover and caps each request's output tokens by it; a run that pauses on
 * the budget is cancelled and recorded. Provider usage is priced per request
 * after each run and subtracted; once the cap is spent the remaining runs are
 * skipped. A request's input is priced only after it returns, so a run can
 * overshoot by at most one request's input; the report states any overshoot.
 *
 * Cases (the tutorial's own resources):
 *   plate-horizon   lab lever plate, Walk lens. The plate is on the back wall
 *                   above the room's horizon (y 112), so no control-line
 *                   change can make it walkable: the case passes when the
 *                   model proposes nothing and says the horizon is why.
 *   rope-walkable   gallery rope barrier, Walk lens: walkable cells must rise.
 *   ledger-depth    archive ledger stand, Depth lens: the stand's own cells
 *                   must gain a depth value (5..15).
 *   robot-eyes      robot view 2, loop 1 (the mirrored, left-facing loop):
 *                   its eye pixels must turn blue; loop 0 must not change.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentSession } from "../app/src/agent/agentSession.ts";
import type { StudioAssistResult } from "../app/src/agent/studioAssist.ts";
import type { LlmConfig, LlmUsage } from "../app/src/agent/llmClient.ts";
import { buildTutorial, TUTORIAL_PICTURE_SOURCES } from "../games/adventure-department/game.ts";
import { DEFAULT_MODELS, MODEL_CAPABILITIES } from "../src/agent/modelEffort.ts";
import type { StudioFocus } from "../src/agent/studioAssistTools.ts";
import { pictureAssistScope, viewAssistScope } from "../src/studio/assistScope.ts";
import {
  compileEditDocument,
  footprintMask,
  type CompiledDocument,
} from "../src/studio/editValidation.ts";
import { parsePictureDocument } from "../src/studio/pictureDocument.ts";
import { openSprite } from "../src/view/spriteDocument.ts";
import { walkableMask } from "../src/runtime/walkable.ts";
import type { AgiProfile } from "../src/runtime/profile.ts";
import { parseView } from "../src/view/view.ts";
import { requestCost } from "./lib/usage.ts";

/** The tutorial rooms' horizon (set.horizon(112) in every room logic). */
const HORIZON = 112;
/** Below this remaining allowance no further run starts. */
const MIN_RUN_USD = 0.01;

type Session = ReturnType<typeof AgentSession.fromAuthoredData>;

interface StudioCase {
  readonly id: string;
  readonly instruction: string;
  readonly focus: (session: Session) => StudioFocus;
  /** The semantic check on a candidate that passed its scope. */
  readonly verify: (session: Session, result: StudioAssistResult) => string | null;
  /** The right answer is to propose nothing and explain why. */
  readonly declines?: true;
}

function pictureFocus(
  session: Session,
  num: number,
  targetIds: string[],
  lens: "walk" | "depth",
): StudioFocus {
  const source = TUTORIAL_PICTURE_SOURCES[num]!;
  const compiled = compileEditDocument(
    parsePictureDocument(source).document,
    session.state.profile,
  );
  return {
    scope: pictureAssistScope({ num, compiled, targetIds, lens }),
    draft: () => ({ kind: "picture", source }),
    lens,
    room: num,
    horizon: HORIZON,
  };
}

function candidatePicture(
  result: StudioAssistResult,
  profile: AgiProfile,
): CompiledDocument | null {
  const candidate = result.candidate;
  if (candidate?.kind !== "picture") return null;
  return compileEditDocument(parsePictureDocument(candidate.draft.source).document, profile);
}

/** Walkable baseline cells for the tutorial ego inside `area`. */
function walkableIn(session: Session, priority: Uint8Array, area: Uint8Array): number {
  const ego = parseView(session.state.container.getResource("view", 0)!, session.state.profile)
    .loops[0]!.cels[0]!;
  const mask = walkableMask({
    priority,
    egoWidth: ego.width,
    egoHeight: ego.height,
    observeBlocks: true,
    waterGate: null,
    horizon: HORIZON,
  });
  let cells = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] === 1 && area[i] === 1) cells++;
  return cells;
}

function walkableCase(id: string, num: number, target: string, instruction: string): StudioCase {
  return {
    id,
    instruction,
    focus: (session) => pictureFocus(session, num, [target], "walk"),
    verify(session, result) {
      const profile = session.state.profile;
      const before = compileEditDocument(
        parsePictureDocument(TUTORIAL_PICTURE_SOURCES[num]!).document,
        profile,
      );
      const after = candidatePicture(result, profile);
      if (!after) return "no candidate";
      const area = footprintMask(before, target, "both");
      const was = walkableIn(session, before.priority, area);
      const now = walkableIn(session, after.priority, area);
      return now > was ? null : `walkable cells in the selection ${was} -> ${now}`;
    },
  };
}

const CASES: Record<string, StudioCase> = {
  "plate-horizon": {
    id: "plate-horizon",
    instruction: "Make the lever plate walkable without changing the art.",
    declines: true,
    focus: (session) => pictureFocus(session, 2, ["wake-plate"], "walk"),
    verify(_session, result) {
      if (result.candidate) return "proposed a change that cannot make the plate walkable";
      return /horizon/i.test(result.text) ? null : "declined without naming the horizon";
    },
  },
  "rope-walkable": walkableCase(
    "rope-walkable",
    1,
    "rope-barrier",
    "Let the player walk through the rope barrier without changing the art.",
  ),
  "ledger-depth": {
    id: "ledger-depth",
    instruction:
      "Give the ledger stand its own depth so the apprentice can walk behind it, without changing the art.",
    focus: (session) => pictureFocus(session, 3, ["ledger-stand"], "depth"),
    verify(session, result) {
      const profile = session.state.profile;
      const before = compileEditDocument(
        parsePictureDocument(TUTORIAL_PICTURE_SOURCES[3]!).document,
        profile,
      );
      const after = candidatePicture(result, profile);
      if (!after) return "no candidate";
      const area = footprintMask(before, "ledger-stand", "visual");
      let gained = 0;
      for (let i = 0; i < area.length; i++)
        if (area[i] === 1 && after.priority[i]! >= 5 && before.priority[i]! < 5) gained++;
      return gained > 0 ? null : "no cell of the stand gained a depth value 5..15";
    },
  },
  "robot-eyes": {
    id: "robot-eyes",
    instruction: "Make the robot's eyes blue on the left-facing loop.",
    focus(session) {
      const document = openSprite(
        session.state.container.getResource("view", 2)!,
        session.state.profile,
      );
      return {
        scope: viewAssistScope({
          num: 2,
          document,
          targetCels: document.loops[1]!.cels.map((_, cel) => ({ loop: 1, cel })),
        }),
        draft: () => ({ kind: "view", payload: document.payload }),
      };
    },
    verify(_session, result) {
      const candidate = result.candidate;
      if (candidate?.kind !== "view") return "no candidate";
      const view = parseView(candidate.draft.payload);
      // The eyes sit at row 7, x 8..9 of the right-facing cels, so x 4..5
      // where loop 1 shows them mirrored (14 wide).
      for (const [index, cel] of view.loops[1]!.cels.entries())
        for (const x of [4, 5]) {
          const colour = cel.pixels[7 * cel.width + x];
          if (colour !== 1 && colour !== 9)
            return `loop 1 cel ${index} eye pixel x ${x} is ${colour}`;
        }
      return null;
    },
  },
};

interface Args {
  cases: string[];
  provider: LlmConfig["provider"];
  model?: string;
  effort?: LlmConfig["effort"];
  budgetUsd?: number;
  repeats: number;
  dryRun: boolean;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    cases: [],
    provider: "stub",
    repeats: 1,
    dryRun: false,
    out: "evals/results/studio-assist",
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]!;
    if (key === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) throw new Error(`${key} needs a value.`);
    if (key === "--case") args.cases = value.split(",");
    else if (key === "--provider") args.provider = value as LlmConfig["provider"];
    else if (key === "--model") args.model = value;
    else if (key === "--effort") args.effort = value as LlmConfig["effort"];
    else if (key === "--budget-usd") args.budgetUsd = Number(value);
    else if (key === "--repeats") args.repeats = Number(value);
    else if (key === "--out") args.out = value;
    else throw new Error(`Unknown option ${key}`);
  }
  if (args.dryRun) args.provider = "stub";
  if (args.cases.length === 0 || args.cases.includes("all")) args.cases = Object.keys(CASES);
  for (const id of args.cases)
    if (!CASES[id]) throw new Error(`Unknown case ${id}; known: ${Object.keys(CASES).join(", ")}.`);
  if (!Number.isInteger(args.repeats) || args.repeats < 1 || args.repeats > 5)
    throw new Error("--repeats must be an integer from 1 to 5.");
  if (args.provider !== "stub") {
    if (args.budgetUsd === undefined || !Number.isFinite(args.budgetUsd) || args.budgetUsd <= 0)
      throw new Error(
        "A live provider run needs --budget-usd <cap in USD>; it is enforced from provider usage. Use --dry-run for the offline stub.",
      );
    const model = args.model ?? DEFAULT_MODELS[args.provider];
    if (!MODEL_CAPABILITIES[model]?.price)
      throw new Error(`No price is known for ${model}, so --budget-usd could not be enforced.`);
  }
  return args;
}

function configFor(args: Args, budgetUsd: number): LlmConfig {
  const apiKey =
    args.provider === "openai"
      ? (process.env["OPENAI_API_KEY"] ?? "")
      : args.provider === "anthropic"
        ? (process.env["ANTHROPIC_API_KEY"] ?? "")
        : "";
  if (args.provider !== "stub" && !apiKey)
    throw new Error(
      `Set ${args.provider === "openai" ? "OPENAI" : "ANTHROPIC"}_API_KEY for a live run.`,
    );
  return {
    provider: args.provider,
    apiKey,
    model: args.model ?? DEFAULT_MODELS[args.provider],
    budgetUsd,
    ...(args.effort !== undefined ? { effort: args.effort } : {}),
  };
}

interface RunReport {
  case: string;
  repeat: number;
  /** A candidate passed its scope. */
  ok: boolean;
  /** The case's semantic check on that candidate; null when it passed. */
  verified: string | null;
  refused: number;
  proposals: number;
  /** Provider requests. */
  rounds: number;
  usage: LlmUsage | null;
  costUsd: number;
  usageIncomplete: boolean;
  text: string;
  error?: string;
  wallMs: number;
}

async function runCase(
  bench: StudioCase,
  args: Args,
  repeat: number,
  allowance: number,
  dir: string,
): Promise<RunReport> {
  const tutorial = buildTutorial();
  const telemetry: { usage?: LlmUsage; usageIncomplete?: boolean }[] = [];
  let usage: LlmUsage | null = null;
  const config = configFor(args, allowance);
  const session = AgentSession.fromAuthoredData(
    config,
    (kind, _message, data) => {
      const details = data as Record<string, unknown> | undefined;
      if (kind === "telemetry") telemetry.push(details?.["telemetry"] as (typeof telemetry)[0]);
      const total = details?.["totalUsage"] as LlmUsage | undefined;
      if (total) usage = total;
    },
    tutorial.files,
    tutorial.words,
    [],
    undefined,
    tutorial.project!.authoringState,
  );
  // A paused task (budget, repetition) waits for a creator who is not
  // there; cancel it and record why.
  let paused = "";
  const monitor = setInterval(() => {
    const task = session.task.snapshot();
    if (task.status !== "paused") return;
    paused = task.reason;
    session.task.cancel();
  }, 20);
  const t0 = performance.now();
  let result: StudioAssistResult | null = null;
  let error: string | undefined;
  try {
    result = await session.runStudioAssist({
      instruction: bench.instruction,
      focus: bench.focus(session),
    });
  } catch (caught) {
    error = paused ? `paused: ${paused}` : String(caught);
  } finally {
    clearInterval(monitor);
  }
  const costs = telemetry.map((t) => (t.usage ? requestCost(config.model, t.usage) : 0));
  const priced = costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0);
  const costUsd = Math.max(priced, session.task.snapshot().spent);
  const usageIncomplete =
    session.task.snapshot().usageIncomplete || telemetry.some((t) => t.usageIncomplete === true);
  if (result?.candidate)
    writeFileSync(join(dir, `${bench.id}-r${repeat}.png`), result.candidate.previewPng);
  writeFileSync(
    join(dir, `${bench.id}-r${repeat}.transcript.json`),
    JSON.stringify(session.getTranscript(), (_key, value: unknown) =>
      typeof value === "string" && value.length > 2000 ? `[${value.length} chars]` : value,
    ),
  );
  return {
    case: bench.id,
    repeat,
    ok: bench.declines
      ? result !== null && !result.candidate
      : result?.candidate?.check.ok === true,
    verified: result ? bench.verify(session, result) : "no result",
    refused: result?.refusals ?? 0,
    proposals: result?.proposals ?? 0,
    rounds: telemetry.length,
    usage,
    costUsd,
    usageIncomplete,
    text: (result?.text ?? "").slice(0, 400),
    ...(error ? { error } : {}),
    wallMs: performance.now() - t0,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cap = args.dryRun || args.provider === "stub" ? Infinity : args.budgetUsd!;
  const model = args.model ?? DEFAULT_MODELS[args.provider];
  const dir = join(
    args.out,
    `${new Date().toISOString().replace(/[:.]/g, "-")}-${args.dryRun ? "dry-run" : `${args.provider}-${model}`}`,
  );
  mkdirSync(dir, { recursive: true });
  const runs: RunReport[] = [];
  const skipped: { case: string; repeat: number; reason: string }[] = [];
  let spent = 0;
  for (const id of args.cases)
    for (let repeat = 1; repeat <= args.repeats; repeat++) {
      const remaining = cap - spent;
      if (remaining < MIN_RUN_USD) {
        skipped.push({
          case: id,
          repeat,
          reason: `budget spent ($${spent.toFixed(4)} of $${cap})`,
        });
        continue;
      }
      const report = await runCase(
        CASES[id]!,
        args,
        repeat,
        Number.isFinite(remaining) ? remaining : 1000,
        dir,
      );
      spent += report.costUsd;
      runs.push(report);
      console.log(
        `${report.ok ? "ok" : CASES[id]!.declines ? "proposed" : "no candidate"}${report.ok && report.verified === null ? ", verified" : report.verified ? ` (${report.verified})` : ""} ${id} r${repeat}: ` +
          `${report.proposals} proposals, ${report.refused} refused, ${report.rounds} requests, $${report.costUsd.toFixed(4)}` +
          (report.error ? ` — ${report.error}` : ""),
      );
    }
  const summary = {
    provider: args.provider,
    model,
    dryRun: args.dryRun,
    budgetUsd: Number.isFinite(cap) ? cap : null,
    runs,
    skipped,
    totals: {
      runs: runs.length,
      ok: runs.filter((r) => r.ok).length,
      verified: runs.filter((r) => r.ok && r.verified === null).length,
      refused: runs.reduce((n, r) => n + r.refused, 0),
      requests: runs.reduce((n, r) => n + r.rounds, 0),
      costUsd: spent,
      overshootUsd: Number.isFinite(cap) ? Math.max(0, spent - cap) : 0,
      usageIncomplete: runs.some((r) => r.usageIncomplete),
    },
  };
  const path = join(dir, "report.json");
  writeFileSync(path, JSON.stringify(summary, null, 2) + "\n");
  console.log(`Report: ${path}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
