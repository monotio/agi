/** Metadata-only inventory of privately held interpreter binaries. No execution or asset output. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getKnownGameByHash } from "../src/games/knownGames.ts";
import {
  EQUIVALENT_BUILDS,
  findVersionString,
  PROFILES,
  type ProfileId,
} from "../src/runtime/profile.ts";
import { descrambleAgi } from "./descramble-agi.ts";

interface FileIdentity {
  name: string;
  bytes: number;
  sha256: string;
}

/** Values are relative to the DOS load module, not a guessed physical load address. */
export function readMzHeader(data: Uint8Array) {
  if (data.length < 28 || data[0] !== 0x4d || data[1] !== 0x5a)
    throw new Error("Missing or truncated MZ header");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const lastPageBytes = view.getUint16(2, true);
  const pages = view.getUint16(4, true);
  const headerBytes = view.getUint16(8, true) * 16;
  const declaredFileBytes = (pages - (lastPageBytes === 0 ? 0 : 1)) * 512 + lastPageBytes;
  const relocationCount = view.getUint16(6, true);
  const relocationTableOffset = view.getUint16(24, true);
  if (
    pages === 0 ||
    lastPageBytes > 511 ||
    headerBytes < 28 ||
    headerBytes > Math.min(declaredFileBytes, data.length) ||
    (relocationCount > 0 &&
      (relocationTableOffset < 28 || relocationTableOffset + relocationCount * 4 > headerBytes))
  )
    throw new Error("Invalid MZ header sizes or relocation table");
  const entryCs = view.getUint16(22, true);
  const entryIp = view.getUint16(20, true);
  const entryModuleOffset = entryCs * 16 + entryIp;
  const actualLoadBytes = Math.min(declaredFileBytes, data.length) - headerBytes;
  if (entryModuleOffset >= actualLoadBytes)
    throw new Error("MZ entry lies outside available load module");
  return {
    headerBytes,
    declaredFileBytes,
    declaredLoadBytes: declaredFileBytes - headerBytes,
    actualLoadBytes,
    fileSizeDelta: data.length - declaredFileBytes,
    entryCs,
    entryIp,
    entryModuleOffset,
    entryFileOffset: headerBytes + entryModuleOffset,
    initialSs: view.getUint16(14, true),
    initialSp: view.getUint16(16, true),
    relocationCount,
    relocationTableOffset,
  };
}

interface InterpreterInventory {
  folder: string;
  status: "inventoried" | "missing" | "unsupported";
  evidence: "static-inventory";
  words: FileIdentity | null;
  knownGame: string | null;
  raw: FileIdentity | null;
  loaders: FileIdentity[];
  overlay: FileIdentity | null;
  overlayAssociation: "co-located-unverified" | "missing";
  decoded:
    | (Omit<FileIdentity, "name"> & {
        method: "already-mz" | "corrected-v2-loader-key";
        loaderCandidates: string[];
        mz: ReturnType<typeof readMzHeader>;
      })
    | null;
  buildCandidates: { source: string; build: string }[];
  build: string | null;
  profile: ProfileId | null;
  profileBasis: "exact-build" | "documented-equivalent" | "unknown";
  issues: string[];
}

