/**
 * Interpreter version profiles, clean-room from Peter Kelly's agi-re behavioral
 * specification: "Version Profiles" and "Conformance Matrix" (profile-variant
 * tables), with the per-field contracts in "Logic Bytecode",
 * "Input, Text and Menus", "Object Behavior" and "Picture Resources".
 *
 * A profile is the single place that records an observable variant. The engine
 * selects behavior by reading these fields; it never compares version strings.
 * Detection uses the version string, the documented equivalent builds below,
 * or a container-family fallback when the version is missing or unrecognized.
 */

import { canonicalResourceName } from "../types.ts";
import { sha256Hex } from "../crypto.ts";
import { detectKnownGameByHashes, type KnownAgiGame } from "../games/knownGames.ts";

/** Identifier of a promoted profile. */
export type ProfileId =
  | "2.001"
  | "2.089"
  | "2.230"
  | "2.272"
  | "2.411"
  | "2.440"
  | "2.917"
  | "2.936"
  | "3.002.086"
  | "3.002.102"
  | "3.002.149"
  | "amiga-2.082"
  | "amiga-2.176"
  | "amiga-2.202"
  | "amiga-2.310"
  | "amiga-2.316"
  | "amiga-2.333"
  | "iigs-1.014";

/** Resource container family (conformance matrix, "Resource directory"). */
export type ContainerKind = "v2-split" | "v3-combined";

/**
 * Extra action slots above the shared 2.936 range (logic_bytecode "Version 3
 * extension actions"; "amiga-2.31x" is the Amiga 2.31x tail through 0xb6,
 * docs/fidelity.md "Amiga interpreter profiles"; "iigs" is the Apple IIgs
 * 0xb0..0xb1 range, docs/fidelity.md "Apple IIgs interpreter").
 */
export type ExtraActions = "none" | "v3-086" | "v3-full" | "amiga-2.31x" | "iigs";

/** Menu-construction action support (conformance matrix, "Exit and menu actions"). */
export type MenuActionSupport = "none" | "stub" | "full";

/**
 * Action 0xa1 semantics: "effect" requests the menu interaction; "noop" is the
 * Amiga stub slot (menu interaction is native, docs/fidelity.md).
 */
export type MenuInputAction = "effect" | "noop";

/** Action 0xae semantics: "effect" sets the priority base; "noop" is the Amiga stub slot. */
export type PriorityBaseAction = "effect" | "noop";

/** Action 0xb4 semantics: "noop" on PC v3; Amiga writes the pointer position into its operands. */
export type MousePosnAction = "noop" | "write-pointer";

/**
 * What a left click in the game window does (docs/fidelity.md "Original
 * click-to-walk"). "none": the PC interpreters take no pointer input.
 * "amiga": left-button-down starts ego's click-move toward the click unless a
 * menu or text window is up. "amiga-2.31x" adds the script surface: the click
 * also sets f19, latches the position `mouse.posn` reports and adds the
 * `adj.ego.move.to.x.y` nudge to the target. "iigs": the same starter,
 * ignoring clicks on the menu bar (screen rows 0-7) and taking no nudge.
 */
export type ClickMoveRule = "none" | "amiga" | "amiga-2.31x" | "iigs";

/**
 * Width of the wander countdown and follow delay (docs/fidelity.md
 * "Original motion counter width"). "byte": the PC counters wrap modulo 256
 * and compare signed bytes. "word": the Amiga and IIgs object records hold
 * them as signed words — the wander decrement goes negative and rerolls,
 * the follow delay subtracts and clamps at zero, and `wander` leaves the
 * countdown as it found it.
 */
export type MotionCounters = "byte" | "word";

/**
 * Condition 0x13 semantics for profiles whose dispatchers reach it. The
 * Amiga 2.31x handler tests ego's motion mode against the click-move value.
 * The Apple IIgs and Amiga 2.082 evaluators' bounds admit 0x13 but their
 * 19-entry handler tables end at 0x12 — the slot reads past the table, so
 * evaluating it has no defined behavior (docs/fidelity.md "Apple IIgs
 * interpreter", "Amiga interpreter profiles").
 */
export type Condition0x13 = "click-move" | "constant-false" | "wild-dispatch";

