#!/usr/bin/env node
/**
 * Reference art benchmark: the same authoring task with the player's
 * reference art sent two ways, on the Adventure Department tutorial through
 * the production AgentSession.
 *
 *   before  the full images ride the request (legacy embedding, kept only
 *           for this comparison: TurnReferences.legacyImages)
 *   after   handles: a manifest line and a 64-pixel thumbnail per image,
 *           and read_reference_image for what the model decides to look at
 *
 * Records per run: tokens (input, cached, output), cost, provider requests,
 * read_reference_image calls, attached art the turn wrote from or claimed to match
 * without viewing (the under-fetch rule), the match scores and the reply.
 *
 *   npm run eval:references -- --provider anthropic --model claude-opus-5-5 \
 *     --live --budget-usd 5 [--case all|harbour-room,door-room,mood-room,hero-view,ledger-swatch] \
 *     [--arm both|before|after] [--effort medium] [--repeats 1] [--out evals/results/references]
 *   npm run eval:references -- --dry-run     # the scripted stub, no key, no spend
 *
 * Keys come from ANTHROPIC_API_KEY / OPENAI_API_KEY. A live run refuses to
 * start without --budget-usd, or for a model without a price in
 * MODEL_CAPABILITIES. The cap covers the whole invocation: each run's session
 * gets the remaining allowance as its task budget, so AgentRun stops before a
 * request the allowance cannot cover and caps each request's output tokens by
 * it; a run that pauses (budget, repetition) is cancelled and recorded.
 * Provider usage is priced per request after each run and subtracted; once
 * the cap is spent the remaining runs are skipped. A request's input is priced
 * only after it returns, so a run can overshoot by at most one request's
 * input; the report states any overshoot.
 *
 * The dry run plays the stub scripts: "reference-region" in the after arm
 * (views a region, reports its colours) and "reference-never" in the before
 * arm. The stub cannot write a room, so its room cases end in the recorded
 * error; the dry run proves the plumbing, the accounting and the report.
 *
 * Cases (every reference image is drawn below by script; no outside art):
 *   harbour-room   a sketchy harbour plate for new room 5: sky, sea, pier, sun
 *   door-room      a wall with a small red door on the right for room 6; the
 *                  door is 40x80 of 640x400, four pixels wide in a thumbnail,
 *                  so placing it needs a closer look
 *   mood-room      a colour mood board of five swatches for room 7
 *   hero-view      a four-pose character sheet; Remix writes view 20 from it
 *   ledger-swatch  Studio assist recolours the archive's ledger stand to the
 *                  colour of an attached swatch
 *
 * Scores are cheap and objective. Rooms: palette overlap (Jaccard of the AGI
 * colours holding at least 5% of the reference quantised to 160x168 and of
 * the rendered picture) and layout agreement (share of the 160x168 cells whose
 * quantised colour matches). door-room: the share of the door's cells drawn
 * red. hero-view: silhouette IoU of view 20 loop 0 cel 0 against the first
 * pose's mask, beside the deterministic sheet converter's own IoU as a
 * baseline. ledger-swatch: the swatch colour's share of the stand's cells.
 * `match` applies the case threshold; the raw scores are in the report.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentSession, type TurnReferences } from "../app/src/agent/agentSession.ts";
import type { LlmConfig, LlmUsage } from "../app/src/agent/llmClient.ts";
import {
  referenceAgentImages,
  roomReference,
  stageCharacterView,
  type DecodedImage,
  type StoredReference,
} from "../app/src/references/referenceArt.ts";
import { referenceSource } from "../app/src/references/referenceHandles.ts";
import { base64ToBytes } from "../app/src/project/bytes.ts";
import { buildTutorial, TUTORIAL_PICTURE_SOURCES } from "../games/adventure-department/game.ts";
import { requireProjectId, requireResourceRevision } from "../src/gameIdentity.ts";
import { DEFAULT_MODELS, MODEL_CAPABILITIES } from "../src/agent/modelEffort.ts";
import { EGA_RGB, encodePngRgb } from "../src/picture/png.ts";
import { renderPicture } from "../src/picture/renderer.ts";
import { createPictureSurface } from "../src/types.ts";
import { parseView } from "../src/view/view.ts";
import { compileEditDocument, footprintMask } from "../src/studio/editValidation.ts";
import { parsePictureDocument } from "../src/studio/pictureDocument.ts";
import { decodePng } from "./lib/decode-png.ts";
import { assertLiveRun } from "./lib/live-guard.ts";
import { requestCost } from "./lib/usage.ts";

type Session = ReturnType<typeof AgentSession.fromAuthoredData>;
type Rgb = readonly [number, number, number];
type Arm = "before" | "after";

/** Below this remaining allowance no further run starts. */
const MIN_RUN_USD = 0.01;
/** A run still going after this long is cancelled and recorded. */
const RUN_TIMEOUT_MS = 20 * 60_000;
const IDENTITY = {
  project: requireProjectId("reference-benchmark"),
  revision: requireResourceRevision("0".repeat(64)),
};

