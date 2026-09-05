/** Scripted interpreter observations in the portable conformance-results format. */
import { createHash } from "node:crypto";
import { openContainer } from "../src/container/container.ts";
import { parseWordsTok } from "../src/logic/words.ts";
import { Engine } from "../src/runtime/engine.ts";
import { CycleClock } from "../src/runtime/cycleClock.ts";
import { PROFILES, type ProfileId } from "../src/runtime/profile.ts";
import type { SoundOutput } from "../src/sound/sound.ts";
import { validateBundle, type Bundle, type CaseResult } from "./conformance.ts";

export function runtimeResults(files: ReadonlyMap<string, Uint8Array>, input: unknown): Bundle {
  if (!input || typeof input !== "object") throw new Error("A runtime scenario is required.");
  const scenario = input as Record<string, unknown>;
  if (typeof scenario["suiteId"] !== "string" || !scenario["suiteId"].trim())
    throw new Error("suiteId is required.");
  if (typeof scenario["profile"] !== "string" || !Object.hasOwn(PROFILES, scenario["profile"]))
    throw new Error("A supported profile is required.");
  if (!Array.isArray(scenario["steps"]) || scenario["steps"].length > 10000)
    throw new Error("Expected at most 10000 steps.");
  const seed = scenario["seed"] ?? 1;
  if (!Number.isInteger(seed) || (seed as number) < 0 || (seed as number) > 0xffffffff)
    throw new Error("seed must be an unsigned 32-bit integer.");
  let random = seed as number;
  let keys: number[] = [];
  let line: string | null = null;
  const sounds: SoundOutput[] = [];
  const saves = new Map<string, Uint8Array>();
  let gameSave: Uint8Array | null = null;
  const cases: CaseResult[] = [];
  const ids = new Set<string>();
  const profile = PROFILES[scenario["profile"] as ProfileId];
  const container = openContainer(files, { kind: profile.container });
  const words = container.files.get("WORDS.TOK");
  const dictionary = new Map(words ? parseWordsTok(words).map(({ word, id }) => [word, id]) : []);
  const engine = new Engine(
    container,
    {
      print() {},
      displayAt() {},
      statusLine() {},
      takeKeys: () => {
        const pending = keys;
        keys = [];
        return pending;
      },
      takeInputLine: () => {
        const pending = line;
        line = null;
        return pending;
      },
      randomWord: () => {
        random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
        return random >>> 16;
      },
      soundOutput: (output) => {
        sounds.push(output);
      },
      saveGame: (bytes) => {
        gameSave = bytes.slice();
      },
      restoreGame: () => gameSave?.slice() ?? null,
      waitKey: () => {
        throw new Error("A blocking key request needs an explicit scripted response.");
      },
      promptString: () => {
        throw new Error("A blocking string request needs an explicit scripted response.");
      },
      promptNumber: () => {
        throw new Error("A blocking number request needs an explicit scripted response.");
      },
    },
    dictionary,
    { profile, instructionBudget: 100000 },
  );
  engine.flags[9] = 1;
  const clock = new CycleClock(0);
  let tick = 0;
  let requestedMs = 0;
  for (const raw of scenario["steps"]) {
    if (!raw || typeof raw !== "object" || Object.keys(raw).length !== 1)
      throw new Error("Each step must contain exactly one operation.");
    const [operation, value] = Object.entries(raw)[0]!;
    if (operation === "advance") {
      if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 0 ||
        value > 3600000 ||
        requestedMs + value > 3600000
      )
        throw new Error("Scenario duration must be at most one hour in integer milliseconds.");
      requestedMs += value as number;
      // Fixed 60 Hz host polling. Keeping the fractional phase across steps
      // makes splitting an advance into smaller steps observationally identical.
      const until = Math.floor((requestedMs * 60 + 1e-7) / 1000);
      while (tick < until) {
        tick++;
        engine.advanceClock(1000 / 60);
        engine.soundTick();
        if (
          engine.modalKind !== null ||
          engine.continuationPending ||
          clock.poll((tick * 1000) / 60, engine.vars[10]!)
        )
          engine.tick();
      }
    } else if (operation === "key") {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 65535)
        throw new Error("Key must be an unsigned 16-bit word.");
      keys.push(value as number);
    } else if (operation === "input") {
      if (typeof value !== "string" || value.length > 40)
        throw new Error("Input must be at most 40 characters.");
      if (line !== null) throw new Error("Advance execution before submitting another input line.");
      line = value;
    } else if (operation === "save" || operation === "restore") {
      if (typeof value !== "string" || !value) throw new Error("A save slot name is required.");
      if (operation === "save") {
        const image = engine.autosaveImage();
        if (!image) throw new Error("The interpreter is not at a resumable save boundary.");
        saves.set(value, image);
      } else {
        const image = saves.get(value);
        if (!image) throw new Error(`Unknown save slot ${value}.`);
        engine.restoreImage(image);
        keys = [];
        line = null;
        clock.reset((tick * 1000) / 60);
      }
    } else if (operation === "checkpoint") {
      if (typeof value !== "string" || !value || ids.has(value))
        throw new Error("Checkpoint names must be nonempty and unique.");
      ids.add(value);
      const frame = engine.getFrame();
      for (const channel of ["visual", "priority"] as const)
        cases.push({
          id: `${value}/${channel}`,
          status: "ok",
          frame: {
            width: 160,
            height: 168,
            pixel_format: "ega16-indexed-row-major",
            sha256: createHash("sha256").update(frame[channel]).digest("hex"),
          },
        });
      cases.push({
        id: `${value}/state`,
        status: "ok",
        values: {
          variables: Array.from(engine.vars),
          flags: Array.from(engine.flags),
          objects: engine.readObjects().map((o) => ({ ...o })),
          modal: engine.modalKind,
          textMode: engine.textModeActive,
          textSha256: createHash("sha256").update(engine.textCells).digest("hex"),
          soundSha256: createHash("sha256").update(JSON.stringify(sounds)).digest("hex"),
        },
      });
      sounds.length = 0;
    } else throw new Error(`Unknown runtime operation ${operation}.`);
  }
  return validateBundle({
    format: "agi-clean-room-conformance-results",
    format_version: 2,
    suite_id: scenario["suiteId"],
    profile: profile.id,
    producer: "AGI IS HERE",
    cases,
  });
}
