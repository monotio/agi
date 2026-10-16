#!/usr/bin/env node
/** Private-media, opt-in original interpreter frame comparison. See docs/testing.md. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureSkip, fixtureDir } from "../test/fixtures.ts";
import { openContainer } from "../src/container/container.ts";
import { Engine, HostWait } from "../src/runtime/engine.ts";
import { CycleClock } from "../src/runtime/cycleClock.ts";
import { detectProfile, PROFILES, type ProfileId } from "../src/runtime/profile.ts";
import { parseWordsTok } from "../src/logic/words.ts";
import { rngDraw } from "../src/runtime/rng.ts";
import { compositeFrame } from "../app/src/render/composite.ts";
import { decodePng, encodePngRgb } from "./png.ts";
import { compareFrames, normalizeFrame, type Rectangle } from "./mame-diff-metrics.ts";

interface Wait {
  room?: number;
  modal?: string | null;
  text?: string;
  advanceMs?: number;
  maxMs?: number;
}
interface Step {
  at: number;
  key?: "Enter" | "Escape" | "F9" | "Space";
  fields?: string[];
  input?: string;
  capture?: string;
  engine?: Wait;
}
export interface Scenario {
  fixture: string;
  profile: ProfileId;
  machine: string;
  bios?: string;
  args?: string[];
  media: { slot: string; path?: string; sha256?: string }[];
  crop: Rectangle;
  seconds: number;
  boot?: { at: number; text: string }[];
  steps: Step[];
}
const KEYS = { Enter: 13, Escape: 27, F9: 0x4300, Space: 32 };
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function json(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}
function lua(value: unknown): string {
  if (value === null || value === undefined) return "nil";
  if (typeof value === "string")
    return JSON.stringify(value).replace(
      /\\u([a-f0-9]{4})/gi,
      (_all, hex: string) => `\\x${hex.slice(2)}`,
    );
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `{${value.map(lua).join(",")}}`;
  return `{${Object.entries(value as object)
    .map(([k, v]) => `[${lua(k)}]=${lua(v)}`)
    .join(",")}}`;
}
function validate(s: Scenario): void {
  if (
    !s ||
    !Object.hasOwn(PROFILES, s.profile) ||
    !/^[a-z0-9_]+$/.test(s.machine) ||
    !s.fixture ||
    !s.crop ||
    !Array.isArray(s.media) ||
    !Array.isArray(s.steps)
  )
    throw new Error("Expected fixture, supported profile, machine, media, crop and steps.");
  if (!(s.seconds > 0 && s.seconds <= 3600)) throw new Error("seconds must be in (0, 3600].");
  const names = new Set<string>();
  let previous = -1;
  for (const step of s.steps) {
    if (!Number.isFinite(step.at) || step.at <= previous || step.at >= s.seconds)
      throw new Error("Steps must have increasing times before seconds.");
    previous = step.at;
    if ([step.key, step.input, step.capture].filter((v) => v !== undefined).length !== 1)
      throw new Error("Each step needs exactly one key, input or capture.");
    if (step.key && !Object.hasOwn(KEYS, step.key)) throw new Error("Unsupported key.");
    if (step.capture) {
      if (!/^[a-z0-9-]+$/.test(step.capture) || names.has(step.capture))
        throw new Error("Capture names must be unique safe filenames.");
      names.add(step.capture);
    }
    for (const n of [step.engine?.advanceMs, step.engine?.maxMs])
      if (n !== undefined && (!Number.isFinite(n) || n < 0 || n > 3600000))
        throw new Error("Invalid engine wait.");
  }
  if (!names.size) throw new Error("At least one capture is required.");
  // Arbitrary machine/device options are allowed, but presentation and output flags belong to the runner.
  if (
    (s.args ?? []).some((a) =>
      /^-(?:no)?(?:video|sound|window|autoboot|snapshot|cfg_|nvram_|rompath|seconds|readconfig|writeconfig)/.test(
        a,
      ),
    )
  )
    throw new Error("Reserved MAME option in args.");
}
function findMedia(hash: string, root: string): string | null {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Expected a disk SHA-256.");
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (name.startsWith(".") || name === "_roms") continue;
    const stat = statSync(path, { throwIfNoEntry: false });
    if (stat?.isDirectory()) {
      const found = findMedia(hash, path);
      if (found) return found;
    } else if (
      stat?.isFile() &&
      /\.(?:img|ima|dsk|td0|adf|po|2mg)$/i.test(name) &&
      sha256(readFileSync(path)) === hash
    )
      return path;
  }
  return null;
}

/** Render the engine side independently while iterating on a local scene script. */
export function captureEngine(s: Scenario, output: string) {
  const files = new Map<string, Uint8Array>();
  const dir = fixtureDir(s.fixture);
  for (const name of readdirSync(dir))
    if (statSync(join(dir, name)).isFile())
      files.set(name.toUpperCase(), readFileSync(join(dir, name)));
  const detected = detectProfile(files);
  if (detected.id !== s.profile)
    throw new Error(
      `Fixture detects as ${detected.id}, not requested ${s.profile}. Use the resources extracted from the boot media.`,
    );
  const profile = PROFILES[s.profile];
  const container = openContainer(files, { kind: profile.container, profile });
  const words = container.files.get("WORDS.TOK");
  const dictionary = new Map(words ? parseWordsTok(words).map(({ word, id }) => [word, id]) : []);
  let keys: number[] = [],
    input: string | null = null,
    random = 1,
    tick = 0;
  const engine = new Engine(
    container,
    {
      waitKey() {
        const key = keys.shift();
        if (key === undefined) throw new HostWait();
        return key;
      },
      print() {},
      displayAt() {},
      statusLine() {},
      takeKeys() {
        const pending = keys;
        keys = [];
        return pending;
      },
      takeInputLine() {
        const pending = input;
        input = null;
        return pending;
      },
      randomByte() {
        const draw = rngDraw(random, () => 1);
        random = draw.state;
        return draw.byte;
      },
    },
    dictionary,
    { profile, instructionBudget: 100000 },
  );
  engine.flags[9] = 1;
  const clock = new CycleClock(0);
  const advance = () => {
    if (++tick > 60 * 3600) throw new Error("Engine exceeded one hour.");
    engine.advanceClock(1000 / 60);
    engine.soundTick();
    if (
      engine.modalKind !== null ||
      engine.continuationPending ||
      clock.poll((tick * 1000) / 60, engine.vars[10]!)
    )
      engine.tick();
  };
  const rows = () => {
    const cells = engine.textCells;
    return Array.from({ length: 25 }, (_, y) =>
      Array.from({ length: 40 }, (_, x) =>
        String.fromCharCode(cells[(y * 40 + x) * 2]! || 32),
      ).join(""),
    );
  };
  const observations = [];
  for (const step of s.steps) {
    const wait = step.engine ?? {};
    const until = tick + Math.ceil(((wait.advanceMs ?? 0) * 60) / 1000);
    while (tick < until) advance();
    const matches = () =>
      (wait.room === undefined || engine.vars[0] === wait.room) &&
      (wait.modal === undefined || engine.modalKind === wait.modal) &&
      (wait.text === undefined || rows().join("\n").includes(wait.text));
    const limit = tick + Math.ceil(((wait.maxMs ?? 120000) * 60) / 1000);
    while (!matches() && tick < limit) advance();
    if (!matches())
      throw new Error(
        `Engine did not reach ${JSON.stringify(wait)}; room ${engine.vars[0]}, modal ${engine.modalKind}, host ${JSON.stringify(engine.hostInteraction)}, cycles ${engine.completedCycleSerial}: ${rows().join("|")}`,
      );
    if (step.key) {
      if (engine.awaitingHostAnswer) engine.deliverHostAnswer(KEYS[step.key]);
      else keys.push(KEYS[step.key]);
    }
    if (step.input !== undefined) input = step.input;
    if (!step.capture) {
      const limit = tick + 600;
      do {
        advance();
      } while ((keys.length || input !== null) && tick < limit);
      if (keys.length || input !== null)
        throw new Error("Input was not consumed within ten seconds.");
      continue;
    }
    const rgba = new Uint8Array(320 * 200 * 4);
    compositeFrame({ ...engine.getPresentation(), picRow: engine.displayBase }, rgba);
    const rgb = normalizeFrame(
      { width: 320, height: 200, rgba },
      { x: 0, y: 0, width: 320, height: 200 },
    );
    writeFileSync(join(output, `${step.capture}-ours.png`), encodePngRgb(320, 200, rgb));
    observations.push({
      scene: step.capture,
      tick,
      room: engine.vars[0],
      modal: engine.modalKind,
      rows: rows(),
    });
  }
  return {
    seed: 1,
    profile: profile.id,
    files: [...files].map(([name, bytes]) => ({ name, sha256: sha256(bytes) })),
    observations,
  };
}

