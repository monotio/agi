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

import {
  AMIGA_INTERPRETER_FILES,
  INTERPRETER_FILES,
  canonicalResourceName,
} from "../container/playableFiles.ts";
import { sha256Hex } from "../crypto.ts";
import { detectKnownGameByHashes, type KnownAgiGame } from "../games/knownGames.ts";
import type { WindowFrameGeometry } from "./textSurface.ts";

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
type ContainerKind = "v2-split" | "v3-combined";

/**
 * When a three-byte resource directory entry names no resource
 * (docs/fidelity.md "Amiga directory absence"). "volume-nibble-f": an entry
 * whose first byte's high nibble reads f is absent whatever its tail bytes
 * hold — the v2 split rule, and the predicate the Amiga 2.310/2.316/2.333
 * combined-directory loaders execute. "exact-fff": only the exact entry
 * ff ff ff is absent, so the volume nibble can name a real VOL.15 — the
 * DOS v3 rule.
 */
export type DirectoryAbsence = "volume-nibble-f" | "exact-fff";

/**
 * Extra action slots above the shared 2.936 range (logic_bytecode "Version 3
 * extension actions"; "amiga-2.31x" is the Amiga 2.31x tail through 0xb6,
 * docs/fidelity.md "Amiga interpreter profiles"; "iigs" is the Apple IIgs
 * 0xb0..0xb1 range, docs/fidelity.md "Apple IIgs interpreter").
 */
type ExtraActions = "none" | "v3-086" | "v3-full" | "amiga-2.31x" | "iigs";

/** Menu-construction action support (conformance matrix, "Exit and menu actions"). */
type MenuActionSupport = "none" | "stub" | "full";

/**
 * Action 0xa1 semantics: "effect" requests the menu interaction; "noop" is the
 * Amiga stub slot (menu interaction is native, docs/fidelity.md).
 */
type MenuInputAction = "effect" | "noop";

/** Action 0xae semantics: "effect" sets the priority base; "noop" is the Amiga stub slot. */
type PriorityBaseAction = "effect" | "noop";

/** Action 0xb4 semantics: "noop" on PC v3; Amiga writes the pointer position into its operands. */
type MousePosnAction = "noop" | "write-pointer";

/**
 * What a left click in the game window does (docs/fidelity.md "Original
 * click-to-walk"). "none": the PC interpreters take no pointer input.
 * "amiga": left-button-down starts ego's click-move toward the click unless a
 * menu or text window is up. "amiga-2.31x" adds the script surface: the click
 * also sets f19, latches the position `mouse.posn` reports and adds the
 * `adj.ego.move.to.x.y` nudge to the target. "iigs": the same starter,
 * ignoring clicks on the menu bar (screen rows 0-7) and taking no nudge.
 */
type ClickMoveRule = "none" | "amiga" | "amiga-2.31x" | "iigs";

/**
 * Width of the wander countdown and follow delay (docs/fidelity.md
 * "Original motion counter width"). "byte": the PC counters wrap modulo 256
 * and compare signed bytes. "word": the Amiga and IIgs object records hold
 * them as signed words — the wander decrement goes negative and rerolls,
 * the follow delay subtracts and clamps at zero, and `wander` leaves the
 * countdown as it found it.
 */
type MotionCounters = "byte" | "word";

/**
 * Action 0x84 `player.control` and object 0's autonomous motion
 * (docs/fidelity.md "Original player.control handler"). "always" clears a
 * running move.obj/follow/wander/click-move outright — the DOS handlers and
 * Amiga 2.082. "on-control-transition" clears it only when the call follows
 * program control: the inspected Amiga 2.176..2.333 handlers test the prior
 * control field and return early when player control is already selected.
 */
type PlayerControlMotionClear = "always" | "on-control-transition";

/**
 * Condition 0x13 semantics for profiles whose dispatchers reach it. The
 * Amiga 2.31x handler tests ego's motion mode against the click-move value.
 * The Apple IIgs and Amiga 2.082 evaluators' bounds admit 0x13 but their
 * 19-entry handler tables end at 0x12 — the slot reads past the table, so
 * evaluating it has no defined behavior (docs/fidelity.md "Apple IIgs
 * interpreter", "Amiga interpreter profiles").
 */
type Condition0x13 = "click-move" | "constant-false" | "wild-dispatch";

/** Action 0xad semantics (input_text_and_menus "Tracked key release"). */
type ReleaseGateAction = "unavailable" | "increment" | "set" | "noop";

/** Actions 0xa3/0xa4 (conformance matrix, "Input-width actions"). */
type InputWidthActions = "effect" | "noop";

/** Automatic direction-based loop selection (object_behavior "Direction and automatic loop selection"). */
type DirectionLoopRule = "exact-four" | "four-or-more" | "four-or-more-f20";

/** When direction-based loop selection runs (object_behavior, same section). */
type DirectionLoopTiming = "every-pass" | "cadence-due";

/** Position actions 0x25/0x26 ordering (conformance matrix, "Position and composition"). */
type PositionActionOrder = "place-when-drawn" | "store-together";

/** Ordering within the earlier-drawn partition (object_behavior "Drawing order and refresh"). */
type PartitionOrder = "object-number" | "drawing-key";

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
type MovementClearRule = "early" | "later";

