#!/usr/bin/env node
/**
 * Picture fidelity eval: can a frontier model recreate an original AGI room
 * picture from an art-direction brief, using the picture-source DSL and a
 * tool that shows it its own rendering?
 *
 * For every entry of the local manifest (evals/fixtures/pictures/manifest.local.json,
 * gitignored; generated on first run from the installed fixtures):
 *   1. read the original as VECTOR SOURCE (readPictureSource: bytes -> DSL)
 *      and render it for the judge/results,
 *   2. BRIEF: a model writes an art-direction brief from the original's
 *      vector source (the reference is the vector form, not the bitmap:
 *      composition, horizon, elements, colours, lighting, walkable areas —
 *      explicitly no coordinates or trace),
 *   3. RECREATE: a fresh session sees ONLY the brief + the DSL doc and
 *      iterates with `write_picture_source` (compile -> render -> metrics +
 *      rendered PNG returned as an image block), up to --rounds times,
 *   4. COMPARE both ways: pixel metrics on the rendered buffers AND a
 *      structural comparison of recreated source vs original source
 *      (command/fill/plot counts, colour sets, channel pass ordering), plus a
 *      vision-judge rubric (composition, fill completeness, detail density,
 *      palette use, walkable-area plausibility; 1..10 each) over the two
 *      rendered images side by side,
 *   5. write evals/results/<timestamp>/<entry>/ (PNGs, brief, sources, JSON)
 *      and print a table.
 *
 * Usage:
 *   npm run eval:picture -- [--provider anthropic|openai|fake] [--model ID]
 *       [--judge-model ID] [--rounds 4] [--only kq1-room1] [--manifest PATH]
 *       [--out DIR] [--effort low|medium|high]
 *       [--brief-mode prose|bounds] [--grid] [--nudge]
 *   --brief-mode bounds: the brief author must also emit a layout table (per
 *       mass: x/y bounds, share, dominant colour index; horizon row).
 *   --grid: diagnostic — the recreate session also gets an 8x7 grid of the
 *       original's dominant colours (separates perception from execution).
 *   --nudge: harness-carried round instruction appended to every
 *       write_picture result ("Revision N of M. Continue revising.").
 *   --feedback: write_picture results also carry the rendered picture's 8x7
 *       dominant-colour grid and, when the source starts with `# layout:`
 *       lines (`# layout: castle x0-70 y30-120 colour 7`), a per-mass
 *       intended-vs-rendered diff (dominant colour inside the declared box,
 *       bounding box of that colour's connected region).
 *   --lane edit: edit-fidelity lane (live-patching metric). The session gets
 *       the original's exact source (readPictureSource) + the render and a
 *       task ("add a second tree"); scored by pixel agreement outside the
 *       changed region, changed-region size, compile success, prefix
 *       preservation, and a judge on a side-by-side crop of the edit.
 *
 * Provider defaults to whichever key is present (ANTHROPIC_API_KEY, then
 * OPENAI_API_KEY), else `fake`: a deterministic offline provider that walks
 * the entire pipeline (including one syntax-error retry) so the harness
 * itself is testable. Sierra images, briefs and results never enter git.
 *
 * Programmatic use (promptfoo lane, evals/configs/picture.mjs):
 *   import { runPictureEntry, loadManifest } from "./eval-picture.ts"
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import {
  createPictureSurface,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
  type PictureSurface,
} from "../src/types.ts";
import { renderPicture } from "../src/picture/renderer.ts";
import {
  analyzePictureStructure,
  annotatePictureSource,
  comparePictureStructure,
  compilePictureSource,
  PICTURE_SOURCE_DOC,
  readPictureSource,
  type PictureStructure,
  type StructureComparison,
} from "../src/picture/source.ts";
import {
  comparePictureMetrics,
  computePictureMetrics,
  type MetricsComparison,
  type PictureMetrics,
} from "../src/picture/metrics.ts";
import { parseLogicResource } from "../src/logic/resource.ts";
import { AGENT_TOOLS, createAgentSessionState, executeAgentTool } from "../src/agent/tools.ts";
import {
  splitToolResult,
  openAiToolContent,
  anthropicToolContent,
  anthropicToolDefinitions,
  type ToolContent,
} from "../src/agent/toolTransport.ts";
export { splitToolResult } from "../src/agent/toolTransport.ts";
import { AGI_SYSTEM_PROMPT } from "../src/agent/prompt.ts";
import { loadGame } from "../test/game-fixture.ts";
import { fixtureSkip } from "../test/fixtures.ts";
import { cropSideBySidePng, sideBySidePng, surfaceToPng } from "./png.ts";

// ---------------------------------------------------------------------------
// Manifest

export interface ManifestEntry {
  id: string;
  game: string;
  room: number;
  /** Picture number; derived from the room logic's load.pic operand when absent. */
  picture?: number;
  horizon?: number;
  /** Edit-fidelity lane task, e.g. "a second tree". */
  edit?: string;
}

const DEFAULT_EDITS: Record<string, string> = {
  "kq1-room1": "a second tree of the same kind, standing on the lawn left of the existing tree",
  "kq2-room1": "a large grey rock lying on the beach sand",
  "kq3-room7": "a rectangular red rug on the floor in front of the stairs",
};

const DEFAULT_ENTRIES: readonly ManifestEntry[] = [
  { id: "kq1-room1", game: "kq1", room: 1 },
  { id: "kq2-room1", game: "kq2", room: 1 },
  { id: "kq3-room7", game: "kq3", room: 7 },
];

const repoRoot = resolve(fileURLToPath(import.meta.url), "../..");
export const DEFAULT_MANIFEST = join(repoRoot, "evals/fixtures/pictures/manifest.local.json");

/**
 * The picture a room draws: scan its logic for `load.pic(vN)` (0x18). `v0`
 * is the current room number; any other var is resolved through the nearest
 * preceding `assignn(vN, K)` (0x03). No guessing: throws when unresolvable.
 */
export function derivePictureNumber(logicPayload: Uint8Array, room: number): number {
  const { code } = parseLogicResource(logicPayload);
  for (let i = 0; i + 1 < code.length; i++) {
    if (code[i] !== 0x18) continue;
    const v = code[i + 1]!;
    if (v === 0) return room;
    for (let j = i - 3; j >= 0; j--) {
      if (code[j] === 0x03 && code[j + 1] === v) return code[j + 2]!;
    }
  }
  throw new Error(`room ${room}: no resolvable load.pic operand in logic`);
}

export function loadManifest(path = DEFAULT_MANIFEST): ManifestEntry[] {
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf-8")) as ManifestEntry[];
  const entries: ManifestEntry[] = [];
  const reported = new Set<string>();
  for (const e of DEFAULT_ENTRIES) {
    const missing = fixtureSkip(e.game);
    if (missing) {
      if (!reported.has(e.game)) console.warn(`[fixture skipped] ${missing}`);
      reported.add(e.game);
      continue;
    }
    const { container } = loadGame(e.game);
    const logic = container.getResource("logic", e.room);
    if (!logic) continue;
    entries.push({ ...e, picture: derivePictureNumber(logic, e.room) });
  }
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(entries, null, 2) + "\n");
  return entries;
}

// ---------------------------------------------------------------------------
// Provider abstraction

