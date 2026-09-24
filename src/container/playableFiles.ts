/**
 * The playable file vocabulary: which files make up an AGI game, and the one
 * canonical spelling of each. Import, discovery, export, revision hashing and
 * interpreter detection all ask this module, so the same bytes are the same
 * game whatever path or spelling they arrived by. Authoring sidecars (tests,
 * notes, history) are not playable and keep their own names.
 */
import type { ProfileId } from "../runtime/profile.ts";

/** PC interpreter files whose version string identifies the build. */
export const INTERPRETER_FILES: readonly string[] = ["AGIDATA.OVL", "AGI"];

/**
 * Amiga hunk executables by their shipped names (docs/fidelity.md "Amiga
 * interpreter profiles"); each names its interpreter build.
 */
export const AMIGA_INTERPRETER_FILES: Readonly<Record<string, ProfileId>> = {
  SIERRA: "amiga-2.082",
  KQ2: "amiga-2.176",
  SQ2: "amiga-2.202",
  PQ: "amiga-2.310",
  GR: "amiga-2.316",
  MH2: "amiga-2.333",
};

/** The Apple IIgs wavetable its interpreter uploads to the sound chip. */
export const IIGS_WAVETABLE = "SIERRASTANDARD";

/**
 * Whether a file is an interpreter executable detection reads: the PC
 * version-string carriers and `*.COM` loaders, the Amiga hunk executables
 * and the Apple IIgs `*.SYS16` load file.
 */
export function isInterpreterFileName(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    INTERPRETER_FILES.includes(upper) ||
    /^[A-Z0-9_-]+\.(?:COM|SYS16)$/.test(upper) ||
    Object.hasOwn(AMIGA_INTERPRETER_FILES, upper)
  );
}

/**
 * The canonical playable file set: directory and volume files, vocabulary and
 * objects, interpreter executables and the IIgs wavetable. A Game export
 * ships exactly these, and they alone define the resource revision.
 */
export function isPlayableFileName(name: string): boolean {
  return (
    /^([A-Z0-9_]*DIR|DIRS|[A-Z0-9_]*VOL\.(?:[0-9]|1[0-5])|WORDS\.TOK|OBJECT)$/i.test(name) ||
    name.toUpperCase() === IIGS_WAVETABLE ||
    isInterpreterFileName(name)
  );
}

/**
 * Canonical spelling of a file name, or the name unchanged. Every playable
 * name matches case-insensitively and is spelled in upper case — `logdir` is
 * LOGDIR, `sierra.com` is SIERRA.COM, the Amiga `Sierra` is SIERRA — and the
 * Amiga v3 `dirs` file is the combined directory DIR. TESTS.JSON, the stored
 * game tests, is canonical too. Other names keep their own spelling.
 */
export function canonicalResourceName(name: string): string {
  const upper = name.toUpperCase();
  if (upper === "DIRS") return "DIR";
  if (upper === "TESTS.JSON" || isPlayableFileName(name)) return upper;
  return name;
}