// --- Reference art, drawn by script --------------------------------------

const EGA = (index: number): Rgb => EGA_RGB[index] as Rgb;
const MAGENTA_KEY: Rgb = [0xff, 0, 0xff];

class Canvas {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
  private seed = 7;
  constructor(width: number, height: number, fill: Rgb) {
    this.width = width;
    this.height = height;
    this.rgba = new Uint8Array(width * height * 4);
    this.rect(0, 0, width, height, fill);
  }
  set(x: number, y: number, colour: Rgb): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.rgba.set([...colour, 255], (Math.floor(y) * this.width + Math.floor(x)) * 4);
  }
  rect(x: number, y: number, w: number, h: number, colour: Rgb): void {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.set(xx, yy, colour);
  }
  disc(cx: number, cy: number, r: number, colour: Rgb): void {
    for (let y = -r; y <= r; y++)
      for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r) this.set(cx + x, cy + y, colour);
  }
  /** Deterministic 0..1 noise, so every run draws the same sketch. */
  private random(): number {
    this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
    return this.seed / 0x7fffffff;
  }
  /** A hand-drawn stroke: a three-pixel pen that wanders a pixel either side. */
  stroke(x0: number, y0: number, x1: number, y1: number, colour: Rgb): void {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    let drift = 0;
    for (let i = 0; i <= steps; i++) {
      drift = Math.max(-2, Math.min(2, drift + (this.random() - 0.5)));
      const x = x0 + ((x1 - x0) * i) / steps + (y1 !== y0 ? drift : 0);
      const y = y0 + ((y1 - y0) * i) / steps + (x1 !== x0 ? drift : 0);
      this.rect(Math.round(x) - 1, Math.round(y) - 1, 3, 3, colour);
    }
  }
  outline(x: number, y: number, w: number, h: number, colour: Rgb): void {
    this.stroke(x, y, x + w, y, colour);
    this.stroke(x + w, y, x + w, y + h, colour);
    this.stroke(x + w, y + h, x, y + h, colour);
    this.stroke(x, y + h, x, y, colour);
  }
  decoded(): DecodedImage {
    const rgb = new Uint8Array(this.width * this.height * 3);
    for (let i = 0; i < this.width * this.height; i++)
      rgb.set(this.rgba.subarray(i * 4, i * 4 + 3), i * 3);
    return {
      width: this.width,
      height: this.height,
      rgba: this.rgba,
      mime: "image/png",
      bytes: encodePngRgb(this.width, this.height, rgb),
    };
  }
}

function harbourPlate(): DecodedImage {
  const c = new Canvas(640, 400, EGA(11));
  c.rect(0, 220, 640, 180, EGA(1));
  c.disc(510, 80, 40, EGA(14));
  c.rect(60, 200, 260, 30, EGA(6));
  for (const x of [80, 150, 220, 290]) c.rect(x, 230, 12, 70, EGA(6));
  c.rect(400, 250, 140, 30, EGA(6));
  c.stroke(470, 250, 470, 170, EGA(0));
  c.stroke(0, 220, 640, 220, EGA(0));
  c.outline(60, 200, 260, 30, EGA(0));
  c.outline(400, 250, 140, 30, EGA(0));
  return c.decoded();
}

/** Where the door is drawn, in plate pixels. */
const DOOR = { x: 520, y: 180, w: 40, h: 80 } as const;