export interface Usage {
  input: number;
  output: number;
  cachedInput: number;
  calls: number;
}

export type ContentPart = { type: "text"; text: string } | { type: "image"; png: Uint8Array };

export type ToolOutcome = ToolContent;
export type ToolExecutor = (name: string, args: Record<string, unknown>) => ToolOutcome;

export interface ToolRound {
  round: number;
  source: string;
  ok: boolean;
  errors?: string;
  metrics?: PictureMetrics;
}

export interface Provider {
  name: string;
  model: string;
  judgeModel: string;
  usage: Usage;
  /** One-shot vision completion. */
  complete(system: string, user: ContentPart[], model: string): Promise<string>;
  /**
   * Tool loop over the full production catalog (AGENT_TOOLS, static for
   * prompt caching). A round is one `write_picture` call; other tool calls
   * execute but do not count. Stops after maxRounds or a turn with no calls.
   */
  recreate(system: string, user: string, execute: ToolExecutor, maxRounds: number): Promise<void>;
}

const PICTURE_TOOL = "write_picture";

let NUDGE = false;

function revisionNote(left: number, done: number, max: number): string {
  const base = `\n\nRevisions left: ${left}. ${left > 0 ? "Look at the rendering, compare it with the brief, and call write_picture again with an improved complete source." : "No revisions left; reply with one sentence."}`;
  return NUDGE && left > 0 ? `${base}\nRevision ${done} of ${max}. Continue revising.` : base;
}

function b64(png: Uint8Array): string {
  return Buffer.from(png).toString("base64");
}

// ---- Anthropic ----

class AnthropicProvider implements Provider {
  name = "anthropic";
  model: string;
  judgeModel: string;
  usage: Usage = { input: 0, output: 0, cachedInput: 0, calls: 0 };
  effort: "low" | "medium" | "high";
  #client: Anthropic;

  constructor(model: string, judgeModel: string, effort: "low" | "medium" | "high") {
    this.model = model;
    this.judgeModel = judgeModel;
    this.effort = effort;
    this.#client = new Anthropic();
  }

  #track(u: Anthropic.Usage): void {
    this.usage.input += u.input_tokens;
    this.usage.output += u.output_tokens;
    this.usage.cachedInput += u.cache_read_input_tokens ?? 0;
    this.usage.calls++;
  }

  static toBlocks(parts: ContentPart[]): (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[] {
    return parts.map((p) =>
      p.type === "text"
        ? { type: "text", text: p.text }
        : { type: "image", source: { type: "base64", media_type: "image/png", data: b64(p.png) } },
    );
  }

  async complete(system: string, user: ContentPart[], model: string): Promise<string> {
    const msg = await this.#client.messages
      .stream({
        model,
        max_tokens: 16000,
        system,
        output_config: { effort: this.effort },
        messages: [{ role: "user", content: AnthropicProvider.toBlocks(user) }],
      })
      .finalMessage();
    this.#track(msg.usage);
    if (msg.stop_reason === "refusal")
      throw new Error(`refusal: ${msg.stop_details?.explanation ?? ""}`);
    return msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  }

  async recreate(
    system: string,
    user: string,
    execute: ToolExecutor,
    maxRounds: number,
  ): Promise<void> {
    const tools: Anthropic.Tool[] = anthropicToolDefinitions(AGENT_TOOLS).map((tool, idx) => ({
      ...(tool as unknown as Anthropic.Tool),
      ...(idx === AGENT_TOOLS.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
    }));
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: user }];
    let rounds = 0;
    while (rounds < maxRounds) {
      const msg = await this.#client.messages
        .stream({
          model: this.model,
          max_tokens: 32000,
          system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
          output_config: { effort: this.effort },
          tools,
          messages,
        })
        .finalMessage();
      this.#track(msg.usage);
      if (msg.stop_reason === "refusal")
        throw new Error(`refusal: ${msg.stop_details?.explanation ?? ""}`);
      messages.push({ role: "assistant", content: msg.content });
      const calls = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (calls.length === 0) {
        if (rounds === 0) {
          messages.push({ role: "user", content: "Call write_picture with the full source now." });
          continue;
        }
        break;
      }
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const call of calls) {
        const outcome = execute(call.name, (call.input as Record<string, unknown>) ?? {});
        let text = outcome.text;
        if (call.name === PICTURE_TOOL) {
          rounds++;
          text += revisionNote(maxRounds - rounds, rounds, maxRounds);
        }
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: anthropicToolContent({ ...outcome, text }),
        });
      }
      messages.push({ role: "user", content: results });
    }
  }
}

// ---- OpenAI (Responses API) ----

class OpenAiProvider implements Provider {
  name = "openai";
  model: string;
  judgeModel: string;
  usage: Usage = { input: 0, output: 0, cachedInput: 0, calls: 0 };
  effort: "low" | "medium" | "high";
  #client: OpenAI;

  constructor(model: string, judgeModel: string, effort: "low" | "medium" | "high") {
    this.model = model;
    this.judgeModel = judgeModel;
    this.effort = effort;
    this.#client = new OpenAI();
  }

  #track(u: OpenAI.Responses.ResponseUsage | undefined): void {
    if (!u) return;
    this.usage.input += u.input_tokens;
    this.usage.output += u.output_tokens;
    this.usage.cachedInput += u.input_tokens_details?.cached_tokens ?? 0;
    this.usage.calls++;
  }

  static toItems(
    parts: ContentPart[],
  ): Array<OpenAI.Responses.ResponseInputText | OpenAI.Responses.ResponseInputImage> {
    return parts.map((p) =>
      p.type === "text"
        ? { type: "input_text", text: p.text }
        : { type: "input_image", detail: "high", image_url: `data:image/png;base64,${b64(p.png)}` },
    );
  }

  async complete(system: string, user: ContentPart[], model: string): Promise<string> {
    const res = await this.#client.responses.create({
      model,
      instructions: system,
      reasoning: { effort: this.effort },
      input: [{ role: "user", content: OpenAiProvider.toItems(user) }],
      store: false,
    });
    this.#track(res.usage);
    return res.output_text;
  }

  async recreate(
    system: string,
    user: string,
    execute: ToolExecutor,
    maxRounds: number,
  ): Promise<void> {
    const tools: OpenAI.Responses.Tool[] = AGENT_TOOLS.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.parameters as unknown as Record<string, unknown>,
      strict: true,
    }));
    const input: OpenAI.Responses.ResponseInputItem[] = [{ role: "user", content: user }];
    const cacheKey = `monotio_agi.eval-picture.${Math.random().toString(36).slice(2, 10)}`;
    let rounds = 0;
    while (rounds < maxRounds) {
      const res = await this.#client.responses.create({
        model: this.model,
        instructions: system,
        reasoning: { effort: this.effort },
        prompt_cache_key: cacheKey,
        tools,
        input,
        include: ["reasoning.encrypted_content"],
        store: false,
      });
      this.#track(res.usage);
      const calls: OpenAI.Responses.ResponseFunctionToolCall[] = [];
      for (const item of res.output) {
        input.push(item as OpenAI.Responses.ResponseInputItem);
        if (item.type === "function_call") calls.push(item);
      }
      if (calls.length === 0) {
        if (rounds === 0) {
          input.push({ role: "user", content: "Call write_picture with the full source now." });
          continue;
        }
        break;
      }
      for (const call of calls) {
        const args = ((): Record<string, unknown> => {
          try {
            return JSON.parse(call.arguments) as Record<string, unknown>;
          } catch {
            return {};
          }
        })();
        const outcome = execute(call.name, args);
        let text = outcome.text;
        if (call.name === PICTURE_TOOL) {
          rounds++;
          text += revisionNote(maxRounds - rounds, rounds, maxRounds);
        }
        input.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: openAiToolContent({ ...outcome, text }),
        });
      }
    }
  }
}

