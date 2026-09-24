/**
 * Genesis quality/cost matrix.
 *
 *   npm run eval:matrix -- <results-dir> <out-dir>
 *
 * Discovers every completed run (`<lane>--<case>--r<N>.report.json` with a
 * sibling `.resources/` folder) in <results-dir>, groups by case, and writes:
 *   <out-dir>/metrics.json                  all measurements, per case, per run
 *   <out-dir>/matrix.md                     cost / content / fidelity / brief tables per case
 *   <out-dir>/<case>/<lane>-visual.png      rendered picture (4x wide, 2x tall)
 *   <out-dir>/<case>/<lane>-priority.png    priority/control plane, EGA palette (AGI editor convention)
 *   <out-dir>/<case>/<lane>-walk.png        reachability overlay from the ego start
 *   <out-dir>/<case>/<lane>-first-frame.png copy of the harness first frame
 *   <out-dir>/<case>/<lane>.logic.txt       disassembly of every logic (with dictionary words)
 * A hand-written `<out-dir>/reading-<case>.md` (optional) is appended to that
 * case's section of matrix.md, so judgment survives reruns.
 *
 * Every table is measured from files except "Brief checklist", which is a
 * keyword heuristic (labelled as such). The engine code is imported from this
 * repo; nothing is written there. Output is deterministic for the same inputs
 * (runs sorted by code point, no timestamps), so a regenerated metrics.json
 * diffs clean against a committed copy.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

import { openContainer } from "../src/container/container.ts";
import { canonicalResourceName } from "../src/container/playableFiles.ts";
import { parseLogicResource } from "../src/logic/resource.ts";
import { decodeLogicInsns, disassembleLogic, type DecodedInsn } from "../src/logic/disassembler.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { parseWordsTok } from "../src/logic/words.ts";
import { renderPicture } from "../src/picture/renderer.ts";
import { computePictureMetrics } from "../src/picture/metrics.ts";
import { EGA_RGB } from "../src/picture/png.ts";
import { createPictureSurface, type GameContainer, type PictureSurface } from "../src/types.ts";
import { parseView } from "../src/view/view.ts";
import { parseSound } from "../src/sound/sound.ts";
import { buildSound } from "../src/agent/soundBuilder.ts";
import { parseGameTests } from "../src/agent/gameTests.ts";
import { readInventoryObjects } from "../src/agent/inventory.ts";
import { scanStaticExits, type EdgeSide } from "../src/agent/roomMap.ts";
import { DEFAULT_V2_PROFILE } from "../src/runtime/profile.ts";
import {
  BASE_TEMPLATE_DEATH_LOGIC_SOURCE,
  BASE_TEMPLATE_DEATH_TRACKS,
  BASE_TEMPLATE_LOGIC0_SOURCE,
  TEMPLATE_DEATH_LOGIC,
} from "../src/agent/baseTemplate.ts";
import { Engine, type EngineHost, type ScreenObjectState } from "../src/runtime/engine.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Ego position, live horizon and room after booting the game in the real interpreter. */
interface BootProbe {
  room: number;
  x: number;
  y: number;
  width: number;
  horizon: number;
}

/**
 * Boot the game in the real interpreter for a few cycles and read where the
 * ego actually stands, the live horizon and the room. null when the boot
 * throws or parks on a host interaction before the ego is placed.
 */
function bootProbe(container: GameContainer, dict: ReadonlyMap<string, number>): BootProbe | null {
  try {
    const host: EngineHost = {
      print: () => {},
      displayAt: () => {},
      statusLine: () => {},
      takeInputLine: () => null,
      takeKeys: () => [],
    };
    const engine = new Engine(container, host, dict, { profile: DEFAULT_V2_PROFILE });
    let ego: ScreenObjectState | null = null;
    for (let i = 0; i < 6; i++) {
      try {
        engine.tick();
      } catch {
        break;
      }
      ego = engine.readObjects().find((o) => o.num === 0) ?? ego;
    }
    return ego
      ? { room: engine.vars[0]!, x: ego.x, y: ego.y, width: ego.width, horizon: engine.horizon }
      : null;
  } catch {
    return null;
  }
}

const W = 160;
const H = 168;
const PRIORITY_BASE = 48; // engine priorityForY default
const priorityForY = (y: number) =>
  y < PRIORITY_BASE
    ? 4
    : Math.min(15, 5 + Math.floor(((y - PRIORITY_BASE) * 10) / (168 - PRIORITY_BASE)));
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const pct = (n: number) => round(n * 100, 1);
const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const readJson = (p: string): unknown => JSON.parse(readFileSync(p, "utf8"));
const bytesEq = (a: Uint8Array | null | undefined, b: Uint8Array | null | undefined) =>
  !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);
/** Deterministic ordering for serializations: code points, never locale (AGENTS.md). */
const compareCodePoints = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- PNG output
function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function pngRgb(width: number, height: number, rgb: Uint8Array): Uint8Array {
  const raw = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y++)
    raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1);
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(sum(parts.map((p) => p.length)));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
/** 160x168 cell RGB -> PNG scaled 4x horizontally, 2x vertically (AGI's double-wide pixels). */
function writeCells(path: string, cellRgb: (i: number) => readonly [number, number, number]) {
  const sx = 4,
    sy = 2,
    w = W * sx,
    h = H * sy;
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = cellRgb(((y / sy) | 0) * W + ((x / sx) | 0));
      rgb.set(c, (y * w + x) * 3);
    }
  writeFileSync(path, pngRgb(w, h, rgb));
}

// ---------------------------------------------------------------- discovery
interface RunRef {
  stem: string;
  lane: string;
  case: string;
  repeat: string;
  dir: string;
}
function discover(dir: string): RunRef[] {
  const runs: RunRef[] = [];
  for (const name of readdirSync(dir)) {
    const m = /^(.+)--(.+)--(r\d+)\.report\.json$/.exec(name);
    if (!m) continue;
    const stem = name.slice(0, -".report.json".length);
    const res = join(dir, `${stem}.resources`);
    if (!existsSync(res) || !statSync(res).isDirectory()) continue;
    runs.push({ stem, lane: m[1]!, case: m[2]!, repeat: m[3]!, dir });
  }
  return runs.sort((a, b) => compareCodePoints(a.stem, b.stem));
}