function doorPlate(): DecodedImage {
  const c = new Canvas(640, 400, EGA(8));
  c.rect(0, 260, 640, 140, EGA(6));
  c.rect(100, 80, 80, 60, EGA(9));
  c.outline(100, 80, 80, 60, EGA(0));
  c.rect(DOOR.x, DOOR.y, DOOR.w, DOOR.h, EGA(4));
  c.outline(DOOR.x, DOOR.y, DOOR.w, DOOR.h, EGA(0));
  c.stroke(0, 260, 640, 260, EGA(0));
  return c.decoded();
}

function moodBoard(): DecodedImage {
  const c = new Canvas(480, 320, EGA(15));
  [5, 8, 9, 14, 0].forEach((colour, index) => c.rect(16 + index * 90, 16, 80, 288, EGA(colour)));
  return c.decoded();
}

/** Four walking poses, 48x64 cells on a magenta key, drawn at twice size. */
function heroSheet(): DecodedImage {
  const c = new Canvas(384, 128, MAGENTA_KEY);
  for (let pose = 0; pose < 4; pose++) {
    const left = pose * 96;
    c.disc(left + 48, 22, 12, EGA(12));
    c.rect(left + 34, 36, 28, 44, EGA(4));
    const stride = [0, 8, 0, -8][pose]!;
    c.rect(left + 36 + stride, 80, 10, 40, EGA(1));
    c.rect(left + 50 - stride, 80, 10, 40, EGA(1));
  }
  return c.decoded();
}

function swatch(): DecodedImage {
  const c = new Canvas(256, 256, EGA(10));
  c.outline(8, 8, 240, 240, EGA(2));
  return c.decoded();
}

// --- Scoring ------------------------------------------------------------

function nearestEga(r: number, g: number, b: number): number {
  let best = 0;
  let distance = Infinity;
  EGA_RGB.forEach(([er, eg, eb], index) => {
    const d = (r - er) ** 2 + (g - eg) ** 2 + (b - eb) ** 2;
    if (d < distance) [best, distance] = [index, d];
  });
  return best;
}

/** The image sampled onto the 160x168 picture grid, as EGA indices. */
function quantised(image: DecodedImage): Uint8Array {
  const out = new Uint8Array(160 * 168);
  for (let y = 0; y < 168; y++)
    for (let x = 0; x < 160; x++) {
      const sx = Math.floor(((x + 0.5) * image.width) / 160);
      const sy = Math.floor(((y + 0.5) * image.height) / 168);
      const at = (sy * image.width + sx) * 4;
      out[y * 160 + x] = nearestEga(image.rgba[at]!, image.rgba[at + 1]!, image.rgba[at + 2]!);
    }
  return out;
}

function mainColours(cells: Uint8Array): Set<number> {
  const counts = new Array<number>(16).fill(0);
  for (const cell of cells) counts[cell]!++;
  return new Set(counts.flatMap((count, index) => (count / cells.length >= 0.05 ? [index] : [])));
}

function jaccard(a: Set<number>, b: Set<number>): number {
  const union = new Set([...a, ...b]).size;
  return union ? [...a].filter((x) => b.has(x)).length / union : 0;
}

function renderedRoom(session: Session, room: number): Uint8Array | null {
  const payload = session.state.container.getResource("picture", room);
  if (!payload) return null;
  const surface = createPictureSurface();
  renderPicture(payload, surface, { profile: session.state.profile });
  return surface.visual;
}

type Scores = Record<string, number | null>;

function roomScores(session: Session, room: number, image: DecodedImage): Scores {
  const visual = renderedRoom(session, room);
  if (!visual) return { paletteOverlap: null, layoutAgreement: null };
  const reference = quantised(image);
  let same = 0;
  for (let i = 0; i < visual.length; i++) if (visual[i] === reference[i]) same++;
  return {
    paletteOverlap: jaccard(mainColours(visual), mainColours(reference)),
    layoutAgreement: same / visual.length,
  };
}

const isKey = (image: DecodedImage, x: number, y: number): boolean => {
  const at = (y * image.width + x) * 4;
  return (
    image.rgba[at] === MAGENTA_KEY[0] &&
    image.rgba[at + 1] === MAGENTA_KEY[1] &&
    image.rgba[at + 2] === MAGENTA_KEY[2]
  );
};

