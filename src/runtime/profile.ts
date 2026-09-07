/**
 * Interpreter version profiles, clean-room from Peter Kelly's agi-re behavioral
 * specification: "Version Profiles" and "Conformance Matrix" (profile-variant
 * tables), with the per-field contracts in "Logic Bytecode",
 * "Input, Text and Menus", "Object Behavior" and "Picture Resources".
 *
 * A profile is the single place that records an observable variant. The engine
 * selects behavior by reading these fields; it never compares version strings.
 * Fields whose code path does not exist yet are still recorded here, so the
 * chapter that implements the path lands on an existing, cited value.
 *
 * The promoted profiles are 2.089, 2.230, 2.272, 2.411, 2.440, 2.917, 2.936,
 * 3.002.086, 3.002.102 and 3.002.149 (conformance matrix, "The common core
 * applies to profiles ..."). Similarity to a promoted profile must never be
 * inferred from a version number (version_profiles.md, "Other observed
 * versions").
 */

/** Identifier of a promoted profile. */
export type ProfileId =
  | "2.089"
  | "2.230"
  | "2.272"
  | "2.411"
  | "2.440"
  | "2.917"
  | "2.936"
  | "3.002.086"
  | "3.002.102"
  | "3.002.149";

/** Resource container family (conformance matrix, "Resource directory"). */
export type ContainerKind = "v2-split" | "v3-combined";

/** Extra action slots above the shared 2.936 range (logic_bytecode "Version 3 extension actions"). */
export type ExtraActions = "none" | "v3-086" | "v3-full";

/** Menu-construction action support (conformance matrix, "Exit and menu actions"). */
export type MenuActionSupport = "none" | "stub" | "full";

/** Action 0xad semantics (input_text_and_menus "Tracked key release"). */
export type ReleaseGateAction = "unavailable" | "increment" | "set";

/** Actions 0xa3/0xa4 (conformance matrix, "Input-width actions"). */
export type InputWidthActions = "effect" | "noop";

/** Automatic direction-based loop selection (object_behavior "Direction and automatic loop selection"). */
export type DirectionLoopRule = "exact-four" | "four-or-more" | "four-or-more-f20";

/** When direction-based loop selection runs (object_behavior, same section). */
export type DirectionLoopTiming = "every-pass" | "cadence-due";

/** Position actions 0x25/0x26 ordering (conformance matrix, "Position and composition"). */
export type PositionActionOrder = "erase-then-store" | "store-together";

/** Ordering within the earlier-drawn partition (object_behavior "Drawing order and refresh"). */
export type PartitionOrder = "object-number" | "drawing-key";

/** Pattern-command profile for picture commands 0xf9/0xfa (picture chapter; version_profiles per profile). */
export type PatternProfile = "none" | "point-2.411" | "shaped-v2" | "v3-center-row";

/** Actions 0x4d/0x4e (conformance matrix, "Movement-clear actions"). */
export type MovementClearRule = "early" | "later";

/** Sound output family (conformance matrix, "Sound output" / "Sound channels"). */
export type SoundProfile = "early-2.089" | "early-2.272" | "early-2.411" | "early-2.440" | "common";

export interface AgiProfile {
  /** Promoted profile identifier, e.g. "2.936". */
  readonly id: ProfileId;

  // ---- resource container (conformance matrix, "Resource and bytecode variants") ----
  /** Split family directories (v2) or one combined prefixed directory (v3). */
  readonly container: ContainerKind;
  /** Volume record header size: five bytes in v2, seven in v3. */
  readonly volumeHeaderBytes: 5 | 7;
  /**
   * Inventory metadata (OBJECT) storage: profiles 2.089, 2.230 and 2.272 store
   * it expanded and plain; later profiles apply the repeating-key transform
   * (conformance matrix, "Resource container" rows for those profiles).
   */
  readonly inventoryMetadataEncrypted: boolean;

  // ---- bytecode ranges (logic_bytecode "Main stream grammar", "Catalog completeness") ----
  /** Highest valid action opcode. Bytes above it are not actions in this profile. */
  readonly maxAction: number;
  /** Highest valid condition opcode; 0x12 in every promoted profile. */
  readonly maxCondition: number;
  /** Extra v3 action slots 0xb0.. (logic_bytecode "Version 3 extension actions"). */
  readonly extraActions: ExtraActions;