// ---------------------------------------------------------------- brief
interface Brief {
  maxScore: number | null;
  points: number[];
  verbs: string[];
  nouns: string[];
  names: string[];
  startingRoom: string;
}
function readBrief(caseName: string): Brief | null {
  const p = join(REPO_ROOT, "games", caseName, "SKILL.md");
  if (!existsSync(p)) return null;
  const md = readFileSync(p, "utf8");
  const section = (title: string) => {
    const m = new RegExp(`## ${title}\\n([\\s\\S]*?)(?=\\n## |$)`).exec(md);
    return m ? m[1]!.trim() : "";
  };
  const list = (line: string) =>
    (new RegExp(`- ${line}:\\s*(.+)`).exec(md)?.[1] ?? "")
      .split(/,\s*/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  const maxScore = /max (\d+)/.exec(md);
  const points = [...section("Point table[^\\n]*").matchAll(/^\|\s*(\d+)\s*\|/gm)].map((m) =>
    Number(m[1]),
  );
  const names = [...new Set([...md.matchAll(/\*\*([^*]+)\*\*/g)].map((m) => m[1]!.trim()))].filter(
    (n) => /^[A-Z]/.test(n) && !/^The /.test(n) && !/[.]$/.test(n),
  );
  return {
    maxScore: maxScore ? Number(maxScore[1]) : null,
    points,
    verbs: list("Verbs"),
    nouns: list("Nouns"),
    names,
    startingRoom: section("Starting room"),
  };
}

/**
 * Hand-authored starting-room checklist per case (heuristic keyword checks).
 * kinds: msg = regex over all room-logic message text; said = any word of the
 * group appears in a said() pattern; inv = inventory item name; exits = number
 * of literal new.room targets from the start room; death = call(255) reachable
 * from a said() block in the start room; score = an addn(v3, N) award;
 * egoColor / picColor = EGA colour indices present in the ego view / picture.
 */
type Check =
  | { label: string; kind: "msg"; re: RegExp }
  | { label: string; kind: "said"; words: string[] }
  | { label: string; kind: "inv"; re: RegExp }
  | { label: string; kind: "exits"; min: number }
  | { label: string; kind: "death" }
  | { label: string; kind: "score"; points: number }
  | { label: string; kind: "egoColor"; any: number[] }
  | { label: string; kind: "picColor"; all: number[][] };
const CHECKLISTS: Record<string, Check[]> = {
  "knights-trial": [
    { label: "royal notice (message)", kind: "msg", re: /notice|proclamation/i },
    { label: "notice readable (said read/look notice)", kind: "said", words: ["notice"] },
    { label: "bread takeable (said + OBJECT)", kind: "inv", re: /bread|loaf/i },
    { label: "lit lantern (OBJECT)", kind: "inv", re: /lantern|lamp/i },
    { label: "alligator in moat (message)", kind: "msg", re: /alligator/i },
    { label: "swimming warned then fatal (call 255)", kind: "death" },
    { label: "hall/drawbridge mentioned", kind: "msg", re: /drawbridge|hall/i },
    { label: "meadow mentioned", kind: "msg", re: /meadow/i },
    { label: ">=2 exits (hall + meadow)", kind: "exits", min: 2 },
    { label: "accept errand +10", kind: "score", points: 10 },
    { label: "King Brannoc named", kind: "msg", re: /brannoc/i },
    { label: "Wenna/Thornwall named", kind: "msg", re: /wenna|thornwall/i },
    { label: "ego red/brown (tunic, hair)", kind: "egoColor", any: [4, 12] },
    {
      label: "palette: green + blue + gray",
      kind: "picColor",
      all: [
        [2, 10],
        [1, 3, 9, 11],
        [7, 8],
      ],
    },
  ],
  "badge-of-millhaven": [
    { label: "precinct / front desk (message)", kind: "msg", re: /precinct|front desk|desk/i },
    { label: "Sergeant Prakash named", kind: "msg", re: /prakash/i },
    { label: "talk to Prakash (said talk)", kind: "said", words: ["talk"] },
    { label: "badge (OBJECT)", kind: "inv", re: /badge/i },
    { label: "radio (OBJECT)", kind: "inv", re: /radio/i },
    { label: "board readable (said board)", kind: "said", words: ["board"] },
    { label: "lead: driver/pharmacy mentioned", kind: "msg", re: /driver|pharmacy/i },
    { label: "receive assignment +10", kind: "score", points: 10 },
    { label: ">=1 exit", kind: "exits", min: 1 },
    { label: "Dana/Reyes named", kind: "msg", re: /dana|reyes/i },
    { label: "ego navy/blue uniform", kind: "egoColor", any: [1, 9] },
    {
      label: "palette: red brick + blue + green",
      kind: "picColor",
      all: [
        [4, 6, 12],
        [1, 9],
        [2, 3, 10],
      ],
    },
  ],
};

// ---------------------------------------------------------------- logic
interface TemplateDelta {
  changedMessages: number[];
  addedInsns: string[];
  removedInsns: number;
}
interface LogicInfo {
  num: number;
  bytes: number;
  codeBytes: number;
  messages: number;
  messageChars: number;
  template: "logic0" | "death" | null;
  templateStatus: "identical" | "modified" | "n/a";
  templateDelta?: TemplateDelta;
  actions: string[];
  tests: string[];
  saidPatterns: number[][];
  flags: number[];
  vars: number[];
  exits: { to: number; edge?: EdgeSide }[];
  pictures: number[];
  calls: number[];
  scoreAwards: number[];
  maxScore: number | null;
  horizon: number | null;
  egoView: number | null;
  egoStart: [number, number] | null;
  deathCalls: number;
  animatedObjects: number[];
  messagesText: string[];
}

const insnKey = (i: DecodedInsn): string =>
  i.kind === "if"
    ? `if ${i.text}`
    : i.kind === "action"
      ? `${i.name}(${(i.args ?? []).join(",")})`
      : i.kind;

function analyzeLogic(
  num: number,
  payload: Uint8Array,
  synthDict: ReadonlyMap<string, number>,
  templateBytes: ReadonlyMap<number, Uint8Array>,
): LogicInfo {
  const res = parseLogicResource(payload);
  const msgs = res.messages.filter((m): m is string => m !== null);
  const insns = decodeLogicInsns(payload, { dictionary: synthDict });
  const text = disassembleLogic(payload, { dictionary: synthDict });
  const body = text.replace(/^#message.*$/gm, "");
  const actions = insns.filter((i) => i.kind === "action" && i.name).map((i) => i.name!);
  const tests: string[] = [];
  for (const i of insns)
    if (i.kind === "if")
      for (const m of (i.text ?? "").matchAll(/([a-z][a-z0-9.]*)\(/g)) tests.push(m[1]!);
  const saidPatterns: number[][] = [];
  for (const m of body.matchAll(/said\(([^)]*)\)/g))
    saidPatterns.push([...m[1]!.matchAll(/"w(\d+)"|\b(\d+)\b/g)].map((w) => Number(w[1] ?? w[2])));
  const nums = (re: RegExp) =>
    [...new Set([...body.matchAll(re)].map((m) => Number(m[1])))].sort((a, b) => a - b);
  const scan = scanStaticExits(payload, undefined, num);
  const scoreAwards = insns
    .filter((i) => i.kind === "action" && i.name === "addn" && i.args?.[0] === 3)
    .map((i) => i.args![1]!);
  const maxScoreInsn = insns.find(
    (i) => i.kind === "action" && i.name === "assignn" && i.args?.[0] === 7,
  );
  const horizon = insns.find((i) => i.kind === "action" && i.name === "set.horizon");
  const ego = insns.find((i) => i.kind === "action" && i.name === "set.view" && i.args?.[0] === 0);
  const egoPos = insns.find(
    (i) => i.kind === "action" && i.name === "position" && i.args?.[0] === 0,
  );
  const animated = [
    ...new Set(
      insns.filter((i) => i.kind === "action" && i.name === "animate.obj").map((i) => i.args![0]!),
    ),
  ];
  const template = num === 0 ? "logic0" : num === TEMPLATE_DEATH_LOGIC ? "death" : null;
  let templateStatus: LogicInfo["templateStatus"] = "n/a";
  let templateDelta: TemplateDelta | undefined;
  const tpl = templateBytes.get(num);
  if (template && tpl) {
    if (bytesEq(tpl, payload)) templateStatus = "identical";
    else {
      templateStatus = "modified";
      const tRes = parseLogicResource(tpl);
      const changedMessages: number[] = [];
      const n = Math.max(tRes.messages.length, res.messages.length);
      for (let k = 0; k < n; k++)
        if (tRes.messages[k] !== res.messages[k]) changedMessages.push(k + 1);
      const tKeys = decodeLogicInsns(tpl, { dictionary: synthDict }).map(insnKey);
      const pool = new Map<string, number>();
      for (const k of tKeys) pool.set(k, (pool.get(k) ?? 0) + 1);
      const added: string[] = [];
      for (const k of insns.map(insnKey)) {
        const c = pool.get(k) ?? 0;
        if (c > 0) pool.set(k, c - 1);
        else if (k !== "goto" && !k.startsWith("if ") && k !== "return") added.push(k);
      }
      templateDelta = { changedMessages, addedInsns: added, removedInsns: sum([...pool.values()]) };
    }
  }
  return {
    num,
    bytes: payload.length,
    codeBytes: res.code.length,
    messages: msgs.length,
    messageChars: sum(msgs.map((m) => m.length)),
    template,
    templateStatus,
    ...(templateDelta ? { templateDelta } : {}),
    actions,
    tests,
    saidPatterns,
    flags: nums(/\bf(\d+)\b/g),
    vars: nums(/\bv(\d+)\b/g),
    exits: scan.targets.map((t) => ({ to: t.to, ...(t.edge ? { edge: t.edge } : {}) })),
    pictures: [...scan.pictures],
    calls: [...scan.calls],
    scoreAwards,
    maxScore: maxScoreInsn ? maxScoreInsn.args![1]! : null,
    horizon: horizon ? horizon.args![0]! : null,
    egoView: ego ? ego.args![1]! : null,
    egoStart: egoPos ? [egoPos.args![1]!, egoPos.args![2]!] : null,
    deathCalls: insns.filter(
      (i) => i.kind === "action" && i.name === "call" && i.args?.[0] === TEMPLATE_DEATH_LOGIC,
    ).length,
    animatedObjects: animated,
    messagesText: msgs,
  };
}

// ---------------------------------------------------------------- picture
const CONTROL_NAMES = ["barrier0", "conditional1", "trigger2", "water3"];
const EGA_NAMES = [
  "black",
  "blue",
  "green",
  "cyan",
  "red",
  "magenta",
  "brown",
  "lgray",
  "dgray",
  "lblue",
  "lgreen",
  "lcyan",
  "lred",
  "lmagenta",
  "yellow",
  "white",
];
interface ReachableColor {
  color: number;
  name: string;
  pctOfReachable: number;
}
interface PictureSummary {
  bytes: number;
  commands: number;
  colorsUsed: number[];
  distinctColors: number;
  fillPct: number;
  edgeDensity: number;
  regionCount: number;
  priorityBandsUsed: number[];
  priorityBandCount: number;
  depthDrawnPct: number;
  controlPct: Record<string, number>;
  controlAnyPct: number;
  horizon: number;
  horizonSanityPct: number;
  egoStart: [number, number] | null;
  egoStartPriority: number | null;
  egoStartStandable: boolean | null;
  egoStartYBand: number | null;
  reachablePctBelowHorizon: number | null;
  reachesEdges: string[];
  waterReachable: boolean;
  triggerReachable: boolean;
  reachableColors: ReachableColor[];
}
interface PicSummary extends PictureSummary {
  num: number;
  usedByRoom: boolean;
  startRoom: boolean;
}
interface PictureAnalysis {
  surface: PictureSurface;
  reach: Uint8Array;
  summary: PictureSummary;
}
function analyzePicture(
  payload: Uint8Array,
  horizon: number,
  egoStart: [number, number] | null,
  egoWidth: number,
): PictureAnalysis {
  const surface = createPictureSurface();
  renderPicture(payload, surface);
  let commands = 0;
  for (const b of payload) if (b >= 0xf0 && b !== 0xff) commands++;
  const metrics = computePictureMetrics(surface, { horizon });
  const pri = surface.priority;
  const vis = surface.visual;
  const hist = new Array<number>(16).fill(0);
  for (const p of pri) hist[p & 15]!++;
  const control: Record<string, number> = {};
  for (let c = 0; c < 4; c++) control[CONTROL_NAMES[c]!] = pct(hist[c]! / (W * H));
  const bands = hist.map((n, p) => (p >= 4 && n > 0 ? p : -1)).filter((p) => p >= 0);
  const depthDrawn = sum(hist.slice(5)) / (W * H);
  const colors = new Array<number>(16).fill(0);
  for (const v of vis) colors[v & 15]!++;
  // Reachability: 4-neighbour flood from the ego baseline over cells the ego
  // footprint could stand on (ego width scanned along the baseline; control 0
  // and 1 block, as with observe.blocks default), rows >= horizon.
  const standable = new Uint8Array(W * H);
  for (let y = horizon; y < H; y++)
    for (let x = 0; x < W; x++) {
      let ok = true;
      for (let i = 0; i < egoWidth && ok; i++) {
        const cx = x + i;
        if (cx > 159) break;
        const v = pri[y * W + cx]!;
        if (v === 0 || v === 1) ok = false;
      }
      standable[y * W + x] = ok ? 1 : 0;
    }
  const reach = new Uint8Array(W * H);
  let startOk: boolean | null = null;
  let startPriority: number | null = null;
  let reachable = 0;
  const edges = { left: false, right: false, bottom: false, horizon: false };
  let waterReachable = false;
  let triggerReachable = false;
  if (egoStart) {
    const [sx, sy] = egoStart;
    startPriority = sy >= 0 && sy < H && sx >= 0 && sx < W ? pri[sy * W + sx]! : null;
    startOk = sy >= horizon && sy < H && standable[sy * W + sx] === 1;
    if (startOk) {
      const stack = [sy * W + sx];
      reach[sy * W + sx] = 1;
      while (stack.length) {
        const i = stack.pop()!;
        reachable++;
        const x = i % W,
          y = (i / W) | 0;
        if (x === 0) edges.left = true;
        if (x + egoWidth - 1 >= 159) edges.right = true;
        if (y === H - 1) edges.bottom = true;
        if (y === horizon) edges.horizon = true;
        for (let k = 0; k < egoWidth; k++) {
          const v = pri[y * W + Math.min(159, x + k)]!;
          if (v === 3) waterReachable = true;
          if (v === 2) triggerReachable = true;
        }
        for (const n of [
          x > 0 ? i - 1 : -1,
          x < W - 1 ? i + 1 : -1,
          y > horizon ? i - W : -1,
          y < H - 1 ? i + W : -1,
        ])
          if (n >= 0 && !reach[n] && standable[n]) {
            reach[n] = 1;
            stack.push(n);
          }
      }
    }
  }
  const belowHorizon = (H - horizon) * W;
  // Which visual colours the ego can stand on: water-blue or wall-gray being
  // reachable is a walkability defect a human would spot at once.
  const reachColor = new Array<number>(16).fill(0);
  for (let i = 0; i < W * H; i++) if (reach[i]) reachColor[vis[i]! & 15]!++;
  const reachableColors = reachColor
    .map((n, c) => ({ c, n }))
    .filter((e) => e.n > 0)
    .sort((a, b) => b.n - a.n)
    .map((e) => ({
      color: e.c,
      name: EGA_NAMES[e.c]!,
      pctOfReachable: pct(e.n / Math.max(1, reachable)),
    }));
  return {
    surface,
    reach,
    summary: {
      bytes: payload.length,
      commands,
      colorsUsed: colors.map((n, c) => (n > 0 ? c : -1)).filter((c) => c >= 0),
      distinctColors: metrics.distinctColors,
      fillPct: pct(metrics.fillCoverage),
      edgeDensity: round(metrics.edgeDensity, 3),
      regionCount: metrics.regionCount,
      priorityBandsUsed: bands,
      priorityBandCount: bands.length,
      depthDrawnPct: pct(depthDrawn),
      controlPct: control,
      controlAnyPct: pct(sum(hist.slice(0, 4)) / (W * H)),
      horizon,
      horizonSanityPct: pct(metrics.priorityHorizonSanity),
      egoStart,
      egoStartPriority: startPriority,
      egoStartStandable: startOk,
      egoStartYBand: egoStart ? priorityForY(egoStart[1]) : null,
      reachablePctBelowHorizon: egoStart && startOk ? pct(reachable / belowHorizon) : null,
      reachesEdges:
        egoStart && startOk
          ? Object.entries(edges)
              .filter(([, v]) => v)
              .map(([k]) => k)
          : [],
      waterReachable,
      triggerReachable,
      reachableColors,
    },
  };
}

// ---------------------------------------------------------------- views / sounds
function analyzeView(num: number, payload: Uint8Array) {
  const view = parseView(payload);
  const loops = view.loops.map((l) => l.cels.length);
  let painted = 0;
  let maxW = 0,
    maxH = 0;
  const colors = new Set<number>();
  for (const loop of view.loops)
    for (const cel of loop.cels) {
      maxW = Math.max(maxW, cel.width);
      maxH = Math.max(maxH, cel.height);
      for (const p of cel.pixels)
        if (p !== cel.transparentColor) {
          painted++;
          colors.add(p);
        }
    }
  const first = view.loops[0]?.cels[0];
  return {
    num,
    bytes: payload.length,
    loops: loops.length,
    celsPerLoop: loops,
    cels: sum(loops),
    paintedPixels: painted,
    maxSize: `${maxW}x${maxH}`,
    firstCelWidth: first?.width ?? 0,
    colors: [...colors].sort((a, b) => a - b),
    description: view.description ?? null,
    fourDirWalk: loops.length >= 4 && loops.slice(0, 4).every((c) => c >= 2),
  };
}
type ViewInfo = ReturnType<typeof analyzeView>;
function analyzeSound(num: number, payload: Uint8Array, templateSound: Uint8Array) {
  const s = parseSound(payload);
  const voices = s.channels.filter((c) =>
    c.notes.some((n) => n.attenuation < 15 && (n.frequency > 0 || c.channelIndex === 3)),
  );
  const notes = sum(
    s.channels.map(
      (c) =>
        c.notes.filter((n) => n.attenuation < 15 && (n.frequency > 0 || c.channelIndex === 3))
          .length,
    ),
  );
  return {
    num,
    bytes: payload.length,
    template: bytesEq(payload, templateSound),
    durationTicks: s.duration,
    durationSec: round(s.durationSeconds, 2),
    voices: voices.map((c) => c.channelIndex),
    audibleNotes: notes,
  };
}
type SoundInfo = ReturnType<typeof analyzeSound>;

// ---------------------------------------------------------------- transcript / events
interface SessionEvent {
  type?: string;
  message?: string;
  data?: {
    tool?: string;
    args?: Record<string, unknown>;
    result?: { error?: unknown };
  };
}
interface TranscriptBlock {
  type?: string;
  text?: string;
  thinking?: string;
}
interface TranscriptItem {
  role?: string;
  type?: string;
  content?: unknown;
  summary?: { text?: string }[];
}
interface ToolFailure {
  tool: string;
  category: string;
  error: string;
}
function classifyError(msg: string): string {
  if (/has not been authored|expected future room/i.test(msg)) return "future-room-exit";
  if (/Source revision changed/i.test(msg)) return "stale-revision";
  if (/Invalid arguments/i.test(msg)) return "invalid-args";
  if (/Assembler error|AssemblerError/i.test(msg)) return "assembler";
  if (/Dictionary compilation|Invalid vocab/i.test(msg)) return "dictionary";
  if (/walkTo did not reach|unreach|needs_i/i.test(msg)) return "playtest-walk";
  if (/Expected .*observed|did not satisfy/i.test(msg)) return "playtest-expect";
  if (/did not accept|modal|pauses/i.test(msg)) return "playtest-input";
  if (/Picture|picture|Scene|scene|Shape/.test(msg)) return "picture/scene";
  if (/facings|view|View|cel/.test(msg)) return "view";
  return "other";
}
function analyzeSession(ref: RunRef) {
  const eventsPath = join(ref.dir, `${ref.stem}.events.json`);
  const transcriptPath = join(ref.dir, `${ref.stem}.transcript.json`);
  const toolCalls: Record<string, number> = {};
  const failures: ToolFailure[] = [];
  const pictureWrites: { tool: string; priorityCommands: number; controlCommands: number }[] = [];
  if (existsSync(eventsPath)) {
    const events = readJson(eventsPath) as SessionEvent[];
    for (const e of events) {
      const tool = e.data?.tool;
      if (e.type === "request" && tool) {
        toolCalls[tool] = (toolCalls[tool] ?? 0) + 1;
        const a = e.data?.args ?? {};
        const pictureEdit =
          tool === "write_picture" ||
          tool === "write_scene" ||
          (tool === "edit_resource_source" && a["kind"] === "picture");
        if (pictureEdit) {
          const s = [
            a["source"] ?? "",
            ...((a["edits"] ?? []) as { replace?: unknown }[]).map((ed) => ed.replace ?? ""),
          ].join("\n");
          const pri = [...s.matchAll(/^\s*pri (\d+)/gm)].map((m) => Number(m[1]));
          const shapes = JSON.stringify(a["shapes"] ?? []);
          const shapePri = [...shapes.matchAll(/"priority":(\d+)/g)].map((m) => Number(m[1]));
          const all = [...pri, ...shapePri];
          pictureWrites.push({
            tool,
            priorityCommands: all.length,
            controlCommands: all.filter((p) => p < 4).length,
          });
        }
      }
      if (e.type === "error" && tool) {
        const err = String(e.data?.result?.error ?? e.message ?? "");
        failures.push({
          tool,
          category: classifyError(err),
          error: err.replace(/\s+/g, " ").slice(0, 220),
        });
      }
    }
  }
  let proseChars = 0,
    proseBlocks = 0,
    reasoningVisibleChars = 0,
    assistantMessages = 0;
  const proseTexts: string[] = [];
  if (existsSync(transcriptPath)) {
    const t = readJson(transcriptPath) as TranscriptItem[];
    for (const item of t) {
      if (item.role === "assistant" && Array.isArray(item.content)) {
        assistantMessages++;
        for (const b of item.content as TranscriptBlock[]) {
          if ((b.type === "text" || b.type === "output_text") && b.text) {
            proseChars += b.text.length;
            proseBlocks++;
            proseTexts.push(b.text);
          }
          if (b.type === "thinking" && b.thinking) reasoningVisibleChars += b.thinking.length;
        }
      }
      if (item.type === "reasoning")
        for (const s of item.summary ?? []) reasoningVisibleChars += (s.text ?? "").length;
    }
  }
  const proseAll = proseTexts.join("\n");
  const byCategory: Record<string, number> = {};
  for (const f of failures) byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
  const representative = [
    "assembler",
    "dictionary",
    "invalid-args",
    "view",
    "picture/scene",
    "playtest-walk",
    "stale-revision",
  ]
    .map((c) => failures.find((f) => f.category === c))
    .filter((f): f is ToolFailure => !!f)
    .slice(0, 2);
  return {
    toolCalls,
    toolCallCount: sum(Object.values(toolCalls)),
    failures,
    failuresByCategory: byCategory,
    representativeErrors: representative,
    pictureWrites,
    pictureWritesUsingPriority: pictureWrites.filter((p) => p.priorityCommands > 0).length,
    assistantMessages,
    proseBlocks,
    proseChars,
    reasoningVisibleChars,
    proseMentionsPriority: (
      proseAll.match(/priority|control line|horizon|walkable|barrier/gi) ?? []
    ).length,
    proseSample: proseTexts.slice(0, 2).map((s) => s.trim().slice(0, 240)),
  };
}

// ---------------------------------------------------------------- per run
/** The fields of a genesis run's report.json this matrix reads. */
interface RunReport {
  provider?: string;
  model?: string;
  effort?: string;
  effectiveEffort?: string | null;
  promptVariant?: string;
  completion?: boolean;
  playtest?: { room?: number; simulation?: string; success?: boolean };
  usage?: { input?: number; cachedInput?: number; cacheWriteInput?: number; output?: number };
  costUsd?: number | null;
  usageIncomplete?: boolean;
  latency?: { totalMs?: number };
  providerRequests?: number;
  modelTurns?: number;
  toolCalls?: number;
  repairs?: { turns?: number; toolFailures?: number; categories?: unknown };
}
type TestSummary =
  | { name: string; room: number; steps: number; stepSummary: string; asserts: string[] }
  | { error: string };

function analyzeRun(ref: RunRef, outCaseDir: string, brief: Brief | null) {
  const report = readJson(join(ref.dir, `${ref.stem}.report.json`)) as RunReport;
  const resDir = join(ref.dir, `${ref.stem}.resources`);
  const files = new Map<string, Uint8Array>();
  for (const n of readdirSync(resDir))
    files.set(canonicalResourceName(n), new Uint8Array(readFileSync(join(resDir, n))));
  const container = openContainer(files);
  const words = parseWordsTok(files.get("WORDS.TOK")!);
  const dict = new Map(words.map((w) => [w.word, w.id]));
  const groups = new Map<number, string[]>();
  for (const w of words) groups.set(w.id, [...(groups.get(w.id) ?? []), w.word]);
  const synthDict = new Map([...groups.keys()].map((id) => [`w${id}`, id]));

  // Template bytecode as it would be assembled against this run's dictionary.
  const templateBytes = new Map<number, Uint8Array>();
  for (const [num, source] of [
    [0, BASE_TEMPLATE_LOGIC0_SOURCE],
    [TEMPLATE_DEATH_LOGIC, BASE_TEMPLATE_DEATH_LOGIC_SOURCE],
  ] as const) {
    try {
      templateBytes.set(
        num,
        assembleLogic(source, { dictionary: dict, profile: DEFAULT_V2_PROFILE }).payload,
      );
    } catch {
      /* dictionary lacks a template word: status stays n/a */
    }
  }
  const templateSound = buildSound(BASE_TEMPLATE_DEATH_TRACKS);

  const logics: LogicInfo[] = [];
  const disasm: string[] = [];
  const pictures = new Map<number, Uint8Array>();
  const views: ViewInfo[] = [];
  const sounds: SoundInfo[] = [];
  for (let n = 0; n < 256; n++) {
    const l = container.getResource("logic", n);
    if (l) {
      logics.push(analyzeLogic(n, l, synthDict, templateBytes));
      disasm.push(
        `// ===== logic ${n} (${l.length} bytes)\n${disassembleLogic(l, { dictionary: dict })}`,
      );
    }
    const p = container.getResource("picture", n);
    if (p) pictures.set(n, p);
    const v = container.getResource("view", n);
    if (v) views.push(analyzeView(n, v));
    const s = container.getResource("sound", n);
    if (s) sounds.push(analyzeSound(n, s, templateSound));
  }
  writeFileSync(join(outCaseDir, `${ref.lane}.logic.txt`), disasm.join("\n\n"));

  // Model-authored logic: everything except byte-identical template logics.
  const authored = logics.filter((l) => l.templateStatus !== "identical");
  const shared = new Set<number>([0, ...logics.flatMap((l) => l.calls)]);
  const rooms = logics.filter((l) => !shared.has(l.num));
  const startRoom = rooms.find((l) => l.num === (report.playtest?.room ?? 1)) ?? rooms[0];
  const cmds = (ls: LogicInfo[]) =>
    [...new Set(ls.flatMap((l) => [...l.actions, ...l.tests]))].sort(compareCodePoints);
  const saidAll = rooms.flatMap((l) => l.saidPatterns);
  const saidDistinct = new Set(saidAll.map((p) => p.join(" ")));
  const saidGroups = new Set(saidAll.flat());
  const saidWords = new Set([...saidGroups].flatMap((id) => groups.get(id) ?? []));
  const inventory = readInventoryObjects(files.get("OBJECT"), DEFAULT_V2_PROFILE);
  const roomMessages = rooms.flatMap((l) => l.messagesText).join("\n");
  const allMessages = logics.flatMap((l) => l.messagesText).join("\n");

  // Ego view and picture
  const egoViewNum = startRoom?.egoView ?? null;
  const egoView = views.find((v) => v.num === egoViewNum) ?? null;
  const boot = bootProbe(container, dict);
  const horizon = boot?.horizon ?? startRoom?.horizon ?? 36;
  const egoStart: [number, number] | null = boot ? [boot.x, boot.y] : (startRoom?.egoStart ?? null);
  const picSummaries: PicSummary[] = [];
  const roomPics = new Set(rooms.flatMap((l) => l.pictures));
  let firstPicDone = false;
  for (const [num, payload] of pictures) {
    const isStart = startRoom?.pictures.includes(num) ?? false;
    const a = analyzePicture(
      payload,
      horizon,
      isStart ? egoStart : null,
      boot?.width || egoView?.firstCelWidth || 1,
    );
    const suffix = !firstPicDone && (isStart || pictures.size === 1) ? "" : `-pic${num}`;
    if (suffix === "") firstPicDone = true;
    const vis = a.surface.visual;
    const pri = a.surface.priority;
    writeCells(join(outCaseDir, `${ref.lane}${suffix}-visual.png`), (i) => EGA_RGB[vis[i]! & 15]!);
    writeCells(
      join(outCaseDir, `${ref.lane}${suffix}-priority.png`),
      (i) => EGA_RGB[pri[i]! & 15]!,
    );
    if (isStart && egoStart) {
      const [ex, ey] = egoStart;
      writeCells(join(outCaseDir, `${ref.lane}${suffix}-walk.png`), (i) => {
        const x = i % W,
          y = (i / W) | 0;
        if (Math.abs(x - ex) <= 1 && Math.abs(y - ey) <= 1) return [255, 0, 255];
        if (y === horizon) return [255, 255, 0];
        const p = pri[i]!;
        if (p === 0) return [255, 0, 0];
        if (p === 1) return [255, 128, 0];
        if (p === 2) return [0, 255, 0];
        if (p === 3) return [0, 160, 255];
        const c = EGA_RGB[vis[i]! & 15]!;
        return a.reach[i] ? c : [c[0] >> 2, c[1] >> 2, c[2] >> 2];
      });
    }
    picSummaries.push({ num, usedByRoom: roomPics.has(num), startRoom: isStart, ...a.summary });
  }
  const firstFrame = join(ref.dir, `${ref.stem}.first-frame.png`);
  if (existsSync(firstFrame))
    copyFileSync(firstFrame, join(outCaseDir, `${ref.lane}-first-frame.png`));

  // Tests
  let tests: TestSummary[];
  try {
    tests = parseGameTests(files.get("TESTS.JSON")).tests.map((t) => ({
      name: t.name,
      room: t.room,
      steps: t.steps.length,
      stepSummary: t.steps
        .map((s) => (s["action"] === "command" ? `"${String(s["command"])}"` : s["action"]))
        .join(", "),
      asserts: t.expect
        ? Object.entries(t.expect)
            .filter(([, v]) => v !== null && v !== undefined)
            .map(([k, v]) =>
              k === "flags" || k === "vars"
                ? `${k}[${(v as unknown[]).length}]`
                : `${k}=${JSON.stringify(v).slice(0, 40)}`,
            )
        : [],
    }));
  } catch (e) {
    tests = [{ error: String(e) }];
  }

  const session = analyzeSession(ref);
  const authoredResourceCount =
    authored.length + pictures.size + views.length + sounds.filter((s) => !s.template).length;

  // Brief checklist
  const checklist: { label: string; pass: boolean }[] = [];
  for (const c of CHECKLISTS[ref.case] ?? []) {
    let pass = false;
    if (c.kind === "msg") pass = c.re.test(roomMessages) || c.re.test(allMessages);
    if (c.kind === "said") pass = c.words.some((w) => saidWords.has(w));
    if (c.kind === "inv") pass = inventory.some((i) => c.re.test(i.name));
    if (c.kind === "exits") pass = new Set((startRoom?.exits ?? []).map((e) => e.to)).size >= c.min;
    if (c.kind === "death") pass = (startRoom?.deathCalls ?? 0) > 0;
    if (c.kind === "score") pass = rooms.some((l) => l.scoreAwards.includes(c.points));
    if (c.kind === "egoColor")
      pass = !!egoView && c.any.some((col) => egoView.colors.includes(col));
    if (c.kind === "picColor") {
      const used = new Set(picSummaries.filter((p) => p.startRoom).flatMap((p) => p.colorsUsed));
      pass = c.all.every((alts) => alts.some((col) => used.has(col)));
    }
    checklist.push({ label: c.label, pass });
  }
  const lexicon = brief
    ? {
        verbsInDictionary: brief.verbs.filter((v) => v.split("/").some((w) => dict.has(w))).length,
        nounsInDictionary: brief.nouns.filter((v) => v.split("/").some((w) => dict.has(w))).length,
        verbsInSaid: brief.verbs.filter((v) => v.split("/").some((w) => saidWords.has(w))).length,
        nounsInSaid: brief.nouns.filter((v) => v.split("/").some((w) => saidWords.has(w))).length,
        verbs: brief.verbs.length,
        nouns: brief.nouns.length,
        namesInMessages: brief.names.filter((n) =>
          allMessages.toLowerCase().includes(n.toLowerCase().split(" ").pop()!),
        ),
        names: brief.names,
      }
    : null;

  const usage = report.usage ?? {};
  const cost = report.costUsd ?? null;
  return {
    stem: ref.stem,
    lane: ref.lane,
    case: ref.case,
    provider: report.provider,
    model: report.model,
    effort: report.effectiveEffort ?? report.effort,
    promptVariant: report.promptVariant,
    completion: report.completion,
    playtest: report.playtest,
    cost: {
      costUsd: cost,
      usageIncomplete: report.usageIncomplete,
      inputTokens: usage.input,
      cachedInputTokens: usage.cachedInput,
      cacheWriteTokens: usage.cacheWriteInput,
      outputTokens: usage.output,
      cachedPct: usage.input ? pct((usage.cachedInput as number) / usage.input) : null,
      wallSec: report.latency ? round((report.latency.totalMs as number) / 1000, 0) : null,
      providerRequests: report.providerRequests,
      modelTurns: report.modelTurns,
      toolCalls: report.toolCalls,
      repairTurns: report.repairs?.turns,
      toolFailures: report.repairs?.toolFailures,
      repairCategories: report.repairs?.categories,
      authoredResources: authoredResourceCount,
      costPerAuthoredResource:
        cost !== null && authoredResourceCount ? round(cost / authoredResourceCount, 3) : null,
    },
    logic: {
      count: logics.length,
      totalBytes: sum(logics.map((l) => l.bytes)),
      totalCodeBytes: sum(logics.map((l) => l.codeBytes)),
      roomLogics: rooms.map((l) => l.num),
      roomCodeBytes: sum(rooms.map((l) => l.codeBytes)),
      template: logics
        .filter((l) => l.template)
        .map((l) => ({ num: l.num, status: l.templateStatus, delta: l.templateDelta })),
      distinctCommandsAll: cmds(logics).length,
      distinctCommandsRooms: cmds(rooms).length,
      roomCommands: cmds(rooms),
      saidCalls: saidAll.length,
      saidDistinctPatterns: saidDistinct.size,
      saidWordGroups: saidGroups.size,
      vocabularyWords: words.length,
      vocabularyGroups: groups.size,
      roomMessages: sum(rooms.map((l) => l.messages)),
      roomMessageChars: sum(rooms.map((l) => l.messageChars)),
      allMessages: sum(logics.map((l) => l.messages)),
      exits: rooms.map((l) => ({ from: l.num, to: l.exits })),
      roomFlags: [...new Set(rooms.flatMap((l) => l.flags))].sort((a, b) => a - b),
      roomVars: [...new Set(rooms.flatMap((l) => l.vars))].sort((a, b) => a - b),
      scoreAwards: rooms.flatMap((l) => l.scoreAwards),
      maxScore: logics.find((l) => l.maxScore !== null)?.maxScore ?? null,
      deathCalls: sum(rooms.map((l) => l.deathCalls)),
      animatedObjects: startRoom?.animatedObjects ?? [],
      horizon: startRoom?.horizon ?? null,
      egoView: egoViewNum,
      egoStart,
      egoStartSource: boot ? "engine boot (6 cycles)" : "first position(o0) in start room",
      boot,
      perLogic: logics.map((l) => {
        const { messagesText: _m, actions: _a, tests: _t, saidPatterns, ...rest } = l;
        return { ...rest, saidCalls: saidPatterns.length };
      }),
    },
    inventory,
    pictures: picSummaries,
    views,
    sounds,
    tests,
    session,
    brief: {
      checklist,
      passed: checklist.filter((c) => c.pass).length,
      total: checklist.length,
      lexicon,
      maxScoreBrief: brief?.maxScore ?? null,
    },
    startMessages: startRoom?.messagesText ?? [],
  };
}

// ---------------------------------------------------------------- markdown
type Run = ReturnType<typeof analyzeRun>;
function table(head: string[], rows: (string | number | null | undefined)[][]): string {
  const cell = (v: unknown) =>
    v === null || v === undefined ? "-" : String(v).replace(/\|/g, "/");
  return [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`),
  ].join("\n");
}
const short = (lane: string) => lane.replace(/^(anthropic|openai)-/, "").replace(/-lean-/, " ");
function caseMarkdown(caseName: string, runs: Run[], outDir: string): string {
  const out: string[] = [`## ${caseName} (${runs.length} run${runs.length === 1 ? "" : "s"})`];
  out.push("\n### Cost and efficiency (measured, from report.json and events.json)\n");
  out.push(
    table(
      [
        "lane",
        "cost $",
        "wall s",
        "turns",
        "tool calls",
        "repair turns",
        "failures (by kind)",
        "input tok (cached %)",
        "output tok",
        "authored res.",
        "$/res.",
        "playtest",
      ],
      runs.map((r) => [
        short(r.lane),
        r.cost.costUsd !== null ? round(r.cost.costUsd, 3) : null,
        r.cost.wallSec,
        r.cost.modelTurns,
        r.cost.toolCalls,
        r.cost.repairTurns,
        `${r.cost.toolFailures} (${Object.entries(r.session.failuresByCategory)
          .map(([k, v]) => `${k} ${v}`)
          .join(", ")})`,
        `${round((r.cost.inputTokens ?? 0) / 1e6, 2)}M (${r.cost.cachedPct}%)`,
        `${round((r.cost.outputTokens ?? 0) / 1e3, 1)}k`,
        r.cost.authoredResources,
        r.cost.costPerAuthoredResource,
        r.playtest?.simulation ?? (r.playtest?.success ? "ok" : "fail"),
      ]),
    ),
  );
  out.push("\n### Content richness (measured from the generated resources)\n");
  out.push(
    table(
      [
        "lane",
        "room code B",
        "room msgs (chars)",
        "said (distinct / groups)",
        "vocab words/groups",
        "cmds used (room)",
        "room flags/vars",
        "OBJECT items",
        "exits from start",
        "score awards (max)",
        "death calls",
        "anim. objs",
        "views (loops x cels)",
        "ego 4-dir walk",
        "sounds (notes, s)",
        "tests",
      ],
      runs.map((r) => {
        const start =
          r.logic.exits.find((e) => e.from === (r.playtest?.room ?? 1)) ?? r.logic.exits[0];
        const authoredSounds = r.sounds.filter((s) => !s.template);
        const ego = r.views.find((v) => v.num === r.logic.egoView);
        return [
          short(r.lane),
          r.logic.roomCodeBytes,
          `${r.logic.roomMessages} (${r.logic.roomMessageChars})`,
          `${r.logic.saidCalls} (${r.logic.saidDistinctPatterns} / ${r.logic.saidWordGroups})`,
          `${r.logic.vocabularyWords}/${r.logic.vocabularyGroups}`,
          r.logic.distinctCommandsRooms,
          `${r.logic.roomFlags.length}/${r.logic.roomVars.length}`,
          r.inventory.filter((i) => i.name !== "?").length,
          start ? [...new Set(start.to.map((t) => t.to))].join(",") || "none" : "-",
          `${r.logic.scoreAwards.join("+") || "none"} (${r.logic.maxScore ?? "-"})`,
          r.logic.deathCalls,
          r.logic.animatedObjects.length,
          r.views.map((v) => `v${v.num}:${v.celsPerLoop.join("/")}`).join(" "),
          ego ? `${ego.fourDirWalk ? "yes" : "no"} (${ego.maxSize})` : "no ego view",
          authoredSounds.map((s) => `${s.audibleNotes}n ${s.durationSec}s`).join("; ") ||
            "template only",
          r.tests.length,
        ];
      }),
    ),
  );
  out.push(
    "\n### Picture fidelity: priority and control (measured from the rendered start-room picture)\n",
  );
  out.push(
    table(
      [
        "lane",
        "pic bytes (cmds)",
        "colours",
        "visual fill %",
        "bands used",
        "depth-drawn % (pri 5-15)",
        "ctl0 %",
        "ctl1 %",
        "ctl2 %",
        "ctl3 %",
        "horizon",
        "ego start (pri)",
        "reachable % below horizon",
        "reaches edges",
        "ctl3 reachable",
        "stands on (top colours % of reachable)",
      ],
      runs.map((r) => {
        const p = r.pictures.find((x) => x.startRoom) ?? r.pictures[0];
        if (!p) return [short(r.lane), "no picture"];
        return [
          short(r.lane),
          `${p.bytes} (${p.commands})`,
          p.distinctColors,
          p.fillPct,
          p.priorityBandsUsed.join(","),
          p.depthDrawnPct,
          p.controlPct["barrier0"],
          p.controlPct["conditional1"],
          p.controlPct["trigger2"],
          p.controlPct["water3"],
          p.horizon,
          p.egoStart
            ? `${p.egoStart.join(",")} (${p.egoStartPriority}${p.egoStartStandable ? "" : ", BLOCKED"})`
            : "-",
          p.reachablePctBelowHorizon,
          p.reachesEdges.join(",") || "-",
          p.waterReachable ? "yes" : "no",
          p.reachableColors
            .filter((c) => c.pctOfReachable >= 3)
            .map((c) => `${c.name} ${c.pctOfReachable}`)
            .join(", "),
        ];
      }),
    ),
  );
  out.push("\n### Template and authoring behaviour (measured)\n");
  out.push(
    table(
      [
        "lane",
        "logic 0",
        "logic 255",
        "picture writes (using pri)",
        "control cmds written",
        "visible prose chars",
        "top tools",
      ],
      runs.map((r) => {
        const t0 = r.logic.template.find((t) => t.num === 0);
        const t255 = r.logic.template.find((t) => t.num === 255);
        const fmt = (t: Run["logic"]["template"][number] | undefined) =>
          !t
            ? "absent"
            : t.status === "modified"
              ? `modified: msgs ${t.delta!.changedMessages.join(",") || "-"}; +${t.delta!.addedInsns.length} insns (${t.delta!.addedInsns.slice(0, 3).join(" ")})`
              : t.status;
        return [
          short(r.lane),
          fmt(t0),
          fmt(t255),
          `${r.session.pictureWrites.length} (${r.session.pictureWritesUsingPriority})`,
          sum(r.session.pictureWrites.map((p) => p.controlCommands)),
          r.session.proseChars + r.session.reasoningVisibleChars,
          Object.entries(r.session.toolCalls)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4)
            .map(([k, v]) => `${k} ${v}`)
            .join(", "),
        ];
      }),
    ),
  );
  const checks = runs[0]?.brief.checklist ?? [];
  if (checks.length) {
    out.push(
      "\n### Brief checklist (HEURISTIC keyword/structure checks against the brief's starting room; not a quality judgment)\n",
    );
    out.push(
      table(
        ["check", ...runs.map((r) => short(r.lane))],
        [
          ...checks.map((c, i) => [
            c.label,
            ...runs.map((r) => (r.brief.checklist[i]?.pass ? "Y" : "-")),
          ]),
          [
            "lexicon verbs in said()",
            ...runs.map((r) =>
              r.brief.lexicon ? `${r.brief.lexicon.verbsInSaid}/${r.brief.lexicon.verbs}` : "-",
            ),
          ],
          [
            "lexicon nouns in said()",
            ...runs.map((r) =>
              r.brief.lexicon ? `${r.brief.lexicon.nounsInSaid}/${r.brief.lexicon.nouns}` : "-",
            ),
          ],
          ["score", ...runs.map((r) => `${r.brief.passed}/${r.brief.total}`)],
        ],
      ),
    );
  }
  out.push("\n### Representative tool failures (verbatim, truncated)\n");
  for (const r of runs)
    for (const e of r.session.representativeErrors)
      out.push(`- ${short(r.lane)} \`${e.tool}\` [${e.category}]: ${e.error.slice(0, 180)}`);
  out.push("\n### Images\n");
  out.push(
    table(
      [
        "lane",
        "first frame",
        "visual",
        "priority (EGA palette)",
        "walk (dimmed = unreachable; red ctl0, orange ctl1, green ctl2, blue ctl3, yellow horizon, magenta ego start)",
      ],
      runs.map((r) => [
        short(r.lane),
        `![](${caseName}/${r.lane}-first-frame.png)`,
        `![](${caseName}/${r.lane}-visual.png)`,
        `![](${caseName}/${r.lane}-priority.png)`,
        `![](${caseName}/${r.lane}-walk.png)`,
      ]),
    ),
  );
  // Auto reading: facts only.
  const withCost = runs.filter((r) => r.cost.costUsd !== null);
  const by = (f: (r: Run) => number) => [...runs].sort((a, b) => f(b) - f(a));
  out.push("\n### Reading (auto-generated, facts only)\n");
  if (withCost.length) {
    const cheap = [...withCost].sort((a, b) => a.cost.costUsd! - b.cost.costUsd!);
    out.push(
      `- Cost spread: ${short(cheap[0]!.lane)} $${round(cheap[0]!.cost.costUsd!, 3)} to ${short(cheap.at(-1)!.lane)} $${round(cheap.at(-1)!.cost.costUsd!, 3)} (${round(cheap.at(-1)!.cost.costUsd! / cheap[0]!.cost.costUsd!, 0)}x).`,
    );
  }
  const richest = by((r) => r.logic.saidDistinctPatterns);
  out.push(
    `- Most distinct said() patterns: ${richest.map((r) => `${short(r.lane)} ${r.logic.saidDistinctPatterns}`).join(", ")}.`,
  );
  const depth = by((r) => r.pictures[0]?.depthDrawnPct ?? 0);
  out.push(
    `- Depth-drawn priority area (pri 5-15): ${depth.map((r) => `${short(r.lane)} ${r.pictures[0]?.depthDrawnPct ?? 0}%`).join(", ")}.`,
  );
  out.push(
    `- All runs passed the harness playtest: ${runs.every((r) => r.playtest?.success) ? "yes" : "no"}.`,
  );
  const readingPath = join(outDir, `reading-${caseName}.md`);
  if (existsSync(readingPath)) out.push("\n" + readFileSync(readingPath, "utf8").trim());
  return out.join("\n");
}

// ---------------------------------------------------------------- main
const [resultsDir, outDir] = process.argv.slice(2);
if (!resultsDir || !outDir) {
  console.error("usage: npm run eval:matrix -- <results-dir> <out-dir>");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
const refs = discover(resultsDir);
const byCase = new Map<string, Run[]>();
for (const ref of refs) {
  const caseDir = join(outDir, ref.case);
  mkdirSync(caseDir, { recursive: true });
  try {
    const run = analyzeRun(ref, caseDir, readBrief(ref.case));
    byCase.set(ref.case, [...(byCase.get(ref.case) ?? []), run]);
    console.log(`analyzed ${ref.stem}`);
  } catch (e) {
    console.error(`FAILED ${ref.stem}: ${(e as Error).stack}`);
  }
}
const metrics = Object.fromEntries(
  [...byCase].map(([c, runs]) => [
    c,
    Object.fromEntries(runs.map((r) => [`${r.lane}--${r.stem.split("--").pop()}`, r])),
  ]),
);
writeFileSync(
  join(outDir, "metrics.json"),
  JSON.stringify({ resultsDir: basename(resultsDir), cases: metrics }, null, 1),
);
const md = [
  "# Genesis quality/cost matrix",
  "",
  `Source: \`${resultsDir}\`. One row per completed run (report.json + resources). Regenerate with \`npm run eval:matrix -- <results-dir> <out-dir>\`.`,
  "Measured columns come from report.json, events.json, transcript.json and the AGI files (parsed with the repo's own container/logic/picture/view/sound code). The brief checklist is a keyword heuristic. Judgment lives only in the optional hand-written `reading-<case>.md`.",
  "",
  "Definitions: *room code B* = bytecode bytes of room logics (excludes logic 0 and called logics like 255). *said (distinct / groups)* = said() calls in room logics (distinct word-id patterns / distinct word groups). *cmds used* = distinct AGI actions + tests in room logics. *depth-drawn %* = picture cells whose priority is 5..15 (4 is the unpainted default). *ctlN %* = share of the 160x168 plane holding control value N (0 barrier, 1 conditional barrier, 2 trigger, 3 water). *reachable %* = flood fill from the ego start over footprints (ego cel width) that avoid control 0/1, rows at or below the horizon. *authored res.* = resources not byte-identical to the base template.",
  "",
  ...[...byCase].map(([c, runs]) => caseMarkdown(c, runs, outDir) + "\n"),
].join("\n");
writeFileSync(join(outDir, "matrix.md"), md);
console.log(
  `wrote ${join(outDir, "matrix.md")} and metrics.json (${refs.length} runs, ${byCase.size} cases)`,
);