/**
 * The figure's mask in a pose cell: its bounding box on the key colour,
 * sampled to w x h, so a cel cropped to the figure compares like for like.
 */
function poseMask(image: DecodedImage, pose: number, w: number, h: number): Uint8Array {
  const cellW = image.width / 4;
  let [left, top, right, bottom] = [Infinity, Infinity, -1, -1];
  for (let y = 0; y < image.height; y++)
    for (let x = pose * cellW; x < (pose + 1) * cellW; x++)
      if (!isKey(image, x, y)) {
        [left, top] = [Math.min(left, x), Math.min(top, y)];
        [right, bottom] = [Math.max(right, x), Math.max(bottom, y)];
      }
  const mask = new Uint8Array(w * h);
  if (right < 0) return mask;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sx = Math.floor(left + ((x + 0.5) * (right - left + 1)) / w);
      const sy = Math.floor(top + ((y + 0.5) * (bottom - top + 1)) / h);
      mask[y * w + x] = isKey(image, sx, sy) ? 0 : 1;
    }
  return mask;
}

function celIoU(payload: Uint8Array | null, image: DecodedImage): number | null {
  if (!payload) return null;
  let cel;
  try {
    cel = parseView(payload).loops[0]?.cels[0];
  } catch {
    return null;
  }
  if (!cel) return null;
  const reference = poseMask(image, 0, cel.width, cel.height);
  let both = 0;
  let either = 0;
  for (let i = 0; i < reference.length; i++) {
    const drawn = cel.pixels[i] !== cel.transparentColor ? 1 : 0;
    if (drawn && reference[i]) both++;
    if (drawn || reference[i]) either++;
  }
  return either ? both / either : 0;
}

// --- Cases --------------------------------------------------------------

interface RunOutcome {
  text: string;
  scores: Scores;
  match: boolean;
}

interface ReferenceCase {
  readonly id: string;
  readonly references: () => StoredReference[];
  /** Stored record ids the player attaches; a room build attaches its room's art itself. */
  readonly attach: readonly string[];
  readonly run: (session: Session, attachments: TurnReferences) => Promise<RunOutcome>;
}

function roomCase(
  id: string,
  room: number,
  brief: string,
  note: string,
  draw: () => DecodedImage,
  score: (session: Session, image: DecodedImage) => { scores: Scores; match: boolean },
): ReferenceCase {
  const image = draw();
  return {
    id,
    references: () => [roomReference(`ref-${id}`, room, brief, IDENTITY, image)],
    attach: [`ref-${id}`],
    async run(session, attachments) {
      const response = await session.handle(
        { op: "room", context: { room, from: 1, playerNotes: [note] } },
        undefined,
        attachments,
      );
      return { text: response ? `room ${room} written` : "", ...score(session, image) };
    },
  };
}