/**
 * Sound output family (conformance matrix, "Sound output" / "Sound
 * channels"; "booter-2.001" per docs/fidelity.md pc-booter-sound-rows;
 * "amiga" is the Paula driver shared by Amiga 2.176 and later, and
 * "amiga-2.082" is the distinct older driver inside the SQ1 build,
 * docs/fidelity.md "Original Amiga sound player").
 */
type SoundProfile =
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
type SoundEnvelope = "2.917" | "3.002" | "amiga-2.176" | "amiga-2.202";

/** Original presentation family a profile reproduces (`AgiProfile.presentation`). */
export type Presentation = "pc" | "amiga" | "iigs";
/** The build's 16-colour table (`AgiProfile.palette`). */
export type PaletteId = "ega" | "amiga" | "amiga-2.082" | "amiga-2.31x";

export type AmigaRegion = "ntsc" | "pal";

/** BIOS PIT channel 0 at its power-on divisor 65536: 1,193,182 / 65,536 Hz. */
const BIOS_TICK_MS = 65_536_000 / 1_193_182;

/**
 * Session timing from the hardware interrupt dividers (docs/fidelity.md
 * "Original scheduler and modal timing", "Original Amiga sound player"):
 * - `"booter-int1c"` (PC 2.001): hooks BIOS INT 1Ch without reprogramming
 *   PIT channel 0, so sound rows, pacing and the clock count 18.2065 Hz
 *   ticks; the clock refreshes v11..v14 from the tick count every 18 ticks,
 *   so one game second is 18.2 ticks.
 * - `"amiga-vblank"` (Amiga 2.082..2.333): VERTB interrupt runs sound every
 *   VBlank (60 Hz NTSC / 50 Hz PAL) and timer/pacing every 3rd VBlank
 *   (20 Hz NTSC / 16.67 Hz PAL, 20 timer ticks per game second).
 * - `"fixed"` (PC 2.089..3.002.149 PIT 60 Hz / 3 = 20 Hz, IIgs 1.014
 *   SetHeartBeat 60 Hz / 3 = 20 Hz): 60 Hz sound, 50 ms timer increments,
 *   1000 ms game seconds.
 */
export function interpreterTiming(profile: AgiProfile, region: AmigaRegion = "ntsc") {
  if (profile.frameTiming === "booter-int1c") {
    return {
      soundHz: 1000 / BIOS_TICK_MS,
      timerIncrementMs: BIOS_TICK_MS,
      gameSecondMs: (BIOS_TICK_MS * 182) / 10,
    };
  }
  const soundHz = profile.frameTiming === "amiga-vblank" && region === "pal" ? 50 : 60;
  return { soundHz, timerIncrementMs: 3000 / soundHz, gameSecondMs: 60000 / soundHz };
}

export interface AgiProfile {
  readonly frameTiming: "fixed" | "booter-int1c" | "amiga-vblank";
  /**
   * When the pacing counter admits a logic pass: once it reaches v10 (PC and
   * Amiga), or once it exceeds v10 (IIgs 1.014 loops while v10 >= counter),
   * so the IIgs waits v10 + 1 timer ticks (docs/fidelity.md "Input and pacing").
   */
  readonly pacingAdmission: "reaches-v10" | "exceeds-v10";
  /** Promoted profile identifier, e.g. "2.936". */
  readonly id: ProfileId;