/** Action 0xad semantics (input_text_and_menus "Tracked key release"). */
export type ReleaseGateAction = "unavailable" | "increment" | "set" | "noop";

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
/**
 * Pattern-plot geometry for picture commands 0xf9/0xfa. "shaped-v2": the v2
 * brush table, horizontal limit 320. "v3-center-row": radius 1 is the
 * center-row cross and the limit 318. The Amiga and IIgs plotters keep the
 * 320 limit: "center-row-320" (Amiga 2.31x, IIgs) has the cross, and
 * "short-r1" (Amiga 2.176/2.202) stores radius 1 as two rows, so its third
 * row is radius 2's first word (docs/fidelity.md "Original Amiga and IIgs
 * pattern brushes").
 */
export type PatternProfile =
  "none" | "point-2.411" | "shaped-v2" | "v3-center-row" | "center-row-320" | "short-r1";

/** Actions 0x4d/0x4e (conformance matrix, "Movement-clear actions"). */
export type MovementClearRule = "early" | "later";

/**
 * Sound output family (conformance matrix, "Sound output" / "Sound
 * channels"; "booter-2.001" per docs/fidelity.md pc-booter-sound-rows;
 * "amiga" is the Paula driver shared by Amiga 2.176 and later, and
 * "amiga-2.082" is the distinct older driver inside the SQ1 build,
 * docs/fidelity.md "Original Amiga sound player").
 */
export type SoundProfile =
  | "booter-2.001"
  | "early-2.089"
  | "early-2.272"
  | "early-2.411"
  | "early-2.440"
  | "common"
  | "amiga"
  | "amiga-2.082"
  | "iigs";

/**
 * The measured decay-envelope shape for the "common" sound family
 * (docs/fidelity.md, "Original sound player audit"): the 68-entry table
 * executed on KQ1 2.917, or the 78-entry table executed on MH1 3.002.107 and
 * GR1 3.002.149. Unmeasured common-family profiles keep the 2.917 table —
 * the audit does not license extending the v3 shape to them.
 *
 * For the "amiga" family the field selects between the two observed data
 * hunks: KQ2 2.176's signed attack curve ("amiga-2.176") and the shared
 * 2.202..2.333 decay table ("amiga-2.202"); the driver code is identical
 * (docs/fidelity.md, "Original Amiga sound player").
 */