const CASES: Record<string, ReferenceCase> = {
  "harbour-room": roomCase(
    "harbour-room",
    5,
    "the harbour at dawn",
    "Build this room from the attached reference art: keep its layout and colours.",
    harbourPlate,
    (session, image) => {
      const scores = roomScores(session, 5, image);
      return {
        scores,
        match: (scores["paletteOverlap"] ?? 0) >= 0.5 && (scores["layoutAgreement"] ?? 0) >= 0.35,
      };
    },
  ),
  "door-room": roomCase(
    "door-room",
    6,
    "the records corridor",
    "Build this room from the attached reference art. The small red door on the right wall is the way east; draw it exactly where the plate has it.",
    doorPlate,
    (session, image) => {
      const visual = renderedRoom(session, 6);
      if (!visual) return { scores: { doorRed: null }, match: false };
      const x0 = Math.floor((DOOR.x * 160) / image.width);
      const x1 = Math.ceil(((DOOR.x + DOOR.w) * 160) / image.width);
      const y0 = Math.floor((DOOR.y * 168) / image.height);
      const y1 = Math.ceil(((DOOR.y + DOOR.h) * 168) / image.height);
      let red = 0;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) if ([4, 12].includes(visual[y * 160 + x]!)) red++;
      const doorRed = red / ((x1 - x0) * (y1 - y0));
      return { scores: { doorRed, ...roomScores(session, 6, image) }, match: doorRed >= 0.5 };
    },
  ),
  "mood-room": roomCase(
    "mood-room",
    7,
    "night market mood",
    "Build this room in the colours of the attached mood board.",
    moodBoard,
    (session, image) => {
      const visual = renderedRoom(session, 7);
      if (!visual) return { scores: { paletteOverlap: null }, match: false };
      const board = new Set([5, 8, 9, 14, 0]);
      const paletteOverlap = jaccard(mainColours(visual), board);
      return {
        scores: { paletteOverlap, ...roomScores(session, 7, image) },
        match: paletteOverlap >= 0.5,
      };
    },
  ),
  "hero-view": (() => {
    const image = heroSheet();
    const references = () => [
      stageCharacterView(
        "ref-hero-view",
        20,
        "the courier, red jacket",
        IDENTITY,
        [{ decoded: image, facing: "right" }],
        { poses: 4, celHeight: 32, symmetric: true },
      ),
    ];
    // The deterministic sheet converter's own VIEW: the baseline IoU.
    const converted = base64ToBytes(references()[0]!.staged!.payload);
    return {
      id: "hero-view",
      references,
      attach: ["ref-hero-view"],
      async run(session, attachments) {
        const result = await session.runPowerUp(
          "Write view 20 from the attached character sheet: loop 0 is the right-facing walk, one cel per pose, 32 pixels tall.",
          1,
          attachments,
        );
        const silhouetteIoU = celIoU(session.state.container.getResource("view", 20), image);
        return {
          text: result.text,
          scores: { silhouetteIoU, convertedIoU: celIoU(converted, image) },
          match: (silhouetteIoU ?? 0) >= 0.6,
        };
      },
    };
  })(),
  "ledger-swatch": {
    id: "ledger-swatch",
    references: () => [
      roomReference("ref-ledger-swatch", 3, "the ledger stand's new colour", IDENTITY, swatch()),
    ],
    attach: ["ref-ledger-swatch"],
    async run(session, attachments) {
      const source = TUTORIAL_PICTURE_SOURCES[3]!;
      const profile = session.state.profile;
      const compiled = compileEditDocument(parsePictureDocument(source).document, profile);
      const result = await session.runPowerUp(
        "Recolour only the ledger-stand item in PICTURE 3 to the attached swatch. Preserve other items.",
        3,
        attachments,
      );
      const after = compileEditDocument(
        parsePictureDocument(session.state.sources.pictures.get(3) ?? source).document,
        profile,
      );
      const area = footprintMask(compiled, "ledger-stand", "visual");
      let cells = 0;
      let green = 0;
      for (let i = 0; i < area.length; i++)
        if (area[i] === 1) {
          cells++;
          if (after.visual[i] === 10) green++;
        }
      const swatchShare = cells ? green / cells : 0;
      return { text: result.text, scores: { swatchShare }, match: swatchShare >= 0.5 };
    },
  },
};

// --- Runner -------------------------------------------------------------

interface Args {
  cases: string[];
  arms: Arm[];
  provider: LlmConfig["provider"];
  model?: string;
  effort?: LlmConfig["effort"];
  budgetUsd?: number;
  repeats: number;
  dryRun: boolean;
  live: boolean;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    cases: [],
    arms: ["before", "after"],
    provider: "stub",
    repeats: 1,
    dryRun: false,
    live: false,
    out: "evals/results/references",
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]!;
    if (key === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (key === "--live") {
      args.live = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) throw new Error(`${key} needs a value.`);
    if (key === "--case") args.cases = value.split(",");
    else if (key === "--arm")
      args.arms = value === "both" ? ["before", "after"] : (value.split(",") as Arm[]);
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
  if (!args.arms.length || args.arms.some((arm) => arm !== "before" && arm !== "after"))
    throw new Error("--arm must be before, after or both.");
  if (!Number.isInteger(args.repeats) || args.repeats < 1 || args.repeats > 5)
    throw new Error("--repeats must be an integer from 1 to 5.");
  if (args.provider === "stub" && !args.dryRun)
    throw new Error("Use --dry-run for the offline stub.");
  if (args.provider !== "stub") {
    const model = args.model ?? DEFAULT_MODELS[args.provider];
    if (!MODEL_CAPABILITIES[model]?.price)
      throw new Error(`No price is known for ${model}, so --budget-usd could not be enforced.`);
    args.budgetUsd = assertLiveRun({
      live: args.live,
      budgetUsd: args.budgetUsd,
      plan: `the reference cases ${args.cases.join(", ")} (${args.arms.join(" and ")}) with ${args.provider} ${model}`,
      offline: "--dry-run",
    });
  }
  return args;
}