// ---- Fake (deterministic, offline) ----

const FAKE_SOURCES = [
  // Round 1: a deliberate syntax error exercises the retry path.
  "vis 1\npri 4\nline 0,0 159,0 159,40 0,40\nfill 80,20\nbogus 1,2\n",
  // Round 2: sky and ground.
  "vis 1\npri 4\nrect 0,0 159,40\nfill 80,20\nvis 2\npri 8\nrect 0,40 159,167\nfill 80,100\nend\n",
  // Round 3: adds a building and a path with priority bands.
  [
    "# sky",
    "vis 1",
    "pri 4",
    "rect 0,0 159,40",
    "fill 80,20",
    "# ground",
    "vis 2",
    "pri 8",
    "rect 0,40 159,167",
    "fill 80,100",
    "# castle wall",
    "vis 7",
    "pri 6",
    "rect 40,10 120,60",
    "fill 80,30",
    "vis 8",
    "line 40,10 40,60",
    "line 120,10 120,60",
    "# path",
    "vis 6",
    "pri 12",
    "polygon 70,60 90,60 130,167 30,167",
    "fill 80,120",
    "# trees",
    "pen 3 stipple",
    "vis 10",
    "plot 17 20,80 33 140,80 55 25,95",
    "end",
  ].join("\n"),
  // Round 4: identical to round 3 (a model that is "done").
  null,
];

class FakeProvider implements Provider {
  name = "fake";
  model = "fake";
  judgeModel = "fake";
  usage: Usage = { input: 0, output: 0, cachedInput: 0, calls: 0 };

  async complete(system: string, user: ContentPart[]): Promise<string> {
    this.usage.calls++;
    if (system.includes("judge")) {
      return JSON.stringify({
        composition: 4,
        fill: 6,
        detail: 3,
        palette: 5,
        ground: 5,
        overall: 4,
        notes: "fake judge",
      });
    }
    return `Brief (fake): a daylight exterior with a horizon near the top third, a grey stone building centred above a winding path, green ground, blue sky, stippled foliage left and right. Walkable ground below the building; the building and sky are not walkable. (${user.length} parts)`;
  }

  async recreate(
    _system: string,
    _user: string,
    execute: ToolExecutor,
    maxRounds: number,
  ): Promise<void> {
    for (let r = 0; r < maxRounds; r++) {
      this.usage.calls++;
      const src = FAKE_SOURCES[r] ?? null;
      if (src === null) break;
      execute(PICTURE_TOOL, { room: 1, source: src });
    }
  }
}

// ---------------------------------------------------------------------------
// Prompts

const BRIEF_SYSTEM = `You are an art director for a 1980s 16-colour EGA adventure game. You write briefs that a picture artist will paint from without ever seeing the reference. The reference is given to you as the picture's vector source (the format is documented below); read it and picture the scene. Describe, do not trace: no coordinates, no pixel lists, no command listings, no step-by-step drawing instructions.

${PICTURE_SOURCE_DOC}`;

const BRIEF_USER = `Below is the complete vector source of a 160x168 game background. Write an art-direction brief for it. Cover, in order:
1. Composition: horizon height (as a fraction of the picture), viewpoint, main masses and where they sit (left/centre/right, top/middle/bottom), relative sizes.
2. Elements: every distinct thing in the scene (buildings, terrain, water, plants, props) with shape, size and placement in plain language.
3. Colours: which of the 16 EGA colours (0 black,1 blue,2 green,3 cyan,4 red,5 magenta,6 brown,7 light grey,8 dark grey,9 light blue,10 light green,11 light cyan,12 light red,13 light magenta,14 yellow,15 white) dominate each element; approximate area share of the top 5 colours.
4. Lighting and texture: shading, outlines, stippling/texture areas, highlights.
5. Playable space: where the player can walk (ground plane), what blocks movement (walls, water, cliffs), exits at the edges, and how depth reads from top (far) to bottom (near).
Aim for 250-450 words. Prose and bullet points only.`;

const BRIEF_BOUNDS_SECTION = `
6. Layout table (REQUIRED, exact numbers): the horizon row (y in 0..167), then one line per named mass in the form
   name | x from..to | y from..to | share of picture % | dominant colour index
   using the picture's 160x168 coordinate space (x 0..159 left to right, y 0..167 top to bottom). Cover every mass you named in section 2, including the ground plane and the sky.`;

const BRIEF_SOURCE_LEAD = `

Vector source:
`;

const JUDGE_SYSTEM = `You are a strict art judge comparing two 16-colour game backgrounds: an ORIGINAL and a RECREATION painted from a written brief of the original. Score the recreation 1..10 on each rubric item (10 = indistinguishable in that respect, 1 = absent). Return ONLY a JSON object: {"composition": n, "fill": n, "detail": n, "palette": n, "ground": n, "overall": n, "notes": "one or two sentences"}.
Rubric: composition (horizon, masses, placement, proportions), fill (no unpainted white, regions closed, no leaks), detail (density of outlines, texture, small elements), palette (same dominant colours in similar proportions), ground = ground plane legibility (the walkable ground reads as one continuous plane with depth, the player can see where to walk).`;

// ---------------------------------------------------------------------------
// Pipeline

export interface JudgeScores {
  composition: number;
  fill: number;
  detail: number;
  palette: number;
  /** Ground plane legibility (rubric key "ground"). */
  ground: number;
  overall: number;
  notes: string;
}

export interface EntryResult {
  id: string;
  game: string;
  picture: number;
  provider: string;
  model: string;
  rounds: ToolRound[];
  original: PictureMetrics;
  originalStructure: PictureStructure;
  recreation: PictureMetrics | null;
  recreationStructure: PictureStructure | null;
  comparison: MetricsComparison | null;
  structureComparison: StructureComparison | null;
  judge: JudgeScores | null;
  usage: Usage;
  error?: string;
}

function parseJudge(text: string): JudgeScores | null {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as Record<string, unknown>;
    const n = (k: string): number => Math.max(1, Math.min(10, Number(j[k]) || 1));
    return {
      composition: n("composition"),
      fill: n("fill"),
      detail: n("detail"),
      palette: n("palette"),
      ground: n("ground"),
      overall: n("overall"),
      notes: String(j["notes"] ?? ""),
    };
  } catch {
    return null;
  }
}