  // ---- exit and menu actions (conformance matrix, "Exit and menu actions") ----
  /**
   * Operand bytes consumed by action 0x86. Profiles 2.089 and 2.230 consume
   * none; 2.272 and later consume one selector byte
   * (version_profiles.md, 2.089 and 2.272 sections).
   */
  readonly exitOperandBytes: 0 | 1;
  /**
   * 2.089/2.230: 0x86 terminates unconditionally. 2.272 and later: selector 1
   * terminates immediately, other values ask for confirmation first.
   */
  readonly exitAlwaysImmediate: boolean;
  /**
   * "none": actions 0x9b.. are unavailable (2.089, 2.230).
   * "stub": 0x9b..0xa0 consume operands without constructing menu state (2.272).
   * "full": menu construction and interaction (2.411 and later).
   */
  readonly menuActions: MenuActionSupport;
  /**
   * Separate menu-interaction gate set by action 0xb1 (v3 profiles). The v2
   * profiles have no such gate (conformance matrix, "Menu interaction gate").
   */
  readonly menuInteractionGate: boolean;

  // ---- runtime state ----
  /**
   * String slot count: six (s0..s5) in 2.089/2.230/2.272, twelve in later
   * promoted profiles (input_text_and_menus "String slots").
   */
  readonly stringSlots: 6 | 12;
  /**
   * Script key-map entries: 39 in 2.411..3.002.102, 49 in 3.002.149
   * (input_text_and_menus "Mapped keys"; logic_bytecode action 0x79). The
   * pre-2.411 profiles are not separately specified; they take the same 39.
   */
  readonly keyMapCapacity: number;
  /** Action 0xad: increment modulo 256, set to one, or not exposed (2.411/2.440). */
  readonly releaseGateAction: ReleaseGateAction;
  /** Action 0xb5 clears the key-release gate (3.002.102, 3.002.149). */
  readonly releaseGateClearAction: boolean;
  /** Actions 0xa3/0xa4 enable/clear the fixed input width, or do nothing (3.002.149). */
  readonly inputWidthActions: InputWidthActions;
  /**
   * Action 0xa9 also clears the fixed input-width override. False in
   * 3.002.149, where there is no override to clear
   * (version_profiles.md, 3.002.149 and 3.002.102 sections).
   */
  readonly closeWindowClearsInputWidth: boolean;
  /**
   * Immediate room aliases applied by action 0x12 before the common room
   * effects. Only the observed Gold Rush 3.002.149 build defines them
   * (version_profiles.md 3.002.149; logic_bytecode "Entry-boundary selectors").
   */
  readonly roomAliases: ReadonlyMap<number, number> | null;
  /** Word-sequence condition recognizes 0x270f as the tail terminator (false in 2.089). */
  readonly wordSequenceTailTerminator: boolean;

  // ---- objects and presentation ----
  /** Which loop counts receive automatic direction-based loop selection. */
  readonly directionLoops: DirectionLoopRule;
  /** Selection runs on every eligible pass (2.089/2.230/2.272) or only when the cadence countdown is 1. */
  readonly directionLoopTiming: DirectionLoopTiming;
  /** Position actions erase drawn state before storing the snapshot (2.089 only). */
  readonly positionActionOrder: PositionActionOrder;
  /** Earlier-drawn partition ordering; 2.089 uses object number, everything else the drawing key. */
  readonly earlierPartitionOrder: PartitionOrder;
  /** Packed loop-header orientation/mirroring nibble; unique to 2.230 (conformance matrix, "View loop encoding"). */
  readonly packedViewLoopHeader: boolean;
  /** Object-distance action 0x45 saturates at 254 (later) or wraps its low byte (early profiles). */
  readonly objectDistanceSaturates: boolean;
  /** Target-motion actions 0x51/0x52 defer their first direction/completion calculation (early profiles). */
  readonly targetMotionDeferred: boolean;
  /** Actions 0x4d/0x4e clear semantics; "early" is the 2.089/2.230 form. */
  readonly movementClear: MovementClearRule;
  /** The interactive inventory selector can write v25 (false in 2.089/2.230/2.272). */
  readonly inventorySelector: boolean;
  /** Showing a prepared picture clears f15 and closes an active text window (false in the early profiles). */
  readonly showPictureClearsF15: boolean;
  /**
   * A print that opens a non-blocking window resets f15 as it returns, so the
   * next print blocks again. docs/fidelity.md: print-handler-output-modes
   */
  readonly printConsumesF15: boolean;
  /**
   * A timed print (v21 half-seconds) zeroes v21 when its window closes, by
   * timeout or key. docs/fidelity.md: print-handler-output-modes
   */
  readonly timedPrintClearsV21: boolean;
  /**
   * A due movement proposal whose left X is exactly zero reports left-boundary
   * code 4 (3.002.086 only; version_profiles.md "screen-boundary variant").
   */
  readonly clampExactZeroLeftBoundary: boolean;