function configFor(args: Args, arm: Arm, budgetUsd: number): LlmConfig {
  if (args.provider === "stub")
    return {
      provider: "stub",
      apiKey: "",
      model: "offline-stub",
      budgetUsd,
      stubScript: arm === "after" ? "reference-region" : "reference-never",
    };
  const apiKey =
    args.provider === "openai"
      ? (process.env["OPENAI_API_KEY"] ?? "")
      : (process.env["ANTHROPIC_API_KEY"] ?? "");
  if (!apiKey)
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
  arm: Arm;
  repeat: number;
  match: boolean;
  scores: Scores;
  viewCalls: number;
  /** Each read_reference_image call's size, region and grid, in call order. */
  views: { size: unknown; region: unknown; grid: unknown }[];
  /** Attached art the turn wrote from or said it matched without viewing it. */
  unviewed: string[];
  requests: number;
  tokens: { input: number; cached: number; output: number };
  costUsd: number;
  usageIncomplete: boolean;
  text: string;
  error?: string;
  wallMs: number;
}

async function runCase(
  bench: ReferenceCase,
  arm: Arm,
  args: Args,
  repeat: number,
  allowance: number,
  dir: string,
): Promise<RunReport> {
  const tutorial = buildTutorial();
  const telemetry: { usage?: LlmUsage; usageIncomplete?: boolean }[] = [];
  let viewCalls = 0;
  const views: RunReport["views"] = [];
  const unviewed: string[] = [];
  const config = configFor(args, arm, allowance);
  const session = AgentSession.fromAuthoredData(
    config,
    (kind, _message, data) => {
      const details = data as Record<string, unknown> | undefined;
      if (kind === "telemetry") telemetry.push(details?.["telemetry"] as (typeof telemetry)[0]);
      if (kind === "request" && details?.["tool"] === "read_reference_image") {
        viewCalls++;
        const call = (details["args"] ?? {}) as Record<string, unknown>;
        views.push({ size: call["size"], region: call["region"], grid: call["grid"] });
      }
      const missed = details?.["unviewedReferences"];
      if (Array.isArray(missed)) unviewed.push(...(missed as string[]));
    },
    tutorial.files,
    tutorial.words,
    [],
    undefined,
    tutorial.project!.authoringState,
  );
  const stored = bench.references();
  const attachments: TurnReferences =
    arm === "after"
      ? { referenceIds: bench.attach }
      : {
          referenceIds: bench.attach,
          legacyImages: stored
            .filter((reference) => bench.attach.includes(reference.id))
            .flatMap(referenceAgentImages),
        };
  if (arm === "after")
    session.setRuntime({
      referenceArt: async (attached) => referenceSource(stored, attached, decodePng),
    });
  let paused = "";
  const monitor = setInterval(() => {
    const task = session.task.snapshot();
    if (task.status !== "paused") return;
    paused = task.reason;
    session.task.cancel();
  }, 20);
  const timeout = setTimeout(() => {
    paused = "timed out";
    session.task.cancel();
  }, RUN_TIMEOUT_MS);
  const t0 = performance.now();
  let outcome: RunOutcome | null = null;
  let error: string | undefined;
  try {
    outcome = await bench.run(session, attachments);
  } catch (caught) {
    error = paused ? `paused: ${paused}` : String(caught);
  } finally {
    clearInterval(monitor);
    clearTimeout(timeout);
  }
  const costs = telemetry.map((t) => (t.usage ? requestCost(config.model, t.usage) : 0));
  const priced = costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0);
  const tokens = { input: 0, cached: 0, output: 0 };
  for (const t of telemetry) {
    tokens.input += t.usage?.input ?? 0;
    tokens.cached += t.usage?.cachedInput ?? 0;
    tokens.output += t.usage?.output ?? 0;
  }
  writeFileSync(
    join(dir, `${bench.id}-${arm}-r${repeat}.transcript.json`),
    JSON.stringify(session.getTranscript(), (_key, value: unknown) =>
      typeof value === "string" && value.length > 2000 ? `[${value.length} chars]` : value,
    ),
  );
  return {
    case: bench.id,
    arm,
    repeat,
    match: outcome?.match ?? false,
    scores: outcome?.scores ?? {},
    viewCalls,
    views,
    unviewed: [...new Set(unviewed)],
    requests: telemetry.length,
    tokens,
    costUsd: Math.max(priced, session.task.snapshot().spent),
    usageIncomplete:
      session.task.snapshot().usageIncomplete || telemetry.some((t) => t.usageIncomplete === true),
    text: (outcome?.text ?? "").slice(0, 400),
    ...(error ? { error } : {}),
    wallMs: performance.now() - t0,
  };
}