function fmtMetrics(m: PictureMetrics): string {
  const top = m.paletteHistogram
    .map((f, c) => [c, f] as const)
    .filter(([, f]) => f > 0.005)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([c, f]) => `${c}:${(f * 100).toFixed(0)}%`)
    .join(" ");
  return [
    `fillCoverage=${(m.fillCoverage * 100).toFixed(1)}% (white left: ${(100 - m.fillCoverage * 100).toFixed(1)}%)`,
    `distinctColors=${m.distinctColors} topColours=[${top}]`,
    `edgeDensity=${m.edgeDensity.toFixed(3)} regions=${m.regionCount}`,
    `priorityBands=${m.priorityBands} bandFraction=${(m.priorityBandFraction * 100).toFixed(0)}% horizonSanity=${(m.priorityHorizonSanity * 100).toFixed(0)}% walkable=${(m.walkableFraction * 100).toFixed(0)}%`,
    `commands=${m.commandCount}`,
  ].join("\n");
}

interface LayoutMass {
  name: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  colour: number;
}

/** `# layout: <name> x<a>-<b> y<c>-<d> colour <n>` lines anywhere in the source. */
export function parseLayout(source: string): LayoutMass[] {
  const out: LayoutMass[] = [];
  const re = /^#\s*layout:\s*([^\s]+)\s+x(\d+)-(\d+)\s+y(\d+)-(\d+)\s+colou?r\s+(\d+)/i;
  for (const line of source.split(/\r?\n/)) {
    const m = re.exec(line.trim());
    if (!m) continue;
    out.push({
      name: m[1]!,
      x0: Number(m[2]),
      x1: Number(m[3]),
      y0: Number(m[4]),
      y1: Number(m[5]),
      colour: Number(m[6]) & 0x0f,
    });
  }
  return out;
}

/** Bounding box of the union of `colour` regions (4-connected) that touch the box. */
function regionBoxTouching(
  visual: Uint8Array,
  colour: number,
  m: LayoutMass,
): { x0: number; y0: number; x1: number; y1: number; cells: number } | null {
  const seen = new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT);
  const stack: number[] = [];
  for (let y = Math.max(0, m.y0); y <= Math.min(SCREEN_HEIGHT - 1, m.y1); y++) {
    for (let x = Math.max(0, m.x0); x <= Math.min(SCREEN_WIDTH - 1, m.x1); x++) {
      const i = y * SCREEN_WIDTH + x;
      if (visual[i] === colour && !seen[i]) {
        seen[i] = 1;
        stack.push(i);
      }
    }
  }
  if (stack.length === 0) return null;
  let x0 = SCREEN_WIDTH,
    y0 = SCREEN_HEIGHT,
    x1 = -1,
    y1 = -1,
    cells = 0;
  while (stack.length > 0) {
    const i = stack.pop()!;
    cells++;
    const x = i % SCREEN_WIDTH;
    const y = (i - x) / SCREEN_WIDTH;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    for (const n of [
      x > 0 ? i - 1 : -1,
      x < SCREEN_WIDTH - 1 ? i + 1 : -1,
      i - SCREEN_WIDTH,
      i + SCREEN_WIDTH,
    ]) {
      if (n < 0 || n >= seen.length || seen[n] || visual[n] !== colour) continue;
      seen[n] = 1;
      stack.push(n);
    }
  }
  return { x0, y0, x1, y1, cells };
}

/** Intended-vs-rendered report for every declared mass. */
export function layoutFeedback(visual: Uint8Array, layout: LayoutMass[]): string {
  if (layout.length === 0)
    return "No `# layout:` declarations found; add `# layout: <name> x<a>-<b> y<c>-<d> colour <n>` lines to get a per-mass comparison.";
  const lines = ["Declared layout vs rendering:"];
  for (const m of layout) {
    const counts = new Array<number>(16).fill(0);
    let n = 0;
    for (let y = Math.max(0, m.y0); y <= Math.min(SCREEN_HEIGHT - 1, m.y1); y++) {
      for (let x = Math.max(0, m.x0); x <= Math.min(SCREEN_WIDTH - 1, m.x1); x++) {
        counts[visual[y * SCREEN_WIDTH + x]! & 0x0f]!++;
        n++;
      }
    }
    const dom = counts.indexOf(Math.max(...counts));
    const share = n === 0 ? 0 : counts[m.colour]! / n;
    const box = regionBoxTouching(visual, m.colour, m);
    const rendered = box
      ? `colour ${m.colour} region spans x${box.x0}-${box.x1} y${box.y0}-${box.y1} (${box.cells} cells)`
      : `colour ${m.colour} is ABSENT inside the box`;
    const verdict = !box
      ? "MISSING"
      : share < 0.4
        ? "UNDERFILLED"
        : box.x1 - box.x0 > (m.x1 - m.x0) * 1.5 || box.y1 - box.y0 > (m.y1 - m.y0) * 1.5
          ? "OVERFLOWS"
          : "ok";
    lines.push(
      `- ${m.name}: declared x${m.x0}-${m.x1} y${m.y0}-${m.y1} colour ${m.colour}; inside the box the dominant colour is ${dom} (declared colour covers ${(share * 100).toFixed(0)}%); ${rendered} -> ${verdict}`,
    );
  }
  return lines.join("\n");
}

export interface RunOptions {
  provider: Provider;
  rounds: number;
  outDir: string;
  log?: (line: string) => void;
  /** "bounds": the brief must include a numeric layout table. */
  briefMode?: "prose" | "bounds";
  /** Diagnostic: attach an 8x7 dominant-colour grid of the original to the recreate prompt. */
  grid?: boolean;
  /** Harness-carried "Revision N of M. Continue revising." line on tool results. */
  nudge?: boolean;
  /** Tool results carry the rendered colour grid + declared-layout diff. */
  feedback?: boolean;
}

/** Coarse dominant-colour grid of a visual surface, one colour index per cell. */
export function colourGrid(visual: Uint8Array, cols = 8, rows = 7): string {
  const cw = SCREEN_WIDTH / cols;
  const ch = SCREEN_HEIGHT / rows;
  const lines: string[] = [
    `8x7 grid of the dominant colour per cell (each cell ${cw}x${ch} pixels; columns left→right, rows top→bottom):`,
  ];
  for (let r = 0; r < rows; r++) {
    const cells: string[] = [];
    for (let c = 0; c < cols; c++) {
      const counts = new Array<number>(16).fill(0);
      for (let y = r * ch; y < (r + 1) * ch; y++)
        for (let x = c * cw; x < (c + 1) * cw; x++) counts[visual[y * SCREEN_WIDTH + x]! & 0x0f]!++;
      cells.push(String(counts.indexOf(Math.max(...counts))).padStart(2));
    }
    lines.push(
      `y ${String(r * ch).padStart(3)}..${String((r + 1) * ch - 1).padStart(3)}: ${cells.join(" ")}`,
    );
  }
  return lines.join("\n");
}