export type SoundEnvelope = "2.917" | "3.002" | "amiga-2.176" | "amiga-2.202";

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
  /**
   * OBJECT header size in the expanded form: the documented profiles carry
   * item_table_size u16le plus the maximum drawable object index byte; the
   * observed 2.001 file is the u16le item table size followed immediately by
   * the three-byte entries, with no object-index byte and no name pool
   * (docs/fidelity.md pc-booter-inventory-file). The Amiga builds carry a
   * four-byte header (table size u16le, object index u16le).
   */
  readonly inventoryHeaderBytes: 2 | 3 | 4;
  /**
   * OBJECT entry stride in the expanded form: three bytes on PC
   * ({nameOffset u16le, room u8}), four on Amiga
   * ({nameOffset u16le, room u8, pad u8}; docs/fidelity.md).
   */
  readonly inventoryEntryBytes: 3 | 4;

  // ---- bytecode ranges (logic_bytecode "Main stream grammar", "Catalog completeness") ----
  /** Highest valid action opcode. Bytes above it are not actions in this profile. */
  readonly maxAction: number;
  /** Highest valid condition opcode; 0x12 everywhere except Amiga 2.082, the Amiga 2.31x generation and the Apple IIgs build (0x13). */
  readonly maxCondition: number;
  /**
   * Semantics of condition 0x13 where it dispatches (Amiga click-move; the
   * IIgs slot reads past its handler table — a wild dispatch). Profiles
   * bounded at 0x12 never consult this field.
   */
  readonly condition0x13: Condition0x13;
  /** Extra action slots 0xb0.. (logic_bytecode "Version 3 extension actions"; Amiga 2.31x tail). */
  readonly extraActions: ExtraActions;
  /**
   * Action 0x8f semantics:
   * - "max-drawn-objects": in 2.001 (load-module 0x0284), action 0x8f is
   *   `max.drawn.objects(count)`, which configures the animated/drawn object
   *   table capacity (docs/fidelity.md pc-booter-action-0x8f).
   * - "set-game-id": in 2.089 and later, action 0x8f is `set.game.id(message_num)`,
   *   which copies up to seven message bytes into the runtime signature
   *   (spec "Save names and signatures").
   */
  readonly action0x8f: "max-drawn-objects" | "set-game-id";

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
   * Action 0xa1 menu.input: "effect" requests menu interaction; "noop" is the
   * Amiga stub slot — the Amiga menu system is driven natively, not by script
   * (docs/fidelity.md "Amiga interpreter profiles").
   */
  readonly menuInputAction: MenuInputAction;
  /**
   * Separate menu-interaction gate set by action 0xb1 (v3 profiles). The v2
   * profiles have no such gate (conformance matrix, "Menu interaction gate").
   */
  readonly menuInteractionGate: boolean;

  // ---- runtime state ----
  /**
   * String slot count: six (s0..s5) in 2.089/2.230/2.272 and Amiga 2.082,
   * twelve in the later promoted PC profiles, thirteen in Amiga 2.176+ and
   * the Apple IIgs build — the parse() operand bound read off the
   * executables (input_text_and_menus "String slots"; docs/fidelity.md
   * "Amiga interpreter profiles" and "Apple IIgs interpreter").
   */
  readonly stringSlots: 6 | 12 | 13;
  /**
   * Script key-map entries: 39 in 2.411..3.002.102 and Amiga 2.176+, 49 in
   * 3.002.149, and 40 in Amiga 2.082 and the Apple IIgs build — the set.key
   * scan bound read off the executables (input_text_and_menus "Mapped keys";
   * logic_bytecode action 0x79; docs/fidelity.md). The pre-2.411 PC profiles
   * are not separately specified; they take the same 39.
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
   * Action 0xae set.pri.base: "effect" sets the priority-band base; "noop" is
   * the Amiga 2.31x stub slot (docs/fidelity.md).
   */
  readonly priorityBaseAction: PriorityBaseAction;
  /**
   * Action 0xb4 mouse.posn: "noop" on the PC v3 profiles; "write-pointer"
   * writes pointerX/2 and pointerY into its variable operands on the Amiga
   * 2.31x generation (docs/fidelity.md).
   */
  readonly mousePosnAction: MousePosnAction;
  /** Left-click handling: none on PC; Amiga and IIgs start ego's click-move. */
  readonly clickMove: ClickMoveRule;
  /** Wander and follow counter width: PC bytes, Amiga and IIgs words. */
  readonly motionCounters: MotionCounters;
  /**
   * Immediate room aliases applied by action 0x12 before the common room
   * effects. Supplied through an explicit profile override for build-specific
   * mappings (version_profiles.md 3.002.149).
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
  /**
   * Object-distance action 0x45 saturates at 254 (later PC and Amiga), at 255
   * on the IIgs — where a far object reads like an undrawn one — or wraps its
   * low byte (null, early profiles).
   */
  readonly objectDistanceCap: 254 | 255 | null;
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
  /** Save envelope block count: four in 2.089, five on PC and Amiga, six on the Apple IIgs build. */
  readonly saveBlocks: 4 | 5 | 6;
  /** Save block 3 is XOR-transformed with the repeating key (v3 profiles). */
  readonly saveBlock3Xor: boolean;

  // ---- sound ----
  /** Sound scheduling/output family. */
  readonly sound: SoundProfile;
  /** Decay-envelope selection for the "common" family (unused by early/booter sound). */
  readonly soundEnvelope: SoundEnvelope;
}
/** Shared defaults: the 2.936 contracts every field falls back to. */
const BASE_2936: AgiProfile = {
  id: "2.936",
  container: "v2-split",
  volumeHeaderBytes: 5,
  inventoryMetadataEncrypted: true,
  inventoryHeaderBytes: 3,
  inventoryEntryBytes: 3,
  action0x8f: "set-game-id",
  maxAction: 0xaf,
  maxCondition: 0x12,
  condition0x13: "constant-false",
  extraActions: "none",
  exitOperandBytes: 1,
  exitAlwaysImmediate: false,
  menuActions: "full",
  menuInputAction: "effect",
  menuInteractionGate: false,
  stringSlots: 12,
  keyMapCapacity: 39,
  releaseGateAction: "increment",
  releaseGateClearAction: false,
  inputWidthActions: "effect",
  closeWindowClearsInputWidth: true,
  priorityBaseAction: "effect",
  mousePosnAction: "noop",
  clickMove: "none",
  motionCounters: "byte",
  roomAliases: null,
  wordSequenceTailTerminator: true,
  directionLoops: "four-or-more",
  directionLoopTiming: "cadence-due",
  positionActionOrder: "store-together",
  earlierPartitionOrder: "drawing-key",
  packedViewLoopHeader: false,
  objectDistanceCap: 254,
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
  soundEnvelope: "2.917",
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
  objectDistanceCap: null,
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

/**
 * Amiga OBJECT metadata layout (docs/fidelity.md "Amiga interpreter
 * profiles"): a four-byte header (table size u16le, object index u16le) and
 * four-byte entries ({nameOffset u16le, room u8, pad u8}), verified on the
 * unencrypted SQ1 file and the key-encrypted KQ2/SQ2/PQ1/GR/MH2 files.
 */
const AMIGA_INVENTORY = {
  inventoryHeaderBytes: 4,
  inventoryEntryBytes: 4,
} as const;

/**
 * Amiga 2.31x generation (PQ1 2.310, GR 2.316, MH2 2.333), derived from the
 * documented 3.002.149 profile: same container, bytecode and runtime shape
 * except where the executables disagree — 183 action slots through 0xb6, 20
 * condition slots through 0x13, and stub handlers for menu.input,
 * open/close.dialogue, hold.key, set.pri.base, discard.sound, hide.mouse,
 * allow.menu, show.mouse, fence.mouse and release.key (docs/fidelity.md
 * "Amiga interpreter profiles"). Sound decodes through the Paula driver
 * (docs/fidelity.md "Original Amiga sound player"). Verified against the
 * executables and their shipped Save/ images: thirteen string slots, a
 * 39-entry key map, exact-four direction selection applied when the cadence
 * countdown is due, and the five-block Amiga save envelope.
 */
const BASE_AMIGA_31X: AgiProfile = {
  ...BASE_V3,
  id: "amiga-2.310",
  maxAction: 0xb6,
  maxCondition: 0x13,
  condition0x13: "click-move",
  extraActions: "amiga-2.31x",
  stringSlots: 13,
  keyMapCapacity: 39,
  releaseGateAction: "noop",
  releaseGateClearAction: false,
  inputWidthActions: "noop",
  closeWindowClearsInputWidth: false,
  menuInputAction: "noop",
  menuInteractionGate: false,
  priorityBaseAction: "noop",
  mousePosnAction: "write-pointer",
  clickMove: "amiga-2.31x",
  motionCounters: "word",
  directionLoops: "exact-four",
  directionLoopTiming: "cadence-due",
  // The Amiga save writes the inventory region raw; the v3 XOR transform is
  // a PC v3 behavior only (docs/fidelity.md "Amiga interpreter profiles").
  // Fields not listed here were checked against the handlers and match the
  // base; docs/fidelity.md "Amiga profile fields verified from the handlers".
  saveBlock3Xor: false,
  patternProfile: "center-row-320",
  heapDiagnosticExtraLine: false,
  sound: "amiga",
  soundEnvelope: "amiga-2.202",
  ...AMIGA_INVENTORY,
};

export const PROFILES: Readonly<Record<ProfileId, AgiProfile>> = {
  // PC booter 2.001: no promoted spec profile exists (the catalog starts at
  // 2.089). Evidence-backed fields only; every other field inherits the
  // earliest documented contract and is listed as unverified in
  // docs/fidelity.md (pc-booter-2.001-profile).
  "2.001": {
    ...BASE_EARLY,
    id: "2.001",
    // The booter dispatch is bounded at 0x90, below the later 2.089 bound.
    // docs/fidelity.md: PC booter action 0x8f (max.drawn.objects).
    maxAction: 0x90,
    inventoryHeaderBytes: 2,
    action0x8f: "max-drawn-objects",
    sound: "booter-2.001",
  },
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
    // MH1 3.002.107's measured envelope; the conformance matrix promotes that
    // build to this profile (docs/fidelity.md, sound player audit).
    soundEnvelope: "3.002",
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
    // docs/fidelity.md: print-handler-output-modes.
    printConsumesF15: true,
    timedPrintClearsV21: true,
    directionLoops: "four-or-more-f20",
    roomAliases: null,
    // GR1 3.002.149's measured envelope (docs/fidelity.md, sound player audit).
    soundEnvelope: "3.002",
  },
  // Amiga "Sierra" 2.082 (SQ1 Amiga): 161 action slots through 0xa0, 19
  // condition slots through 0x12 behind an inclusive 0x13 bound, one-byte
  // quit selector, real menu handlers
  // and a plain OBJECT file (docs/fidelity.md "Amiga interpreter profiles").
  // Verified on the executable and its shipped Save/ images: six string
  // slots, a 40-entry key map, direction selection on every pass, and the
  // older sound driver family distinct from the later Paula driver.
  // Unlisted fields match the base: docs/fidelity.md "Amiga profile fields
  // verified from the handlers".
  "amiga-2.082": {
    ...BASE_EARLY,
    ...AMIGA_INVENTORY,
    id: "amiga-2.082",
    maxAction: 0xa0,
    // The condition bound is inclusive (`cmpi.l #$13, bls`) but the table
    // holds 0x00..0x12, so 0x13 jumps through the bytes past its end
    // (docs/fidelity.md "Amiga interpreter profiles").
    maxCondition: 0x13,
    condition0x13: "wild-dispatch",
    clickMove: "amiga",
    motionCounters: "word",
    // restart.game prompts without testing f16; the timed print clears v21
    // on either exit; show.mem has no "rm.0" line (docs/fidelity.md
    // "Amiga profile fields verified from the handlers").
    restartPromptBypassedByF16: false,
    timedPrintClearsV21: true,
    heapDiagnosticExtraLine: false,
    exitOperandBytes: 1,
    exitAlwaysImmediate: false,
    menuActions: "full",
    menuInputAction: "noop",
    keyMapCapacity: 40,
    // Sierra's stop.motion clears the motion word like the later builds
    // (docs/fidelity.md "Amiga interpreter profiles").
    movementClear: "later",
    saveBlocks: 5,
    sound: "amiga-2.082",
  },
  // Amiga "KQ2" 2.176 (KQ2 Amiga): 170 action slots through 0xa9, 19
  // condition slots; menu.input and open/close.dialogue share the stub
  // routine; the OBJECT file is key-encrypted (docs/fidelity.md). Verified:
  // thirteen string slots, 39 key-map entries, direction selection on the
  // cadence countdown, the shared Paula driver with KQ2's own envelope.
  "amiga-2.176": {
    ...BASE_EARLY,
    ...AMIGA_INVENTORY,
    id: "amiga-2.176",
    maxAction: 0xa9,
    clickMove: "amiga",
    motionCounters: "word",
    exitOperandBytes: 1,
    exitAlwaysImmediate: false,
    menuActions: "full",
    menuInputAction: "noop",
    inputWidthActions: "noop",
    inventoryMetadataEncrypted: true,
    stringSlots: 13,
    directionLoopTiming: "cadence-due",
    // KQ2's distance, stop.motion, show.pic and print worker share the later
    // behavior, verified on the executable (docs/fidelity.md).
    objectDistanceCap: 254,
    movementClear: "later",
    showPictureClearsF15: true,
    printConsumesF15: true,
    // move.obj steers at once, status is the interactive selector, the timed
    // print clears v21, pictures dispatch 0xf9/0xfa with the short radius-1
    // brush, and show.mem has no "rm.0" line (docs/fidelity.md).
    targetMotionDeferred: false,
    inventorySelector: true,
    timedPrintClearsV21: true,
    pictureMaxCommand: 0xfa,
    patternProfile: "short-r1",
    heapDiagnosticExtraLine: false,
    saveBlocks: 5,
    sound: "amiga",
    soundEnvelope: "amiga-2.176",
  },
  // Amiga "SQ2" 2.202 (SQ2 Amiga): the same 170/19-slot dispatch shape as
  // 2.176 with the same stub slots (docs/fidelity.md). Verified: thirteen
  // string slots, 39 key-map entries, exact-four direction selection on the
  // cadence countdown, the shared Paula driver and envelope table.
  "amiga-2.202": {
    ...BASE_2936,
    ...AMIGA_INVENTORY,
    id: "amiga-2.202",
    maxAction: 0xa9,
    clickMove: "amiga",
    motionCounters: "word",
    menuInputAction: "noop",
    inputWidthActions: "noop",
    stringSlots: 13,
    directionLoops: "exact-four",
    patternProfile: "short-r1",
    heapDiagnosticExtraLine: false,
    sound: "amiga",
    soundEnvelope: "amiga-2.202",
  },
  // Amiga "PQ" 2.310 / "GR" 2.316 / "MH2" 2.333: the shared 2.31x generation
  // (BASE_AMIGA_31X above; docs/fidelity.md "Amiga interpreter profiles").
  "amiga-2.310": { ...BASE_AMIGA_31X, id: "amiga-2.310" },
  "amiga-2.316": { ...BASE_AMIGA_31X, id: "amiga-2.316" },
  "amiga-2.333": { ...BASE_AMIGA_31X, id: "amiga-2.333" },
  // Apple IIgs "SQ2.SYS16" 1.014 (SQ2 IIgs; docs/fidelity.md "Apple IIgs
  // interpreter"). The executable's action and condition dispatchers bound at
  // 0xb1 and 0x13. The relocated action table ends at 0xb0: its 0xaf/0xb0
  // entries are the sound-fade pair (immediate/variable pace operand), and
  // slot 0xb1 reads past the table into the operand-count bytes, resolving
  // to the middle of the GS/OS quit routine — executing it terminates the
  // interpreter. Condition 0x13's slot likewise reads past the 19-entry
  // condition table into the code that follows it, so it has no defined
  // result. Sound resources use the IIgs stream formats decoded by the
  // "iigs" family. Verified on the executable: thirteen string slots
  // (parse() bound 0x0d), a 40-entry key map, exact-four direction-based
  // loop selection applied when the cadence countdown is due, and the
  // six-block big-endian save envelope. Other runtime fields match the
  // 2.936 contract.
  "iigs-1.014": {
    ...BASE_2936,
    // Fields not listed here were checked against the handlers and match
    // the 2.936 contract; docs/fidelity.md "IIgs profile fields verified
    // from the handlers".
    id: "iigs-1.014",
    maxAction: 0xb1,
    maxCondition: 0x13,
    condition0x13: "wild-dispatch",
    clickMove: "iigs",
    motionCounters: "word",
    // menu.input and the input-width pair are stubs; slot 0xae is the sound
    // discard, not set.pri.base; distance saturates at 255; the plotter keeps
    // the 320 limit with the center-row cross; show.mem has no "rm.0" line
    // (docs/fidelity.md "IIgs profile fields verified from the handlers").
    menuInputAction: "noop",
    inputWidthActions: "noop",
    priorityBaseAction: "noop",
    objectDistanceCap: 255,
    patternProfile: "center-row-320",
    heapDiagnosticExtraLine: false,
    extraActions: "iigs",
    stringSlots: 13,
    keyMapCapacity: 40,
    directionLoops: "exact-four",
    saveBlocks: 6,
    sound: "iigs",
  },
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
 */
export const EQUIVALENT_BUILDS: Readonly<Record<string, ProfileId>> = {
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
  const byCanonical = new Map<string, string>();
  for (const name of files.keys()) {
    const canonical = canonicalResourceName(name);
    if (!byCanonical.has(canonical)) byCanonical.set(canonical, name);
  }
  const loaders = [...byCanonical.keys()].filter((name) => /^[A-Z0-9_-]+\.COM$/i.test(name)).sort();
  for (const name of [...INTERPRETER_FILES, ...loaders]) {
    const bytes = files.get(byCanonical.get(name) ?? name);
    if (!bytes) continue;
    const found = findVersionString(bytes);
    if (found !== null) return found;
  }
  return null;
}

/** True when the file map looks like a combined v3 container (`<PREFIX>DIR` + `<PREFIX>VOL.n`). */
export function hasCombinedDirectory(files: ReadonlyMap<string, Uint8Array>): boolean {
  const names = [...files.keys()].map(canonicalResourceName);
  for (const name of names) {
    const m = /^(.*)DIR$/.exec(name);
    if (!m) continue;
    const prefix = m[1]!;
    if (prefix === "LOG" || prefix === "PIC" || prefix === "VIEW" || prefix === "SND") continue;
    for (const other of names) {
      if (other.startsWith(`${prefix}VOL.`)) return true;
    }
  }
  return false;
}

/** Amiga hunk executable magic: the load-module header's first long word. */
const AMIGA_HUNK_MAGIC = 0x000003f3;

/**
 * Amiga interpreter executables observed in contributor fixtures, keyed by
 * their (case-insensitive) file names (docs/fidelity.md "Amiga interpreter
 * profiles"). A name only selects a build when the file opens with the hunk
 * magic; a PC data file that happens to share the name is not an interpreter.
 */
const AMIGA_INTERPRETER_FILES: Readonly<Record<string, ProfileId>> = {
  SIERRA: "amiga-2.082",
  KQ2: "amiga-2.176",
  SQ2: "amiga-2.202",
  PQ: "amiga-2.310",
  GR: "amiga-2.316",
  MH2: "amiga-2.333",
};

/**
 * Amiga folders carry no PC version string. A hunk executable with a known
 * interpreter name selects its exact build; anything else returns null.
 */
function detectAmigaProfile(files: ReadonlyMap<string, Uint8Array>): AgiProfile | null {
  for (const [name, bytes] of files) {
    const id = AMIGA_INTERPRETER_FILES[name.toUpperCase()];
    if (id === undefined || bytes.length < 4) continue;
    const magic = ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
    if (magic === AMIGA_HUNK_MAGIC) return PROFILES[id];
  }
  return null;
}

/**
 * An Amiga v3 `dirs` file — the combined directory with an empty prefix,
 * canonical DIR, beside its volumes — is the container shape the 2.31x
 * generation shipped. It is shape, not interpreter evidence: an unidentified
 * folder with it falls back to that generation's latest observed build.
 */
function hasAmigaCombinedDirectory(files: ReadonlyMap<string, Uint8Array>): boolean {
  const canonical = [...files.keys()].map(canonicalResourceName);
  return canonical.includes("DIR") && canonical.some((name) => /^VOL\.\d+$/.test(name));
}

/**
 * Whether a file is an interpreter executable detection reads: the PC
 * version-string carriers and `*.COM` loaders, the Amiga hunk executables
 * and the Apple IIgs `*.SYS16` load file. Hosts keep these beside the
 * resources so the edition is identified from its own binary.
 */
export function isInterpreterFileName(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    INTERPRETER_FILES.includes(upper) ||
    upper.endsWith(".COM") ||
    upper.endsWith(".SYS16") ||
    Object.hasOwn(AMIGA_INTERPRETER_FILES, upper)
  );
}