  // ---- pictures ----
  /** Highest dispatched picture command byte: 0xf8 in the early profiles, 0xfa later. */
  readonly pictureMaxCommand: number;
  /** Pattern-plot behavior for commands 0xf9/0xfa. */
  readonly patternProfile: PatternProfile;

  // ---- session, diagnostics, persistence ----
  /** Action 0x80 accepts restart without confirmation while f16 is set (false in 2.411). */
  readonly restartPromptBypassedByF16: boolean;
  /** The heap diagnostic prints the later "rm.0, etc." line (false in 2.411/2.440). */
  readonly heapDiagnosticExtraLine: boolean;
  /** Save envelope block count: four in 2.089, five afterwards. */
  readonly saveBlocks: 4 | 5;
  /** Save block 3 is XOR-transformed with the repeating key (v3 profiles). */
  readonly saveBlock3Xor: boolean;

  // ---- sound ----
  /** Sound scheduling/output family. */
  readonly sound: SoundProfile;
}

/** Shared defaults: the 2.936 contracts every field falls back to. */
const BASE_2936: AgiProfile = {
  id: "2.936",
  container: "v2-split",
  volumeHeaderBytes: 5,
  inventoryMetadataEncrypted: true,
  maxAction: 0xaf,
  maxCondition: 0x12,
  extraActions: "none",
  exitOperandBytes: 1,
  exitAlwaysImmediate: false,
  menuActions: "full",
  menuInteractionGate: false,
  stringSlots: 12,
  keyMapCapacity: 39,
  releaseGateAction: "increment",
  releaseGateClearAction: false,
  inputWidthActions: "effect",
  closeWindowClearsInputWidth: true,
  roomAliases: null,
  wordSequenceTailTerminator: true,
  directionLoops: "four-or-more",
  directionLoopTiming: "cadence-due",
  positionActionOrder: "store-together",
  earlierPartitionOrder: "drawing-key",
  packedViewLoopHeader: false,
  objectDistanceSaturates: true,
  targetMotionDeferred: false,
  movementClear: "later",
  inventorySelector: true,
  showPictureClearsF15: true,
  printConsumesF15: true,
  timedPrintClearsV21: true,
  clampExactZeroLeftBoundary: false,
  pictureMaxCommand: 0xfa,
  patternProfile: "shaped-v2",
  restartPromptBypassedByF16: true,
  heapDiagnosticExtraLine: true,
  saveBlocks: 5,
  saveBlock3Xor: false,
  sound: "common",
};

/** Early split-container shape shared by 2.089, 2.230 and 2.272. */
const BASE_EARLY: AgiProfile = {
  ...BASE_2936,
  inventoryMetadataEncrypted: false,
  maxAction: 0x9a,
  exitOperandBytes: 0,
  exitAlwaysImmediate: true,
  menuActions: "none",
  stringSlots: 6,
  releaseGateAction: "unavailable",
  directionLoops: "exact-four",
  directionLoopTiming: "every-pass",
  objectDistanceSaturates: false,
  targetMotionDeferred: true,
  movementClear: "early",
  inventorySelector: false,
  showPictureClearsF15: false,
  printConsumesF15: false,
  timedPrintClearsV21: false,
  pictureMaxCommand: 0xf8,
  patternProfile: "none",
  sound: "early-2.089",
};

/** Combined v3 container shape shared by the 3.002.x profiles. */
const BASE_V3: AgiProfile = {
  ...BASE_2936,
  container: "v3-combined",
  volumeHeaderBytes: 7,
  menuInteractionGate: true,
  patternProfile: "v3-center-row",
  saveBlock3Xor: true,
};

/** Gold Rush 3.002.149 immediate-room aliases: 0x7e, 0x7f and 0x80 select room 0x49. */
const GOLD_RUSH_ROOM_ALIASES: ReadonlyMap<number, number> = new Map([
  [0x7e, 0x49],
  [0x7f, 0x49],
  [0x80, 0x49],
]);