export async function runPictureEntry(
  entry: ManifestEntry,
  opts: RunOptions,
): Promise<EntryResult> {
  const log = opts.log ?? ((): void => {});
  const { provider } = opts;
  const { container } = loadGame(entry.game);
  const picture =
    entry.picture ?? derivePictureNumber(container.getResource("logic", entry.room)!, entry.room);
  const bytes = container.getResource("picture", picture);
  const originalSource = readPictureSource(container, picture);
  if (!bytes || originalSource === null)
    throw new Error(`${entry.game}: picture ${picture} absent`);
  const horizon = entry.horizon ?? 36;
  const dir = join(opts.outDir, entry.id);
  mkdirSync(dir, { recursive: true });

  const originalSurface = createPictureSurface();
  renderPicture(bytes, originalSurface);
  const originalStructure = analyzePictureStructure(bytes);
  const originalMetrics = computePictureMetrics(originalSurface, {
    horizon,
    commandCount: compilePictureSource(originalSource, { lenient: true }).commandCount,
  });
  const originalPng = surfaceToPng(originalSurface.visual, SCREEN_WIDTH, SCREEN_HEIGHT);
  writeFileSync(join(dir, "original.png"), originalPng);
  writeFileSync(
    join(dir, "original-priority.png"),
    surfaceToPng(originalSurface.priority, SCREEN_WIDTH, SCREEN_HEIGHT),
  );
  writeFileSync(join(dir, "original.pic.txt"), originalSource);
  log(
    `  original: ${bytes.length} bytes, ${originalMetrics.commandCount} commands\n${fmtMetrics(originalMetrics).replace(/^/gm, "    ")}`,
  );

  const usageStart = { ...provider.usage };
  const result: EntryResult = {
    id: entry.id,
    game: entry.game,
    picture,
    provider: provider.name,
    model: provider.model,
    rounds: [],
    original: originalMetrics,
    originalStructure,
    recreation: null,
    recreationStructure: null,
    comparison: null,
    structureComparison: null,
    judge: null,
    usage: { input: 0, output: 0, cachedInput: 0, calls: 0 },
  };

  try {
    // (b) brief
    NUDGE = opts.nudge === true;
    const briefPrompt =
      BRIEF_USER +
      (opts.briefMode === "bounds" ? BRIEF_BOUNDS_SECTION : "") +
      BRIEF_SOURCE_LEAD +
      originalSource;
    const brief = await provider.complete(
      BRIEF_SYSTEM,
      [{ type: "text", text: briefPrompt }],
      provider.judgeModel,
    );
    writeFileSync(join(dir, "brief.md"), brief + "\n");
    log(`  brief: ${brief.split(/\s+/).length} words`);

    // (c) recreate
    let best: {
      surface: PictureSurface;
      metrics: PictureMetrics;
      source: string;
      bytes: Uint8Array;
    } | null = null;
    // The recreate session runs the PRODUCTION catalog: every call goes
    // through executeAgentTool on a fresh session, exactly as it ships.
    const session = createAgentSessionState();
    const execute: ToolExecutor = (name, args) => {
      const toolResult = executeAgentTool(session, name, args);
      if (name !== PICTURE_TOOL) {
        log(
          `  tool ${name}: ${toolResult.success ? "ok" : `error ${toolResult.error ?? ""}`.slice(0, 120)}`,
        );
        return splitToolResult(toolResult);
      }
      const round = result.rounds.length + 1;
      const source = typeof args["source"] === "string" ? args["source"] : "";
      writeFileSync(join(dir, `round-${round}.pic.txt`), source);
      if (!toolResult.success) {
        const msg = toolResult.error ?? "unknown error";
        result.rounds.push({ round, source, ok: false, errors: msg });
        log(`  round ${round}: ERROR ${msg.split("\n").slice(0, 2).join(" | ")}`);
        return splitToolResult(toolResult);
      }
      // Re-render the stored resource (metrics are computed here, not trusted from the tool text).
      const room = Number(args["room"]);
      const stored = session.container.getResource("picture", room)!;
      const surface = createPictureSurface();
      renderPicture(stored, surface);
      const metrics = computePictureMetrics(surface, {
        horizon,
        commandCount: analyzePictureStructure(stored).commands,
      });
      writeFileSync(
        join(dir, `round-${round}.png`),
        surfaceToPng(surface.visual, SCREEN_WIDTH, SCREEN_HEIGHT),
      );
      writeFileSync(
        join(dir, `round-${round}-priority.png`),
        surfaceToPng(surface.priority, SCREEN_WIDTH, SCREEN_HEIGHT),
      );
      best = { surface, metrics, source, bytes: stored };
      result.rounds.push({ round, source, ok: true, metrics });
      log(
        `  round ${round}: ok, ${stored.length} bytes, fill ${(metrics.fillCoverage * 100).toFixed(1)}%, colours ${metrics.distinctColors}, commands ${metrics.commandCount}`,
      );
      const split = splitToolResult(toolResult);
      if (opts.feedback) {
        const fb = `\n\nRendered layout, ${colourGrid(surface.visual)}\n${layoutFeedback(surface.visual, parseLayout(source))}`;
        writeFileSync(join(dir, `round-${round}-feedback.txt`), fb.trim() + "\n");
        return { ...split, text: split.text + fb };
      }
      return split;
    };
    await provider.recreate(
      AGI_SYSTEM_PROMPT,
      `Art-direction brief for the background picture of room ${entry.room}:\n\n${brief}\n\n${opts.grid ? `Reference layout, ${colourGrid(originalSurface.visual)}\n\n` : ""}Author ONLY this picture: call write_picture with room ${entry.room} and the complete source. Do not write words, views, logic or sounds, and do not call finish_genesis. Study the returned rendering after every call and revise until it matches the brief.${opts.feedback ? "\n\nStart the source with one `# layout:` comment per major mass, e.g. `# layout: castle x0-70 y30-120 colour 7` (bounds in the 160x168 space, dominant colour index). Every write_picture result then reports, per mass, the dominant colour actually rendered inside that box and the real extent of that colour, plus an 8x7 grid of the rendering: use those numbers to correct placement and size before adding detail." : ""}`,
      execute,
      opts.rounds,
    );

    // (d) compare
    if (best !== null) {
      const b = best as {
        surface: PictureSurface;
        metrics: PictureMetrics;
        source: string;
        bytes: Uint8Array;
      };
      writeFileSync(join(dir, "recreation.pic.txt"), b.source);
      writeFileSync(
        join(dir, "recreation.png"),
        surfaceToPng(b.surface.visual, SCREEN_WIDTH, SCREEN_HEIGHT),
      );
      result.recreation = b.metrics;
      result.comparison = comparePictureMetrics(originalMetrics, b.metrics, {
        reference: originalSurface,
        candidate: b.surface,
      });
      result.recreationStructure = analyzePictureStructure(b.bytes);
      result.structureComparison = comparePictureStructure(
        originalStructure,
        result.recreationStructure,
      );
      log(
        `  structure: commands ${originalStructure.commands}→${result.recreationStructure.commands}, fills ${originalStructure.fillSeeds}→${result.recreationStructure.fillSeeds}, plots ${originalStructure.plots}→${result.recreationStructure.plots}, both-channel ${(originalStructure.bothChannelsFraction * 100).toFixed(0)}%→${(result.recreationStructure.bothChannelsFraction * 100).toFixed(0)}%, colour overlap ${result.structureComparison.visualColourOverlap.toFixed(2)}`,
      );
      const pair = sideBySidePng(
        originalSurface.visual,
        b.surface.visual,
        SCREEN_WIDTH,
        SCREEN_HEIGHT,
      );
      writeFileSync(join(dir, "side-by-side.png"), pair);
      const judgeText = await provider.complete(
        JUDGE_SYSTEM,
        [
          { type: "text", text: "Image 1: ORIGINAL." },
          { type: "image", png: originalPng },
          { type: "text", text: "Image 2: RECREATION." },
          { type: "image", png: surfaceToPng(b.surface.visual, SCREEN_WIDTH, SCREEN_HEIGHT) },
          { type: "text", text: "Image 3: both side by side (left original, right recreation)." },
          { type: "image", png: pair },
          { type: "text", text: "Score the recreation per the rubric; JSON only." },
        ],
        provider.judgeModel,
      );
      writeFileSync(join(dir, "judge.txt"), judgeText + "\n");
      result.judge = parseJudge(judgeText);
      if (!result.judge) log(`  judge output not parseable: ${judgeText.slice(0, 200)}`);
    } else {
      result.error = "no successful round";
    }
  } catch (err) {
    result.error = String(err);
    log(`  ERROR: ${result.error}`);
  }

  result.usage = {
    input: provider.usage.input - usageStart.input,
    output: provider.usage.output - usageStart.output,
    cachedInput: provider.usage.cachedInput - usageStart.cachedInput,
    calls: provider.usage.calls - usageStart.calls,
  };
  writeFileSync(join(dir, "result.json"), JSON.stringify(result, null, 2) + "\n");
  return result;
}