/** True when the binary contains the ASCII marker (an OMF segment's data is contiguous). */
function containsAscii(bytes: Uint8Array, marker: string): boolean {
  outer: for (let i = 0; i + marker.length <= bytes.length; i++) {
    for (let j = 0; j < marker.length; j++)
      if (bytes[i + j] !== marker.charCodeAt(j)) continue outer;
    return true;
  }
  return false;
}

/**
 * The Apple IIgs interpreter is a GS/OS OMF load file named `*.SYS16` (the
 * executable keeps its own name next to the canonical v2 container). Its
 * build is identified by the banner the observed file carries —
 * "Adventure Game Interpreter\n      Version 1.014" (docs/fidelity.md
 * "Apple IIgs interpreter"). A SYS16 file without the banner, or the banner
 * under any other name, does not select the profile.
 */
function detectIigsProfile(files: ReadonlyMap<string, Uint8Array>): AgiProfile | null {
  for (const [name, bytes] of files) {
    if (!name.toUpperCase().endsWith(".SYS16")) continue;
    if (containsAscii(bytes, "Adventure Game Interpreter") && containsAscii(bytes, "Version 1.014"))
      return PROFILES["iigs-1.014"];
  }
  return null;
}

/** How the engine identified the edition whose profile it runs. */
export type ProfileDetectionKind = "binary" | "catalog" | "default";

