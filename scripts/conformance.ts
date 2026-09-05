#!/usr/bin/env node
/**
 * Peter Kelly's agi-re portable conformance-results format, version 2.
 * npm run conformance -- pictures GAME_DIR OUTPUT_JSON [PROFILE] [SUITE_ID]
 * npm run conformance -- compare REFERENCE_JSON CANDIDATE_JSON
 * Picture production writes hashes only; original game images stay with their owner.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openContainer } from "../src/container/container.ts";
import { detectProfile, type ProfileId } from "../src/runtime/profile.ts";
import { renderPicture } from "../src/picture/renderer.ts";
import { EGA_RGB } from "../src/picture/png.ts";
import { createPictureSurface } from "../src/types.ts";
import { runtimeResults } from "./runtime-conformance.ts";

type Value = null | boolean | number | bigint | string | Value[] | { [key: string]: Value };
export interface Frame {
  width: 160;
  height: 168;
  pixel_format: "ega16-indexed-row-major";
  sha256: string;
  artifact?: string;
}
export interface CaseResult {
  id: string;
  status: "ok" | "error";
  frame?: Frame;
  values?: { [key: string]: Value };
  error?: string;
}
export interface Bundle {
  format: "agi-clean-room-conformance-results";
  format_version: 2;
  suite_id: string;
  profile: string;
  producer: string;
  cases: CaseResult[];
}
const verifiedArtifacts = new WeakMap<Frame, string>();

function object(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}
function portable(value: unknown): boolean {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    typeof value === "bigint"
  )
    return true;
  if (typeof value === "number") return Number.isSafeInteger(value);
  if (Array.isArray(value)) return value.every(portable);
  return object(value) && Object.values(value).every(portable);
}
export function validateBundle(input: unknown): Bundle {
  if (
    !object(input) ||
    input["format"] !== "agi-clean-room-conformance-results" ||
    input["format_version"] !== 2
  )
    throw new Error("Expected conformance-results format version 2.");
  for (const key of ["suite_id", "profile", "producer"])
    if (typeof input[key] !== "string" || !input[key]) throw new Error(`Missing ${key}.`);
  if (!Array.isArray(input["cases"])) throw new Error("A bundle requires cases.");
  const ids = new Set<string>();
  for (const entry of input["cases"]) {
    if (!object(entry) || typeof entry["id"] !== "string" || !entry["id"] || ids.has(entry["id"]))
      throw new Error("Case identifiers must be nonempty and unique.");
    ids.add(entry["id"]);
    if (entry["status"] !== "ok" && entry["status"] !== "error")
      throw new Error(`Invalid status for ${entry["id"]}.`);
    if (entry["status"] === "ok" && !("frame" in entry) && !("values" in entry))
      throw new Error(`Missing observations for ${entry["id"]}.`);
    if ("values" in entry && (!object(entry["values"]) || !portable(entry["values"])))
      throw new Error(`Invalid portable values for ${entry["id"]}.`);
    if ("frame" in entry) {
      const frame = entry["frame"];
      if (
        !object(frame) ||
        frame["width"] !== 160 ||
        frame["height"] !== 168 ||
        frame["pixel_format"] !== "ega16-indexed-row-major" ||
        typeof frame["sha256"] !== "string" ||
        !/^[a-f0-9]{64}$/.test(frame["sha256"])
      )
        throw new Error(`Invalid canonical frame for ${entry["id"]}.`);
      if (
        "artifact" in frame &&
        (typeof frame["artifact"] !== "string" ||
          !frame["artifact"] ||
          isAbsolute(frame["artifact"]))
      )
        throw new Error("Frame artifact must be a relative path.");
    }
  }
  return input as unknown as Bundle;
}

/** Preserve mathematical JSON integers beyond JavaScript's safe-number range. */
export function parseBundleJson(text: string): Bundle {
  return validateBundle(
    JSON.parse(text, (_key, value: unknown, context?: { source?: string }) => {
      if (typeof value !== "number") return value;
      const source = context?.source;
      if (!source) {
        if (!Number.isSafeInteger(value))
          throw new Error(
            "Lossless JSON integer parsing requires a runtime with reviver source context.",
          );
        return value;
      }
      const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(source)!;
      let digits = match[2]! + (match[3] ?? "");
      const scale = Number(match[4] ?? 0) - (match[3]?.length ?? 0);
      if (scale < 0) {
        const removed = digits.slice(Math.max(0, digits.length + scale));
        if (/[^0]/.test(removed))
          throw new Error("Portable values cannot contain floating-point numbers.");
        digits = digits.slice(0, Math.max(0, digits.length + scale)) || "0";
      } else digits += "0".repeat(scale);
      const integer = BigInt(match[1]! + digits);
      return integer <= BigInt(Number.MAX_SAFE_INTEGER) &&
        integer >= BigInt(Number.MIN_SAFE_INTEGER)
        ? Number(integer)
        : integer;
    }),
  );
}