// ---------------------------------------------------------------------------
// Edit-fidelity lane (live-patching metric)

export interface EditJudge {
  edit: number;
  style: number;
  overall: number;
  notes: string;
}

export interface EditResult {
  id: string;
  game: string;
  picture: number;
  task: string;
  provider: string;
  model: string;
  rounds: ToolRound[];
  compiled: boolean;
  /** Recompiled edited bytes start with the original's bytes (terminator excluded): a pure append. */
  prefixPreserved: boolean;
  /** Original source commands found in the edited source, in order (inserts allowed). */
  originalPreserved: { kept: number; total: number };
  /** Cells whose visual colour differs from the original. */
  diffPixels: number;
  /** Bounding box of the largest connected diff component (the edit), padded by 2. */
  changedBox: { x0: number; y0: number; x1: number; y1: number } | null;
  /** changedBox area / surface area. */
  changedRegionFraction: number;
  /** Diff cells outside changedBox. */
  strayCells: number;
  /** 4-connected components of the diff mask (1 = one clean edit). */
  changedComponents: number;
  /** Fraction of cells outside changedBox equal to the original (target ~1). */
  agreementOutside: number;
  /** Same for the priority surface. */
  priorityAgreementOutside: number;
  originalCommands: number;
  editedCommands: number;
  judge: EditJudge | null;
  usage: Usage;
  error?: string;
}

const EDIT_JUDGE_SYSTEM = `You are a strict art judge for a 16-colour adventure-game background. You see a cropped region before (left) and after (right) an edit that was supposed to add one described thing. Score 1..10: edit (the described thing is present, recognisable, and correctly placed), style (drawn in the same outline/fill/palette idiom as the surrounding original art, integrated, no leaks or stray marks), overall. Return ONLY JSON: {"edit": n, "style": n, "overall": n, "notes": "one or two sentences"}.`;

function parseEditJudge(text: string): EditJudge | null {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as Record<string, unknown>;
    const n = (k: string): number => Math.max(1, Math.min(10, Number(j[k]) || 1));
    return {
      edit: n("edit"),
      style: n("style"),
      overall: n("overall"),
      notes: String(j["notes"] ?? ""),
    };
  } catch {
    return null;
  }
}

/** Largest 4-connected component of the diff mask (bounding box padded by `pad`) and the component count. */
function largestDiffBox(
  mask: Uint8Array,
  pad = 2,
): { box: { x0: number; y0: number; x1: number; y1: number } | null; components: number } {
  const seen = new Uint8Array(mask.length);
  let best: { x0: number; y0: number; x1: number; y1: number; cells: number } | null = null;
  let components = 0;
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    components++;
    seen[start] = 1;
    stack.push(start);
    let x0 = SCREEN_WIDTH,
      y0 = SCREEN_HEIGHT,
      x1 = -1,
      y1 = -1,
      cells = 0;
    while (stack.length > 0) {
      const i = stack.pop()!;
      cells++;
      const x = i % SCREEN_WIDTH;
      const y = (i - x) / SCREEN_WIDTH;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (const nb of [
        x > 0 ? i - 1 : -1,
        x < SCREEN_WIDTH - 1 ? i + 1 : -1,
        i - SCREEN_WIDTH,
        i + SCREEN_WIDTH,
      ]) {
        if (nb < 0 || nb >= mask.length || seen[nb] || !mask[nb]) continue;
        seen[nb] = 1;
        stack.push(nb);
      }
    }
    if (!best || cells > best.cells) best = { x0, y0, x1, y1, cells };
  }
  if (!best) return { box: null, components };
  return {
    box: {
      x0: Math.max(0, best.x0 - pad),
      y0: Math.max(0, best.y0 - pad),
      x1: Math.min(SCREEN_WIDTH - 1, best.x1 + pad),
      y1: Math.min(SCREEN_HEIGHT - 1, best.y1 + pad),
    },
    components,
  };
}