async function main() {
  const [manifest, rompath, destination, binary = "mame"] = process.argv.slice(2);
  if (!manifest || !rompath)
    throw new Error(
      "Usage: node --experimental-strip-types scripts/mame-diff.ts SCENARIO.json ROMPATH [OUTPUT_DIR] [MAME_BINARY]",
    );
  const s = JSON.parse(readFileSync(manifest, "utf8")) as Scenario;
  validate(s);
  const output = resolve(destination ?? `.local/mame-diff/${s.machine}`);
  const within = relative(resolve("."), output);
  if (
    !within.startsWith("..") &&
    spawnSync("git", ["check-ignore", "--quiet", output]).status !== 0
  )
    throw new Error(
      "Output inside the repository must be gitignored (for example .local/mame-diff). ",
    );
  mkdirSync(output, { recursive: true });
  const skip = (reason: string) => {
    json(join(output, "result.json"), { status: "skipped", reason });
    console.log(`SKIP: ${reason}`);
  };
  const version = spawnSync(binary, ["-version"], { encoding: "utf8" });
  if (version.error && (version.error as NodeJS.ErrnoException).code === "ENOENT")
    return skip("MAME is not installed.");
  if (version.status !== 0) throw new Error(`Cannot query MAME: ${version.stderr}`);
  if (!existsSync(rompath)) return skip("ROM directory is missing.");
  const missing = fixtureSkip(s.fixture);
  if (missing) return skip(missing);
  const mediaArgs: string[] = [],
    mediaHashes = [];
  for (const [i, medium] of s.media.entries()) {
    if (!/^-flop[1-4]$/.test(medium.slot))
      throw new Error("Media slot must be -flop1 through -flop4.");
    const source = medium.path
      ? resolve(dirname(resolve(manifest)), medium.path)
      : medium.sha256
        ? findMedia(medium.sha256, resolve("games"))
        : null;
    if (!source || !existsSync(source)) return skip(`Disk for ${medium.slot} is missing.`);
    const hash = sha256(readFileSync(source));
    if (medium.sha256 && hash !== medium.sha256)
      throw new Error(`Disk hash mismatch for ${medium.slot}.`);
    const target = join(output, `disk-${i}${extname(source)}`);
    copyFileSync(source, target);
    mediaArgs.push(medium.slot, target);
    mediaHashes.push({ slot: medium.slot, sha256: hash });
  }
  // Remove stale success before starting a new run; a failed run must not retain old measurements.
  json(join(output, "result.json"), { status: "running" });
  const events = [...(s.boot ?? []).map((e) => ({ at: e.at, boot: e.text })), ...s.steps].sort(
    (a, b) => a.at - b.at,
  );
  const driver = readFileSync(new URL("./mame-diff/drive.lua", import.meta.url), "utf8");
  const script = `local events=${lua(events)}\nlocal output=${lua(output)}\n${driver}`;
  const machineWork = mkdtempSync(join(output, "machine-"));
  const scriptPath = join(output, "drive.lua");
  writeFileSync(scriptPath, script);
  const args = [
    s.machine,
    ...(s.bios ? ["-bios", s.bios] : []),
    ...(s.args ?? []),
    ...mediaArgs,
    "-rompath",
    resolve(rompath),
    "-noreadconfig",
    "-nowriteconfig",
    "-video",
    "none",
    "-sound",
    "none",
    "-nothrottle",
    "-seconds_to_run",
    String(s.seconds),
    "-skip_gameinfo",
    "-autoboot_delay",
    "0",
    "-autoboot_script",
    scriptPath,
    "-cfg_directory",
    join(machineWork, "cfg"),
    "-nvram_directory",
    join(machineWork, "nvram"),
    "-snapshot_directory",
    output,
  ];
  json(join(output, "provenance.json"), {
    scenario: s,
    mame: version.stdout.trim(),
    args,
    media: mediaHashes,
    harnessSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
    luaSha256: sha256(Buffer.from(driver)),
    compositorSha256: sha256(
      readFileSync(new URL("../app/src/render/composite.ts", import.meta.url)),
    ),
    worktreeStatus: spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" }).stdout.trim(),
    revision: spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(),
  });
  console.log(`Capturing ${s.fixture} on ${s.machine} (${s.seconds} emulated seconds)…`);
  const run = spawnSync(binary, args, {
    encoding: "utf8",
    timeout: 30 * 60 * 1000,
    maxBuffer: 10 * 1024 * 1024,
  });
  writeFileSync(join(output, "mame.log"), run.stdout + run.stderr);
  if (run.status !== 0) {
    if (
      /required (?:files|ROM|rom).*missing|NOT FOUND|Required files are missing/.test(
        run.stdout + run.stderr,
      )
    )
      return skip("Required machine ROMs are missing; see mame.log.");
    throw new Error(
      `MAME failed (${run.status}): ${run.error?.message ?? run.stderr}. See mame.log.`,
    );
  }
  if (/\[LUA ERROR\]|error in.*callback/i.test(run.stdout + run.stderr))
    throw new Error("MAME Lua failed; see mame.log.");
  const engine = captureEngine(s, output);
  json(join(output, "engine.json"), engine);
  const results = [];
  for (const step of s.steps)
    if (step.capture) {
      if (!run.stdout.includes(`CAPTURE ${step.capture} `))
        throw new Error(`MAME did not capture ${step.capture}.`);
      const original = decodePng(readFileSync(join(output, `${step.capture}-mame.png`)));
      const normalized = normalizeFrame(original, s.crop);
      writeFileSync(
        join(output, `${step.capture}-original.png`),
        encodePngRgb(320, 200, normalized),
      );
      const ours = decodePng(readFileSync(join(output, `${step.capture}-ours.png`)));
      const { diff, ...metrics } = compareFrames(
        normalized,
        normalizeFrame(ours, { x: 0, y: 0, width: 320, height: 200 }),
      );
      writeFileSync(join(output, `${step.capture}-diff.png`), encodePngRgb(320, 200, diff));
      results.push({
        scene: step.capture,
        source: { width: original.width, height: original.height, crop: s.crop },
        ...metrics,
      });
      console.log(`${step.capture}: ${metrics.differingPixels}/64000 RGB pixels differ`);
    }
  json(join(output, "result.json"), {
    status: "captured",
    note: "Scene correspondence requires visual review of the raw pairs. No tolerance, masking or palette remapping.",
    results,
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