function differences(a: Value, b: Value, path: string, output: string[]): void {
  if (
    (typeof a === "number" || typeof a === "bigint") &&
    (typeof b === "number" || typeof b === "bigint")
  ) {
    if (BigInt(a) !== BigInt(b)) output.push(`${path}: integer differs`);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) output.push(`${path}: array length differs`);
    for (let i = 0; i < Math.min(a.length, b.length); i++)
      differences(a[i]!, b[i]!, `${path}/${i}`, output);
    return;
  }
  if (object(a) && object(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const at = `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
      if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key))
        output.push(`${at}: member missing or unexpected`);
      else differences(a[key] as Value, b[key] as Value, at, output);
    }
    return;
  }
  if (a !== b) output.push(`${path}: value or type differs`);
}

/** Load artifact-bearing bundles with loadBundle before comparing them. */
export function compareBundles(referenceInput: unknown, candidateInput: unknown): string[] {
  const reference = validateBundle(referenceInput);
  const candidate = validateBundle(candidateInput);
  for (const bundle of [reference, candidate])
    for (const item of bundle.cases)
      if (item.frame?.artifact && verifiedArtifacts.get(item.frame) !== item.frame.sha256)
        throw new Error("Load and validate frame artifacts before comparison.");
  const output: string[] = [];
  if (reference.suite_id !== candidate.suite_id) output.push("/suite_id: differs");
  if (reference.profile !== candidate.profile) output.push("/profile: differs");
  const candidates = new Map(candidate.cases.map((entry) => [entry.id, entry]));
  for (const [index, expected] of reference.cases.entries()) {
    const actual = candidates.get(expected.id);
    const at = `/cases/${index}`;
    if (!actual) {
      output.push(`${at}: missing case`);
      continue;
    }
    candidates.delete(expected.id);
    if (expected.status !== "ok" || actual.status !== "ok") {
      output.push(`${at}: execution error, no conformance result`);
      continue;
    }
    if (expected.frame) {
      if (!actual.frame) output.push(`${at}/frame: missing observation`);
      else if (expected.frame.sha256 !== actual.frame.sha256)
        output.push(`${at}/frame/sha256: differs`);
    }
    if (expected.values) {
      if (!actual.values) output.push(`${at}/values: missing observation`);
      else differences(expected.values, actual.values, `${at}/values`, output);
    }
  }
  for (const entry of candidates.values())
    output.push(`/cases/${candidate.cases.indexOf(entry)}: unexpected case ${entry.id}`);
  return output;
}

export function decodePpm(bytes: Uint8Array): Uint8Array {
  let at = 0;
  const whitespace = (b: number | undefined): boolean =>
    b !== undefined && [9, 10, 11, 12, 13, 32].includes(b);
  const token = (): string => {
    for (;;) {
      while (whitespace(bytes[at])) at++;
      if (bytes[at] !== 35) break;
      while (at < bytes.length && bytes[at] !== 10) at++;
    }
    const start = at;
    while (at < bytes.length && !whitespace(bytes[at]) && bytes[at] !== 35) at++;
    return Buffer.from(bytes.subarray(start, at)).toString("ascii");
  };
  if (token() !== "P6" || token() !== "160" || token() !== "168" || token() !== "255")
    throw new Error("Expected canonical P6 160x168, max value 255.");
  if (!whitespace(bytes[at])) throw new Error("Missing PPM raster separator.");
  if (bytes[at] === 13 && bytes[at + 1] === 10) at += 2;
  else at++;
  if (bytes.length - at !== 26880 * 3) throw new Error("Invalid PPM raster length.");
  const palette = new Map(EGA_RGB.map(([r, g, b], i) => [(r << 16) | (g << 8) | b, i]));
  const pixels = new Uint8Array(26880);
  for (let i = 0; i < pixels.length; i++, at += 3) {
    const index = palette.get((bytes[at]! << 16) | (bytes[at + 1]! << 8) | bytes[at + 2]!);
    if (index === undefined)
      throw new Error(`Non-EGA RGB pixel at ${i % 160},${Math.floor(i / 160)}.`);
    pixels[i] = index;
  }
  return pixels;
}

export async function loadBundle(path: string): Promise<Bundle> {
  const bundle = parseBundleJson(await readFile(path, "utf8"));
  for (const entry of bundle.cases) {
    if (!entry.frame?.artifact) continue;
    const pixels = decodePpm(await readFile(resolve(dirname(path), entry.frame.artifact)));
    const hash = createHash("sha256").update(pixels).digest("hex");
    if (hash !== entry.frame.sha256) throw new Error(`Artifact digest mismatch for ${entry.id}.`);
    verifiedArtifacts.set(entry.frame, hash);
  }
  return bundle;
}

export function pictureResults(
  files: ReadonlyMap<string, Uint8Array>,
  options: { profile?: ProfileId; suiteId?: string } = {},
): Bundle {
  const profile = detectProfile(files, options.profile);
  const container = openContainer(files, { kind: profile.container });
  const cases: CaseResult[] = [];
  for (let number = 0; number < 256; number++) {
    const id = `picture_${String(number).padStart(3, "0")}`;
    try {
      const payload = container.getResource("picture", number);
      if (!payload) continue;
      const surface = createPictureSurface();
      renderPicture(payload, surface, { profile });
      for (const channel of ["visual", "priority"] as const)
        cases.push({
          id: `${id}/${channel}`,
          status: "ok",
          frame: {
            width: 160,
            height: 168,
            pixel_format: "ega16-indexed-row-major",
            sha256: createHash("sha256").update(surface[channel]).digest("hex"),
          },
        });
    } catch (error) {
      for (const channel of ["visual", "priority"])
        cases.push({
          id: `${id}/${channel}`,
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
    }
  }
  return validateBundle({
    format: "agi-clean-room-conformance-results",
    format_version: 2,
    suite_id: options.suiteId ?? "agi-pictures",
    profile: profile.id,
    producer: "AGI IS HERE",
    cases,
  });
}

async function main(args: string[]): Promise<void> {
  const [command, first, second, profile, suiteId] = args;
  if (command === "pictures" && first && second && args.length <= 5) {
    const files = new Map<string, Uint8Array>();
    for (const entry of await readdir(first, { withFileTypes: true }))
      if (entry.isFile())
        files.set(entry.name.toUpperCase(), await readFile(join(first, entry.name)));
    const bundle = pictureResults(files, {
      ...(profile ? { profile: profile as ProfileId } : {}),
      ...(suiteId ? { suiteId } : {}),
    });
    await writeFile(second, JSON.stringify(bundle, null, 2) + "\n");
    const failed = bundle.cases.filter((entry) => entry.status !== "ok").length;
    console.log(`${bundle.cases.length} observations written (${failed} errors).`);
    if (failed) process.exitCode = 1;
  } else if (command === "runtime" && first && second && profile && args.length === 4) {
    const files = new Map<string, Uint8Array>();
    for (const entry of await readdir(first, { withFileTypes: true }))
      if (entry.isFile())
        files.set(entry.name.toUpperCase(), await readFile(join(first, entry.name)));
    const bundle = runtimeResults(files, JSON.parse(await readFile(second, "utf8")));
    await writeFile(profile, JSON.stringify(bundle, null, 2) + "\n");
    console.log(`${bundle.cases.length} runtime observations written (${bundle.profile}).`);
  } else if (command === "compare" && first && second && args.length === 3) {
    const [reference, candidate] = await Promise.all([loadBundle(first), loadBundle(second)]);
    const mismatches = compareBundles(reference, candidate);
    if (mismatches.length) {
      console.error(mismatches.join("\n"));
      process.exitCode = 1;
    } else console.log(`All ${reference.cases.length} cases match (${reference.profile}).`);
  } else
    throw new Error(
      "Usage: conformance pictures GAME_DIR OUTPUT_JSON [PROFILE] [SUITE_ID] | runtime GAME_DIR SCENARIO_JSON OUTPUT_JSON | compare REFERENCE_JSON CANDIDATE_JSON",
    );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