export const PROFILES: Readonly<Record<ProfileId, AgiProfile>> = {
  // version_profiles.md "AGI 2.089 profile"; conformance matrix "2.089 variant selection".
  "2.089": {
    ...BASE_EARLY,
    id: "2.089",
    wordSequenceTailTerminator: false,
    positionActionOrder: "erase-then-store",
    earlierPartitionOrder: "object-number",
    saveBlocks: 4,
  },
  // version_profiles.md "AGI 2.230 profile"; conformance matrix "2.230 variant selection".
  "2.230": {
    ...BASE_EARLY,
    id: "2.230",
    packedViewLoopHeader: true,
  },
  // version_profiles.md "AGI 2.272 profile"; conformance matrix "2.272 variant selection".
  "2.272": {
    ...BASE_EARLY,
    id: "2.272",
    maxAction: 0xa0,
    exitOperandBytes: 1,
    exitAlwaysImmediate: false,
    menuActions: "stub",
    movementClear: "later",
    sound: "early-2.272",
  },
  // version_profiles.md "AGI 2.411 profile"; conformance matrix "2.411 variant selection".
  "2.411": {
    ...BASE_2936,
    id: "2.411",
    maxAction: 0xa9,
    releaseGateAction: "unavailable",
    directionLoops: "exact-four",
    patternProfile: "point-2.411",
    restartPromptBypassedByF16: false,
    heapDiagnosticExtraLine: false,
    sound: "early-2.411",
  },
  // version_profiles.md "AGI 2.440 profile"; conformance matrix "2.440 variant selection".
  "2.440": {
    ...BASE_2936,
    id: "2.440",
    maxAction: 0xa9,
    releaseGateAction: "unavailable",
    directionLoops: "exact-four",
    heapDiagnosticExtraLine: false,
    sound: "early-2.440",
  },
  // version_profiles.md "AGI 2.917 profile"; conformance matrix "2.917 variant selection".
  "2.917": {
    ...BASE_2936,
    id: "2.917",
    maxAction: 0xad,
    directionLoops: "exact-four",
  },
  "2.936": BASE_2936,
  // version_profiles.md "AGI 3.002.086 profile"; conformance matrix "3.002.086 variant selection".
  "3.002.086": {
    ...BASE_V3,
    id: "3.002.086",
    maxAction: 0xb1,
    extraActions: "v3-086",
    clampExactZeroLeftBoundary: true,
  },
  // version_profiles.md "AGI 3.002.102 profile"; conformance matrix "3.002.102 variant selection".
  "3.002.102": {
    ...BASE_V3,
    id: "3.002.102",
    maxAction: 0xb5,
    extraActions: "v3-full",
    releaseGateAction: "set",
    releaseGateClearAction: true,
    directionLoops: "four-or-more-f20",
  },
  // version_profiles.md "AGI 3.002.149 profile"; conformance matrix two-column tables.
  "3.002.149": {
    ...BASE_V3,
    id: "3.002.149",
    maxAction: 0xb5,
    extraActions: "v3-full",
    keyMapCapacity: 49,
    releaseGateAction: "set",
    releaseGateClearAction: true,
    inputWidthActions: "noop",
    closeWindowClearsInputWidth: false,
    // docs/fidelity.md: print-handler-output-modes (Gold Rush build verified).
    printConsumesF15: true,
    timedPrintClearsV21: true,
    directionLoops: "four-or-more-f20",
    // The base MH2 build defines no aliases; select the Gold Rush build with
    // goldRushProfile() when a claim uses that data.
    roomAliases: null,
  },
};

/**
 * The observed Gold Rush 3.002.149 build. A conformance claim must state which
 * build variant it uses (version_profiles.md, 3.002.149 section).
 */
export const GOLD_RUSH_3_002_149: AgiProfile = {
  ...PROFILES["3.002.149"],
  roomAliases: GOLD_RUSH_ROOM_ALIASES,
};

/** String-keyed lookup used by detection (an arbitrary string may name no profile). */
const BY_ID: Readonly<Record<string, AgiProfile | undefined>> = PROFILES;

/** Fallback when no interpreter version string is available. */
export const DEFAULT_V2_PROFILE = PROFILES["2.936"];
export const DEFAULT_V3_PROFILE = PROFILES["3.002.149"];

/**
 * Observed builds that the specification states select a promoted profile:
 * 2.915 and the second 2.917 build select 2.917, 2.439 selects 2.440, and
 * 3.002.107 selects 3.002.102 (version_profiles.md, per-profile paragraphs).
 * No other similarity may be assumed.
 */