/** Per case and arm: runs, matches, mean tokens, cost and read_reference_image calls. */
function compare(runs: readonly RunReport[]) {
  const rows: Record<string, unknown>[] = [];
  for (const id of new Set(runs.map((run) => run.case)))
    for (const arm of ["before", "after"] as const) {
      const group = runs.filter((run) => run.case === id && run.arm === arm);
      if (!group.length) continue;
      const mean = (pick: (run: RunReport) => number) =>
        group.reduce((sum, run) => sum + pick(run), 0) / group.length;
      rows.push({
        case: id,
        arm,
        runs: group.length,
        matches: group.filter((run) => run.match).length,
        meanInputTokens: Math.round(mean((run) => run.tokens.input)),
        meanOutputTokens: Math.round(mean((run) => run.tokens.output)),
        meanCostUsd: mean((run) => run.costUsd),
        meanViewCalls: mean((run) => run.viewCalls),
        underFetch: group.filter((run) => run.unviewed.length).length,
      });
    }
  return rows;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cap = args.dryRun ? Infinity : args.budgetUsd!;
  const model = args.model ?? DEFAULT_MODELS[args.provider];
  const dir = join(
    args.out,
    `${new Date().toISOString().replace(/[:.]/g, "-")}-${args.dryRun ? "dry-run" : `${args.provider}-${model}`}`,
  );
  mkdirSync(dir, { recursive: true });
  const runs: RunReport[] = [];
  const skipped: { case: string; arm: Arm; repeat: number; reason: string }[] = [];
  let spent = 0;
  for (const id of args.cases)
    for (let repeat = 1; repeat <= args.repeats; repeat++)
      for (const arm of args.arms) {
        const remaining = cap - spent;
        if (remaining < MIN_RUN_USD) {
          skipped.push({
            case: id,
            arm,
            repeat,
            reason: `budget spent ($${spent.toFixed(4)} of $${cap})`,
          });
          continue;
        }
        const report = await runCase(
          CASES[id]!,
          arm,
          args,
          repeat,
          Number.isFinite(remaining) ? remaining : 1000,
          dir,
        );
        spent += report.costUsd;
        runs.push(report);
        console.log(
          `${report.match ? "match" : "no match"} ${id} ${arm} r${repeat}: ${report.viewCalls} views` +
            (report.views.length
              ? ` (${report.views.map((v) => `${v.size ?? "default"}${v.region ? "+region" : ""}${v.grid ? "+grid" : ""}`).join(", ")})`
              : "") +
            `, ` +
            `${report.requests} requests, ${report.tokens.input} input tokens, $${report.costUsd.toFixed(4)}` +
            (report.unviewed.length ? `, unviewed ${report.unviewed.join(", ")}` : "") +
            (report.error ? ` — ${report.error}` : ""),
        );
      }
  const summary = {
    provider: args.provider,
    model,
    dryRun: args.dryRun,
    budgetUsd: Number.isFinite(cap) ? cap : null,
    comparison: compare(runs),
    runs,
    skipped,
    totals: {
      runs: runs.length,
      matches: runs.filter((run) => run.match).length,
      viewCalls: runs.reduce((n, run) => n + run.viewCalls, 0),
      requests: runs.reduce((n, run) => n + run.requests, 0),
      costUsd: spent,
      overshootUsd: Number.isFinite(cap) ? Math.max(0, spent - cap) : 0,
      usageIncomplete: runs.some((run) => run.usageIncomplete),
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
