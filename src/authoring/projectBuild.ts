import { openContainer } from "../container/container.ts";
import { canonicalResourceName, isPlayableFileName } from "../container/playableFiles.ts";
import { sha256Hex } from "../crypto.ts";
import type { LogicSourceMap } from "../logic/assembler.ts";
import { parseWordsTok } from "../logic/words.ts";
import { PROFILES, type ProfileId } from "../runtime/profile.ts";
import { compileProjectLogic } from "./projectLogic.ts";
import { computeResourceRevision } from "./resourceRevision.ts";

interface ProjectBuildInput {
  readonly files: Readonly<Record<string, Uint8Array>>;
  readonly profileId: ProfileId;
  /** Only exact authored sources belong here; missing entries remain bytecode-only. */
  readonly sources: Readonly<Record<string, string>>;
  readonly bindings: Readonly<Record<string, { readonly num: number }>>;
}

interface CapturedLogic {
  readonly num: number;
  readonly payloadHash: string;
  readonly authored?: string;
  readonly authoredStart?: number;
  readonly sourceMap?: LogicSourceMap;
}

// Hash UTF-16 code units explicitly: even unpaired surrogates retain exact identity.
// This is an in-memory build schema, separate from the released resource digest.
function hashManifest(value: unknown): string {
  const text = JSON.stringify(value);
  const bytes = new Uint8Array(text.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i));
  return sha256Hex(bytes);
}

function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a, (char) => char.codePointAt(0)!);
  const right = Array.from(b, (char) => char.codePointAt(0)!);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i]! - right[i]!;
  }
  return left.length - right.length;
}

/**
 * Capture one executable image and verified source origins. This neither edits
 * resources nor persists/installs a build. Reference validation belongs to the
 * project transaction; source association here always requires exact bytes.
 */
export function captureProjectBuild(input: ProjectBuildInput) {
  const revision = computeResourceRevision(input.files);
  const profile = PROFILES[input.profileId];
  if (!profile) throw new Error(`Unknown build profile: ${input.profileId}`);
  const owned = new Map<string, Uint8Array>();
  for (const [name, bytes] of Object.entries(input.files)) {
    if (isPlayableFileName(name)) owned.set(canonicalResourceName(name), new Uint8Array(bytes));
  }
  const container = openContainer(owned, { profile });
  const words = owned.get("WORDS.TOK");
  const dictionary = new Map(words ? parseWordsTok(words).map(({ word, id }) => [word, id]) : []);
  const bindings = Object.fromEntries(
    Object.entries(input.bindings)
      .sort(([a], [b]) => compareCodePoints(a, b))
      .map(([name, binding]) => [name, { num: binding.num }]),
  );
  for (const key of Object.keys(input.sources)) {
    const num = Number(key);
    if (!Number.isInteger(num) || num < 0 || num > 255 || String(num) !== key) {
      throw new Error(`Invalid source LOGIC id: ${key}`);
    }
    if (!container.getResource("logic", num)) throw new Error(`Source has no LOGIC ${num}`);
  }
  for (const [name, binding] of Object.entries(bindings)) {
    if (!Number.isInteger(binding.num) || binding.num < 0 || binding.num > 255) {
      throw new Error(`Invalid binding ${name}: expected an integer in 0..255`);
    }
  }
  const logics: CapturedLogic[] = [];
  for (let num = 0; num < 256; num++) {
    const payload = container.getResource("logic", num);
    if (!payload) continue;
    const payloadHash = sha256Hex(payload);
    const source = input.sources[String(num)];
    if (source === undefined) {
      logics.push(Object.freeze({ num, payloadHash }));
      continue;
    }
    const compiled = compileProjectLogic(source, {
      profile,
      dictionary,
      bindings,
      sourceMap: true,
    });
    if (
      compiled.assembly.payload.length !== payload.length ||
      !payload.every((byte, index) => byte === compiled.assembly.payload[index])
    ) {
      throw new Error(`Source does not reproduce LOGIC ${num}`);
    }
    const map = compiled.assembly.sourceMap!;
    const sourceMap = Object.freeze({
      ...map,
      entries: Object.freeze(map.entries.map((entry) => Object.freeze({ ...entry }))),
    });
    logics.push(
      Object.freeze({
        num,
        payloadHash,
        authored: source,
        authoredStart: compiled.expansion.authoredStart,
        sourceMap,
      }),
    );
  }
  const compilerId = "agi-logic-1";
  const buildId = hashManifest([
    1,
    compilerId,
    input.profileId,
    revision,
    Object.entries(bindings).map(([name, binding]) => [name, binding.num]),
    logics,
  ]);
  return Object.freeze({
    identity: Object.freeze({ buildId, revision, profileId: input.profileId, compilerId }),
    logics: Object.freeze(logics),
    /** Detached native files for a worker/export; no mutable internal buffers escape. */
    files(): ReadonlyMap<string, Uint8Array> {
      return new Map([...owned].map(([name, bytes]) => [name, new Uint8Array(bytes)]));
    },
  });
}