function identity(name: string, bytes: Uint8Array): FileIdentity {
  return { name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function interpreterImage(data: Uint8Array) {
  const mz = readMzHeader(data);
  const banner = new TextDecoder("latin1").decode(
    data.subarray(mz.headerBytes, mz.headerBytes + 256),
  );
  if (!banner.startsWith("Adventure Game Interpreter"))
    throw new Error("MZ load module lacks AGI interpreter banner");
  return mz;
}

/** Names locate files; hashes identify their content. No folder-to-title inference. */
export function inspectInterpreter(
  folder: string,
  inputs: ReadonlyMap<string, Uint8Array>,
): InterpreterInventory {
  const row: InterpreterInventory = {
    folder,
    status: "missing",
    evidence: "static-inventory",
    words: null,
    knownGame: null,
    raw: null,
    loaders: [],
    overlay: null,
    overlayAssociation: "missing",
    decoded: null,
    buildCandidates: [],
    build: null,
    profile: null,
    profileBasis: "unknown",
    issues: [],
  };
  const files = new Map<string, { name: string; data: Uint8Array }>();
  for (const [name, data] of inputs) {
    const key = name.toUpperCase();
    if (files.has(key)) {
      row.status = "unsupported";
      row.issues.push(`Ambiguous case-insensitive file: ${key}`);
      return row;
    }
    files.set(key, { name, data });
  }
  const words = files.get("WORDS.TOK");
  if (words) {
    row.words = identity(words.name, words.data);
    row.knownGame = getKnownGameByHash(row.words.sha256)?.alias ?? null;
  } else row.issues.push("Missing WORDS.TOK; resource identity unknown");
  const overlay = files.get("AGIDATA.OVL");
  if (overlay) {
    row.overlay = identity(overlay.name, overlay.data);
    row.overlayAssociation = "co-located-unverified";
  } else row.issues.push("Missing AGIDATA.OVL; overlay association unknown");
  const loaders = [...files.entries()]
    .filter(([name]) => /\.COM$/.test(name))
    .sort(([a], [b]) => a.localeCompare(b));
  row.loaders = loaders.map(([, file]) => identity(file.name, file.data));
  const raw = files.get("AGI");
  if (!raw) {
    row.issues.push(
      "Missing AGI interpreter; disk images and other executable layouts are not decoded",
    );
    return row;
  }
  row.raw = identity(raw.name, raw.data);
  const candidates: {
    data: Uint8Array;
    loader: string | null;
    mz: ReturnType<typeof readMzHeader>;
  }[] = [];
  const alreadyMz = raw.data[0] === 0x4d && raw.data[1] === 0x5a;
  if (alreadyMz) {
    try {
      candidates.push({ data: raw.data, loader: null, mz: interpreterImage(raw.data) });
    } catch (error) {
      row.issues.push(error instanceof Error ? error.message : String(error));
    }
  } else {
    for (const [, loader] of loaders) {
      if (loader.data.length < 0x41 + 128) continue;
      const data = descrambleAgi(raw.data, loader.data.subarray(0x41, 0x41 + 128));
      try {
        candidates.push({ data, loader: loader.name, mz: interpreterImage(data) });
      } catch {
        // Unrelated COM files are inventoried but are not accepted as decoding keys.
      }
    }
  }
  const hashes = new Set(candidates.map((candidate) => identity("decoded", candidate.data).sha256));
  const candidate = candidates[0];
  if (!candidate || hashes.size !== 1) {
    row.status = "unsupported";
    row.issues.push(
      candidate
        ? "Ambiguous loader keys produce different valid images"
        : "No supported AGI image; provide its matching v2 COM loader or an already-MZ executable",
    );
    return row;
  }
  const decodedIdentity = identity("decoded", candidate.data);
  row.decoded = {
    bytes: decodedIdentity.bytes,
    sha256: decodedIdentity.sha256,
    method: alreadyMz ? "already-mz" : "corrected-v2-loader-key",
    loaderCandidates: candidates.flatMap((entry) => (entry.loader === null ? [] : [entry.loader])),
    mz: candidate.mz,
  };
  row.status = "inventoried";
  if (candidate.mz.fileSizeDelta !== 0)
    row.issues.push(
      `MZ actual file length minus declared length: ${candidate.mz.fileSizeDelta}; do not infer a complete DOS load from inventory`,
    );
  for (const [source, data] of [
    ["decoded AGI", candidate.data],
    ...(overlay ? [[overlay.name, overlay.data] as const] : []),
  ] as const) {
    const build = findVersionString(data);
    if (build !== null) row.buildCandidates.push({ source, build });
  }
  const builds = new Set(row.buildCandidates.map((entry) => entry.build));
  if (builds.size === 1) {
    row.build = row.buildCandidates[0]!.build;
    if (Object.hasOwn(PROFILES, row.build)) {
      row.profile = row.build as ProfileId;
      row.profileBasis = "exact-build";
    } else if (EQUIVALENT_BUILDS[row.build]) {
      row.profile = EQUIVALENT_BUILDS[row.build]!;
      row.profileBasis = "documented-equivalent";
    }
  } else if (builds.size > 1) row.issues.push("Conflicting build strings; profile remains unknown");
  if (row.profile === null)
    row.issues.push("Unknown supported interpreter profile; no container fallback applied");
  return row;
}

/** Scan immediate fixture folders. The report contains hashes/metadata, never original bytes. */
export function inventoryInterpreters(library: string) {
  const interpreters: InterpreterInventory[] = [];
  const issues: string[] = [];
  if (!existsSync(library)) issues.push("Missing private fixture library");
  else
    for (const entry of readdirSync(library, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (
        !entry.isDirectory() &&
        !(
          entry.isSymbolicLink() &&
          statSync(join(library, entry.name), { throwIfNoEntry: false })?.isDirectory()
        )
      )
        continue;
      const folder = join(library, entry.name);
      const names = readdirSync(folder).filter((name) =>
        /^(?:AGI|AGIDATA\.OVL|WORDS\.TOK)$|\.COM$/i.test(name),
      );
      const hasDiskImage = readdirSync(folder).some((name) => /\.(?:img|ima)$/i.test(name));
      if (!names.length && !hasDiskImage) continue;
      const files = new Map<string, Uint8Array>();
      for (const name of names)
        if (statSync(join(folder, name)).isFile())
          files.set(name, readFileSync(join(folder, name)));
      interpreters.push(inspectInterpreter(entry.name, files));
    }
  if (!interpreters.length) issues.push("No interpreter fixtures discovered");
  return {
    schema: 1,
    evidence: "static-inventory",
    tool: "scripts/interpreter-inventory.ts",
    toolSha256: identity("tool", readFileSync(fileURLToPath(import.meta.url))).sha256,
    decoderSha256: identity(
      "decoder",
      readFileSync(new URL("./descramble-agi.ts", import.meta.url)),
    ).sha256,
    nodeVersion: process.version,
    controlledInputs: "none: no BIOS, timer, device or interpreter execution",
    interpreters,
    issues,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [library, ...extra] = process.argv.slice(2);
  if (!library || extra.length) {
    console.error(
      "Usage: node --experimental-strip-types scripts/interpreter-inventory.ts LIBRARY_DIR > SCRATCH_JSON",
    );
    process.exitCode = 1;
  } else console.log(JSON.stringify(inventoryInterpreters(library), null, 2));
}