  // ---- resource container (conformance matrix, "Resource and bytecode variants") ----
  /** Split family directories (v2) or one combined prefixed directory (v3). */
  readonly container: ContainerKind;
  /** Volume record header size: five bytes in v2, seven in v3. */
  readonly volumeHeaderBytes: 5 | 7;
  /**
   * Which three-byte directory entry spellings count as absent, selected
   * before any entry is read. The v2 rule marks every first byte whose high
   * nibble is f; the DOS v3 rule requires the exact ff ff ff triple and
   * keeps VOL.15 usable. The Amiga 2.31x combined loaders execute the
   * first-byte form too (docs/fidelity.md "Amiga directory absence").
   */
  readonly directoryAbsence: DirectoryAbsence;
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
   *   table capacity (docs/fidelity.md pc-booter-action-0x8f-maxdrawnobjects).
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
  /**
   * The native menu strip the player opens outside the script: "intuition"
   * on the Amiga builds (right mouse button, pull-downs built from
   * set.menu / set.menu.item), "none" where menus open through menu.input
   * (docs/fidelity.md "Original native menu dispatch").
   */
  readonly nativeMenu: "none" | "intuition";
  /**
   * Whether the native menu's verify step also requires f14: 2.176..2.333
   * do; 2.082 checks the dialog inhibitor and text mode only.
   */
  readonly nativeMenuF14Gate: boolean;

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
   * v19 receives the low byte of every type-1 key event BEFORE the
   * input-acceptance gate and the line editor across every shipped PC, Amiga,
   * and IIgs interpreter (docs/fidelity.md "Original input, menu and modal
   * handling").
   */
  readonly keyByteStoredBeforeEdit: boolean;
  /**
   * The event queue keeps the full 16-bit keypad Enter/Escape words and every
   * GetKey-consuming path normalizes them to their main-keyboard twins
   * (docs/fidelity.md "Original input, menu and modal handling").
   */
  readonly keypadWordsNormalized: boolean;
  /**
   * Keys that acknowledge a print/showObj/showPri modal. "enter-escape":
   * ChkAcAb accepts CR or ESC only across every shipped PC, Amiga, and IIgs
   * interpreter (docs/fidelity.md "Original input, menu and modal handling").
   */
  readonly modalDismissalKeys: "enter-escape" | "enter-escape-space";
  /**
   * The acknowledgement-only inventory list ends on a bare WaitEvent — ANY
   * event dismisses it, including zero-low-byte extended words and
   * navigation (docs/fidelity.md "Original input, menu and modal handling").
   */
  readonly inventoryListEndsOnAnyEvent: boolean;
  /**
   * The word loop tests the retained-word count BEFORE each match and exits
   * silently at ten: tokens past the tenth are never examined, so an unknown
   * word there is not reported (docs/fidelity.md "Parser verdicts").
   */
  readonly parserStopsAtTenthWord: boolean;
  /**
   * Match initializes wordLen = 1 and wordNum = 0 for a single-letter token
   * 'a' or 'i' before scanning the dictionary section, so lone 'a' and 'i'
   * default to group 0 (ignored) when absent from WORDS.TOK while an explicit
   * dictionary entry still overrides it: true across every PC, Amiga and IIgs
   * profile except 2.001 (docs/fidelity.md "Parser verdicts", F-Parser-07).
   */
  readonly parserDefaultsLoneAAndI: boolean;
  /**
   * MakeLine classifies ",.?!();:[]{}" as word separators and drops "'`-\""
   * without splitting across PC 2.089..3.002.149, Amiga 2.082..2.333, and IIgs
   * 1.014; on PC 2.001 MakeLine (0x1901) collapses space runs only and FindWord
   * (0x1961) requires a space or NUL after a match (docs/fidelity.md "Parser verdicts,
   * second pass", F-Parser-10).
   */
  readonly parserStripsPunctuation: boolean;
  /**
   * Whether the line editor uses the original interpreter capacity formula
   * modeled by `inputLineEditCap` (docs/fidelity.md "Original input, menu and
   * modal handling").
   */
  readonly originalInputCapacity: boolean;
  /**
   * Exact line-editor character-cap formula from the binary disassembly
   * (docs/fidelity.md "Original input, menu and modal handling"):
   * - `"early-35"`: `35` (PC 2.001..2.230).
   * - `"prompt-40"`: `min(v24, 40 - strlen(s0) - (promptByte !== 0 ? 1 : 0))`
   *   (PC 2.272, 3.002.149, Amiga 2.082..2.333).
   * - `"dialogue-36"`: `min(v24, (dialogueOpen ? 36 : 40) - strlen(s0) - (promptByte !== 0 ? 1 : 0))`
   *   (PC 2.411..3.002.107).
   * - `"iigs-39"`: `min(v24, 39 - strlen(s0))` (IIgs 1.014).
   */
  readonly inputLineEditCap: "early-35" | "prompt-40" | "dialogue-36" | "iigs-39";
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
   * Whether action 0x84 `player.control` ends object 0's autonomous motion on
   * every call or only on the program→player transition (docs/fidelity.md
   * "Original player.control handler").
   */
  readonly playerControlMotionClear: PlayerControlMotionClear;
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
  /**
   * Whether the ego↔v6 direction mirror runs BEFORE the autonomous-motion and
   * block pass of the pre-logic phase (PC 2.411..3.002.149, Amiga 2.176..2.333,
   * IIgs 1.014) or AFTER that pass (PC 2.001..2.272, Amiga 2.082)
   * (docs/fidelity.md "Original input, menu and modal handling").
   */
  readonly preLogicDirectionMirror: boolean;
  /** Selection runs on every eligible pass (2.089/2.230/2.272) or only when the cadence countdown is 1. */
  readonly directionLoopTiming: DirectionLoopTiming;
  /** Position actions run the horizon/placement routine on a drawn object before storing the snapshot (2.001 and 2.089). */
  readonly positionActionOrder: PositionActionOrder;
  /** Earlier-drawn partition ordering; 2.089 uses object number, everything else the drawing key. */
  readonly earlierPartitionOrder: PartitionOrder;
  /** Packed loop-header orientation/mirroring nibble; unique to 2.230 (conformance matrix, "View loop encoding"). */
  readonly packedViewLoopHeader: boolean;
  /**
   * Bitmask for the stored loop-index field in `MirrorCell` (`(cel[2] >> 4) & mask`):
   * - `0`: no loop or cel mirroring exists (`2.001`, `2.089`).
   * - `3`: 2-bit loop orientation (`0x30`, `2.230`, `2.272..2.440`, `amiga-2.082..2.310`).
   * - `7`: 3-bit loop orientation (`0x70`, `2.903..3.002.149`, `amiga-2.316..2.333`, `iigs-1.014`).
   * (docs/fidelity.md "Original cel handling and priority table", F-VIEWS-01).
   */
  readonly celMirrorLoopMask: 0 | 3 | 7;
  /**
   * First row PriToY reads once set.pri.base has replaced the default table:
   * 168 (one past the table, a zero byte) on 2.936 and 3.002.086, 167 on
   * 3.002.102 and later (docs/fidelity.md F-VIEWS-06). Builds whose
   * set.pri.base is a stub never leave the closed form.
   */
  readonly priorityTableScanStart: 167 | 168;
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
   * The original window-text behaviors: wrap consumes the break space and
   * strips continuation leading spaces, an overlong message is replaced by
   * the "Message too verbose:" notice, print.at row/col overrides are used
   * verbatim with picTop added on both paths, the status line uses the
   * profile's `statusLineFormat`, and the window frame uses the profile's
   * `windowFrameGeometry` (docs/fidelity.md "Original window and status-line
   * text").
   */
  readonly originalTextWindows: boolean;
  /**
   * Status-line formatting variant (docs/fidelity.md "Original window and
   * status-line text"):
   * - `"booter-2.001"`: col 1 `"Score:%d  "`, col 30 `"Sound:%s"`, `"on "`/`"off"`.
   * - `"early-2.089"`: col 1 `"Score:%d of %d"`, col 30 `"Sound:%s"`, `"on"`/`"off"`.
   * - `"common"`: col 1 `"Score:%d of %d  "`, col 30 `"Sound:%s"`, `"on "`/`"off"`.
   */
  readonly statusLineFormat: "booter-2.001" | "early-2.089" | "common";
  /**
   * Pixel-exact OpenWndw frame geometry (docs/fidelity.md "Original window and
   * status-line text").
   */
  readonly windowFrameGeometry: WindowFrameGeometry;
  /**
   * Which original presentation the frame reproduces: the font, the status
   * line's placement and the pointer (docs/fidelity.md "Amiga screen, font
   * and pointer"). `"pc"` is the EGA text-mode look every PC build shares.
   * `"amiga"` is the Intuition screen the six Amiga builds open: the system
   * `topaz.font` 8×8 glyphs, the status line in the 11 px screen title bar
   * with its depth gadgets, s0 + typed text + cursor byte on the input row,
   * and the interpreter's own 16×16 arrow pointer. `"iigs"` is the Apple
   * IIgs build's own look.
   */
  readonly presentation: Presentation;
  /**
   * The 16-colour table the build loads for AGI colours 0..15
   * (docs/fidelity.md "Amiga screen, font and pointer"): `"ega"` is the PC
   * EGA palette; the Amiga builds each carry their own 16×3 nibble table —
   * `"amiga"` (KQ2 2.176, SQ2 2.202), `"amiga-2.082"` (SQ1, colour 13
   * orange instead of purple) and `"amiga-2.31x"` (PQ1, GR, MH2: an
   * EGA-like table).
   */
  readonly palette: PaletteId;
  /**
   * What the input row shows (docs/fidelity.md "Amiga screen, font and
   * pointer"). `"prompt-edit-cursor"`: string 0, the typed text, then the
   * cursor byte from set.cursor.char — the order every Amiga build's
   * ShowInput prints (SQ2 h85+0x366 and its siblings). `"cursor-first"`: the
   * engine's earlier model, the cursor byte before the typed text and no
   * string 0, kept on the builds whose input routine has not been read.
   */
  readonly inputLineOrder: "cursor-first" | "prompt-edit-cursor";
  /**
   * Whether the cursor byte leaves the input row while a restart or quit
   * confirmation is open: `"erased"` on the Amiga builds, whose RestartGame
   * calls EraseCur before the prompt and WriteCur unconditionally after it
   * (F-persistence-02); `"kept"` elsewhere until each build's cursor
   * handling is modelled.
   */
  readonly confirmCursor: "kept" | "erased";
  /**
   * Gate on actions 0x70/0x71 (`status.line.on` / `status.line.off`) and the
   * Amiga screen title bar (docs/fidelity.md "Amiga screen, font and pointer"):
   * - `"unconditional"`: PC, IIgs, and Amiga 2.082 (`h60+0x2ba`/`+0x2d2`), which
   *   execute both handlers and show the title bar regardless of picture top or
   *   prior status state.
   * - `"pic-top"`: Amiga 2.176 and 2.202 (`h82+0x548`/`+0x56c`), which test
   *   `$6a14` (`displayBaseRow !== 0`) and suppress the title bar while the
   *   picture top is row 0.
   * - `"pic-top-and-enabled"`: Amiga 2.310, 2.316 and 2.333 (`h82+0x580` tests
   *   the status-enabled longword at `h206+0x400`), which also return early from
   *   `status.line.off` when the status line is already off.
   */
  readonly statusLineGate: "unconditional" | "pic-top" | "pic-top-and-enabled";
  /**
   * How `show.pic` presents a picture after `draw.pic` (docs/fidelity.md
   * "Original picture dissolve"); after `overlay.pic` every build copies it
   * at once. `"instant"`: PC, and Amiga 2.333, whose mode string is patched
   * to "blit" (`h116+0x0`). The others block the pass for a dissolve that
   * also ends restore.game: `"amiga-2.082"` always skips picture rows 0..1
   * (`h154+0x2c0`); `"amiga-pic-top"` (2.176, 2.202, `h215+0x2e0`) skips them
   * while the picture starts below row 0; `"amiga-pic-top-and-status"` (2.310,
   * 2.316, `h215+0x300`) only while the status line is on as well; `"iigs"`
   * (`main+0x0f53`) copies all 168 rows.
   */
  readonly showPictureReveal:
    "instant" | "amiga-2.082" | "amiga-pic-top" | "amiga-pic-top-and-status" | "iigs";
  /**
   * A due movement proposal whose left X is exactly zero reports left-boundary
   * code 4 (3.002.086 only; version_profiles.md "screen-boundary variant").
   */
  readonly clampExactZeroLeftBoundary: boolean;
  /**
   * Whether add.to.pic packs (margin << 4) | priority into a byte and gates
   * the control box on packed <= 0x3f (PC and Amiga builds checked;
   * docs/fidelity.md "Original add.to.pic control box", F-VIEWS-04, F-VIEWS-09).
   */
  readonly addToPicPacking: boolean;
  /**
   * Whether ObjInPic replaces a zero priority nibble with the baseline's band
   * (`pri_tbl[y]`) before drawing: 2.089 and later, Amiga and IIgs. The 2.001
   * ObjInPic (`0x532a`) calls InsertObj directly, so priority 0 draws as 0
   * (docs/fidelity.md F-VIEWS-04).
   */
  readonly addToPicBandForZeroPriority: boolean;
  /**
   * Whether add.to.pic runs the scratch-entry FindPosn relocation spiral before
   * objinpic (verified across all 18 profiles; docs/fidelity.md, F-VIEWS-03).
   */
  readonly addToPicRelocation: boolean;
  /**
   * Whether the cel blit clips negative-top and right-edge rows/columns in
   * place without shifting left and masks priority to its low nibble (verified
   * across all 18 profiles; docs/fidelity.md, F-VIEWS-05, F-VIEWS-07).
   */
  readonly originalCelBlitClippingAndPriorityMask: boolean;
  /**
   * Whether new.room's object reset preserves newlyPositioned (0x0400) and
   * cycleDelay (0x1000) across room transitions (verified across all 18
   * profiles; docs/fidelity.md, F-motion-10).
   */
  readonly newRoomPreservesReposAndCycleDelay: boolean;
  /**
   * Whether menu Home and End load the first/last menu heading unconditionally
   * without scanning for an enabled item (verified on 2.936; docs/fidelity.md,
   * F-IN-15).
   */
  readonly menuHomeEndUnconditional: boolean;
  /**
   * Whether show.pri.screen preserves an open text window across the priority
   * screen modal (verified across all 18 profiles; docs/fidelity.md,
   * F-picture-04).
   */
  readonly showPriScreenPreservesWindow: boolean;
  /**
   * Whether show.obj on a descriptionless view (vdesc == 0) formats the raw
   * view header bytes from offset 0 (verified across all 18 profiles;
   * docs/fidelity.md, F-VIEWS-11).
   */
  readonly showObjUncheckedDescOffset: boolean;

  // ---- pictures ----
  /** Highest dispatched picture command byte: 0xf8 in the early profiles, 0xfa later. */
  readonly pictureMaxCommand: number;
  /** Pattern-plot behavior for commands 0xf9/0xfa. */
  readonly patternProfile: PatternProfile;

  // ---- session, diagnostics, persistence ----
  /** Action 0x80 accepts restart without confirmation while f16 is set (false in 2.001..2.411 and Amiga 2.082). */
  readonly restartPromptBypassedByF16: boolean;
  /**
   * The original restart/restore contract: the restart/quit prompts carry
   * the original wording, the authentic restore tail clears controllers and
   * leaves v19/f2/f4 untouched, and input acceptance survives restart
   * (docs/fidelity.md "Persistence verdicts").
   */
  readonly originalRestartRestore: boolean;
  /**
   * Whether the authentic RestoreGame tail rewrites v20, v26, v22 and
   * conditional f11 after reading the save blocks: true in PC 2.903..3.002.149
   * and false in PC 2.001..2.440, Amiga 2.082..2.333, and IIgs 1.014, where
   * the save file's machine variables remain untouched (docs/fidelity.md
   * "Persistence verdicts", F-persistence-03).
   */
  readonly restoreRewritesMachineState: boolean;
  /**
   * Replay-pair capacity of a game that never calls script.size: the shipped
   * interpreter data image holds SCRIPTSIZE = 0x0032 (50 pairs) across every
   * PC, Amiga, and IIgs build (docs/fidelity.md "Original script capacity and
   * version handlers"). A game's own script.size replaces it.
   */
  readonly defaultScriptBufferPairs: number;
  /**
   * script.size stores the capacity, then resets the recorded pair sequence
   * and refreshes the object update lists: RestoreAll + InitScript +
   * AllInBack across every PC, Amiga, and IIgs build (docs/fidelity.md
   * "Original script capacity and version handlers").
   */
  readonly scriptSizeResetsSequence: boolean;
  /** The heap diagnostic prints the later "rm.0, etc." line (PC 2.903..3.002.149 only). */
  readonly heapDiagnosticExtraLine: boolean;
  /** Save envelope block count: four in 2.089, five on PC and Amiga, six on the Apple IIgs build. */
  readonly saveBlocks: 4 | 5 | 6;
  /** Save block 3 is XOR-transformed with the repeating key (v3 profiles). */
  readonly saveBlock3Xor: boolean;

  // ---- sound ----
  /** Sound scheduling/output family. */
  readonly sound: SoundProfile;
  /**
   * sound() runs StopSnd FIRST — setting the interrupted sound's done flag —
   * then reads the operands, resets the new done flag, and only then can the
   * lookup fault across every PC, Amiga, and IIgs build (docs/fidelity.md
   * "Sound verdicts").
   */
  readonly soundStopsBeforeFault: boolean;
  /** Representative PC sound hardware; docs/fidelity.md "PCjr and Tandy noise". */
  readonly psgNoise: "sn76496" | "ncr8496";
  /** Decay-envelope selection for the "common" family (unused by early/booter sound). */
  readonly soundEnvelope: SoundEnvelope;
}
/** Shared defaults: the 2.936 contracts every field falls back to. */
const BASE_2936: AgiProfile = {
  id: "2.936",
  container: "v2-split",
  volumeHeaderBytes: 5,
  directoryAbsence: "volume-nibble-f",
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
  nativeMenu: "none",
  nativeMenuF14Gate: false,
  stringSlots: 12,
  keyMapCapacity: 39,
  releaseGateAction: "increment",
  releaseGateClearAction: false,
  inputWidthActions: "effect",
  keyByteStoredBeforeEdit: true,
  keypadWordsNormalized: true,
  modalDismissalKeys: "enter-escape",
  inventoryListEndsOnAnyEvent: true,
  parserStopsAtTenthWord: true,
  parserDefaultsLoneAAndI: true,
  parserStripsPunctuation: true,
  originalInputCapacity: true,
  inputLineEditCap: "dialogue-36",
  closeWindowClearsInputWidth: true,
  priorityBaseAction: "effect",
  mousePosnAction: "noop",
  clickMove: "none",
  motionCounters: "byte",
  playerControlMotionClear: "always",
  roomAliases: null,
  wordSequenceTailTerminator: true,
  directionLoops: "four-or-more",
  preLogicDirectionMirror: true,
  directionLoopTiming: "cadence-due",
  positionActionOrder: "store-together",
  earlierPartitionOrder: "drawing-key",
  packedViewLoopHeader: false,
  celMirrorLoopMask: 7,
  priorityTableScanStart: 168,
  objectDistanceCap: 254,
  targetMotionDeferred: false,
  movementClear: "later",
  inventorySelector: true,
  showPictureClearsF15: true,
  printConsumesF15: true,
  timedPrintClearsV21: true,
  originalTextWindows: true,
  statusLineFormat: "common",
  windowFrameGeometry: "pc",
  presentation: "pc",
  palette: "ega",
  inputLineOrder: "cursor-first",
  confirmCursor: "kept",
  statusLineGate: "unconditional",
  showPictureReveal: "instant",
  clampExactZeroLeftBoundary: false,
  addToPicPacking: true,
  addToPicBandForZeroPriority: true,
  addToPicRelocation: true,
  originalCelBlitClippingAndPriorityMask: true,
  newRoomPreservesReposAndCycleDelay: true,
  menuHomeEndUnconditional: false,
  showPriScreenPreservesWindow: true,
  showObjUncheckedDescOffset: true,
  pictureMaxCommand: 0xfa,
  patternProfile: "shaped-v2",
  restartPromptBypassedByF16: true,
  originalRestartRestore: true,
  restoreRewritesMachineState: true,
  defaultScriptBufferPairs: 50,
  scriptSizeResetsSequence: true,
  heapDiagnosticExtraLine: true,
  saveBlocks: 5,
  saveBlock3Xor: false,
  frameTiming: "fixed",
  pacingAdmission: "reaches-v10",
  sound: "common",
  soundStopsBeforeFault: true,
  psgNoise: "ncr8496",
  soundEnvelope: "2.917",
};

/** Early split-container shape shared by 2.001, 2.089, 2.230 and 2.272. */
const BASE_EARLY: AgiProfile = {
  ...BASE_2936,
  inventoryMetadataEncrypted: false,
  maxAction: 0x9a,
  exitOperandBytes: 0,
  exitAlwaysImmediate: true,
  menuActions: "none",
  stringSlots: 6,
  releaseGateAction: "unavailable",
  inputLineEditCap: "early-35",
  directionLoops: "exact-four",
  preLogicDirectionMirror: false,
  directionLoopTiming: "every-pass",
  celMirrorLoopMask: 3,
  objectDistanceCap: null,
  targetMotionDeferred: true,
  movementClear: "early",
  inventorySelector: false,
  showPictureClearsF15: false,
  printConsumesF15: false,
  timedPrintClearsV21: false,
  pictureMaxCommand: 0xf8,
  patternProfile: "none",
  restartPromptBypassedByF16: false,
  restoreRewritesMachineState: false,
  heapDiagnosticExtraLine: false,
  sound: "early-2.089",
  psgNoise: "sn76496",
};

/** Combined v3 container shape shared by the 3.002.x profiles. */
const BASE_V3: AgiProfile = {
  ...BASE_2936,
  container: "v3-combined",
  volumeHeaderBytes: 7,
  directoryAbsence: "exact-fff",
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
  // The 2.31x loader's directory predicate marks any entry whose first
  // byte's high nibble is f absent; only its volume reads reach a record
  // (docs/fidelity.md "Amiga directory absence").
  directoryAbsence: "volume-nibble-f",
  maxAction: 0xb6,
  maxCondition: 0x13,
  condition0x13: "click-move",
  extraActions: "amiga-2.31x",
  stringSlots: 13,
  keyMapCapacity: 39,
  releaseGateAction: "noop",
  releaseGateClearAction: false,
  inputWidthActions: "noop",
  keypadWordsNormalized: false,
  inputLineEditCap: "prompt-40",
  closeWindowClearsInputWidth: false,
  menuInputAction: "noop",
  menuInteractionGate: false,
  nativeMenu: "intuition",
  nativeMenuF14Gate: true,
  priorityBaseAction: "noop",
  mousePosnAction: "write-pointer",
  clickMove: "amiga-2.31x",
  motionCounters: "word",
  playerControlMotionClear: "on-control-transition",
  directionLoops: "exact-four",
  directionLoopTiming: "cadence-due",
  windowFrameGeometry: "amiga",
  presentation: "amiga",
  palette: "amiga-2.31x",
  inputLineOrder: "prompt-edit-cursor",
  confirmCursor: "erased",
  statusLineGate: "pic-top-and-enabled",
  showPictureReveal: "amiga-pic-top-and-status",
  // The Amiga save writes the inventory region raw; the v3 XOR transform is
  // a PC v3 behavior only (docs/fidelity.md "Amiga interpreter profiles").
  // Fields not listed here were checked against the handlers and match the
  // base; docs/fidelity.md "Amiga profile fields verified from the handlers".
  restoreRewritesMachineState: false,
  saveBlock3Xor: false,
  patternProfile: "center-row-320",
  heapDiagnosticExtraLine: false,
  frameTiming: "amiga-vblank",
  sound: "amiga",
  soundEnvelope: "amiga-2.202",
  ...AMIGA_INVENTORY,
};

export const PROFILES: Readonly<Record<ProfileId, AgiProfile>> = {
  // PC booter 2.001: no promoted spec profile exists (the catalog starts at
  // 2.089); every field is verified against the 2.001 booter disk image in
  // docs/fidelity.md (pc-booter-2001-profile).
  "2.001": {
    ...BASE_EARLY,
    id: "2.001",
    frameTiming: "booter-int1c",
    // The booter dispatch is bounded at 0x90, below the later 2.089 bound.
    // docs/fidelity.md: PC booter action 0x8f (max.drawn.objects).
    maxAction: 0x90,
    inventoryHeaderBytes: 2,
    action0x8f: "max-drawn-objects",
    addToPicBandForZeroPriority: false,
    parserDefaultsLoneAAndI: false,
    parserStripsPunctuation: false,
    positionActionOrder: "place-when-drawn",
    celMirrorLoopMask: 0,
    statusLineFormat: "booter-2.001",
    windowFrameGeometry: "pc-2.001",
    sound: "booter-2.001",
  },
  // version_profiles.md "AGI 2.089 profile"; conformance matrix "2.089 variant selection".
  "2.089": {
    ...BASE_EARLY,
    id: "2.089",
    wordSequenceTailTerminator: false,
    positionActionOrder: "place-when-drawn",
    earlierPartitionOrder: "object-number",
    celMirrorLoopMask: 0,
    statusLineFormat: "early-2.089",
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
    inputLineEditCap: "prompt-40",
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
    celMirrorLoopMask: 3,
    patternProfile: "point-2.411",
    restartPromptBypassedByF16: false,
    restoreRewritesMachineState: false,
    heapDiagnosticExtraLine: false,
    sound: "early-2.411",
    psgNoise: "sn76496",
  },
  // version_profiles.md "AGI 2.440 profile"; conformance matrix "2.440 variant selection".
  "2.440": {
    ...BASE_2936,
    id: "2.440",
    maxAction: 0xa9,
    releaseGateAction: "unavailable",
    directionLoops: "exact-four",
    celMirrorLoopMask: 3,
    restoreRewritesMachineState: false,
    heapDiagnosticExtraLine: false,
    sound: "early-2.440",
    psgNoise: "sn76496",
  },
  // version_profiles.md "AGI 2.917 profile"; conformance matrix "2.917 variant selection".
  "2.917": {
    ...BASE_2936,
    id: "2.917",
    maxAction: 0xad,
    directionLoops: "exact-four",
  },
  "2.936": {
    ...BASE_2936,
    menuHomeEndUnconditional: true,
  },
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
    priorityTableScanStart: 167,
    // MH1 3.002.107's measured envelope; the conformance matrix promotes that
    // build to this profile (docs/fidelity.md, sound player audit).
    soundEnvelope: "3.002",
  },
  // version_profiles.md "AGI 3.002.149 profile"; conformance matrix two-column tables.
  "3.002.149": {
    ...BASE_V3,
    id: "3.002.149",
    maxAction: 0xb5,
    priorityTableScanStart: 167,
    extraActions: "v3-full",
    keyMapCapacity: 49,
    releaseGateAction: "set",
    releaseGateClearAction: true,
    inputWidthActions: "noop",
    inputLineEditCap: "prompt-40",
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
    nativeMenu: "intuition",
    nativeMenuF14Gate: false,
    keypadWordsNormalized: false,
    inputLineEditCap: "prompt-40",
    keyMapCapacity: 40,
    // Sierra's stop.motion clears the motion word like the later builds
    // (docs/fidelity.md "Amiga interpreter profiles").
    movementClear: "later",
    windowFrameGeometry: "amiga",
    presentation: "amiga",
    showPictureReveal: "amiga-2.082",
    palette: "amiga-2.082",
    inputLineOrder: "prompt-edit-cursor",
    confirmCursor: "erased",
    saveBlocks: 5,
    frameTiming: "amiga-vblank",
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
    playerControlMotionClear: "on-control-transition",
    exitOperandBytes: 1,
    exitAlwaysImmediate: false,
    menuActions: "full",
    menuInputAction: "noop",
    nativeMenu: "intuition",
    nativeMenuF14Gate: true,
    inputWidthActions: "noop",
    keypadWordsNormalized: false,
    inputLineEditCap: "prompt-40",
    inventoryMetadataEncrypted: true,
    stringSlots: 13,
    preLogicDirectionMirror: true,
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
    windowFrameGeometry: "amiga",
    presentation: "amiga",
    palette: "amiga",
    inputLineOrder: "prompt-edit-cursor",
    confirmCursor: "erased",
    statusLineGate: "pic-top",
    showPictureReveal: "amiga-pic-top",
    pictureMaxCommand: 0xfa,
    patternProfile: "short-r1",
    restartPromptBypassedByF16: true,
    heapDiagnosticExtraLine: false,
    saveBlocks: 5,
    frameTiming: "amiga-vblank",
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
    playerControlMotionClear: "on-control-transition",
    menuInputAction: "noop",
    nativeMenu: "intuition",
    nativeMenuF14Gate: true,
    inputWidthActions: "noop",
    keypadWordsNormalized: false,
    inputLineEditCap: "prompt-40",
    stringSlots: 13,
    directionLoops: "exact-four",
    celMirrorLoopMask: 3,
    windowFrameGeometry: "amiga",
    presentation: "amiga",
    palette: "amiga",
    inputLineOrder: "prompt-edit-cursor",
    confirmCursor: "erased",
    statusLineGate: "pic-top",
    showPictureReveal: "amiga-pic-top",
    patternProfile: "short-r1",
    restoreRewritesMachineState: false,
    heapDiagnosticExtraLine: false,
    frameTiming: "amiga-vblank",
    sound: "amiga",
    soundEnvelope: "amiga-2.202",
  },
  // Amiga "PQ" 2.310 / "GR" 2.316 / "MH2" 2.333: the shared 2.31x generation
  // (BASE_AMIGA_31X above; docs/fidelity.md "Amiga interpreter profiles").
  "amiga-2.310": { ...BASE_AMIGA_31X, id: "amiga-2.310", celMirrorLoopMask: 3 },
  "amiga-2.316": { ...BASE_AMIGA_31X, id: "amiga-2.316" },
  // 2.333 keeps the 2.31x dissolve code, but its mode string reads "blit".
  "amiga-2.333": { ...BASE_AMIGA_31X, id: "amiga-2.333", showPictureReveal: "instant" },
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
    pacingAdmission: "exceeds-v10",
    // Fields not listed here were checked against the handlers and match
    // the 2.936 contract; docs/fidelity.md "IIgs profile fields verified
    // from the handlers".
    id: "iigs-1.014",
    presentation: "iigs",
    showPictureReveal: "iigs",
    maxAction: 0xb1,
    maxCondition: 0x13,
    condition0x13: "wild-dispatch",
    clickMove: "iigs",
    motionCounters: "word",
    playerControlMotionClear: "on-control-transition",
    // menu.input and the input-width pair are stubs; slot 0xae is the sound
    // discard, not set.pri.base; distance saturates at 255; the plotter keeps
    // the 320 limit with the center-row cross; show.mem has no "rm.0" line
    // (docs/fidelity.md "IIgs profile fields verified from the handlers").
    menuInputAction: "noop",
    inputWidthActions: "noop",
    keypadWordsNormalized: false,
    inputLineEditCap: "iigs-39",
    priorityBaseAction: "noop",
    objectDistanceCap: 255,
    windowFrameGeometry: "iigs",
    patternProfile: "center-row-320",
    restoreRewritesMachineState: false,
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
const DEFAULT_V3_PROFILE = PROFILES["3.002.149"];

/**
 * Observed builds that select an identical promoted profile:
 * 2.903 (`start.exe` sha256 `db97accc...`) and 2.915 (`AGI` sha256 `6ee9d44b...`)
 * match 2.917 across all 18 conditions, 174 actions (0x00..0xad), and engine
 * tables (docs/fidelity.md); 2.439 selects 2.440; 3.002.107 selects 3.002.102
 * (version_profiles.md, per-profile paragraphs).
 */
export const EQUIVALENT_BUILDS: Readonly<Record<string, ProfileId>> = {
  "2.903": "2.917",
  "2.915": "2.917",
  "2.439": "2.440",
  "3.002.107": "3.002.102",
};

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
function hasCombinedDirectory(files: ReadonlyMap<string, Uint8Array>): boolean {
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

// The playable vocabulary lives in container/playableFiles.ts; detection
// callers keep importing it from here.
export { INTERPRETER_FILES } from "../container/playableFiles.ts";