/**
 * The profile decision for a game folder: the profile the engine runs, how
 * the edition was identified, and the interpreter build that identification
 * named. `build` differs from `profile.id` when the named build has no
 * promoted profile (version_profiles.md, "Other observed versions") and the
 * container fallback runs instead, or when an explicit override replaces the
 * identified profile.
 */
export interface ProfileDecision {
  readonly profile: AgiProfile;
  readonly kind: ProfileDetectionKind;
  readonly build: string | null;
}

function resolveProfile(override: ProfileId | AgiProfile): AgiProfile {
  if (typeof override !== "string") return override;
  const chosen = BY_ID[override];
  if (!chosen) throw new RangeError(`unknown interpreter profile ${override}`);
  return chosen;
}

/** The promoted profile a build name selects, directly or through a documented equivalent. */
function promotedProfile(build: string): AgiProfile | null {
  const direct = BY_ID[build];
  if (direct) return direct;
  const equivalent = EQUIVALENT_BUILDS[build];
  return equivalent ? PROFILES[equivalent] : null;
}

/**
 * The catalog fingerprints an edition by its WORDS.TOK + OBJECT pair; a port
 * or fan edition sharing only the vocabulary is not the catalogued release.
 */
function detectCatalogEntry(files: ReadonlyMap<string, Uint8Array>): KnownAgiGame | null {
  const byCanonical = new Map<string, Uint8Array>();
  for (const [name, bytes] of files) {
    const canonical = canonicalResourceName(name);
    if (!byCanonical.has(canonical)) byCanonical.set(canonical, bytes);
  }
  const words = byCanonical.get("WORDS.TOK");
  if (!words) return null;
  const object = byCanonical.get("OBJECT");
  return detectKnownGameByHashes(sha256Hex(words), object ? sha256Hex(object) : undefined);
}