const EQUIVALENT_BUILDS: Readonly<Record<string, ProfileId>> = {
  "2.915": "2.917",
  "2.439": "2.440",
  "3.002.107": "3.002.102",
};

/**
 * Files that carry the interpreter's ASCII version string. On the observed
 * installations the string lives in AGIDATA.OVL ("Adventure Game Interpreter\n
 * Version 2.917"); the loader/boot files are searched too because other
 * installations place it there.
 */
export const INTERPRETER_FILES: readonly string[] = ["AGIDATA.OVL", "AGI"];

const DIGIT_0 = 0x30;
const DIGIT_9 = 0x39;
const DOT = 0x2e;

function isDigit(b: number | undefined): boolean {
  return b !== undefined && b >= DIGIT_0 && b <= DIGIT_9;
}

function digitsAt(bytes: Uint8Array, at: number, count: number): string | null {
  let out = "";
  for (let i = 0; i < count; i++) {
    const b = bytes[at + i];
    if (!isDigit(b)) return null;
    out += String.fromCharCode(b!);
  }
  return out;
}

/**
 * First interpreter version string in a binary, as ASCII: "2.936" or
 * "3.002.149". A candidate must not be followed by another digit, so a longer
 * numeric run is never truncated into a false match.
 */
export function findVersionString(bytes: Uint8Array): string | null {
  for (let i = 0; i + 4 < bytes.length; i++) {
    const lead = bytes[i]!;
    if (bytes[i + 1] !== DOT) continue;
    if (isDigit(bytes[i - 1])) continue;
    if (lead === 0x33) {
      // 3.002.xxx: major, minor triple, patch triple.
      const minor = digitsAt(bytes, i + 2, 3);
      if (minor === null || bytes[i + 5] !== DOT) continue;
      const patch = digitsAt(bytes, i + 6, 3);
      if (patch === null || isDigit(bytes[i + 9])) continue;
      return `3.${minor}.${patch}`;
    }
    if (lead === 0x32) {
      const minor = digitsAt(bytes, i + 2, 3);
      if (minor === null || isDigit(bytes[i + 5]) || bytes[i + 5] === DOT) continue;
      return `2.${minor}`;
    }
  }
  return null;
}

/** Interpreter version string found in a game folder's binaries, if any. */
export function detectVersionString(files: ReadonlyMap<string, Uint8Array>): string | null {
  const loaders = [...files.keys()].filter((name) => /^[A-Z0-9_-]+\.COM$/i.test(name)).sort();
  for (const name of [...INTERPRETER_FILES, ...loaders]) {
    const bytes = files.get(name);
    if (!bytes) continue;
    const found = findVersionString(bytes);
    if (found !== null) return found;
  }
  return null;
}

/** True when the file map looks like a combined v3 container (`<PREFIX>DIR` + `<PREFIX>VOL.n`). */
function hasCombinedDirectory(files: ReadonlyMap<string, Uint8Array>): boolean {
  for (const name of files.keys()) {
    const m = /^(.+)DIR$/.exec(name);
    if (!m) continue;
    const prefix = m[1]!;
    if (prefix === "LOG" || prefix === "PIC" || prefix === "VIEW" || prefix === "SND") continue;
    for (const other of files.keys()) {
      if (other.startsWith(`${prefix}VOL.`)) return true;
    }
  }
  return false;
}

/**
 * Select the interpreter profile for a game folder.
 *
 * The interpreter version is not recorded in the resource container, so
 * detection is: an explicit override, then the ASCII version string in an
 * interpreter binary shipped alongside the data, then the container shape
 * (v2 split -> 2.936, v3 combined -> 3.002.149). A version string that names
 * no promoted profile falls back to the container shape as well: similarity to
 * a promoted profile must not be assumed (version_profiles.md, "Other observed
 * versions").
 */
export function detectProfile(
  files: ReadonlyMap<string, Uint8Array>,
  override?: ProfileId | AgiProfile,
): AgiProfile {
  if (override !== undefined) {
    if (typeof override !== "string") return override;
    const chosen = BY_ID[override];
    if (!chosen) throw new RangeError(`unknown interpreter profile ${override}`);
    return chosen;
  }
  const version = detectVersionString(files);
  if (version !== null) {
    const direct = BY_ID[version];
    if (direct) return direct;
    const equivalent = EQUIVALENT_BUILDS[version];
    if (equivalent) return PROFILES[equivalent];
  }
  return hasCombinedDirectory(files) ? DEFAULT_V3_PROFILE : DEFAULT_V2_PROFILE;
}