export async function runEditEntry(entry: ManifestEntry, opts: RunOptions): Promise<EditResult> {
  const log = opts.log ?? ((): void => {});
  const { provider } = opts;
  const { container } = loadGame(entry.game);
  const picture =
    entry.picture ?? derivePictureNumber(container.getResource("logic", entry.room)!, entry.room);
  const bytes = container.getResource("picture", picture);
  const originalSource = readPictureSource(container, picture);
  if (!bytes || originalSource === null)
    throw new Error(`${entry.game}: picture ${picture} absent`);
  const task = entry.edit ?? DEFAULT_EDITS[entry.id] ?? "a small rock";
  const dir = join(opts.outDir, entry.id);
  mkdirSync(dir, { recursive: true });

  const originalSurface = createPictureSurface();
  renderPicture(bytes, originalSurface);
  const originalPng = surfaceToPng(originalSurface.visual, SCREEN_WIDTH, SCREEN_HEIGHT);
  writeFileSync(join(dir, "original.png"), originalPng);
  writeFileSync(join(dir, "original.pic.txt"), originalSource);
  const originalCommands = analyzePictureStructure(bytes).commands;
  const total = SCREEN_WIDTH * SCREEN_HEIGHT;
  // The session sees the element-annotated source (what read_picture will return).
  const annotatedSource = annotatePictureSource(bytes);
  writeFileSync(join(dir, "original-annotated.pic.txt"), annotatedSource);

  const usageStart = { ...provider.usage };
  const result: EditResult = {
    id: entry.id,
    game: entry.game,
    picture,
    task,
    provider: provider.name,
    model: provider.model,
    rounds: [],
    compiled: false,
    prefixPreserved: false,
    originalPreserved: { kept: 0, total: 0 },
    diffPixels: 0,
    changedBox: null,
    changedRegionFraction: 0,
    strayCells: 0,
    changedComponents: 0,
    agreementOutside: 0,
    priorityAgreementOutside: 0,
    originalCommands,
    editedCommands: 0,
    judge: null,
    usage: { input: 0, output: 0, cachedInput: 0, calls: 0 },
  };
  NUDGE = opts.nudge === true;

  try {
    // The production session starts with the original picture loaded, as a live game would.
    const session = createAgentSessionState();
    session.container.putResource("picture", entry.room, bytes);
    let last: { surface: PictureSurface; source: string; bytes: Uint8Array } | null = null;
    const execute: ToolExecutor = (name, args) => {
      const toolResult = executeAgentTool(session, name, args);
      if (name !== PICTURE_TOOL) {
        log(
          `  tool ${name}: ${toolResult.success ? "ok" : `error ${toolResult.error ?? ""}`.slice(0, 120)}`,
        );
        return splitToolResult(toolResult);
      }
      const round = result.rounds.length + 1;
      const source = typeof args["source"] === "string" ? args["source"] : "";
      writeFileSync(join(dir, `round-${round}.pic.txt`), source);
      if (!toolResult.success) {
        result.rounds.push({
          round,
          source,
          ok: false,
          errors: toolResult.error ?? "unknown error",
        });
        log(
          `  round ${round}: ERROR ${(toolResult.error ?? "").split("\n").slice(0, 2).join(" | ")}`,
        );
        return splitToolResult(toolResult);
      }
      const stored = session.container.getResource("picture", Number(args["room"]))!;
      const surface = createPictureSurface();
      renderPicture(stored, surface);
      writeFileSync(
        join(dir, `round-${round}.png`),
        surfaceToPng(surface.visual, SCREEN_WIDTH, SCREEN_HEIGHT),
      );
      const metrics = computePictureMetrics(surface, {
        horizon: entry.horizon ?? 36,
        commandCount: analyzePictureStructure(stored).commands,
      });
      last = { surface, source, bytes: stored };
      result.rounds.push({ round, source, ok: true, metrics });
      let diff = 0;
      for (let i = 0; i < total; i++) if (surface.visual[i] !== originalSurface.visual[i]) diff++;
      log(
        `  round ${round}: ok, ${stored.length} bytes, ${metrics.commandCount} commands, ${diff} changed cells (${((diff / total) * 100).toFixed(1)}%)`,
      );
      return splitToolResult(toolResult);
    };

    await provider.recreate(
      AGI_SYSTEM_PROMPT,
      `You are live-patching an existing room. Below is the EXACT current source of room ${entry.room}'s picture (from read_picture); the rendering is attached to your first write_picture result only after you call it, so work from the source.\n\nTASK: add ${task}. Change nothing else: keep every existing command byte-for-byte and append or insert only what the addition needs (draw it in the same idiom: outline, fill, priority band of the ground it stands on). Call write_picture with room ${entry.room} and the COMPLETE source including your addition. Do not touch other resources. The source is annotated with '# element N: lines a-b ...' headers (line numbers of this listing) and '# --- element N' markers: an element is one drawn thing (outline plus the fills inside it). To add another one of an existing thing, copy all of that element's line ranges with one offset.\n\nCurrent source:\n${annotatedSource}`,
      execute,
      opts.rounds,
    );

    if (last !== null) {
      const l = last as { surface: PictureSurface; source: string; bytes: Uint8Array };
      result.compiled = true;
      result.editedCommands = analyzePictureStructure(l.bytes).commands;
      const origBody = bytes.subarray(0, bytes.length - 1);
      result.prefixPreserved =
        l.bytes.length >= origBody.length && origBody.every((b, i) => l.bytes[i] === b);
      const origLines = originalSource
        .trim()
        .split("\n")
        .filter((x) => x !== "end");
      const editedLines = l.source
        .split(/\r?\n/)
        .map((x) => x.replace(/#.*/, "").trim())
        .filter((x) => x.length > 0);
      let kept = 0;
      for (const line of editedLines)
        if (kept < origLines.length && line === origLines[kept]) kept++;
      result.originalPreserved = { kept, total: origLines.length };
      const mask = new Uint8Array(total);
      for (let i = 0; i < total; i++)
        if (l.surface.visual[i] !== originalSurface.visual[i]) mask[i] = 1;
      result.diffPixels = mask.reduce((a, b) => a + b, 0);
      const { box, components } = largestDiffBox(mask);
      result.changedBox = box;
      result.changedComponents = components;
      const inBox = (i: number): boolean => {
        if (!box) return false;
        const x = i % SCREEN_WIDTH;
        const y = (i - x) / SCREEN_WIDTH;
        return x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1;
      };
      const boxArea = box ? (box.x1 - box.x0 + 1) * (box.y1 - box.y0 + 1) : 0;
      result.changedRegionFraction = boxArea / total;
      let stray = 0;
      let priStray = 0;
      for (let i = 0; i < total; i++) {
        if (inBox(i)) continue;
        if (mask[i]) stray++;
        if (l.surface.priority[i] !== originalSurface.priority[i]) priStray++;
      }
      result.strayCells = stray;
      const outside = total - boxArea;
      result.agreementOutside = outside === 0 ? 1 : 1 - stray / outside;
      result.priorityAgreementOutside = outside === 0 ? 1 : 1 - priStray / outside;
      writeFileSync(join(dir, "edited.pic.txt"), l.source);
      writeFileSync(
        join(dir, "edited.png"),
        surfaceToPng(l.surface.visual, SCREEN_WIDTH, SCREEN_HEIGHT),
      );
      if (box) {
        const crop = cropSideBySidePng(
          originalSurface.visual,
          l.surface.visual,
          SCREEN_WIDTH,
          SCREEN_HEIGHT,
          box,
        );
        writeFileSync(join(dir, "edit-crop.png"), crop);
        const judgeText = await provider.complete(
          EDIT_JUDGE_SYSTEM,
          [
            {
              type: "text",
              text: `The edit was supposed to add: ${task}. Left: before. Right: after (same crop).`,
            },
            { type: "image", png: crop },
            { type: "text", text: "Full picture after the edit, for context:" },
            { type: "image", png: surfaceToPng(l.surface.visual, SCREEN_WIDTH, SCREEN_HEIGHT) },
            { type: "text", text: "Score per the rubric; JSON only." },
          ],
          provider.judgeModel,
        );
        writeFileSync(join(dir, "judge.txt"), judgeText + "\n");
        result.judge = parseEditJudge(judgeText);
      } else {
        result.error = "no visual change";
      }
      log(
        `  edit: diff ${result.diffPixels} cells, box ${box ? `x${box.x0}-${box.x1} y${box.y0}-${box.y1}` : "-"} (${(result.changedRegionFraction * 100).toFixed(1)}%), stray ${stray} in ${components} component${components === 1 ? "" : "s"}, agreement outside ${(result.agreementOutside * 100).toFixed(2)}%, prefix ${result.prefixPreserved ? "preserved" : "not a pure append"}, original commands kept in order ${result.originalPreserved.kept}/${result.originalPreserved.total}`,
      );
    } else {
      result.error = "no successful round";
    }
  } catch (err) {
    result.error = String(err);
    log(`  ERROR: ${result.error}`);
  }
  result.usage = {
    input: provider.usage.input - usageStart.input,
    output: provider.usage.output - usageStart.output,
    cachedInput: provider.usage.cachedInput - usageStart.cachedInput,
    calls: provider.usage.calls - usageStart.calls,
  };
  writeFileSync(join(dir, "result.json"), JSON.stringify(result, null, 2) + "\n");
  return result;
}

// ---------------------------------------------------------------------------
// CLI

/** USD per 1M tokens (input, output). Unknown models report tokens only. */
const PRICES: Record<string, [number, number]> = {
  "claude-opus-5": [5, 25],
  "claude-fable-5-1": [10, 50],
  "claude-sonnet-5": [2, 10],
};

export function createProvider(
  name: string,
  model: string | undefined,
  judgeModel: string | undefined,
  effort: "low" | "medium" | "high",
): Provider {
  if (name === "anthropic")
    return new AnthropicProvider(
      model ?? "claude-opus-5",
      judgeModel ?? model ?? "claude-opus-5",
      effort,
    );
  if (name === "openai")
    return new OpenAiProvider(model ?? "gpt-5.6-sol", judgeModel ?? model ?? "gpt-5.6-sol", effort);
  return new FakeProvider();
}

function parseArgs(argv: string[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      o[a.slice(2)] = next;
      i++;
    } else o[a.slice(2)] = "true";
  }
  return o;
}

function pad(s: string | number, n: number): string {
  return String(s).padEnd(n);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const providerName =
    args["provider"] ??
    (process.env["ANTHROPIC_API_KEY"]
      ? "anthropic"
      : process.env["OPENAI_API_KEY"]
        ? "openai"
        : "fake");
  const effort = (args["effort"] as "low" | "medium" | "high" | undefined) ?? "medium";
  const provider = createProvider(providerName, args["model"], args["judge-model"], effort);
  const rounds = Number(args["rounds"] ?? 4);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = args["out"] ?? join(repoRoot, "evals/results", stamp);
  mkdirSync(outDir, { recursive: true });

  let entries = loadManifest(args["manifest"]);
  if (args["only"]) entries = entries.filter((e) => e.id === args["only"]);
  if (entries.length === 0) {
    console.error("No manifest entries (are the local game fixtures installed under games/?)");
    process.exit(1);
  }
  console.log(
    `eval-picture: provider=${provider.name} model=${provider.model} judge=${provider.judgeModel} rounds=${rounds} brief=${args["brief-mode"] ?? "prose"} grid=${args["grid"] === "true"} nudge=${args["nudge"] === "true"} feedback=${args["feedback"] === "true"} lane=${args["lane"] ?? "recreate"} out=${outDir}`,
  );
  if (provider.name === "fake")
    console.log("NOTE: fake provider — deterministic offline run; no model was consulted.");

  if (args["lane"] === "edit") {
    const results: EditResult[] = [];
    for (const entry of entries) {
      console.log(
        `\n== ${entry.id} (${entry.game} room ${entry.room}) edit: ${entry.edit ?? DEFAULT_EDITS[entry.id] ?? "?"}`,
      );
      results.push(
        await runEditEntry(entry, {
          provider,
          rounds,
          outDir,
          log: (l) => console.log(l),
          nudge: args["nudge"] === "true",
        }),
      );
    }
    writeFileSync(
      join(outDir, "summary.json"),
      JSON.stringify(
        { lane: "edit", provider: provider.name, model: provider.model, rounds, results },
        null,
        2,
      ) + "\n",
    );
    console.log(
      "\n" +
        [
          pad("entry", 12),
          pad("rounds", 7),
          pad("compiled", 9),
          pad("kept", 9),
          pad("cmds", 10),
          pad("diff px", 8),
          pad("region%", 8),
          pad("stray", 6),
          pad("comps", 6),
          pad("agree%", 8),
          pad("pri%", 7),
          pad("judge e/s", 10),
          "overall",
        ].join(" "),
    );
    for (const r of results) {
      console.log(
        [
          pad(r.id, 12),
          pad(`${r.rounds.filter((x) => x.ok).length}/${r.rounds.length}`, 7),
          pad(r.compiled ? "yes" : "no", 9),
          pad(`${r.originalPreserved.kept}/${r.originalPreserved.total}`, 9),
          pad(`${r.originalCommands}→${r.editedCommands}`, 10),
          pad(r.diffPixels, 8),
          pad((r.changedRegionFraction * 100).toFixed(1), 8),
          pad(r.strayCells, 6),
          pad(r.changedComponents, 6),
          pad((r.agreementOutside * 100).toFixed(2), 8),
          pad((r.priorityAgreementOutside * 100).toFixed(1), 7),
          pad(r.judge ? `${r.judge.edit}/${r.judge.style}` : "-", 10),
          r.judge ? String(r.judge.overall) : (r.error ?? "-"),
        ].join(" "),
      );
    }
    const u = provider.usage;
    console.log(
      `\ntokens: input=${u.input} (cached ${u.cachedInput}) output=${u.output} calls=${u.calls}`,
    );
    console.log(`results: ${outDir}`);
    return;
  }

  const results: EntryResult[] = [];
  for (const entry of entries) {
    console.log(`\n== ${entry.id} (${entry.game} room ${entry.room})`);
    results.push(
      await runPictureEntry(entry, {
        provider,
        rounds,
        outDir,
        log: (l) => console.log(l),
        briefMode: args["brief-mode"] === "bounds" ? "bounds" : "prose",
        grid: args["grid"] === "true",
        nudge: args["nudge"] === "true",
        feedback: args["feedback"] === "true",
      }),
    );
  }
  writeFileSync(
    join(outDir, "summary.json"),
    JSON.stringify({ provider: provider.name, model: provider.model, rounds, results }, null, 2) +
      "\n",
  );

  console.log(
    "\n" +
      [
        pad("entry", 12),
        pad("rounds", 7),
        pad("fill%", 12),
        pad("colours", 9),
        pad("cmds", 11),
        pad("fills", 9),
        pad("histΔ", 6),
        pad("pix%", 5),
        pad("judge c/f/d/p/g", 16),
        "overall",
      ].join(" "),
  );
  for (const r of results) {
    const o = r.original;
    const c = r.recreation;
    const j = r.judge;
    console.log(
      [
        pad(r.id, 12),
        pad(`${r.rounds.filter((x) => x.ok).length}/${r.rounds.length}`, 7),
        pad(
          `${(o.fillCoverage * 100).toFixed(0)}→${c ? (c.fillCoverage * 100).toFixed(0) : "-"}`,
          12,
        ),
        pad(`${o.distinctColors}→${c ? c.distinctColors : "-"}`, 9),
        pad(`${o.commandCount}→${c ? c.commandCount : "-"}`, 11),
        pad(
          `${r.originalStructure.fillSeeds}→${r.recreationStructure ? r.recreationStructure.fillSeeds : "-"}`,
          9,
        ),
        pad(r.comparison ? r.comparison.histogramDistance.toFixed(2) : "-", 6),
        pad(r.comparison ? (r.comparison.pixelAgreement * 100).toFixed(0) : "-", 5),
        pad(j ? `${j.composition}/${j.fill}/${j.detail}/${j.palette}/${j.ground}` : "-", 16),
        j ? String(j.overall) : (r.error ?? "-"),
      ].join(" "),
    );
  }
  const u = provider.usage;
  const price = PRICES[provider.model];
  const cost = price
    ? ((u.input - u.cachedInput) * price[0] +
        u.cachedInput * price[0] * 0.1 +
        u.output * price[1]) /
      1e6
    : null;
  console.log(
    `\ntokens: input=${u.input} (cached ${u.cachedInput}) output=${u.output} calls=${u.calls}${cost !== null ? ` est. cost $${cost.toFixed(2)}` : ""}`,
  );
  console.log(`results: ${outDir}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error("eval-picture failed:", e);
    process.exit(1);
  });
}