function identifyEdition(files: ReadonlyMap<string, Uint8Array>): {
  kind: ProfileDetectionKind;
  build: string | null;
  profile: AgiProfile | null;
} {
  const version = detectVersionString(files);
  if (version !== null)
    return { kind: "binary", build: version, profile: promotedProfile(version) };
  const iigs = detectIigsProfile(files);
  if (iigs) return { kind: "binary", build: iigs.id, profile: iigs };
  const amiga = detectAmigaProfile(files);
  if (amiga) return { kind: "binary", build: amiga.id, profile: amiga };
  const known = detectCatalogEntry(files);
  if (known)
    return { kind: "catalog", build: known.profile, profile: promotedProfile(known.profile) };
  return { kind: "default", build: null, profile: null };
}

/**
 * Decide the interpreter profile for a game folder and report how.
 *
 * The interpreter version is not recorded in the resource container, so the
 * edition is identified from the ASCII version string in an interpreter
 * binary shipped alongside the data, then the Apple IIgs `*.SYS16` banner,
 * then the Amiga hunk executable, then the catalog's WORDS.TOK + OBJECT
 * fingerprint. The profile is the identified build's promoted profile or
 * documented equivalent; a build without one, and an unidentified edition,
 * run the container fallback (v2 split -> 2.936, Amiga `dirs` -> 2.333,
 * other v3 combined -> 3.002.149).
 * An explicit override replaces the profile but not the identification.
 */
export function detectProfileDecision(
  files: ReadonlyMap<string, Uint8Array>,
  override?: ProfileId | AgiProfile,
): ProfileDecision {
  const edition = identifyEdition(files);
  const fallback = hasAmigaCombinedDirectory(files)
    ? PROFILES["amiga-2.333"]
    : hasCombinedDirectory(files)
      ? DEFAULT_V3_PROFILE
      : DEFAULT_V2_PROFILE;
  const profile = override !== undefined ? resolveProfile(override) : (edition.profile ?? fallback);
  return { profile, kind: edition.kind, build: edition.build };
}

/** The profile half of `detectProfileDecision`. */
export function detectProfile(
  files: ReadonlyMap<string, Uint8Array>,
  override?: ProfileId | AgiProfile,
): AgiProfile {
  return detectProfileDecision(files, override).profile;
}
