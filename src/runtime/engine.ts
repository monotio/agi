/**
 * AGI interpreter core, clean-room from Peter Kelly's agi-re
 * behavioral specification: "Core Runtime State", "Logic Bytecode",
 * "Top-level cycle order".
 *
 * The engine owns game state and executes real logic bytecode. It knows
 * nothing about the DOM, Node, or rendering backends: all observable output
 * and player input flow through the EngineHost port. Headless tests use a
 * scripted host; the browser app uses a worker bridge host.
 *
 * Observable version differences come from the selected interpreter profile
 * (src/runtime/profile.ts): the engine reads profile fields and never compares
 * version strings.
 */

import { matchDictionaryPhrase } from "../logic/words.ts";
import type { GameContainer } from "../types.ts";
import {
  createPictureSurface,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
  type PictureSurface,
} from "../types.ts";
import { renderPicture } from "../picture/renderer.ts";
import { SoundPlayback, type SoundOutput } from "../sound/sound.ts";
import { parseLogicResource, type LogicResource } from "../logic/resource.ts";
import { decodeInventoryFile } from "./inventoryFile.ts";
import { actionSpec, CONDITION_BY_CODE, GOTO, IF, NOT, OR } from "../logic/opcodes.ts";
import { parseView, selectViewCel, readViewCel, drawCel, type AgiView } from "../view/view.ts";
import { detectProfile, type AgiProfile, type ProfileId } from "./profile.ts";
import { TraceWindow } from "./trace.ts";
import { InputQueue, NAV_KEYS } from "./inputQueue.ts";
import { runSaveDialog, type SaveSlot } from "./saveDialog.ts";
import {
  newScreenObject,
  packObjectState,
  motionParams,
  applyObjectRecord,
  MOTION_NORMAL,
  MOTION_MOVE_OBJ,
  MOTION_FOLLOW,
  MOTION_WANDER,
  CYCLE_FORWARD,
  CYCLE_REVERSE,
  CYCLE_END_OF_LOOP,
  CYCLE_REVERSE_LOOP,
  type ScreenObject,
} from "./screenObject.ts";
import {
  decodeHostImage,
  decodeSave,
  encodeHostImage,
  encodeSave,
  newObjectRecord,
  newSaveState,
  resumeOffsetFor,
  type LogicResumeRecord,
  type ReplayPair,
  type SaveObjectRecord,
} from "./persistence.ts";
import {
  TEXT_COLS,
  TEXT_ROWS,
  TextSurface,
  attr,
  drawWindow,
  placeWindow,
  wrapLines,
  type SavedRect,
} from "./textSurface.ts";

export class UnimplementedOpcodeError extends Error {
  readonly code: number;
  readonly opcodeName: string;
  readonly logicNum: number;
  readonly position: number;

  constructor(code: number, name: string, logicNum: number, position: number) {
    super(`unimplemented opcode 0x${code.toString(16)} (${name}) at logic ${logicNum}:${position}`);
    this.name = "UnimplementedOpcodeError";
    this.code = code;
    this.opcodeName = name;
    this.logicNum = logicNum;
    this.position = position;
  }
}

/** Host port: everything the engine needs from its environment. */
export interface EngineHost {
  /** Modal message window; returns when acknowledged. */
  print(text: string): void;
  /** Non-modal text at a character position. */
  displayAt(row: number, col: number, text: string): void;
  /** Clear active on-screen text positioned by displayAt. */
  clearText?(): void;
  /** Clear specific rows fromRow to toRow (0x69 clear.lines / 0x9a clear.text.rect). */
  clearLines?(fromRow: number, toRow: number, color?: number): void;
  /** Toggle full text mode (0x6a text.screen / 0x6b graphics). */
  setTextMode?(active: boolean): void;
  /**
   * Block until a key is pressed. Used by have.key busy loops (see condition
   * 0x0d): a host whose keys arrive by message cannot deliver one while the
   * interpreter spins. `waitKey` is preferred; `waitTextKey` is the older name
   * and is still accepted.
   */
  waitKey?(): number;
  /** Deprecated alias of waitKey, kept for hosts written against the old port. */
  waitTextKey?(): number;
  /** Status line content (score etc.); empty string hides it. */
  statusLine(text: string): void;
  /**
   * Input phase: a completed input line entered by the player since the last
   * cycle, or null. The engine parses it when parser input is accepted.
   */
  takeInputLine(): string | null;
  /** Raw key events pending since last cycle (low byte values). */
  takeKeys(): number[];
  /**
   * Optional host preparation before a room transition changes any state.
   * The host may synchronously supply missing resources. False cancels the
   * transition; ordinary interpreters omit this hook entirely.
   */
  prepareRoom?(room: number, from: number): boolean;

  /** shake.screen: shake the visible display `count` times. */
  shakeScreen?(count: number): void;
  /** show.obj / show.obj.v: modal view preview; dismissal acks via ackPrint(). */
  showObj?(viewNum: number): void;
  /** show.pri.screen: modal priority-surface view; dismissal acks via ackPrint(). */
  showPriScreen?(): void;
  /** status: modal carried-inventory list; dismissal acks via ackPrint(). */
  statusScreen?(items: { num: number; name: string }[]): void;
  /**
   * get.num: blocking numeric prompt; the engine stores the low 8 bits. The
   * prompt is already drawn on the text surface at (row, col); the accepted
   * text is echoed there by the engine when the call returns.
   */
  promptNumber?(prompt: string, row?: number, col?: number): number;
  /** get.string: blocking text prompt; the engine truncates to maxLen. */
  promptString?(prompt: string, maxLen: number, row?: number, col?: number): string;
  /**
   * save.game: persist the real save-file image (31-byte description header
   * plus the profile's length-prefixed blocks) the engine just encoded.
   */
  saveGame?(bytes: Uint8Array, slot?: number): boolean | void;
  /** Available storage namespace; opts into the engine-owned 12-slot selector. */
  listSaveGames?(): SaveSlot[];
  /** Native text input adapter for the engine-drawn save description editor. */
  promptSaveDescription?(initial: string, maxLen: number, row: number, col: number): string | null;
  /**
   * restore.game: blocking; returns a save-file image, or null when the
   * player cancelled or no save exists.
   */
  restoreGame?(slot?: number): Uint8Array | null;
  /** log / obj.status.v / show.mem: diagnostic text sink (LOGFILE semantics). */
  logText?(text: string): void;
  /** version: interpreter name/version, stored into string slot 0. */
  versionString?(): string;
  /** Notification that a resource started; soundOutput owns its timed output. */
  playSound?(soundNum: number, payload: Uint8Array): void;
  /** Timed sound command; the backend synthesizes output without scheduling completion. */
  soundOutput?(output: SoundOutput): void;
  /** Device selector for a new playback (default1, four channels). */
  soundDevice?(): number;
  /** Optional adapter override for v23 attenuation, read on every sound tick. */
  soundAttenuation?(): number;
  /** Optional reproducible unsigned random-word source for simulation hosts. */
  randomWord?(): number;
  /** stopSound: silences active audio playback. */
  stopSound?(): void;
  /** The interpreter accepted quit; the host may close its playing session. */
  quit?(): void;
}

/** Special variables (2.936 roles used by the engine core). */
const V_ROOM = 0;
const V_PREV_ROOM = 1;
const V_EDGE = 2;
const V_SCORE = 3;
const V_OBJ_HIT = 4;
const V_OBJ_EDGE = 5;
const V_EGO_DIR = 6;
const V_WORDS = 9;
const V_EGO_VIEW = 16;
const V_KEY = 19;
const V_SELECTED_ITEM = 25;

/** Special flags. */
const F_INPUT_READY = 2;
const F_SAID_MATCHED = 4;
const F_NEW_ROOM = 5;
const F_RESTART = 6;
const F_SOUND_ENABLED = 9;
/** Recording gate: the replay sequence appends only while f7 is clear (spec). */
const F_REPLAY_OFF = 7;
const F_SCRIPT_0 = 12;
const F_NO_PROMPT_RESTART = 16;

/** Flag 20 gates direction loop selection for >4 loop views in the later v3 profiles. */
const F_DIR_LOOP_GATE = 20;

interface MenuItem {
  text: string;
  id: number;
  enabled: boolean;
}

interface MenuHeading {
  title: string;
  items: MenuItem[];
  enabled: boolean;
  /** Remembered current item for this heading (spec "Menu construction"). */
  current: number;
}

/** Session menu state carried by host checkpoints, separate from AGI save-file bytes. */
export interface EngineMenuState {
  headings: MenuHeading[];
  finalized: boolean;
  heading: number;
  requested: boolean;
}

type Modal =
  | { kind: "print"; saved: SavedRect; remainingMs: number | null }
  | {
      kind: "inventory";
      saved: SavedRect;
      items: { num: number; name: string }[];
      slots: { row: number; col: number }[];
      selected: number;
      interactive: boolean;
    }
  | { kind: "menu"; saved: SavedRect }
  | { kind: "showObj"; saved: SavedRect; view: number }
  | { kind: "showPri" };

const KEY_ENTER = 0x0d;
/** have.key polls per cycle before a keyless host receives a synthesized Enter. */
const HAVE_KEY_POLL_LIMIT = 1000;
/**
 * Backward jumps within one host tick after which a logic pass that has read a
 * clock variable (v11..v14) is parked until the next tick. Observed 3.002.107
 * data (a title screen's key-to-skip path) busy-waits inside one invocation
 * with `if (greaterv(v49, v11)) goto` after zeroing v11, relying on the
 * timer interrupt to advance v11 while bytecode runs. The spec makes timer
 * ticks asynchronous inputs and does not require delivery between individual
 * instructions ("Top-level cycle order"); parking the call stack, exactly as a
 * modal instruction does, lets the host's clock reach such a loop at the host
 * cadence. Ordinary bounded loops stay far below this count in one pass.
 */
const CLOCK_WAIT_JUMPS = 1000;
/**
 * Host time a parked clock busy-wait may accumulate before it is an error.
 * Games wait seconds; a loop that compares a clock variable with itself would
 * otherwise park forever and never reach the instruction budget.
 */
const CLOCK_WAIT_LIMIT_MS = 10 * 60 * 1000;
/**
 * Replay-pair capacity of a game that never calls script.size. The
 * interpreters always hold a configured capacity (the save layout has no
 * unconfigured state) and the spec's 2.230 XMAS data carries 200 pairs; the
 * shipped default itself is undocumented, so 200 stands until the binaries
 * settle it. A game's own script.size replaces it.
 */
const DEFAULT_REPLAY_CAPACITY = 200;
/** Pairs the host-only shadow record keeps for autosaves of a blocked script buffer. */
const HOST_REPLAY_LIMIT = 4096;
/**
 * Polls within one cycle after which have.key is treated as a busy loop and a
 * blocking host wait is used. A script that merely polls once per cycle stays
 * non-blocking, so ordinary graphics-mode play never freezes on a keypress.
 */
const HAVE_KEY_BUSY_POLLS = 16;
const KEY_ESC = 0x1b;
const KEY_BACKSPACE = 0x08;
/** Inventory interaction flag (spec "Inventory selection"). */
const F_INV_SELECT = 13;
/** Menu request gate flag (spec "Menu interaction"). */
const F_MENU_ENABLED = 14;

/** Internal control-flow signal: new.room unwinds the current invocation. */
class RoomChange {
  readonly room: number;

  constructor(room: number) {
    this.room = room;
  }
}

/**
 * Internal control-flow signal: restore and accepted restart abort the current
 * logic continuation (spec "Restore action outcomes", "Restart"). Unlike
 * RoomChange there is no destination to enter — the next top-level pass simply
 * starts logic 0 again against the state the action established.
 */
class ContinuationAbort {}

interface LogicFrame {
  logic: number;
  resource: LogicResource;
  pc: number;
}

/**
 * Replay-pair kinds (spec "Resource replay sequence"). Kind 5 opens a
 * four-pair transient-cel packet; every other kind is a single pair.
 */
const REPLAY_LOAD_LOGIC = 0;
const REPLAY_LOAD_VIEW = 1;
const REPLAY_LOAD_PICTURE = 2;
const REPLAY_LOAD_SOUND = 3;
const REPLAY_DRAW_PICTURE = 4;
const REPLAY_ADD_TO_PIC = 5;
const REPLAY_DISCARD_PICTURE = 6;
const REPLAY_DISCARD_VIEW = 7;
const REPLAY_OVERLAY_PICTURE = 8;

export class Engine {
  readonly vars = new Uint8Array(256);
  readonly flags = new Uint8Array(256);
  /** String slots s0.. — six or twelve, per the selected profile. */
  readonly strings: string[];
  /** Selected interpreter profile: the single source of version-variant behavior. */
  readonly profile: AgiProfile;
  readonly controllers = new Uint8Array(256);
  readonly surface: PictureSurface = createPictureSurface();

  /** Parsed word ids of the current input line (max 10). */
  parsedWords: number[] = [];
  /** Normalized token text per parsed slot (incl. the unknown token); %w/word.to.string source. */
  parsedWordTexts: string[] = [];
  /** Raw text of the last parsed input line (host inspection). */
  lastInputLine = "";
  /**
   * Parser count (spec "Parser results"): retained identifiers, or the
   * unknown-token position. Internal state, distinct from v9, and what
   * said() gates on.
   */
  parserCount = 0;
  /** have.key polls without a key inside one cycle (busy-loop bound). */
  private haveKeyPolls = 0;
  /**
   * Clock busy-wait parking state for the current host tick: backward jumps
   * taken, and the logic and offset of the latest scalar comparison against a
   * clock variable. A loop parks only when that comparison lies inside its
   * own byte range, so a clock read elsewhere in the pass cannot shield an
   * unrelated runaway loop from the playtest budget.
   */
  private backwardJumps = 0;
  private clockReadLogic = -1;
  private clockReadPc = -1;
  /** Host milliseconds spent parked in the current clock busy-wait. */
  private clockWaitMs = 0;
  /** Current room number mirrors vars[0]. */
  horizon = 36;
  /** Priority bands are independent of the movement horizon and are not saved. */
  private priorityBase = 48;

  private readonly logics = new Map<number, LogicResource>();
  private readonly pictures = new Set<number>();
  private readonly views = new Map<number, AgiView>();
  /**
   * First-load retention order per resource family (spec "Resource
   * lifecycle"): discarding a retained picture or view also discards every
   * resource loaded later in that same family.
   */
  private readonly pictureOrder: number[] = [];
  private readonly viewOrder: number[] = [];
  private readonly objects: ScreenObject[] = Array.from({ length: 256 }, newScreenObject);
  private readonly keymap = new Map<number, number>();

  private activation: { logic: number; messages: readonly (string | null)[] } | null = null;
  /** Exact call stack parked at a modal instruction, innermost frame last. */
  private pendingLogic: LogicFrame[] | null = null;
  private pictureShown = false;
  private terminated = false;
  private statusEnabled = false;
  /** Cycle-entry status values survive a modal suspension of the logic stack. */
  private cycleStatusScore = 0;
  private cycleStatusSound = 0;
  private statusRefreshRequested = false;
  private inputAccepted = false;
  private scriptCapacity = DEFAULT_REPLAY_CAPACITY;
  private maximumReplayPairs = 0;
  private menu: MenuHeading[] = [];
  private menuFinalized = false;
  private menuHeading = 0;
  private menuRequested = false;
  private menuInteractionGate = 0;
  private blockRect: { left: number; top: number; right: number; bottom: number } | null = null;
  private textMode = false;
  private inputPrompt = "";
  private textFg = 15;
  private textBg = 0;
  private displayBaseRow = 1;
  private inputRow = 22;
  private statusRow = 0;
  /** Engine-owned text surface (spec "Text geometry and surfaces"). */
  private readonly text = new TextSurface();
  private readonly trace = new TraceWindow();
  private readonly tracedText = new TextSurface();
  /** Live input-line edit buffer and the most recently accepted line (echo.line). */
  private editLine = "";
  private acceptedLine = "";
  /**
   * Open modals, innermost last. Saved text windows replace each other
   * (spec: opening another saved window closes the current one); the
   * non-window modals (show.pri, inventory, menu) stay underneath a print.
   */
  private readonly modals: Modal[] = [];
  /** f15 output mode keeps a window visible without suspending execution. */
  private persistentWindow: SavedRect | null = null;
  /** Menu selection carried into the next cycle's input phase as a mapped event. */
  private pendingController: number | null = null;
  /** Tracked key-release gate (action 0xad; spec "Tracked key release"). */
  private keyReleaseGate = 0;
  /** A gated release enqueued a movement value 0 for the next input phase. */
  private readonly inputQueue = new InputQueue();
  /**
   * Saved bytecode resume offsets per logic (set.scan.start/reset.scan.start).
   * They are the source of save block 5 and are re-established by restore.
   */
  private readonly scanStart = new Map<number, number>();
  /**
   * Ordered resource replay sequence (spec "Resource replay sequence"): the
   * two-byte (kind, value) pairs restore replays to rebuild room resource and
   * display state, rather than re-running the room's logic.
   */
  private readonly replay: ReplayPair[] = [];
  /**
   * Every pair the recording gate lets through, including those f7 blocks
   * from the game's own sequence. Host autosaves of a game that blocks its
   * script buffer (the demo pack sets f7 for good) use it so a resume can
   * redraw the room; the game's save.game keeps writing the authentic
   * sequence.
   */
  private readonly hostReplay: ReplayPair[] = [];
  /** The shadow record hit HOST_REPLAY_LIMIT: an autosave could no longer rebuild the room. */
  private hostReplayOverflow = false;
  /** Saved active-pair count of the last push.script (spec "Replay checkpoints"). */
  private replayCheckpoint = 0;
  /** Internal recording gate; cleared around replay and view previews. */
  private replayRecording = true;
  /** Engine timing accumulator serialized as the save's timer tick count. */
  private timerTicks = 0;
  private clockRemainderMs = 0;
  /** Most recently prepared picture number (save block 1). */
  private lastPicture = 0;
  /** Game/save signature area, set by set.game.id (spec "Save names and signatures"). */
  private signature = "";
  /** Last selected/entered save description; set.simple copies at most 31 bytes. */
  private saveDescription = "";
  private saveDialogMode: "save" | "restore" | null = null;
  /**
   * Object-0/global-direction coupling selector (save block 1): player.control
   * couples object 0 to the global direction byte, program.control decouples it.
   */
  private directionCoupling = 1;
  /** Decoded OBJECT metadata: block-3 payload, entry count and block-2 record count. */
  private inventoryMetaCache: {
    payload: Uint8Array;
    entryCount: number;
    objectRecords: number;
  } | null = null;
  private readonly sounds = new Map<number, Uint8Array>();
  private soundPlayback: SoundPlayback | null = null;
  private playingSound: number | null = null;
  private soundDoneFlag: number | null = null;
  /** open.dialogue fixed input-width cap (spec: 36 chars), null when derived. */
  private inputWidthCap: number | null = null;
  /** Lazily decoded OBJECT-file inventory names (XOR "Avis Durgan"). */
  private itemNameCache: string[] | null = null;

  private readonly container: GameContainer;
  private readonly host: EngineHost;
  private readonly dictionary: ReadonlyMap<string, number> | undefined;
  private readonly instructionBudget: number;
  private remainingInstructions: number;

  constructor(
    container: GameContainer,
    host: EngineHost,
    dictionary?: ReadonlyMap<string, number>,
    options?: { restarted?: boolean; profile?: ProfileId | AgiProfile; instructionBudget?: number },
  ) {
    this.container = container;
    this.host = host;
    this.dictionary = dictionary;
    if (
      options?.instructionBudget !== undefined &&
      (!Number.isInteger(options.instructionBudget) || options.instructionBudget < 1)
    )
      throw new Error("instructionBudget must be a positive integer.");
    this.instructionBudget = options?.instructionBudget ?? Infinity;
    this.remainingInstructions = this.instructionBudget;
    // The interpreter version is not in the resource data: an explicit profile
    // wins, otherwise detection reads the version string from an interpreter
    // binary shipped in the same folder, otherwise the container shape decides.
    this.profile = detectProfile(container.files, options?.profile);
    this.strings = Array.from({ length: this.profile.stringSlots }, () => "");
    this.vars[22] = (this.host.soundDevice?.() ?? 1) === 0 ? 1 : 3;
    this.vars[26] = 3; // EGA presentation on the PC-compatible platform (v20 = 0).
    // On cold boot, f5 (F_NEW_ROOM) is set for the initial room 0;
    // f6 (F_RESTART) is only set on restart (options.restarted or restart.game).
    this.flags[F_NEW_ROOM] = 1;
    if (options?.restarted) {
      this.flags[F_RESTART] = 1;
    }
    // Initial object/inventory setup: item locations start where the game's
    // metadata puts them (spec "Objects and inventory items").
    this.initInventory();
  }

  /**
   * Runtime container patch (the authoring agent's growth primitive):
   * reclaims superseded records and repoints the directory transactionally.
   * The engine picks it up on next load.
   */
  patchResource(
    kind: "logic" | "picture" | "view" | "sound",
    num: number,
    payload: Uint8Array,
  ): void {
    this.container.putResource(kind, num, payload);
    if (kind === "logic") this.logics.delete(num);
    else if (kind === "picture") this.pictures.delete(num);
    else if (kind === "view") this.views.delete(num);
    else this.sounds.delete(num);
    this.patchGen++;
  }

  /** Replace cartridge metadata while preserving the player's existing item locations. */
  patchAuxiliaryFiles(files: {
    words?: Uint8Array;
    objects?: Uint8Array;
    tests?: Uint8Array;
  }): void {
    const existingItems = this.inventoryMetadata().entryCount;
    if (files.words) this.container.putFile("WORDS.TOK", files.words);
    if (files.tests) this.container.putFile("TESTS.JSON", files.tests);
    if (files.objects) {
      this.container.putFile("OBJECT", files.objects);
      this.inventoryMetaCache = null;
      this.itemNameCache = null;
      const meta = this.inventoryMetadata();
      for (let item = existingItems; item < meta.entryCount; item++) {
        this.itemLocations[item] = meta.payload[item * 3 + 2] ?? 0;
      }
    }
    if (files.words || files.objects || files.tests) this.patchGen++;
  }

  /**
   * Live container bytes (LOGDIR/PICDIR/VIEWDIR/SNDDIR/VOL.n/WORDS.TOK/OBJECT).
   * A save image is state, not resources: a host that persists a save of an
   * agent-authored game has to persist the patched container beside it, or the
   * restore replays room resources the stored container never received.
   */
  get containerFiles(): ReadonlyMap<string, Uint8Array> {
    return this.container.files;
  }

  /**
   * Counter of container patches applied so far. A host comparing it against
   * the value it last persisted knows whether `containerFiles` changed, which
   * is what makes a periodic snapshot affordable: the bytes travel only when
   * a patch really landed.
   */
  get patchGeneration(): number {
    return this.patchGen;
  }

  // ---------- resource access ----------

  private loadLogic(num: number): LogicResource {
    const cached = this.logics.get(num);
    if (cached) return cached;
    const payload = this.container.getResource("logic", num);
    if (!payload) throw new Error(`logic resource ${num} not in container`);
    const parsed = parseLogicResource(payload);
    this.logics.set(num, parsed);
    return parsed;
  }

  // ---------- main cycle ----------

  /**
   * Undismissed modal windows. Classic AGI message windows pause the
   * interpreter until acknowledged — the crocodiles wait while you read.
   */
  private printsPending = 0;

  /** Container patches applied so far; the host's change detector. */
  private patchGen = 0;

  /**
   * Host acknowledged the open modal (Enter/Esc/click). For a print window
   * this restores the covered cells; for an interactive inventory it is the
   * cancel path (v25 = 0xff); for a menu it closes without selection.
   */
  ackPrint(): void {
    if (!this.modal) return;
    if (this.modal.kind === "inventory" && this.modal.interactive)
      this.vars[V_SELECTED_ITEM] = 0xff;
    this.closeModal();
  }

  // ---------- text surface (spec "Text geometry and surfaces") ----------

  /** 40x25 cells, [char, attr] pairs; char 0 = transparent (picture shows through). */
  /** The trace overlay shows only while no window or dialog owns the surface. */
  private get traceOverlayVisible(): boolean {
    return (
      this.trace.active &&
      this.modal === null &&
      this.saveDialogMode === null &&
      this.persistentWindow === null
    );
  }

  get textCells(): Uint8Array {
    return this.getPresentation().text;
  }

  private mergeTraceText(game: Uint8Array): Uint8Array {
    // The trace overlay is a host surface and stays on top of everything.
    if (!this.traceOverlayVisible) return game;
    const cells = this.tracedText.cells;
    cells.set(game);
    const overlay = this.trace.surface.cells;
    for (let i = 0; i < cells.length; i += 2) {
      if (overlay[i] !== 0) {
        cells[i] = overlay[i]!;
        cells[i + 1] = overlay[i + 1]!;
      }
    }
    return cells;
  }

  /** Increments on every text-surface mutation. */
  get textDirty(): number {
    return this.text.dirty + this.trace.surface.dirty;
  }

  /** Text row where picture row 0 is presented (configure.screen display base). */
  get displayBase(): number {
    return this.displayBaseRow;
  }

  /** Alternate full-screen text mode (text.screen) active. */
  get textModeActive(): boolean {
    return this.textMode;
  }

  /** Kind of the open modal, or null when the interpreter is running. */
  get modalKind(): Modal["kind"] | "save" | "restore" | null {
    return this.saveDialogMode ?? this.modal?.kind ?? null;
  }

  /** A message has suspended a cycle, including after its timeout expires. */
  get continuationPending(): boolean {
    return this.pendingLogic !== null;
  }

  private get modal(): Modal | null {
    return this.modals[this.modals.length - 1] ?? null;
  }

  /** Close a saved text window on top before opening another one. */
  private closeWindowOnTop(): void {
    const top = this.modal;
    if (top && (top.kind === "print" || top.kind === "showObj")) this.closeModal();
    if (this.persistentWindow) {
      this.text.restore(this.persistentWindow);
      this.persistentWindow = null;
    }
  }

  /** Current unaccepted input-line text. */
  get inputEdit(): string {
    return this.editLine;
  }

  /** Whether the host should offer parser editing rather than raw key input. */
  get inputEnabled(): boolean {
    return this.inputAccepted;
  }

  /** The text row for a text-surface read-back (debug/test helper). */
  /** The written row, trace overlay included, before sprites hide anything. */
  textRow(row: number): string {
    if (!this.traceOverlayVisible) return this.text.rowText(row);
    this.mergeTraceText(this.text.cells);
    return this.tracedText.rowText(row);
  }

  /**
   * Replace the live edit buffer (a host that edits input in its own widget
   * mirrors it here so the input row shows what the player typed).
   */
  setEditLine(text: string): void {
    this.editLine = text.slice(0, this.inputCapacity());
    this.drawInputRow();
  }

  /**
   * Tracked key release (spec): when the release gate is nonzero the release
   * enqueues a movement value 0, processed in the next input phase. A host
   * delaying delivery through a modal may supply eligibility captured at release.
   */
  releaseTrackedKey(eligible = this.keyReleaseGate !== 0): void {
    if (eligible) {
      for (const key of this.host.takeKeys()) this.inputQueue.enqueueKey(key, this.keymap);
      this.inputQueue.enqueue({ type: 2, value: 0 });
    }
  }

  /** Key-release event gate (action 0xad / 0xb5); nonzero enqueues release events. */
  get releaseGate(): number {
    return this.keyReleaseGate;
  }

  /** Screen objects, for tests and hosts that inspect object state. */
  get screenObjects(): readonly ScreenObject[] {
    return this.objects;
  }

  /**
   * Slot writes outside the profile's string range are ignored
   * (spec "String slots": six slots before 2.411, twelve afterwards).
   */
  private setString(slot: number, value: string): void {
    if (slot < this.strings.length) this.strings[slot] = value.slice(0, 39);
  }

  private inputCapacity(): number {
    return Math.min(this.inputWidthCap ?? TEXT_COLS - 1, TEXT_COLS - 1 - this.inputPrompt.length);
  }

  private textAttr(): number {
    return attr(this.textFg, this.textBg);
  }

  /** Host sound control refreshes status without overwriting an open modal. */
  setSoundEnabled(enabled: boolean): void {
    const value = enabled ? 1 : 0;
    if (this.flags[F_SOUND_ENABLED] === value) return;
    this.flags[F_SOUND_ENABLED] = value;
    this.statusRefreshRequested = true;
    if (this.modalKind === null && this.pendingLogic === null) this.drawStatus();
  }

  /** Status line: score at column 1, sound state at column 30, black on white. */
  private drawStatus(): void {
    if (!this.statusEnabled || this.textMode) return;
    const a = attr(0, 15);
    this.text.fill(this.statusRow, 0, this.statusRow, TEXT_COLS - 1, 0x20, a);
    this.text.write(this.statusRow, 1, this.statusText(), a);
    this.text.write(
      this.statusRow,
      30,
      `Sound:${this.flags[F_SOUND_ENABLED] !== 0 ? "on" : "off"}`,
      a,
    );
    this.statusRefreshRequested = false;
    this.host.statusLine(this.statusText());
  }

  private statusText(): string {
    // Supplemental variable contract: AGI specs §3.3 identifies v7 as maximum score.
    // https://www.agidev.com/articles/agispec/agispecs-3.html
    return `Score: ${this.vars[V_SCORE]} of ${this.vars[7]}`;
  }

  /** Input row: prompt marker, then the edit buffer (spec "Text geometry"). */
  private drawInputRow(): void {
    if (this.textMode) return;
    if (!this.inputAccepted) {
      this.text.fill(this.inputRow, 0, this.inputRow, TEXT_COLS - 1, 0, 0);
      return;
    }
    const a = this.textAttr();
    this.text.fill(this.inputRow, 0, this.inputRow, TEXT_COLS - 1, 0x20, a);
    this.text.write(this.inputRow, 0, this.inputPrompt + this.editLine, a);
  }

  private acceptLine(line: string): void {
    this.acceptedLine = line;
    this.editLine = "";
    this.parseInput(line);
    this.drawInputRow();
  }

  /** have.key discards navigation/status events and preserves the unread suffix. */
  private pollRawKey(): number | undefined {
    for (let event = this.inputQueue.dequeue(); event; event = this.inputQueue.dequeue()) {
      if (event.type === 1) {
        if (event.mapOnConsume && this.keymap.has(event.value)) continue;
        return event.value;
      }
    }
    return undefined;
  }

  /** Raw key in the ordinary (non-modal) input phase. */
  private handleKey(key: number): void {
    if (key === 0x4600) {
      if (this.trace.active || this.flags[10] !== 0) this.trace.setActive(!this.trace.active);
      return;
    }
    const byte = key & 0xff;
    if (this.inputAccepted && !this.textMode) {
      if (byte === KEY_ENTER && this.editLine.length > 0) {
        this.acceptLine(this.editLine);
        return;
      }
      if (byte === KEY_BACKSPACE) {
        this.editLine = this.editLine.slice(0, -1);
        this.drawInputRow();
        return;
      }
      if (byte >= 0x20 && byte <= 0x7e && this.editLine.length < this.inputCapacity()) {
        this.editLine += String.fromCharCode(byte);
        this.drawInputRow();
        return;
      }
    }
    this.vars[V_KEY] = byte;
  }

  // ---------- modal windows ----------

  /** Key delivered while a modal is open (Enter/Esc/navigation per spec). */
  modalKey(key: number): void {
    if (key === 0x4600) {
      this.handleKey(key);
      return;
    }
    const m = this.modal;
    if (!m) return;
    if (key === 0x0101 || key === 0x0301) key = KEY_ENTER;
    if (key === 0x0201 || key === 0x0401) key = KEY_ESC;
    const nav = NAV_KEYS[key];
    if (nav !== undefined) {
      this.modalNavigate(nav);
      return;
    }
    const byte = key & 0xff;
    switch (m.kind) {
      case "print":
      case "showObj":
      case "showPri":
        if (byte === KEY_ENTER || byte === KEY_ESC || byte === 0x20) this.closeModal();
        return;
      case "inventory":
        if (!m.interactive) {
          if (byte !== 0) this.closeModal();
          return;
        }
        if (byte === KEY_ENTER) {
          this.vars[V_SELECTED_ITEM] = m.items[m.selected]?.num ?? 0xff;
          this.closeModal();
        } else if (byte === KEY_ESC) {
          this.vars[V_SELECTED_ITEM] = 0xff;
          this.closeModal();
        }
        return;
      case "menu":
        if (byte === KEY_ENTER) {
          const heading = this.menu[this.menuHeading]!;
          const item = heading.items[heading.current];
          if (item && item.enabled) {
            this.pendingController = item.id;
            this.closeModal();
          }
        } else if (byte === KEY_ESC) {
          this.closeModal();
        }
        return;
    }
  }

  /** Type-2 navigation value (1..8) delivered while a modal is open. */
  modalNavigate(value: number): void {
    const m = this.modal;
    if (!m) return;
    if (m.kind === "inventory" && m.interactive && m.items.length > 0) {
      const n = m.items.length;
      if (value === 1 || value === 7) m.selected = (m.selected - 1 + n) % n;
      else if (value === 5 || value === 3) m.selected = (m.selected + 1) % n;
      else if (value === 2 || value === 8) m.selected = 0;
      else if (value === 4 || value === 6) m.selected = n - 1;
      this.drawInventory(m);
      return;
    }
    if (m.kind === "menu") this.menuNavigate(value);
  }

  private closeModal(): void {
    const m = this.modals.pop();
    if (!m) return;
    if (this.printsPending > 0) this.printsPending--;
    // A timed print zeroes v21 when its window closes, by timeout or key.
    // docs/fidelity.md: print-handler-output-modes
    if (m.kind === "print" && m.remainingMs !== null && this.profile.timedPrintClearsV21)
      this.vars[21] = 0;
    if (m.kind !== "showPri") this.text.restore(m.saved);
    if (m.kind === "menu") {
      this.menuRequested = false;
      this.drawStatus();
    }
  }

  /**
   * Modal message window (spec "Modal text"): closes any open window, saves
   * the covered cells, draws the bordered window, and pauses the interpreter
   * until acknowledged. `place` carries the print.at overrides.
   */
  private emitPrint(
    text: string,
    place?: { row?: number | undefined; col?: number | undefined; width?: number | undefined },
    forceAcknowledgement = false,
  ): void {
    this.closeWindowOnTop();
    const width = place?.width ? place.width : 30;
    const lines = wrapLines(text, width);
    const box = placeWindow(lines, this.displayBaseRow, place);
    const saved = this.text.save(
      box.top,
      box.left,
      box.top + box.rows - 1,
      box.left + box.cols - 1,
    );
    drawWindow(this.text, box, lines, attr(0, 15), attr(4, 15));
    if (!forceAcknowledgement && this.flags[15] !== 0) {
      // A print that opens a non-blocking window consumes f15 as it returns.
      // docs/fidelity.md: print-handler-output-modes
      if (this.profile.printConsumesF15) this.flags[15] = 0;
      this.persistentWindow = saved;
    } else {
      this.modals.push({
        kind: "print",
        saved,
        remainingMs: !forceAcknowledgement && this.vars[21] !== 0 ? this.vars[21]! * 500 : null,
      });
      this.printsPending++;
    }
    this.host.print(text);
  }

  /** show.obj: description window plus the cel, drawn by getFrame while open. */
  private showObj(viewNum: number): void {
    this.closeWindowOnTop();
    // Temporary view preview actions disable recording around their internal
    // load/display/discard work (spec "Resource replay sequence").
    const recording = this.replayRecording;
    this.replayRecording = false;
    let view: AgiView;
    try {
      view = this.loadView(viewNum);
      selectViewCel(view, 0, 0);
    } finally {
      this.replayRecording = recording;
    }
    const lines = wrapLines(view.description ?? "", 30);
    const box = placeWindow(lines, this.displayBaseRow, { row: this.displayBaseRow + 1 });
    const saved = this.text.save(
      box.top,
      box.left,
      box.top + box.rows - 1,
      box.left + box.cols - 1,
    );
    drawWindow(this.text, box, lines, attr(0, 15), attr(4, 15));
    this.modals.push({ kind: "showObj", saved, view: viewNum });
    this.printsPending++;
    this.host.showObj?.(viewNum);
  }

  private showPriScreen(): void {
    this.closeWindowOnTop();
    this.modals.push({ kind: "showPri" });
    this.printsPending++;
    this.host.showPriScreen?.();
  }

  /** Engine-owned confirmation window with the host's blocking key adapter. */
  private confirmSessionAction(action: "restart" | "quit"): boolean {
    this.emitPrint(
      `${action === "restart" ? "Restart" : "Quit"} the game?\nENTER: yes   ESC: continue`,
      undefined,
      true,
    );
    const confirmation = this.modal;
    const wait = this.host.waitKey ?? this.host.waitTextKey;
    try {
      for (;;) {
        const key = wait ? wait.call(this.host) : (this.host.takeKeys()[0] ?? KEY_ESC);
        const byte = key & 0xff;
        if (byte === KEY_ENTER) return true;
        if (byte === KEY_ESC || key === 0) return false;
      }
    } finally {
      if (confirmation && this.modal === confirmation) this.closeModal();
    }
  }

  /** The adapter supplies an available directory; the engine owns selection and text. */
  private selectSavedGame(mode: "save" | "restore"): Uint8Array | null {
    const list = this.host.listSaveGames!;
    const wait = this.host.waitKey ?? this.host.waitTextKey;
    const describe = this.host.promptSaveDescription;
    this.stopSound();
    this.saveDialogMode = mode;
    try {
      return runSaveDialog(mode, this.text, this.signature, {
        list: () => list.call(this.host),
        waitKey: () => {
          if (wait) return wait.call(this.host);
          // Polling hosts return a batch. Preserve the bounded FIFO and leave
          // its unread suffix for the next modal or script input consumer.
          for (const key of this.host.takeKeys()) {
            const normalized =
              key === 0x0101 || key === 0x0301
                ? KEY_ENTER
                : key === 0x0201 || key === 0x0401
                  ? KEY_ESC
                  : key;
            const raw = normalized & 0xff ? normalized & 0xff : normalized & 0xffff;
            const navigation = NAV_KEYS[raw];
            this.inputQueue.enqueue({
              type: navigation === undefined ? 1 : 2,
              value: navigation ?? raw,
              mapOnConsume: true,
            });
          }
          for (let event = this.inputQueue.dequeue(); event; event = this.inputQueue.dequeue()) {
            if (event.type === 1) return event.value;
            if (event.type === 2 && event.value !== 0) {
              const navigationKey = Object.entries(NAV_KEYS).find(
                ([, direction]) => direction === event.value,
              );
              if (navigationKey) return Number(navigationKey[0]);
            }
          }
          return KEY_ESC;
        },
        ...(describe
          ? {
              describe: (initial: string, maxLen: number, row: number, col: number) =>
                describe.call(this.host, initial, maxLen, row, col),
            }
          : {}),
        write: (slot, description) => {
          this.saveDescription = description;
          return this.host.saveGame ? this.host.saveGame(this.serialize(), slot) : false;
        },
        read: (slot) => this.host.restoreGame?.(slot) ?? null,
      });
    } finally {
      this.saveDialogMode = null;
      this.controllers.fill(0);
    }
  }

  /**
   * Inventory screen (spec "Inventory selection"): carried items in item
   * order, one centred column, or two columns when more than 21 items.
   */
  private openInventory(): void {
    this.closeWindowOnTop();
    const names = this.itemNames();
    const items: { num: number; name: string }[] = [];
    for (let i = 0; i < this.itemLocations.length; i++) {
      if (this.itemLocations[i] === 0xff) items.push({ num: i, name: names[i] ?? `item ${i}` });
    }
    const slots: { row: number; col: number }[] = [];
    const twoColumns = items.length > 21;
    const longest = items.reduce((m, it) => Math.max(m, it.name.length), 0);
    const singleCol = Math.floor((TEXT_COLS - longest) / 2);
    for (let i = 0; i < items.length; i++) {
      slots.push(
        twoColumns ? { row: 2 + (i % 21), col: i < 21 ? 1 : 21 } : { row: 2 + i, col: singleCol },
      );
    }
    const saved = this.text.save(0, 0, TEXT_ROWS - 1, TEXT_COLS - 1);
    const modal: Modal = {
      kind: "inventory",
      saved,
      items,
      slots,
      selected: 0,
      interactive: this.profile.inventorySelector && this.flags[F_INV_SELECT] !== 0,
    };
    this.modals.push(modal);
    this.printsPending++;
    this.drawInventory(modal);
    this.host.statusScreen?.(items);
  }

  private drawInventory(m: Modal & { kind: "inventory" }): void {
    const a = attr(0, 15);
    this.text.fill(0, 0, TEXT_ROWS - 1, TEXT_COLS - 1, 0x20, a);
    this.text.write(0, 11, "You are carrying:", a);
    if (m.items.length === 0) this.text.write(2, 16, "nothing", a);
    for (let i = 0; i < m.items.length; i++) {
      const slot = m.slots[i]!;
      if (slot.row > 22) continue;
      const highlight = m.interactive && i === m.selected;
      this.text.write(slot.row, slot.col, m.items[i]!.name, highlight ? attr(15, 0) : a);
    }
    if (m.interactive) this.text.write(24, 2, "Press ENTER to select, ESC to cancel", a);
    else this.text.write(24, 3, "Press a key to return to the game", a);
  }

  // ---------- menus (spec "Menu construction" / "Menu interaction") ----------

  readMenuState(): EngineMenuState {
    return {
      headings: this.menu.map((heading) => ({
        ...heading,
        items: heading.items.map((item) => ({ ...item })),
      })),
      finalized: this.menuFinalized,
      heading: this.menuHeading,
      requested: this.menuRequested,
    };
  }

  /** Restore host checkpoint data atomically; absent or malformed metadata leaves menus intact. */
  restoreMenuState(value: unknown): boolean {
    if (typeof value !== "object" || value === null) return false;
    const state = value as EngineMenuState;
    if (
      !Array.isArray(state.headings) ||
      typeof state.finalized !== "boolean" ||
      typeof state.requested !== "boolean" ||
      !Number.isInteger(state.heading) ||
      state.heading < 0 ||
      state.heading >= Math.max(1, state.headings.length) ||
      !state.headings.every(
        (heading) =>
          heading !== null &&
          typeof heading === "object" &&
          typeof heading.title === "string" &&
          typeof heading.enabled === "boolean" &&
          Array.isArray(heading.items) &&
          Number.isInteger(heading.current) &&
          heading.current >= 0 &&
          heading.current < Math.max(1, heading.items.length) &&
          heading.items.every(
            (item) =>
              item !== null &&
              typeof item === "object" &&
              typeof item.text === "string" &&
              typeof item.enabled === "boolean" &&
              Number.isInteger(item.id) &&
              item.id >= 0 &&
              item.id <= 255,
          ),
      )
    )
      return false;
    this.menu = state.headings.map((heading) => ({
      title: heading.title,
      enabled: heading.enabled,
      current: heading.current,
      items: heading.items.map((item) => ({ text: item.text, id: item.id, enabled: item.enabled })),
    }));
    this.menuFinalized = state.finalized;
    this.menuHeading = state.heading;
    this.menuRequested = state.requested;
    return true;
  }

  private finalizeMenu(): void {
    if (this.menuFinalized) return;
    this.menuFinalized = true;
    for (const h of this.menu) {
      h.enabled = h.items.length > 0;
      h.current = 0;
    }
    this.menuHeading = Math.max(
      0,
      this.menu.findIndex((h) => h.enabled),
    );
  }

  /** Column of each heading on the menu bar: from column 1, one space apart. */
  private menuColumns(): number[] {
    const cols: number[] = [];
    let c = 1;
    for (const h of this.menu) {
      cols.push(c);
      c += h.title.length + 1;
    }
    return cols;
  }

  /** Open the modal menu at the input phase; false when there is no usable menu. */
  private openMenu(): boolean {
    if (!this.menuFinalized || !this.menu.some((h) => h.enabled)) return false;
    this.closeWindowOnTop();
    if (!this.menu[this.menuHeading]!.enabled)
      this.menuHeading = this.menu.findIndex((h) => h.enabled);
    this.modals.push({ kind: "menu", saved: this.text.save(0, 0, TEXT_ROWS - 1, TEXT_COLS - 1) });
    this.printsPending++;
    this.drawMenu();
    return true;
  }

  private drawMenu(): void {
    const m = this.modal;
    if (!m || m.kind !== "menu") return;
    this.text.restore(m.saved);
    const bar = attr(0, 15);
    const cols = this.menuColumns();
    this.text.fill(0, 0, 0, TEXT_COLS - 1, 0x20, bar);
    this.menu.forEach((h, i) => {
      this.text.write(0, cols[i]!, h.title, i === this.menuHeading ? attr(15, 0) : bar);
    });
    const heading = this.menu[this.menuHeading]!;
    const width = heading.items.reduce((w, it) => Math.max(w, it.text.length), 1);
    let left = cols[this.menuHeading]! - 1;
    if (left + width + 1 > TEXT_COLS - 1) left = TEXT_COLS - 2 - width;
    const box = { top: 1, left, rows: heading.items.length + 2, cols: width + 2 };
    drawWindow(
      this.text,
      box,
      heading.items.map((it) => it.text),
      bar,
      bar,
    );
    heading.items.forEach((it, i) => {
      const a = i === heading.current ? attr(15, 0) : it.enabled ? bar : attr(8, 15);
      this.text.write(2 + i, left + 1, it.text.padEnd(width, " "), a);
    });
  }

  private menuNavigate(value: number): void {
    const heading = this.menu[this.menuHeading]!;
    const n = heading.items.length;
    switch (value) {
      case 1:
        heading.current = (heading.current - 1 + n) % n;
        break;
      case 2:
        heading.current = 0;
        break;
      case 4:
        heading.current = n - 1;
        break;
      case 5:
        heading.current = (heading.current + 1) % n;
        break;
      case 3:
        this.menuHeading = this.nextEnabledHeading(this.menuHeading, 1);
        break;
      case 7:
        this.menuHeading = this.nextEnabledHeading(this.menuHeading, -1);
        break;
      case 6:
        this.menuHeading = this.nextEnabledHeading(0, -1);
        break;
      case 8:
        this.menuHeading = this.nextEnabledHeading(this.menu.length - 1, 1);
        break;
    }
    this.drawMenu();
  }

  /** Circular heading search skipping disabled headings; the current item stays remembered. */
  private nextEnabledHeading(from: number, step: number): number {
    const n = this.menu.length;
    for (let i = 1; i <= n; i++) {
      const idx = (from + step * i + n * i) % n;
      if (this.menu[idx]!.enabled) return idx;
    }
    return from;
  }

  /**
   * Save-file image for save.game (spec "Save-file envelope"): the 31-byte
   * description header plus the selected profile's length-prefixed blocks.
   *
   * The blocks are game state, not an engine dump: block 1 the scalars,
   * signature, strings, key map and display state; block 2 the drawable-object
   * records; block 3 the game's runtime inventory payload carrying live item
   * locations; block 4 the resource replay sequence; block 5 the loaded-logic
   * resume records.
   */
  serialize(): Uint8Array {
    const state = newSaveState(this.profile);
    state.description = this.saveDescription;
    for (let i = 0; i < this.signature.length && i < 7; i++) {
      state.signature[i] = this.signature.charCodeAt(i) & 0xff;
    }
    state.vars.set(this.vars);
    state.flags.set(this.flags);
    state.timerTicks = this.timerTicks;
    state.horizon = this.horizon;
    state.blockLeft = this.blockRect?.left ?? 0;
    state.blockTop = this.blockRect?.top ?? 0;
    state.blockRight = this.blockRect?.right ?? 0;
    state.blockBottom = this.blockRect?.bottom ?? 0;
    state.blockEnabled = this.blockRect ? 1 : 0;
    state.directionCoupling = this.directionCoupling;
    state.lastPicture = this.lastPicture;
    // The capacity word and the block-4 byte length must agree, so the image
    // never claims fewer slots than the pairs it holds.
    state.replayCapacity = Math.max(this.scriptCapacity, this.replay.length);
    state.replayActive = this.replay.length;
    state.replayCheckpoint = this.replayCheckpoint;
    let slot = 0;
    for (const [rawKey, status] of this.keymap) {
      const entry = state.keyMap[slot];
      if (!entry) break;
      entry.rawKey = rawKey;
      entry.status = status;
      slot++;
    }
    for (let i = 0; i < state.strings.length; i++) state.strings[i] = this.strings[i] ?? "";
    state.textFg = this.textFg;
    state.textBg = this.textBg;
    state.textAttr = attr(this.textFg, this.textBg);
    state.inputEnabled = this.inputAccepted ? 1 : 0;
    state.inputRow = this.inputRow;
    state.promptChar = this.inputPrompt.charCodeAt(0) || 0;
    state.statusEnabled = this.statusEnabled ? 1 : 0;
    state.statusRow = this.statusRow;
    state.displayBaseRow = this.displayBaseRow;
    state.displayBottomRow = this.displayBaseRow + 21;
    state.menuGate = this.menuInteractionGate;
    state.releaseGate = this.keyReleaseGate;

    const meta = this.inventoryMetadata();
    state.objects = [];
    for (let num = 0; num < meta.objectRecords; num++) {
      state.objects.push(this.objectRecord(num));
    }
    state.inventory = Uint8Array.from(meta.payload);
    for (let item = 0; item < meta.entryCount; item++) {
      state.inventory[item * 3 + 2] = this.itemLocations[item]!;
    }
    state.replay = this.replay.map((pair) => ({ ...pair }));
    state.logicResume = [...this.logics.keys()].map((logic) => ({
      logic,
      offset: this.scanStart.get(logic) ?? 0,
    }));
    return encodeSave(state, this.profile);
  }

  /** Block-2 record for one drawable object. */
  private objectRecord(num: number): SaveObjectRecord {
    const o = this.objects[num]!;
    const record = newObjectRecord();
    record.stepTime = o.stepTime;
    record.stepCount = o.stepCount;
    record.event = num; // normalized to the object's table index
    record.x = o.x;
    record.y = o.y;
    record.view = o.view;
    record.loop = o.loop;
    record.loopCount = this.views.get(o.view)?.loops.length ?? 0;
    record.cel = o.cel;
    record.celCount = this.celCount(o);
    record.prevX = o.prevX;
    record.prevY = o.prevY;
    record.width = o.width;
    record.height = o.height;
    record.stepSize = o.stepSize;
    record.cycleTime = o.cycleTime;
    record.cycleCount = o.cycleCount;
    record.direction = o.direction;
    record.motionMode = o.motionMode;
    record.cycleMode = o.cycleMode;
    record.priority = o.fixedPriority ? o.priority : 0;
    record.state = packObjectState(o);
    record.motionParams = motionParams(o);
    return record;
  }

  /**
   * Host-initiated save image for an autosave, or null when this cycle
   * boundary is not a safe one to snapshot.
   *
   * Wraps the authentic `save.game` image with the host's screen sequence,
   * text and draw ages. Snapshots need a safe cycle boundary because they
   * do not preserve suspended logic or modal interaction:
   *
   * - An open modal window or a pending message owns the text surface; its
   *   interaction cannot resume from the saved scalar and presentation state.
   * - Full-screen text mode is the same problem one layer up.
   * - Before any room has drawn (boot, or the gap inside a room transition),
   *   the image would restore to a blank screen.
   *
   * The caller skips this tick and tries the next one.
   */
  autosaveImage(): Uint8Array | null {
    if (this.pendingLogic !== null) return null;
    if (this.modal !== null || this.persistentWindow !== null || this.printsPending > 0)
      return null;
    if (this.textMode) return null;
    // Nothing to resume before the first room has drawn. The shadow record
    // is the witness rather than the game's replay: a game that blocks the
    // script buffer (f7, the demo pack does) records no replay pairs at all,
    // and a resumed one has the sequence that rebuilt its screen but no
    // show.pic of its own yet.
    if (this.hostReplay.length === 0 && !this.pictureShown) return null;
    // The host envelope wraps save.game's own image with the shadow record:
    // every load and draw since the room began, including the ones f7 kept out
    // of the game's sequence, so the resume rebuilds the room the game drew
    // while the game's replay and capacity come back untouched. A shadow that
    // overflowed cannot rebuild it.
    if (this.hostReplayOverflow) return null;
    return encodeHostImage(this.serialize(), this.hostReplay, {
      cells: this.text.cells,
      written: this.text.written,
      seq: this.text.seq,
      draws: this.objects.map(({ drawSeq, drawnX, drawnY, drawnWidth, drawnHeight }) => ({
        drawSeq,
        drawnX,
        drawnY,
        drawnWidth,
        drawnHeight,
      })),
    });
  }

  /**
   * Host-driven restore, for resuming an autosave after a page reload. The
   * bytecode path (`applyRestore`) aborts the continuation of the logic that
   * issued restore.game; there is no activation on the stack when the HOST
   * restores, so the abort is caught here, exactly as `reenterRoom` catches
   * the unwind `newRoom` throws.
   *
   * A malformed or profile-mismatched image throws out of `decodeHostImage` or
   * `decodeSave` before any state is replaced, so a failed restore leaves the
   * game untouched.
   */
  restoreImage(bytes: Uint8Array): void {
    const { image, screen, presentation } = decodeHostImage(bytes);
    // Run the same restore against disposable state and a silent host first.
    // This validates both packet grammar and referenced resources before the
    // live engine or host sees any mutation, without a second replay parser.
    const candidate = new Engine(
      this.container,
      {
        print() {},
        displayAt() {},
        statusLine() {},
        takeInputLine() {
          return null;
        },
        takeKeys() {
          return [];
        },
      },
      this.dictionary,
      { profile: this.profile },
    );
    try {
      candidate.applyRestore(image, screen);
    } catch (e) {
      if (!(e instanceof ContinuationAbort)) throw e;
    }
    try {
      this.applyRestore(image, screen);
    } catch (e) {
      if (!(e instanceof ContinuationAbort)) throw e;
    }
    if (presentation) {
      this.textMode = false; // Host snapshots are taken only in graphics mode.
      this.text.cells.set(presentation.cells);
      this.text.written.set(presentation.written);
      this.text.seq = presentation.seq;
      this.text.dirty++;
      for (let i = 0; i < this.objects.length; i++)
        Object.assign(this.objects[i]!, presentation.draws[i]!);
      // Parser edits are transient, as in an authentic restore; redraw the
      // engine-owned controls over the restored game captions.
      this.drawStatus();
      this.drawInputRow();
      this.host.setTextMode?.(false);
    }
  }

  /**
   * Restore from a save-file image (spec "Restore action outcomes"): replace
   * game-visible state, reset transient caches and replay the recorded
   * resource sequence with recording disabled, rebind object views and refresh
   * presentation, then abort the current continuation. The room's logic is NOT
   * re-run: the screen comes from the replay sequence, not from room re-entry.
   * A host resume passes the autosave's screen sequence to rebuild from.
   */
  applyRestore(image: Uint8Array, screen: readonly ReplayPair[] | null = null): never {
    const s = decodeSave(image, this.profile);
    this.saveDescription = s.description;
    this.statusRefreshRequested = false;
    this.inputQueue.clear();
    this.pendingController = null;
    this.pendingLogic = null;
    this.stopSound();

    // 1. Scalar, parser, object, inventory, replay, logic-resume, display and
    //    session state.
    this.vars.set(s.vars);
    this.flags.set(s.flags);
    this.timerTicks = s.timerTicks;
    this.clockRemainderMs = 0;
    this.horizon = s.horizon;
    this.blockRect = s.blockEnabled
      ? { left: s.blockLeft, top: s.blockTop, right: s.blockRight, bottom: s.blockBottom }
      : null;
    this.directionCoupling = s.directionCoupling;
    this.lastPicture = s.lastPicture;
    this.scriptCapacity = s.replayCapacity || DEFAULT_REPLAY_CAPACITY;
    this.replayCheckpoint = s.replayCheckpoint;
    this.menuInteractionGate = s.menuGate;
    this.keymap.clear();
    for (const entry of s.keyMap) {
      if (entry.rawKey !== 0 || entry.status !== 0) this.keymap.set(entry.rawKey, entry.status);
    }
    for (let i = 0; i < this.strings.length; i++) this.strings[i] = s.strings[i] ?? "";
    this.textFg = s.textFg;
    this.textBg = s.textBg;
    this.inputAccepted = s.inputEnabled !== 0;
    this.inputRow = s.inputRow;
    this.inputPrompt = s.promptChar === 0 ? "" : String.fromCharCode(s.promptChar);
    this.statusEnabled = s.statusEnabled !== 0;
    this.statusRow = s.statusRow;
    this.displayBaseRow = s.displayBaseRow;
    this.keyReleaseGate = s.releaseGate;
    for (let num = 0; num < this.objects.length; num++) {
      const o = this.objects[num]!;
      applyObjectRecord(o, s.objects[num]);
      // The rebuilt screen shows each object where the save left it, so that
      // is the rectangle its next erase restores, not where it stood before.
      this.stampDraw(o);
    }
    const entryCount = this.inventoryMetadata().entryCount;
    for (let item = 0; item < entryCount; item++) {
      this.itemLocations[item] = s.inventory[item * 3 + 2] ?? 0;
    }
    this.replay.length = 0;
    for (const pair of s.replay.slice(0, s.replayActive)) this.replay.push({ ...pair });
    // The screen is rebuilt from the host's sequence when the image came with
    // one (every load and draw since the room began, f7 or not); the game's
    // own replay and capacity are the image's, untouched. Either way the
    // sequence that rebuilt the screen is the shadow the next autosave carries.
    const sequence = screen ?? this.replay;
    this.hostReplay.length = 0;
    for (const pair of sequence) this.hostReplay.push({ ...pair });
    this.hostReplayOverflow = false;
    this.parsedWords = [];
    this.parsedWordTexts = [];
    this.parserCount = 0;
    this.lastInputLine = "";
    this.editLine = "";
    this.acceptedLine = "";
    this.controllers.fill(0);
    this.vars[V_KEY] = 0;
    this.flags[F_INPUT_READY] = 0;
    this.flags[F_SAID_MATCHED] = 0;

    // 2. Reset transient caches and replay the saved sequence.
    this.replaySequence(s.logicResume, sequence);

    // 3. Rebind object views and refresh picture, objects, status and input.
    this.rebindObjectViews();
    this.updateEgoVisibility();
    this.modals.length = 0;
    this.persistentWindow = null;
    this.printsPending = 0;
    if (!this.textMode) {
      this.text.clear();
      this.drawStatus();
      this.drawInputRow();
    }
    this.host.clearText?.();

    // 4. Abort the current continuation.
    throw new ContinuationAbort();
  }

  /**
   * Execute the replay sequence (spec "Resource replay sequence"): stop sound,
   * reset room resource caches, disable recording, run the pairs in order,
   * then re-enable recording. Replayed operations therefore append no
   * duplicates. Kinds 6 and 7 use the ordinary ordered-discard rule, so a
   * later pair may load the same resource again and establish a new order.
   */
  private replaySequence(resume: readonly LogicResumeRecord[], pairs: readonly ReplayPair[]): void {
    this.playingSound = null;
    this.soundDoneFlag = null;
    this.soundPlayback = null;
    this.sounds.clear();
    this.logics.clear();
    this.pictures.clear();
    this.pictureOrder.length = 0;
    this.views.clear();
    this.viewOrder.length = 0;
    this.scanStart.clear();
    this.surface.reset();
    this.pictureShown = false;

    const recording = this.replayRecording;
    this.replayRecording = false;
    try {
      for (let i = 0; i < pairs.length; i++) {
        const pair = pairs[i]!;
        switch (pair.kind) {
          case REPLAY_LOAD_LOGIC:
            this.loadLogic(pair.value);
            this.scanStart.set(pair.value, resumeOffsetFor(resume, pair.value));
            break;
          case REPLAY_LOAD_VIEW:
            this.loadView(pair.value);
            break;
          case REPLAY_LOAD_PICTURE:
            this.loadPicture(pair.value);
            break;
          case REPLAY_LOAD_SOUND:
            this.loadSound(pair.value);
            break;
          case REPLAY_DRAW_PICTURE:
            this.drawPicture(pair.value);
            break;
          case REPLAY_DISCARD_PICTURE:
            this.discardPicture(pair.value);
            break;
          case REPLAY_DISCARD_VIEW:
            this.discardView(pair.value);
            break;
          case REPLAY_OVERLAY_PICTURE:
            this.overlayPicture(pair.value);
            break;
          case REPLAY_ADD_TO_PIC: {
            // A four-pair packet: (5,0) then (view, loop), (cel, left_x),
            // (baseline_y, packed_priority_control).
            const a = pairs[i + 1];
            const b = pairs[i + 2];
            const c = pairs[i + 3];
            if (!a || !b || !c) throw new RangeError("replay transient-cel packet is truncated");
            this.addToPic(
              a.kind,
              a.value,
              b.kind,
              b.value,
              c.kind,
              (c.value >> 4) & 0x0f,
              c.value & 0x0f,
            );
            i += 3;
            break;
          }
          default:
            throw new RangeError(`unknown replay pair kind ${pair.kind}`);
        }
      }
    } finally {
      this.replayRecording = recording;
    }
  }

  /**
   * Rebuild every object's view references from the loaded view resource: the
   * saved view, loop and cel numbers are kept, and the loop/cel counts and cel
   * dimensions come from the resource (spec, block 2).
   */
  private rebindObjectViews(): void {
    for (const o of this.objects) {
      if (!o.active && o.view === 0) continue;
      const view =
        this.views.get(o.view) ??
        (this.container.getResource("view", o.view) ? this.loadView(o.view) : null);
      if (!view) continue;
      if (o.loop >= view.loops.length) o.loop = 0;
      const loop = view.loops[o.loop];
      if (loop && o.cel >= loop.cels.length) o.cel = 0;
      this.updateCelSize(o);
    }
  }

  /**
   * The game's decoded inventory metadata: the runtime payload that becomes
   * save block 3, its three-byte entry count, and the drawable-object record
   * count block 2 uses (maximum object index plus one).
   */
  private inventoryMetadata(): { payload: Uint8Array; entryCount: number; objectRecords: number } {
    if (this.inventoryMetaCache) return this.inventoryMetaCache;
    const decoded = this.decodedInventoryFile();
    if (!decoded) {
      return (this.inventoryMetaCache = {
        payload: new Uint8Array(0),
        entryCount: 0,
        // Without metadata the profile's own record count applies.
        objectRecords: 21,
      });
    }
    const tableSize = decoded[0]! | (decoded[1]! << 8);
    return (this.inventoryMetaCache = {
      payload: decoded.subarray(3),
      entryCount: Math.floor(tableSize / 3),
      objectRecords: decoded[2]! + 1,
    });
  }

  /** The OBJECT metadata file, decoded per the profile's storage rule. */
  private decodedInventoryFile(): Uint8Array | null {
    const payload = this.container.files.get("OBJECT");
    if (!payload || payload.length < 3) return null;
    return decodeInventoryFile(payload, this.profile);
  }

  /** Initial inventory locations from the game metadata (boot and restart). */
  private initInventory(): void {
    this.itemLocations.fill(0);
    const meta = this.inventoryMetadata();
    for (let item = 0; item < meta.entryCount; item++) {
      this.itemLocations[item] = meta.payload[item * 3 + 2] ?? 0;
    }
  }

  /** Legacy host stop notification; completion normally comes from soundTick. */
  soundDone(): void {
    this.stopSound();
  }

  /** Stop the active sound before the host changes audio devices. */
  stopSoundPlayback(): void {
    this.stopSound();
  }

  /** Advance the script-visible clock (v11..v14) from injected elapsed time. */
  advanceClock(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0)
      throw new RangeError("Elapsed game time must be finite and nonnegative.");
    if (this.terminated) return;
    const modal = this.modal;
    if (modal !== null) {
      if (modal.kind === "print" && modal.remainingMs !== null) {
        modal.remainingMs -= milliseconds;
        if (modal.remainingMs <= 1e-7) this.closeModal();
      }
      return;
    }
    if (this.pendingLogic !== null) this.clockWaitMs += milliseconds;
    const elapsed = this.clockRemainderMs + milliseconds;
    let seconds = Math.floor((elapsed + 1e-7) / 1000);
    this.clockRemainderMs = Math.max(0, elapsed - seconds * 1000);
    while (seconds-- > 0) {
      this.vars[11] = this.vars[11]! + 1;
      if (this.vars[11] !== 60) continue;
      this.vars[11] = 0;
      this.vars[12] = this.vars[12]! + 1;
      if (this.vars[12] !== 60) continue;
      this.vars[12] = 0;
      this.vars[13] = this.vars[13]! + 1;
      if (this.vars[13] !== 24) continue;
      this.vars[13] = 0;
      this.vars[14] = this.vars[14]! + 1;
    }
  }

  /** Advance one independent 60Hz sound tick, including during modal waits. */
  soundTick(): void {
    if (!this.soundPlayback) return;
    const tick = this.soundPlayback.tick(
      this.flags[F_SOUND_ENABLED] !== 0,
      this.host.soundAttenuation?.() ?? this.vars[23]!,
    );
    for (const output of tick.outputs) this.host.soundOutput?.(output);
    if (tick.complete) this.stopSound();
  }

  private loadSound(num: number): void {
    if (this.sounds.has(num)) return;
    const payload = this.container.getResource("sound", num);
    if (!payload) throw new Error(`sound resource ${num} not in container`);
    this.sounds.set(num, payload);
  }

  /** stop.sound state teardown, shared with pause (spec: pause stops sound). */
  private stopSound(): void {
    if (this.playingSound === null) return;
    for (const output of this.soundPlayback?.stop() ?? []) this.host.soundOutput?.(output);
    if (this.soundDoneFlag !== null) this.flags[this.soundDoneFlag] = 1;
    this.playingSound = null;
    this.soundDoneFlag = null;
    this.soundPlayback = null;
    this.host.stopSound?.();
  }

  /**
   * add.to.pic: draw the selected loaded cel into the persistent picture
   * surface at (x, baseline y) with the given priority, then — classic
   * control/margin semantics — stamp control color `margin` along the cel's
   * baseline row when margin is 0..3. The bytecode entry points record a
   * four-pair transient-cel packet so restore can reproduce the draw; replay
   * calls this one directly, with recording already disabled.
   */
  private addToPic(
    viewNum: number,
    loop: number,
    cel: number,
    x: number,
    y: number,
    priority: number,
    margin: number,
  ): void {
    const view = this.loadView(viewNum);
    const c = selectViewCel(view, loop, cel);
    if (!c) throw new Error(`view ${viewNum} loop ${loop} cel ${cel} out of range`);
    // The cel paints into the picture for good, text included, but only where
    // its opaque pixels land and the priority screen lets them (the demo
    // pack's menu paints rows 0..9 black, then add.to.pic's its cards on top).
    const covered = new Set<number>();
    drawCel(this.surface, c, x, y, {
      priority,
      onPixel: (pixel) => {
        const cell = this.textCellUnder(pixel);
        if (cell >= 0) covered.add(cell);
      },
    });
    this.text.dropCells(covered);
    if (margin < 4 && y >= 0 && y < SCREEN_HEIGHT) {
      const from = Math.max(0, x);
      const to = Math.min(SCREEN_WIDTH, x + c.width);
      for (let dx = from; dx < to; dx++) this.surface.priority[y * SCREEN_WIDTH + dx] = margin;
    }
  }

  /**
   * Text and graphics share one screen in the interpreters. Erasing or
   * redrawing a cel restores the pixels saved when it was drawn, so text
   * written over the cel since then is gone; text older than the draw was
   * saved with the background and stays (hideTextUnderSprites hides it
   * meanwhile). Text lives in its own cell layer here: drop the cells under
   * the cel's rectangle written after its last draw, then stamp the draw. A
   * Mother Goose demonstration relies on this when it redraws its speech
   * bubble over stale words.
   */
  private restoreBehind(o: ScreenObject): void {
    // The rectangle the interpreter restores is the one it saved at the draw,
    // not where the object stands now: position and reposition move x/y
    // before the erase that follows them.
    const drawn = o.drawnWidth > 0;
    const x = drawn ? o.drawnX : o.x;
    const y = drawn ? o.drawnY : o.y;
    const width = drawn ? o.drawnWidth : o.width;
    const height = drawn ? o.drawnHeight : o.height;
    this.text.coverPicture(x, y - height + 1, x + width - 1, y, this.displayBaseRow, o.drawSeq);
  }

  /** Record what the cel covers from this draw on: text written later lies on top of it. */
  private stampDraw(o: ScreenObject): void {
    o.drawSeq = this.text.seq;
    o.drawnX = o.x;
    o.drawnY = o.y;
    o.drawnWidth = o.width;
    o.drawnHeight = o.height;
  }

  /** Text cell index under a picture pixel index, or -1 below the text rows. */
  private textCellUnder(pixel: number): number {
    const row = this.displayBaseRow + (((pixel / SCREEN_WIDTH) | 0) >> 3);
    if (row >= TEXT_ROWS) return -1;
    return row * TEXT_COLS + ((pixel % SCREEN_WIDTH) >> 2);
  }

  /**
   * A drawn cel hides the text under the pixels it paints; the interpreter
   * saved that text with the background, so it shows again when the cel moves
   * on or is erased. Text written after the draw lies on top and stays
   * visible. This shapes the cells a host presents; the cells themselves are
   * untouched.
   */
  private hideTextUnderSprites(
    ownership: Uint16Array | null,
    sprites: readonly ScreenObject[],
  ): Uint8Array {
    const cells = this.text.cells;
    if (!ownership) return cells;
    let out: Uint8Array | null = null;
    for (let pixel = 0; pixel < ownership.length; pixel++) {
      const owner = ownership[pixel]!;
      if (owner === 0) continue;
      const index = this.textCellUnder(pixel);
      if (
        index < 0 ||
        cells[index * 2] === 0 ||
        this.text.written[index]! > sprites[owner - 1]!.drawSeq
      )
        continue;
      out ??= cells.slice();
      out[index * 2] = 0;
      out[index * 2 + 1] = 0;
    }
    return out ?? cells;
  }

  /**
   * Inventory item display names from the OBJECT metadata file (spec
   * "Inventory metadata file"): XOR "Avis Durgan", u16le table size, u8 max
   * object index, then (nameOffset u16le, location u8) entries with a
   * zero-terminated name pool. Empty when the game has no OBJECT file.
   */
  private itemNames(): readonly string[] {
    if (this.itemNameCache) return this.itemNameCache;
    const decoded = this.decodedInventoryFile();
    if (!decoded) return (this.itemNameCache = []);
    const tableSize = decoded[0]! | (decoded[1]! << 8);
    const base = 3; // runtime_inventory_data starts after the 3-byte header
    const names: string[] = [];
    const decoder = new TextDecoder();
    for (let at = base; at + 3 <= base + tableSize && at + 3 <= decoded.length; at += 3) {
      const rel = decoded[at]! | (decoded[at + 1]! << 8);
      let end = base + rel;
      while (end < decoded.length && decoded[end] !== 0) end++;
      names.push(decoder.decode(decoded.subarray(base + rel, end)));
    }
    return (this.itemNameCache = names);
  }

  /** One synchronous interpreter cycle (spec: top-level cycle order). */
  tick(): void {
    this.remainingInstructions = this.instructionBudget;
    this.backwardJumps = 0;
    this.clockReadLogic = -1;
    this.clockReadPc = -1;
    if (this.terminated) return;
    // Modal windows pause the interpreter; keys drive the modal instead.
    if (this.modal) {
      for (const key of this.host.takeKeys()) {
        const normalized =
          key === 0x0101 || key === 0x0301
            ? KEY_ENTER
            : key === 0x0201 || key === 0x0401
              ? KEY_ESC
              : key;
        // Modal Enter/Escape are raw controls, even when a script binds them.
        const raw = normalized & 0xff ? normalized & 0xff : normalized & 0xffff;
        const navigation = NAV_KEYS[raw];
        this.inputQueue.enqueue({
          type: navigation === undefined ? 1 : 2,
          value: navigation ?? raw,
          mapOnConsume: true,
        });
      }
      while (this.modal) {
        const event = this.inputQueue.dequeue();
        if (!event) break;
        if (event.type === 2) this.modalNavigate(event.value);
        else if (event.type === 1) this.modalKey(event.value);
      }
      // Keep unread modal keys raw: the continuation may open another modal.
      if (this.modal || this.pendingLogic === null) return;
    }
    if (this.printsPending > 0) return;
    if (this.pendingLogic === null) {
      // The timer tick accumulator serialized as the save's tick count.
      this.timerTicks = (this.timerTicks + 1) >>> 0;
      // 2. Clear transient mapped events, f2, f4.
      this.controllers.fill(0);
      this.flags[F_INPUT_READY] = 0;
      this.flags[F_SAID_MATCHED] = 0;

      // 3. Input phase: clear v19/v9, consume pending input, then any
      // requested modal menu interaction.
      this.vars[V_KEY] = 0;
      this.vars[V_WORDS] = 0;
      this.haveKeyPolls = 0;
      if (this.pendingController !== null) {
        this.inputQueue.enqueue({ type: 3, value: this.pendingController });
        this.pendingController = null;
      }
      for (const key of this.host.takeKeys()) this.inputQueue.enqueueKey(key, this.keymap);
      for (let event = this.inputQueue.dequeue(); event; event = this.inputQueue.dequeue()) {
        if (event.type === 2)
          this.vars[V_EGO_DIR] = this.vars[V_EGO_DIR] === event.value ? 0 : event.value;
        else if (event.type === 3) this.controllers[event.value] = 1;
        else {
          const mapped = event.mapOnConsume ? this.keymap.get(event.value) : undefined;
          if (mapped !== undefined) this.controllers[mapped] = 1;
          else this.handleKey(event.value);
        }
      }
      const line = this.host.takeInputLine();
      if (line !== null && this.inputAccepted) this.acceptLine(line);
      if (this.menuRequested) {
        this.menuRequested = false;
        if (this.openMenu()) return;
      }

      // Autonomous direction and rectangle transitions are visible to this
      // cycle's logic; they do not move the objects yet.
      for (const obj of this.objects) {
        if (!obj.active || !obj.update || obj.earlierPartition) continue;
        if (obj.stepCount === 1) this.updateMotion(obj);
        if (obj.direction !== 0 && obj.observeBlocks && this.blockRect) {
          const [dx, dy] = directionDelta(obj.direction);
          const rect = this.blockRect;
          const inside =
            obj.x > rect.left && obj.x < rect.right && obj.y > rect.top && obj.y < rect.bottom;
          const x = obj.x + dx * obj.stepSize;
          const y = obj.y + dy * obj.stepSize;
          const nextInside = x > rect.left && x < rect.right && y > rect.top && y < rect.bottom;
          if (inside !== nextInside) {
            obj.direction = 0;
            if (obj === this.objects[0]) this.vars[V_EGO_DIR] = 0;
          }
        }
      }
      if (this.directionCoupling === 0) this.vars[V_EGO_DIR] = this.objects[0]!.direction;
      else this.objects[0]!.direction = this.vars[V_EGO_DIR]!;
      this.cycleStatusScore = this.vars[V_SCORE]!;
      this.cycleStatusSound = this.flags[F_SOUND_ENABLED]!;
    }

    // 6. Execute logic 0 (with re-entry on restart-style requests).
    for (;;) {
      try {
        if (this.pendingLogic !== null) {
          const frames = this.pendingLogic;
          this.pendingLogic = null;
          this.runLogicStack(frames);
        } else {
          this.clockWaitMs = 0;
          this.execute(0);
        }
        if (this.pendingLogic !== null) return;
        break;
      } catch (rc) {
        if (rc instanceof RoomChange) {
          this.finishRoomChange(rc.room);
          // agi-re "Top-level cycle order" refreshes remembered v3 only on reentry;
          // retain the pre-logic f9 comparison so sound changes still redraw at the tail.
          this.cycleStatusScore = this.vars[V_SCORE]!;
          this.controllers.fill(0);
          this.vars[V_KEY] = 0;
          continue; // next top-level pass begins with logic 0
        }
        // Restore and accepted restart abort the continuation without a
        // destination. The rest of this cycle is abandoned too: the state the
        // action established (f6 after restart, the replayed screen and
        // refreshed presentation after restore) must survive into the next
        // top-level pass rather than be cleared by this cycle's tail.
        if (rc instanceof ContinuationAbort) return;
        throw rc;
      }
    }

    // 8. Only score/sound changes redraw status; games can use the other cells.
    this.objects[0]!.direction = this.vars[V_EGO_DIR]!;
    if (
      this.statusEnabled &&
      (this.statusRefreshRequested ||
        this.vars[V_SCORE] !== this.cycleStatusScore ||
        this.flags[F_SOUND_ENABLED] !== this.cycleStatusSound)
    ) {
      if (!this.modal) this.drawStatus(); // a modal opened this cycle owns the surface
    }

    // 9. Clear object event bytes and cycle flags.
    this.vars[V_OBJ_HIT] = 0;
    this.vars[V_OBJ_EDGE] = 0;
    this.flags[F_NEW_ROOM] = 0;
    this.flags[F_RESTART] = 0;
    this.flags[F_SCRIPT_0] = 0;
    // 10. Post-logic object update (movement + cycling).
    if (!this.textMode) {
      // An open text window never suspends this update.
      // docs/fidelity.md: window-update-gate
      this.updateObjects();
      this.updateEgoVisibility();
    }
  }

  /**
   * Targeted motion on object 0 selects object-to-v6 coupling (program
   * control) until it completes, and completion or a border stop restores
   * v6-to-object coupling with v6 cleared. The spec's movement chapter is
   * silent on this; game scripts rely on it: a zero-distance move.obj on ego
   * is the idiom that hands control back after a scripted placement.
   * docs/fidelity.md: ego-direction-coupling
   */
  private startMoveObj(o: ScreenObject, x: number, y: number, step: number, flag: number): void {
    o.motionMode = MOTION_MOVE_OBJ;
    o.moveTarget = { x, y, savedStep: o.stepSize, flag };
    if (step !== 0) o.stepSize = step;
    this.flags[flag] = 0;
    if (o === this.objects[0]) this.directionCoupling = 0;
    if (!this.profile.targetMotionDeferred) this.updateMotion(o);
    if (o === this.objects[0]) this.vars[V_EGO_DIR] = o.direction;
  }

  private updateObjects(): void {
    // The movement pass starts by clearing the border bytes v2, v4 and v5, so a
    // border contact is visible to logic for exactly one cycle.
    // docs/fidelity.md: border-variables-cleared
    this.vars[V_EDGE] = 0;
    this.vars[V_OBJ_HIT] = 0;
    this.vars[V_OBJ_EDGE] = 0;
    for (const obj of this.objects) {
      if (!obj.active || !obj.update || obj.earlierPartition) continue;
      // Every updating cel is erased and redrawn each pass, which repaints
      // whatever text was written over it since its last draw; the redraw at
      // the pass's end is what later erases restore.
      this.restoreBehind(obj);
      if (this.profile.directionLoopTiming === "every-pass" || obj.stepCount === 1)
        this.selectLoop(obj);
      this.updateCycle(obj);
      if (obj.stepCount === 0 || --obj.stepCount === 0) {
        obj.stepCount = obj.stepTime;
        const previousX = obj.x;
        const previousY = obj.y;
        this.moveObject(obj, obj.newlyPositioned ? 0 : obj.stepSize);
        obj.stationary = obj.x === previousX && obj.y === previousY;
        obj.newlyPositioned = false;
      }
      this.stampDraw(obj);
    }
  }

  private updateMotion(obj: ScreenObject): void {
    switch (obj.motionMode) {
      case MOTION_MOVE_OBJ: {
        const t = obj.moveTarget!;
        const step = obj.stepSize;
        const dx = t.x - obj.x;
        const dy = t.y - obj.y;
        // Completion: both signed deltas strictly within (-step, +step).
        if (dx > -step && dx < step && dy > -step && dy < step) {
          obj.motionMode = MOTION_NORMAL;
          obj.moveTarget = null;
          obj.direction = 0;
          obj.stepSize = t.savedStep;
          this.flags[t.flag] = 1;
          this.releaseEgoMotion(obj);
          return;
        }
        obj.direction = directionToward(dx, dy, step);
        if (obj === this.objects[0]) this.vars[V_EGO_DIR] = obj.direction;
        return;
      }
      case MOTION_FOLLOW: {
        const f = obj.follow!;
        const ego = this.objects[0]!;
        const dx = ego.x + Math.floor(ego.width / 2) - obj.x - Math.floor(obj.width / 2);
        const dy = ego.y - obj.y;
        const direct = directionToward(dx, dy, f.threshold);
        if (direct === 0) {
          obj.motionMode = MOTION_NORMAL;
          obj.follow = null;
          obj.direction = 0;
          this.flags[f.flag] = 1;
          return;
        }
        if (f.retryDelay === 255) {
          f.retryDelay = 0;
          obj.direction = direct;
        } else if (obj.stationary) {
          do {
            obj.direction =
              ((this.host.randomWord?.() ?? Math.floor(Math.random() * 65536)) & 0xffff) % 9;
          } while (obj.direction === 0);
          const distance = Math.floor((Math.abs(dx) + Math.abs(dy)) / 2) + 1;
          if (distance <= obj.stepSize) f.retryDelay = obj.stepSize;
          else {
            do {
              f.retryDelay =
                ((this.host.randomWord?.() ?? Math.floor(Math.random() * 65536)) & 0xffff) %
                distance;
            } while (f.retryDelay < obj.stepSize);
          }
        } else if (f.retryDelay !== 0) {
          const delay = (f.retryDelay - obj.stepSize) & 0xff;
          f.retryDelay = delay < 0x80 ? delay : 0;
        } else obj.direction = direct;
        if (obj === this.objects[0]) this.vars[V_EGO_DIR] = obj.direction;
        return;
      }
      case MOTION_WANDER: {
        const previousCount = obj.wanderCount;
        obj.wanderCount = (previousCount - 1) & 0xff;
        if (previousCount === 0 || obj.stationary) {
          obj.direction =
            ((this.host.randomWord?.() ?? Math.floor(Math.random() * 65536)) & 0xffff) % 9;
          do {
            obj.wanderCount =
              ((this.host.randomWord?.() ?? Math.floor(Math.random() * 65536)) & 0xffff) % 51;
          } while (obj.wanderCount < 6);
        }
        if (obj === this.objects[0]) this.vars[V_EGO_DIR] = obj.direction;
        return;
      }
    }
  }

  private moveObject(obj: ScreenObject, step: number): void {
    const [dx, dy] = directionDelta(obj.direction);
    let nx = obj.x + dx * step;
    let ny = obj.y + dy * step;

    // Screen boundaries (spec: movement proposal), each with its code.
    let boundary = 0;
    if (ny < obj.height - 1) {
      ny = obj.height - 1;
      boundary = 1;
    }
    if (obj.observeHorizon && ny <= this.horizon) {
      ny = this.horizon + 1;
      boundary = 1;
    }
    if (nx > 160 - obj.width) {
      nx = 160 - obj.width;
      boundary = 2;
    }
    if (ny > 167) {
      ny = 167;
      boundary = 3;
    }
    if (nx < 0 || (nx === 0 && this.profile.clampExactZeroLeftBoundary)) {
      nx = 0;
      boundary = 4;
    }

    if (this.collides(obj, nx, ny) || !this.footprintAccepts(obj, nx, ny)) {
      this.placeObject(obj);
      return;
    }

    obj.prevX = obj.x;
    obj.prevY = obj.y;
    obj.x = nx;
    obj.y = ny;
    if (!obj.fixedPriority) obj.priority = this.priorityForY(ny);
    if (boundary !== 0) {
      if (obj === this.objects[0]) {
        this.vars[V_EDGE] = boundary;
      } else {
        this.vars[V_OBJ_HIT] = this.objects.indexOf(obj);
        this.vars[V_OBJ_EDGE] = boundary;
      }
      if (obj.motionMode === MOTION_MOVE_OBJ && obj.moveTarget) {
        obj.stepSize = obj.moveTarget.savedStep;
        this.flags[obj.moveTarget.flag] = 1;
        obj.moveTarget = null;
        obj.motionMode = MOTION_NORMAL;
        obj.direction = 0;
        this.releaseEgoMotion(obj);
      }
    }
  }

  /** A completed or border-stopped targeted move of object 0 hands control back (see startMoveObj). */
  private releaseEgoMotion(obj: ScreenObject): void {
    if (obj !== this.objects[0]) return;
    this.vars[V_EGO_DIR] = 0;
    this.directionCoupling = 1;
  }

  /** First geometrically valid, collision-free footprint in the specified spiral. */
  private placeObject(obj: ScreenObject): void {
    let x = obj.x;
    let y = obj.observeHorizon ? Math.max(obj.y, this.horizon + 1) : obj.y;
    const originX = x;
    const originY = y;
    let leg = 1;
    let remaining = 1;
    let direction = 0;
    const deltas = [
      [-1, 0],
      [0, 1],
      [1, 0],
      [0, -1],
    ] as const;
    // The furthest legal point is inside this square. Valid game state
    // supplies an acceptable candidate; an impossible room fails explicitly.
    const radius =
      Math.max(
        Math.abs(originX),
        Math.abs(originX - 159),
        Math.abs(originY),
        Math.abs(originY - 167),
      ) + 1;
    const limit = (radius * 2 + 1) ** 2;
    for (let i = 0; i < limit; i++) {
      if (
        x >= 0 &&
        x + obj.width <= SCREEN_WIDTH &&
        y >= obj.height - 1 &&
        y < SCREEN_HEIGHT &&
        (!obj.observeHorizon || y > this.horizon) &&
        !this.collides(obj, x, y) &&
        this.footprintAccepts(obj, x, y)
      ) {
        obj.x = x;
        obj.y = y;
        return;
      }
      x += deltas[direction]![0];
      y += deltas[direction]![1];
      if (--remaining === 0) {
        direction = (direction + 1) % 4;
        if (direction === 0 || direction === 2) leg++;
        remaining = leg;
      }
    }
    throw new Error("no acceptable position for object");
  }

  /**
   * Footprint control acceptance: scan the priority/control cells along the
   * baseline for exactly the cel width, left to right. Control 0 rejects;
   * control 1 rejects unless ignore.blocks. The two class flags are:
   *
   * - trigger (f3): set when ANY scanned cell is control 2, never cleared by a
   *   later cell;
   * - water (f0): set only when EVERY scanned cell is control 3.
   *
   * The spec's "Footprint control acceptance" states a final-cell rule for
   * both classes; the shipped interpreters and observed game data disagree.
   * Priority 15 skips the scan, accepts the footprint, and for object 0
   * clears both flags, as the same routine does.
   * docs/fidelity.md: footprint-class-flags
   */
  private footprintAccepts(obj: ScreenObject, nx: number, ny: number): boolean {
    if (!obj.fixedPriority) obj.priority = this.priorityForY(ny);
    if (obj.priority === 15) {
      if (obj === this.objects[0]) {
        this.flags[3] = 0;
        this.flags[0] = 0;
      }
      return true;
    }
    if (ny < 0 || ny > 167) return false;
    let flag3 = false;
    let flag0 = true;
    for (let i = 0; i < obj.width; i++) {
      const cx = nx + i;
      if (cx < 0 || cx > 159) continue;
      const v = this.surface.priority[ny * 160 + cx] ?? 4;
      if (v === 0) return false;
      if (v === 3) continue;
      flag0 = false;
      if (v === 1 && obj.observeBlocks) return false;
      if (v === 2) flag3 = true;
    }
    if (obj.waterGate === "on" && !flag0) return false; // obj.on.water: every cell is control 3
    if (obj.waterGate === "off" && flag0) return false; // obj.on.land: not every cell is control 3
    if (obj === this.objects[0]) {
      this.flags[3] = flag3 ? 1 : 0;
      this.flags[0] = flag0 ? 1 : 0;
    }
    return true;
  }

  /** Object-object collision (spec): horizontal span overlap + baseline crossing. */
  private collides(obj: ScreenObject, nx: number, ny: number): boolean {
    if (!obj.observeObjects) return false;
    for (const other of this.objects) {
      if (other === obj || !other.active || !other.update || !other.observeObjects) continue;
      const overlap = !(nx + obj.width < other.x || nx > other.x + other.width);
      if (!overlap) continue;
      const equalBaseline = ny === other.y;
      const crossedDown = ny > other.y && obj.prevY < other.prevY;
      const crossedUp = ny < other.y && obj.prevY > other.prevY;
      if (equalBaseline || crossedDown || crossedUp) return true;
    }
    return false;
  }

  /**
   * Automatic direction-based loop selection (spec tables). Which loop counts
   * use the four-direction table is a profile variant: the early profiles and
   * 2.917 use it for exactly four loops, 2.936/3.002.086 for four or more, and
   * 3.002.102/3.002.149 for four or more only while f20 is set above four.
   */
  private selectLoop(obj: ScreenObject): void {
    if (obj.loopFixed || obj.direction === 0) return;
    const view = this.views.get(obj.view);
    if (!view) return;
    const loops = view.loops.length;
    const d = obj.direction;
    let target = -1;
    if (loops === 2 || loops === 3) {
      if (d >= 2 && d <= 4) target = 0;
      else if (d >= 6 && d <= 8) target = 1;
    } else if (loops === 4 || (loops > 4 && this.fourLoopTableApplies())) {
      if (d >= 2 && d <= 4) target = 0;
      else if (d >= 6 && d <= 8) target = 1;
      else if (d === 5) target = 2;
      else if (d === 1) target = 3;
    }
    if (target >= 0 && target < loops && target !== obj.loop) this.setLoop(obj, target);
  }

  /**
   * View binding: the object keeps its current loop when the new view has
   * that many loops and otherwise takes loop 0, then selects the loop through
   * setLoop. The spec's "set.view" text reads "select its default loop and
   * cel"; the interpreters only fall back to the defaults when the kept
   * indices are out of range. docs/fidelity.md: view-loop-index-retention
   */
  private setView(obj: ScreenObject, view: number): void {
    obj.view = view;
    const loops = this.views.get(view)?.loops.length ?? 0;
    this.setLoop(obj, obj.loop < loops ? obj.loop : 0);
  }

  /**
   * Loop selection: set.loop, set.loop.v, set.view and the direction-driven
   * loop change all route here. The current cel survives when the new loop
   * has that many cels and otherwise becomes 0; SetCel then refreshes the
   * size. Manhunter's knife game (logic 118) depends on the survival: while
   * it waits for the barker's cel to cycle it re-selects loop 0 every cycle,
   * which a reset-to-0 would freeze forever.
   * docs/fidelity.md: view-loop-index-retention
   */
  private setLoop(obj: ScreenObject, loop: number): void {
    obj.loop = loop;
    if (obj.cel >= this.celCount(obj)) obj.cel = 0;
    this.updateCelSize(obj);
  }

  /** Whether a view with MORE than four loops receives direction-based selection. */
  private fourLoopTableApplies(): boolean {
    switch (this.profile.directionLoops) {
      case "four-or-more":
        return true;
      case "four-or-more-f20":
        return this.flags[F_DIR_LOOP_GATE] !== 0;
      default:
        return false;
    }
  }

  private updateCelSize(obj: ScreenObject): void {
    const view = this.views.get(obj.view);
    const cel = view && selectViewCel(view, obj.loop, obj.cel);
    if (cel) {
      obj.width = cel.width;
      obj.height = cel.height;
    }
  }

  private updateCycle(obj: ScreenObject): void {
    if (!obj.cycling) return;
    if (obj.cycleCount > 0) {
      obj.cycleCount--;
      if (obj.cycleCount !== 0) return;
    }
    obj.cycleCount = obj.cycleTime;
    if (obj.cycleDelay) {
      obj.cycleDelay = false;
      return;
    }
    const count = this.celCount(obj);
    switch (obj.cycleMode) {
      case CYCLE_FORWARD:
        obj.cel = (obj.cel + 1) % count;
        break;
      case CYCLE_REVERSE:
        obj.cel = (obj.cel - 1 + count) % count;
        break;
      case CYCLE_END_OF_LOOP:
        obj.cel = Math.min(count - 1, obj.cel + 1);
        if (obj.cel === count - 1) this.completeLoop(obj);
        break;
      case CYCLE_REVERSE_LOOP:
        obj.cel = Math.max(0, obj.cel - 1);
        if (obj.cel === 0) this.completeLoop(obj);
        break;
    }
    this.updateCelSize(obj);
  }

  private completeLoop(obj: ScreenObject): void {
    if (obj.cycleFlag !== null) this.flags[obj.cycleFlag] = 1;
    obj.cycleFlag = null;
    obj.cycling = false;
    obj.direction = 0;
    obj.cycleMode = CYCLE_FORWARD;
  }

  private finishRoomChange(room: number): void {
    // Spec room-switch sequence (already partly applied at the action site):
    // entry-boundary placement from v2, then clear it.
    const ego = this.objects[0]!;
    switch (this.vars[V_EDGE]) {
      case 1:
        ego.y = 167;
        break;
      case 2:
        ego.x = 0;
        break;
      case 3:
        ego.y = 37;
        break;
      case 4:
        ego.x = SCREEN_WIDTH - ego.width;
        break;
    }
    this.vars[V_EDGE] = 0;
    this.flags[F_NEW_ROOM] = 1;
    this.controllers.fill(0);
    this.vars[V_KEY] = 0;
    this.flags[F_INPUT_READY] = 0;
    this.flags[F_SAID_MATCHED] = 0;
    // Spec room switch: refresh normal status/input display state.
    if (!this.textMode) {
      this.text.clear();
      this.persistentWindow = null;
      this.drawStatus();
      this.drawInputRow();
    }
    this.host.clearText?.();
    void room;
  }

  /**
   * Composite the presentable frame: picture surface plus active objects
   * drawn in baseline order (classic painter's algorithm by priority).
   * Returns fresh copies — the worker transfers these to the renderer.
   */
  getFrame(): { visual: Uint8Array; priority: Uint8Array } {
    return this.composeFrame(false).frame;
  }

  /** Pixels and text from one completed composition; buffers may be transferred by the host. */
  getPresentation(): { visual: Uint8Array; priority: Uint8Array; text: Uint8Array } {
    const { frame, ownership, sprites } = this.composeFrame(!this.textMode);
    // Only the final owner of a pixel can obscure text. Intermediate paints
    // may themselves be covered by another sprite in the same pass.
    const text = this.mergeTraceText(this.hideTextUnderSprites(ownership, sprites)).slice();
    return { ...frame, text };
  }

  /** f1 is engine state, updated when sprites draw rather than when a host asks for pixels. */
  private updateEgoVisibility(): void {
    if (this.objects[0]!.active) this.flags[1] = this.composeFrame(true).egoVisible ? 0 : 1;
  }

  private composeFrame(trackOwnership: boolean): {
    frame: { visual: Uint8Array; priority: Uint8Array };
    egoVisible: boolean;
    ownership: Uint16Array | null;
    sprites: ScreenObject[];
  } {
    const visual = this.surface.visual.slice();
    const priority = this.surface.priority.slice();
    const ownership = trackOwnership ? new Uint16Array(visual.length) : null;
    const frame: PictureSurface = { visual, priority, reset(): void {} };
    // Stable sorting retains object-number order for equal drawing keys.
    // Positive fixed priorities sort after every baseline in the table mode.
    const active = this.objects
      .filter((o) => o.active)
      .sort((a, b) => {
        if (a.earlierPartition !== b.earlierPartition) return a.earlierPartition ? -1 : 1;
        if (a.earlierPartition && this.profile.earlierPartitionOrder === "object-number") return 0;
        const aKey = a.fixedPriority ? (a.priority === 0 ? -1 : SCREEN_HEIGHT) : a.y;
        const bKey = b.fixedPriority ? (b.priority === 0 ? -1 : SCREEN_HEIGHT) : b.y;
        return aKey - bKey;
      });
    for (const [slot, o] of active.entries()) {
      const view = this.views.get(o.view);
      const cel = view && readViewCel(view, o.loop, o.cel);
      if (!cel) continue;
      const pri = o.fixedPriority ? o.priority : this.priorityForY(o.y);
      drawCel(frame, cel, o.x, o.y, {
        priority: pri,
        ...(ownership
          ? {
              onPixel: (index: number) => {
                ownership[index] = slot + 1;
              },
            }
          : {}),
      });
    }
    const egoSlot = active.indexOf(this.objects[0]!);
    const egoVisible = egoSlot >= 0 && (ownership?.includes(egoSlot + 1) ?? false);
    if (this.modal?.kind === "showObj") {
      // show.obj preview: the view's first cel, bottom centre of the picture.
      const view = this.views.get(this.modal.view);
      const cel = view && readViewCel(view, 0, 0);
      if (cel)
        drawCel(frame, cel, (SCREEN_WIDTH - cel.width) >> 1, SCREEN_HEIGHT - 1, { priority: 15 });
    }
    if (this.modal?.kind === "showPri")
      return {
        frame: { visual: priority.slice(), priority },
        egoVisible,
        ownership,
        sprites: active,
      };
    return { frame: { visual, priority }, egoVisible, ownership, sprites: active };
  }

  /** Baseline priority bands (spec "Priority and horizon" and set.pri.base). */
  private priorityForY(y: number): number {
    if (y < this.priorityBase) return 4;
    return Math.min(15, 5 + Math.floor(((y - this.priorityBase) * 10) / (168 - this.priorityBase)));
  }

  // ---------- parser ----------

  private parseInput(line: string): void {
    this.lastInputLine = line;
    this.parserCount = 0;
    // Spec "Parser normalization": space and , . ? ! ( ) ; : [ ] { } separate;
    // apostrophe, backtick, hyphen and double quote drop WITHOUT separating
    // ("don't" is one token); separator runs collapse to one space; a trailing
    // space is removed; ASCII matching ignores case. A leading separator
    // leaves an empty leading token, which is not a token at all.
    const normalized = line
      .toLowerCase()
      .replace(/['`\-"]/g, "")
      .replace(/[ ,.?!();:[\]{}]+/g, " ")
      .replace(/ $/, "");
    const words: number[] = [];
    const texts: string[] = [];
    // Spec "Parser results": id-0 words occupy no slot; the first unknown
    // token stores its text, v9 = retained count + 1, f2 set, stop parsing.
    if (normalized.length > 0 && this.dictionary) {
      let unknown = false;
      const tokens = normalized.split(" ").filter((token) => token.length > 0);
      for (let index = 0; index < tokens.length;) {
        const { text: token, id, length } = matchDictionaryPhrase(tokens, index, this.dictionary);
        index += length;
        if (id === undefined) {
          // First unknown token: v9 and the parser count take its one-based
          // position; later tokens are not parsed.
          texts.push(token);
          this.parserCount = words.length + 1;
          this.vars[V_WORDS] = this.parserCount;
          unknown = true;
          break;
        }
        if (id === 0) continue;
        if (words.length < 10) {
          words.push(id);
          texts.push(token);
        }
      }
      if (!unknown) {
        // A fully recognised line leaves v9 at zero (spec: v9 is written only
        // at an unknown token); the parser count is internal state.
        this.parserCount = words.length;
        // Only retained identifiers raise f2; an all-ignored line does not.
        if (words.length === 0) {
          this.parsedWords = words;
          this.parsedWordTexts = texts;
          return;
        }
      }
    }
    this.parsedWords = words;
    this.parsedWordTexts = texts;
    this.flags[F_INPUT_READY] = 1;
  }

  // ---------- logic execution ----------

  /** Execute until return, stream end, or a modal instruction suspends the call stack. */
  execute(logicNum: number): void {
    const resource = this.loadLogic(logicNum);
    this.runLogicStack([{ logic: logicNum, resource, pc: this.scanStart.get(logicNum) ?? 0 }]);
  }

  private runLogicStack(frames: LogicFrame[]): void {
    const caller = this.activation;
    try {
      while (frames.length > 0) {
        const frame = frames[frames.length - 1]!;
        const code = frame.resource.code;
        this.activation = { logic: frame.logic, messages: frame.resource.messages };
        if (frame.pc >= code.length) {
          frames.pop();
          continue;
        }
        this.consumeInstructionBudget();
        const pc = frame.pc;
        const op = code[pc]!;
        if (op !== IF) this.traceInstruction(code, pc);
        if (op === 0x00) {
          frames.pop();
          continue;
        }
        if (op === GOTO) {
          const target = pc + 3 + readS16(code, pc + 1);
          frame.pc = target;
          if (
            target <= pc &&
            ++this.backwardJumps >= CLOCK_WAIT_JUMPS &&
            this.clockReadLogic === frame.logic &&
            this.clockReadPc >= target &&
            this.clockReadPc < pc
          ) {
            // A clock busy-wait: resume at the loop head on the next host tick.
            if (this.clockWaitMs > CLOCK_WAIT_LIMIT_MS)
              throw new Error(
                `clock busy-wait in logic ${frame.logic} exceeded ${CLOCK_WAIT_LIMIT_MS / 1000} seconds of host time`,
              );
            this.pendingLogic = frames;
            return;
          }
          continue;
        }
        if (op === IF) {
          const { result, next } = this.evalConditionList(code, pc + 1);
          frame.pc = result ? next + 2 : next + 2 + readS16(code, next);
          continue;
        }
        if (op === 0x16 || op === 0x17) {
          const logic = op === 0x16 ? code[pc + 1]! : this.vars[code[pc + 1]!]!;
          const resource = this.loadLogic(logic);
          frame.pc = pc + 2;
          frames.push({ logic, resource, pc: this.scanStart.get(logic) ?? 0 });
          continue;
        }
        frame.pc = this.dispatchAction(code, pc);
        if (this.modal !== null) {
          this.pendingLogic = frames;
          return;
        }
      }
    } finally {
      this.activation = caller;
    }
  }

  /** Evaluate a condition list starting at `from` (just after opening 0xff). */
  private evalConditionList(code: Uint8Array, from: number): { result: boolean; next: number } {
    let pc = from;
    let negateNext = false;
    for (;;) {
      this.consumeInstructionBudget();
      const b = code[pc]!;
      if (b === IF) return { result: true, next: pc + 1 }; // all terms held
      if (b === NOT) {
        negateNext = true;
        pc++;
        continue;
      }
      if (b === OR) {
        // OR group: terms until closing 0xfc; first true term satisfies it.
        pc++;
        let satisfied = false;
        for (;;) {
          this.consumeInstructionBudget();
          const t = code[pc]!;
          if (t === OR) {
            pc++;
            break;
          }
          let neg = false;
          if (t === NOT) {
            neg = true;
            pc++;
          }
          const { result, next } = this.evalOneCondition(code, pc);
          pc = next;
          if (!satisfied && result !== neg) satisfied = true;
        }
        if (!satisfied) return this.failList(code, pc);
        continue;
      }
      const { result, next } = this.evalOneCondition(code, pc);
      pc = next;
      if (result === negateNext) return this.failList(code, pc);
      negateNext = false;
    }
  }

  /** Skip the rest of the list to locate the closing 0xff for the false jump. */
  private failList(code: Uint8Array, from: number): { result: false; next: number } {
    let pc = from;
    for (;;) {
      this.consumeInstructionBudget();
      const b = code[pc]!;
      if (b === IF) return { result: false, next: pc + 1 };
      if (b === OR || b === NOT) {
        pc++;
        continue;
      }
      pc = this.skipCondition(code, pc);
    }
  }

  private skipCondition(code: Uint8Array, pc: number): number {
    const b = code[pc]!;
    if (b === 0x0e) {
      const count = code[pc + 1]!;
      return pc + 2 + count * 2;
    }
    const spec = CONDITION_BY_CODE.get(b);
    if (!spec) throw new Error(`invalid condition byte 0x${b.toString(16)} in skip`);
    return pc + 1 + spec.operands.length;
  }

  private consumeInstructionBudget(): void {
    if (--this.remainingInstructions < 0)
      throw new Error(
        `Playtest instruction budget exceeded in logic ${this.activation?.logic ?? 0}. Check for a loop that never returns.`,
      );
  }

  private evalOneCondition(code: Uint8Array, pc: number): { result: boolean; next: number } {
    const outcome = this.evaluateCondition(code, pc);
    this.traceInstruction(code, pc, outcome.result);
    return outcome;
  }

  private traceInstruction(code: Uint8Array, pc: number, result?: boolean): void {
    if (!this.trace.active) return;
    const op = code[pc]!;
    const condition = result !== undefined;
    const spec = condition ? CONDITION_BY_CODE.get(op) : actionSpec(op, this.profile);
    // Trace dictionaries use messages 1..160 for actions, then the tests.
    const name =
      this.trace.logic === null
        ? undefined
        : this.loadLogic(this.trace.logic).messages[(condition ? 160 : 0) + op - 1];
    let args: string;
    if (condition && op === 14) {
      args = Array.from({ length: code[pc + 1]! }, (_, i) =>
        String(code[pc + 2 + i * 2]! | (code[pc + 3 + i * 2]! << 8)),
      ).join(",");
    } else {
      args = Array.from(code.subarray(pc + 1, pc + 1 + (spec?.operands.length ?? 0))).join(",");
    }
    this.trace.append(
      `${this.activation?.logic ?? 0}:${pc} ${name || op}(${args})${condition ? ` ${result}` : ""}`,
    );
  }

  private evaluateCondition(code: Uint8Array, pc: number): { result: boolean; next: number } {
    const b = code[pc]!;
    const o = (i: number) => code[pc + 1 + i]!;
    // Scalar comparisons against the clock variables mark this pass as a
    // possible clock busy-wait (see CLOCK_WAIT_JUMPS).
    if (b >= 0x01 && b <= 0x06) {
      const first = o(0);
      const second = (b & 1) === 0 ? o(1) : -1;
      if ((first >= 11 && first <= 14) || (second >= 11 && second <= 14)) {
        this.clockReadLogic = this.activation?.logic ?? -1;
        this.clockReadPc = pc;
      }
    }
    switch (b) {
      case 0x00:
        return { result: false, next: pc + 1 };
      case 0x01:
        return { result: this.vars[o(0)] === o(1), next: pc + 3 };
      case 0x02:
        return { result: this.vars[o(0)] === this.vars[o(1)], next: pc + 3 };
      case 0x03:
        return { result: this.vars[o(0)]! < o(1), next: pc + 3 };
      case 0x04:
        return { result: this.vars[o(0)]! < this.vars[o(1)]!, next: pc + 3 };
      case 0x05:
        return { result: this.vars[o(0)]! > o(1), next: pc + 3 };
      case 0x06:
        return { result: this.vars[o(0)]! > this.vars[o(1)]!, next: pc + 3 };
      case 0x07:
        return { result: this.flags[o(0)] !== 0, next: pc + 2 };
      case 0x08:
        return { result: this.flags[this.vars[o(0)]!] !== 0, next: pc + 2 };
      case 0x09:
        return { result: this.itemLocation(o(0)) === 0xff, next: pc + 2 };
      case 0x0a:
        return { result: this.itemLocation(o(0)) === this.vars[o(1)], next: pc + 3 };
      case 0x0b:
      case 0x10:
      case 0x11:
      case 0x12: {
        const obj = this.objects[o(0)]!;
        const [left, top, right, bottom] = [o(1), o(2), o(3), o(4)];
        if (!(top <= obj.y && obj.y <= bottom)) return { result: false, next: pc + 6 };
        const width = obj.width;
        const testX =
          b === 0x0b
            ? obj.x
            : b === 0x10
              ? -1
              : b === 0x11
                ? obj.x + Math.floor(width / 2)
                : obj.x + width - 1;
        const result =
          b === 0x10
            ? left <= obj.x && obj.x + width - 1 <= right
            : left <= testX && testX <= right;
        return { result, next: pc + 6 };
      }
      case 0x0c:
        return { result: this.controllers[o(0)] !== 0, next: pc + 2 };
      case 0x0d: {
        // have.key: bytecode may busy-loop on it (goto) inside one logic
        // invocation — help screens in text mode, "press any key" in graphics
        // mode. Keys pressed meanwhile are polled first. A host that offers a
        // blocking wait is used for such a loop in either mode, because a host
        // whose keys arrive by message can never deliver one while the
        // interpreter spins; the loop must first prove itself
        // (HAVE_KEY_BUSY_POLLS) so a once-per-cycle poll stays non-blocking
        // and the game keeps running. That holds in text mode too: the Space
        // Quest intro shows its captions on a text screen and polls have.key
        // once per cycle to let a key skip them. A host with no blocking wait
        // gets a synthesized Enter after a bounded number of polls so a
        // headless run never spins forever.
        if (this.vars[V_KEY] !== 0) return { result: true, next: pc + 1 };
        for (const key of this.host.takeKeys()) this.inputQueue.enqueueKey(key, this.keymap);
        let pressed = this.pollRawKey();
        const blockingWait = this.host.waitKey ?? this.host.waitTextKey;
        if (pressed === undefined) {
          if (blockingWait) {
            if (++this.haveKeyPolls > HAVE_KEY_BUSY_POLLS) {
              this.inputQueue.enqueueKey(blockingWait.call(this.host), this.keymap);
              pressed = this.pollRawKey();
            }
          } else if (++this.haveKeyPolls > HAVE_KEY_POLL_LIMIT) {
            pressed = KEY_ENTER;
          }
        }
        if (pressed !== undefined) this.vars[V_KEY] = pressed & 0xff;
        return { result: pressed !== undefined && pressed !== 0, next: pc + 1 };
      }
      case 0x0e: {
        const count = code[pc + 1]!;
        const ids: number[] = [];
        for (let i = 0; i < count; i++)
          ids.push(code[pc + 2 + i * 2]! | (code[pc + 3 + i * 2]! << 8));
        return { result: this.evalSaid(ids), next: pc + 2 + count * 2 };
      }
      case 0x0f: {
        const a = this.normalizeString(this.strings[o(0)]!);
        const b2 = this.normalizeString(this.strings[o(1)]!);
        return { result: a === b2, next: pc + 3 };
      }
      default:
        throw new Error(`invalid condition byte 0x${b.toString(16)}`);
    }
  }

  private evalSaid(pattern: number[]): boolean {
    if (this.flags[F_INPUT_READY] === 0) return false;
    // Spec: said can run only when the parser count/error position is nonzero.
    if (this.parserCount === 0) return false;
    if (this.flags[F_SAID_MATCHED] !== 0) return false;
    let wi = 0;
    for (const p of pattern) {
      if (p === 0x270f && this.profile.wordSequenceTailTerminator) {
        this.flags[F_SAID_MATCHED] = 1;
        return true;
      }
      if (wi >= this.parsedWords.length) return false;
      if (p !== 0x0001 && p !== this.parsedWords[wi]) return false;
      wi++;
    }
    // Exact match: every retained identifier consumed, and no trailing
    // unknown token (the parser count then exceeds the identifier count).
    if (wi !== this.parsedWords.length || this.parserCount !== this.parsedWords.length)
      return false;
    this.flags[F_SAID_MATCHED] = 1;
    return true;
  }

  private normalizeString(s: string): string {
    return s.toLowerCase().replace(/[ \t.,;:'!-]/g, "");
  }

  // ---------- inventory (minimal: location bytes) ----------

  private readonly itemLocations = new Uint8Array(256);

  private itemLocation(item: number): number {
    return this.itemLocations[item]!;
  }

  /**
   * display / display.v: text at a cell position with the current attribute.
   * CR and LF break to the next row, capped at row 24, and the character
   * after column 39 wraps the same way; both continue at the routine's start
   * column, which only a message window sets, so a display call resumes at
   * column 0. docs/fidelity.md: display-line-layout
   */
  private display(row: number, col: number, text: string): void {
    const a = this.textAttr();
    let r = row;
    let c = col;
    const lineBreak = (): void => {
      if (r < TEXT_ROWS - 1) r++;
      c = 0;
    };
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      if (ch === 0x0a || ch === 0x0d) {
        lineBreak();
        continue;
      }
      this.text.put(r, c, ch, a);
      if (++c > TEXT_COLS - 1) lineBreak();
    }
    this.host.displayAt(row, col, text);
  }

  // ---------- messages ----------

  private message(num: number): string {
    const messages = this.activation?.messages;
    if (!messages || num < 1 || num >= messages.length + 1) {
      throw new Error(`message ${num} out of range for current logic`);
    }
    return this.expandMessage(messages[num - 1] ?? "");
  }

  private expandMessage(text: string): string {
    return (
      text
        // AGI specs §4.2 print: %vN|width retains leading zeroes.
        // https://www.agidev.com/articles/agispec/agispecs-4.html
        .replace(/%v(\d+)(?:\|(\d+))?/g, (_, n, width: string | undefined) => {
          const value = String(this.vars[Number(n)] ?? 0);
          // Bound requested padding to one text row before allocating it.
          return width === undefined
            ? value
            : value.padStart(Math.min(TEXT_COLS, Number(width)), "0");
        })
        .replace(/%s(\d+)/g, (_, n) => this.strings[Number(n)] ?? "")
        .replace(/%m(\d+)/g, (_, n) => this.message(Number(n)))
        .replace(/%w(\d+)/g, (_, n) => this.parsedWordTexts[Number(n) - 1] ?? "")
    );
  }

  // ---------- action dispatch ----------

  private dispatchAction(code: Uint8Array, pc: number): number {
    const op = code[pc]!;
    const spec = actionSpec(op, this.profile);
    if (!spec) {
      throw new UnimplementedOpcodeError(op, "<not an action>", this.activation?.logic ?? -1, pc);
    }
    // Profile action range (spec "Main stream grammar"): bytes above the
    // profile's last action are not actions in that profile.
    if (op > this.profile.maxAction) {
      throw new UnimplementedOpcodeError(op, spec.name, this.activation?.logic ?? -1, pc);
    }
    const a = (i: number) => code[pc + 1 + i]!;
    const next = pc + 1 + spec.operands.length;
    const obj = (i: number) => this.objects[a(i)]!;

    switch (op) {
      // scalar state
      case 0x01:
        this.vars[a(0)] = Math.min(255, this.vars[a(0)]! + 1);
        return next;
      case 0x02:
        this.vars[a(0)] = Math.max(0, this.vars[a(0)]! - 1);
        return next;
      case 0x03:
        this.vars[a(0)] = a(1);
        return next;
      case 0x04:
        this.vars[a(0)] = this.vars[a(1)]!;
        return next;
      case 0x05:
        this.vars[a(0)] = (this.vars[a(0)]! + a(1)) & 0xff;
        return next;
      case 0x06:
        this.vars[a(0)] = (this.vars[a(0)]! + this.vars[a(1)]!) & 0xff;
        return next;
      case 0x07:
        this.vars[a(0)] = (this.vars[a(0)]! - a(1)) & 0xff;
        return next;
      case 0x08:
        this.vars[a(0)] = (this.vars[a(0)]! - this.vars[a(1)]!) & 0xff;
        return next;
      case 0x09:
        this.vars[this.vars[a(0)]!] = this.vars[a(1)]!;
        return next;
      case 0x0a:
        this.vars[a(0)] = this.vars[this.vars[a(1)]!]!;
        return next;
      case 0x0b:
        this.vars[this.vars[a(0)]!] = a(1);
        return next;

      // flags
      case 0x0c:
        this.flags[a(0)] = 1;
        return next;
      case 0x0d:
        this.flags[a(0)] = 0;
        return next;
      case 0x0e:
        this.flags[a(0)] = this.flags[a(0)]! ^ 1;
        return next;
      case 0x0f:
        this.flags[this.vars[a(0)]!] = 1;
        return next;
      case 0x10:
        this.flags[this.vars[a(0)]!] = 0;
        return next;
      case 0x11: {
        const f = this.vars[a(0)]!;
        this.flags[f] = this.flags[f]! ^ 1;
        return next;
      }

      // room and logic control
      // new.room / new.room.v never return: newRoom throws RoomChange.
      // new.room: the Gold Rush 3.002.149 build aliases immediate destinations
      // before the common room effects (spec); every other profile passes the
      // destination through unchanged. The variable form is never aliased.
      case 0x12:
        return this.newRoom(this.profile.roomAliases?.get(a(0)) ?? a(0));
      case 0x13:
        return this.newRoom(this.vars[a(0)]!);
      case 0x14:
        this.loadLogicRecorded(a(0));
        return next;
      case 0x15:
        this.loadLogicRecorded(this.vars[a(0)]!);
        return next;
      case 0x16:
        this.execute(a(0));
        return next;
      case 0x17:
        this.execute(this.vars[a(0)]!);
        return next;

      // picture
      case 0x18: {
        const num = this.vars[a(0)]!;
        this.loadPicture(num);
        this.record(REPLAY_LOAD_PICTURE, num);
        return next;
      }
      case 0x19: {
        const num = this.vars[a(0)]!;
        this.drawPicture(num);
        this.record(REPLAY_DRAW_PICTURE, num);
        return next;
      }
      case 0x1a: {
        this.pictureShown = true;
        if (this.profile.showPictureClearsF15) {
          this.flags[15] = 0;
          this.closeWindowOnTop();
        }
        const window = this.persistentWindow;
        const visibleWindow = window
          ? this.text.save(window.top, window.left, window.bottom, window.right)
          : null;
        // Presenting the picture repaints its band; text there is gone.
        if (!this.textMode)
          this.text.fill(this.displayBaseRow, 0, this.displayBaseRow + 20, TEXT_COLS - 1, 0, 0);
        if (visibleWindow) this.text.restore(visibleWindow);
        return next;
      }
      case 0x1b: {
        const num = this.vars[a(0)]!;
        this.discardPicture(num);
        this.record(REPLAY_DISCARD_PICTURE, num);
        return next;
      }
      case 0x1c: {
        const num = this.vars[a(0)]!;
        this.overlayPicture(num);
        this.record(REPLAY_OVERLAY_PICTURE, num);
        return next;
      }
      case 0x1d:
        this.showPriScreen();
        return next;
      case 0x1e:
        this.loadViewRecorded(a(0));
        return next;
      case 0x1f:
        this.loadViewRecorded(this.vars[a(0)]!);
        return next;
      case 0x20:
        this.discardViewRecorded(a(0));
        return next;

      // object setup
      case 0x21: {
        const o = obj(0);
        if (!o.update) {
          // animate.obj resets the state flags, not the object's scalar data.
          // Reusing a title actor must not carry fixed priority or ignored
          // boundaries into an ordinary room actor.
          o.active = false;
          o.update = true;
          o.earlierPartition = false;
          o.newlyPositioned = false;
          o.cycleDelay = false;
          o.stationary = false;
          o.cycling = true;
          o.fixedPriority = false;
          o.observeHorizon = true;
          o.observeBlocks = true;
          o.observeObjects = true;
          o.loopFixed = false;
          o.waterGate = null;
          o.direction = 0;
          o.motionMode = MOTION_NORMAL;
          o.cycleMode = CYCLE_FORWARD;
        }
        return next;
      }
      case 0x22:
        this.unanimateAll();
        return next;
      case 0x23: {
        const o = obj(0);
        if (o.active) return next;
        const view = this.views.get(o.view);
        if (!view || !readViewCel(view, o.loop, o.cel))
          throw new Error("draw requires a selected cel");
        this.placeObject(o);
        o.prevX = o.x;
        o.prevY = o.y;
        o.active = true;
        o.earlierPartition = false;
        // The cel now covers whatever text lies under it (hideTextUnderSprites);
        // text written from here on lies on top of it.
        this.stampDraw(o);
        this.updateEgoVisibility();
        return next;
      }
      case 0x24: {
        const o = obj(0);
        // Erasing restores the pixels saved when the cel was drawn: text
        // written since then is gone.
        if (o.active) this.restoreBehind(o);
        o.active = false;
        this.updateEgoVisibility();
        return next;
      }
      case 0x25: {
        const o = obj(0);
        o.x = o.prevX = a(1);
        o.y = o.prevY = a(2);
        o.newlyPositioned = true;
        return next;
      }
      case 0x26: {
        const o = obj(0);
        o.x = o.prevX = this.vars[a(1)]!;
        o.y = o.prevY = this.vars[a(2)]!;
        o.newlyPositioned = true;
        return next;
      }
      case 0x27: {
        const o = obj(0);
        this.vars[a(1)] = o.x;
        this.vars[a(2)] = o.y;
        return next;
      }
      case 0x28: {
        // reposition: signed 8-bit deltas from variables; negative underflow
        // clamps to zero; the object is newly positioned and placement runs,
        // which also refreshes f0/f3 for ego (spec, action 0x28). Like
        // reposition.to, the previous-position snapshot is left alone.
        const o = obj(0);
        const dx = (this.vars[a(1)]! << 24) >> 24;
        const dy = (this.vars[a(2)]! << 24) >> 24;
        o.x = Math.max(0, o.x + dx);
        o.y = Math.max(0, o.y + dy);
        o.newlyPositioned = true;
        this.placeObject(o);
        return next;
      }
      case 0x29:
        this.requireView(a(1));
        this.setView(obj(0), a(1));
        return next;
      case 0x2a: {
        const view = this.vars[a(1)]!;
        this.requireView(view);
        this.setView(obj(0), view);
        return next;
      }
      case 0x2b:
        this.setLoop(obj(0), a(1));
        return next;
      case 0x2c:
        this.setLoop(obj(0), this.vars[a(1)]!);
        return next;
      case 0x2d:
        obj(0).loopFixed = true;
        return next;
      case 0x2e:
        obj(0).loopFixed = false;
        return next;
      case 0x2f: {
        const o = obj(0);
        o.cel = a(1);
        o.cycleDelay = false;
        this.updateCelSize(o);
        return next;
      }
      case 0x30: {
        const o = obj(0);
        o.cel = this.vars[a(1)]!;
        o.cycleDelay = false;
        this.updateCelSize(o);
        return next;
      }
      case 0x31:
        this.vars[a(1)] = Math.max(0, this.celCount(obj(0)) - 1);
        return next;
      case 0x32:
        this.vars[a(1)] = obj(0).cel;
        return next;
      case 0x33:
        this.vars[a(1)] = obj(0).loop;
        return next;
      case 0x34:
        this.vars[a(1)] = obj(0).view;
        return next;
      case 0x35: {
        const view = this.views.get(obj(0).view);
        this.vars[a(1)] = view ? view.loops.length : 0;
        return next;
      }
      case 0x36:
        obj(0).fixedPriority = true;
        obj(0).priority = a(1);
        return next;
      case 0x37:
        obj(0).fixedPriority = true;
        obj(0).priority = this.vars[a(1)]!;
        return next;
      case 0x38:
        obj(0).fixedPriority = false;
        return next;
      case 0x39:
        this.vars[a(1)] = obj(0).priority;
        return next;
      case 0x3a:
        if (obj(0).active) obj(0).earlierPartition = true;
        return next;
      case 0x3b:
        if (obj(0).active) obj(0).earlierPartition = false;
        return next;
      // force.update: getFrame() recomposites every active object on every
      // call (no damage tracking), so the forced redraw is already inherent.
      case 0x3c:
        this.updateEgoVisibility();
        return next;
      case 0x3d:
        obj(0).observeHorizon = false;
        return next;
      case 0x3e:
        obj(0).observeHorizon = true;
        return next;
      case 0x3f:
        this.horizon = a(0);
        return next;
      case 0x40:
        obj(0).waterGate = "on";
        return next; // obj.on.water
      case 0x41:
        obj(0).waterGate = "off";
        return next; // obj.on.land
      case 0x42:
        obj(0).waterGate = null;
        return next; // obj.on.anything
      case 0x43:
        obj(0).observeObjects = false;
        return next;
      case 0x44:
        obj(0).observeObjects = true;
        return next;
      case 0x46:
        obj(0).cycling = false;
        return next;
      case 0x47:
        obj(0).cycling = true;
        return next;
      case 0x48:
        obj(0).cycleMode = CYCLE_FORWARD;
        return next;
      case 0x49: {
        const o = obj(0);
        o.cycleMode = CYCLE_END_OF_LOOP;
        o.cycleDelay = true;
        o.cycleFlag = a(1);
        this.flags[a(1)] = 0;
        o.cycling = true;
        return next;
      }
      case 0x4a:
        obj(0).cycleMode = CYCLE_REVERSE;
        return next;
      case 0x4b: {
        const o = obj(0);
        o.cycleMode = CYCLE_REVERSE_LOOP;
        o.cycleDelay = true;
        o.cycleFlag = a(1);
        this.flags[a(1)] = 0;
        o.cycling = true;
        return next;
      }
      case 0x51:
        this.startMoveObj(obj(0), a(1), a(2), a(3), a(4));
        return next;
      case 0x52:
        this.startMoveObj(obj(0), this.vars[a(1)]!, this.vars[a(2)]!, this.vars[a(3)]!, a(4));
        return next;
      case 0x53: {
        const o = obj(0);
        o.motionMode = MOTION_FOLLOW;
        o.follow = { threshold: a(1), flag: a(2), retryDelay: 255 };
        this.flags[a(2)] = 0;
        return next;
      }
      case 0x54: {
        const o = obj(0);
        o.motionMode = MOTION_WANDER;
        o.wanderCount = 0;
        if (o === this.objects[0]) this.directionCoupling = 0;
        return next;
      }
      case 0x4c: {
        const o = obj(0);
        o.cycleTime = this.vars[a(1)]!;
        o.cycleCount = o.cycleTime;
        return next;
      }
      case 0x4f:
        obj(0).stepSize = this.vars[a(1)]!;
        return next;
      case 0x50:
        obj(0).stepTime = this.vars[a(1)]!;
        obj(0).stepCount = this.vars[a(1)]!;
        return next;
      case 0x45: {
        const aObj = obj(0);
        const bObj = obj(1);
        if (!aObj.active || !bObj.active) {
          this.vars[a(2)] = 255;
        } else {
          const ax = aObj.x + Math.floor(aObj.width / 2);
          const bx = bObj.x + Math.floor(bObj.width / 2);
          const d = Math.abs(ax - bx) + Math.abs(aObj.y - bObj.y);
          this.vars[a(2)] = this.profile.objectDistanceSaturates ? Math.min(254, d) : d & 0xff;
        }
        return next;
      }
      case 0x4d: {
        const o = obj(0);
        o.direction = 0;
        if (this.profile.movementClear === "later") {
          o.motionMode = MOTION_NORMAL;
          o.moveTarget = null;
          o.follow = null;
        }
        if (o === this.objects[0]) {
          this.vars[V_EGO_DIR] = 0;
          this.directionCoupling = 0;
        }
        return next;
      }
      case 0x4e: {
        const o = obj(0);
        if (this.profile.movementClear === "later") {
          o.motionMode = MOTION_NORMAL;
          o.moveTarget = null;
          o.follow = null;
        }
        if (o === this.objects[0]) {
          this.vars[V_EGO_DIR] = 0;
          this.directionCoupling = 1;
        }
        return next;
      }
      case 0x56:
        obj(0).direction = this.vars[a(1)]!;
        if (obj(0) === this.objects[0]) this.vars[V_EGO_DIR] = obj(0).direction;
        return next;
      case 0x57:
        this.vars[a(1)] = obj(0).direction;
        return next;
      case 0x55:
        obj(0).motionMode = MOTION_NORMAL;
        return next;
      case 0x58:
        obj(0).observeBlocks = false;
        return next;
      case 0x59:
        obj(0).observeBlocks = true;
        return next;
      case 0x5a:
        this.blockRect = { left: a(0), top: a(1), right: a(2), bottom: a(3) };
        return next;
      case 0x5b:
        this.blockRect = null;
        return next;

      // inventory
      case 0x5c:
        this.itemLocations[a(0)] = 0xff;
        return next;
      case 0x5d:
        this.itemLocations[this.vars[a(0)]!] = 0xff;
        return next;
      case 0x5e:
        this.itemLocations[a(0)] = 0;
        return next;
      case 0x5f:
        this.itemLocations[a(0)] = this.vars[a(1)]!;
        return next;
      case 0x60:
        this.itemLocations[this.vars[a(0)]!] = this.vars[a(1)]!;
        return next;
      case 0x61:
        this.vars[a(1)] = this.itemLocations[this.vars[a(0)]!]!;
        return next;

      // transient views and inventory UI
      case 0x7a:
        this.addToPicRecorded(a(0), a(1), a(2), a(3), a(4), a(5), a(6));
        return next;
      case 0x7b: {
        this.addToPicRecorded(
          this.vars[a(0)]!,
          this.vars[a(1)]!,
          this.vars[a(2)]!,
          this.vars[a(3)]!,
          this.vars[a(4)]!,
          this.vars[a(5)]!,
          this.vars[a(6)]!,
        );
        return next;
      }
      case 0x7c:
        this.openInventory();
        return next;
      case 0x81:
        this.showObj(a(0));
        return next;
      case 0xa2:
        this.showObj(this.vars[a(0)]!);
        return next;

      // persistence and session control
      case 0x7d:
        // Save writes the real file image: header plus the profile's
        // length-prefixed blocks (spec "Save action outcomes").
        if (this.host.listSaveGames) this.selectSavedGame("save");
        else this.host.saveGame?.call(this.host, this.serialize());
        this.controllers.fill(0);
        return next;
      case 0x7e: {
        const restore = this.host.restoreGame;
        const image = this.host.listSaveGames
          ? this.selectSavedGame("restore")
          : restore
            ? restore.call(this.host)
            : null;
        this.controllers.fill(0);
        // Cancel and file-open failure are recoverable and continue after the
        // restore action; a successful restore aborts the continuation
        // instead (spec "Restore action outcomes").
        if (image === null || image === undefined) return next;
        try {
          this.applyRestore(image);
        } catch (error) {
          if (error instanceof ContinuationAbort) throw error;
          // Block-read/decode failure is fatal only after its error dialog.
          this.emitPrint(
            "Unable to restore saved game.\nThe save file is invalid.",
            undefined,
            true,
          );
          const wait = this.host.waitKey ?? this.host.waitTextKey;
          if (wait) {
            while (this.modal) {
              const key = wait.call(this.host);
              this.modalKey(key === 0 ? KEY_ESC : key);
            }
          }
          this.terminated = true;
          throw error;
        }
        return next;
      }
      case 0x85: {
        // obj.status.v: modal diagnostic of the variable-selected object.
        const num = this.vars[a(0)]!;
        const o = this.objects[num]!;
        this.host.logText?.call(
          this.host,
          `obj ${num}: x=${o.x} y=${o.y} w=${o.width} h=${o.height} pri=${o.priority} step=${o.stepSize}`,
        );
        return next;
      }
      case 0x87: {
        // This allocator retains the cartridge and reserves replay capacity;
        // the spec defines the diagnostic categories, not a DOS heap layout.
        const cartridgeBytes = Array.from(this.container.files.values()).reduce(
          (sum, bytes) => sum + bytes.length,
          0,
        );
        const capacity = Math.max(this.scriptCapacity, this.maximumReplayPairs);
        const lines = [
          `heap size: ${cartridgeBytes + capacity * 2}`,
          `current/max use: ${cartridgeBytes + this.replay.length * 2}/${cartridgeBytes + this.maximumReplayPairs * 2}`,
          `maximum script use: ${this.maximumReplayPairs * 2}`,
        ];
        if (this.profile.heapDiagnosticExtraLine)
          lines.push(`rm.0, etc.: ${this.container.getResource("logic", 0)?.length ?? 0}`);
        this.host.logText?.(lines.join("\n"));
        return next;
      }
      case 0x88: {
        // pause: stop sound, fixed pause message, wait for acknowledgement.
        this.stopSound();
        this.emitPrint("Game paused. Press ENTER to continue.", undefined, true);
        return next;
      }

      // Sound resource lifecycle; the host supplies independent sound ticks.
      case 0x62: {
        this.loadSound(a(0));
        this.record(REPLAY_LOAD_SOUND, a(0));
        return next;
      }
      case 0x63: {
        const soundData = this.sounds.get(a(0));
        if (!soundData) throw new Error(`sound ${a(0)} is not loaded`);
        this.stopSound();
        this.soundPlayback = new SoundPlayback(
          this.profile,
          soundData,
          this.host.soundDevice?.() ?? 1,
          (message) => this.host.logText?.(`Sound ${a(0)}: ${message}`),
        );
        this.playingSound = a(0);
        this.soundDoneFlag = a(1);
        this.flags[a(1)] = 0;
        this.host.playSound?.(a(0), soundData);
        return next;
      }
      case 0x64:
        this.stopSound();
        return next;

      // text and input
      case 0x65:
        this.emitPrint(this.message(a(0)));
        return next;
      case 0x66:
        this.emitPrint(this.message(this.vars[a(0)]!));
        return next;
      case 0x68:
        this.display(this.vars[a(0)]!, this.vars[a(1)]!, this.message(this.vars[a(2)]!));
        return next;
      case 0x69:
        // clear.lines: full-width rows, painted with the colour operand.
        this.text.fill(a(0), 0, a(1), TEXT_COLS - 1, 0x20, attr(this.textFg, a(2)));
        this.host.clearLines?.(a(0), a(1), a(2));
        return next;
      case 0x6a:
        // text.screen: fill the whole surface with the text attribute pair.
        this.textMode = true;
        this.text.fill(0, 0, TEXT_ROWS - 1, TEXT_COLS - 1, 0x20, this.textAttr());
        this.host.setTextMode?.(true);
        this.host.clearText?.();
        return next;
      case 0x6b:
        // graphics: back to the picture; redraw status/input areas.
        this.textMode = false;
        this.text.clear();
        this.drawStatus();
        this.drawInputRow();
        this.host.setTextMode?.(false);
        this.host.clearText?.();
        return next;
      case 0x6c:
        this.inputPrompt = this.message(a(0)).charAt(0);
        this.drawInputRow();
        return next;
      case 0x6d:
        this.textFg = a(0);
        this.textBg = a(1);
        return next;
      case 0x6e:
        this.host.shakeScreen?.call(this.host, a(0));
        return next;
      case 0x6f:
        this.displayBaseRow = a(0);
        this.inputRow = a(1);
        this.statusRow = a(2);
        return next;
      case 0x67:
        this.display(a(0), a(1), this.message(a(2)));
        return next;
      case 0x70:
        this.statusEnabled = true;
        this.drawStatus();
        return next;
      case 0x71:
        this.statusEnabled = false;
        this.text.fill(this.statusRow, 0, this.statusRow, TEXT_COLS - 1, 0, 0);
        this.host.statusLine("");
        return next;
      case 0x72:
        this.setString(a(0), this.message(a(1)));
        return next;
      case 0x73: {
        // get.string: prompt drawn at (row, col) — or the input row when the
        // row is off the surface — then the blocking host edit; accepted
        // text stores at most min(maxLen, 39) characters and is echoed.
        const prompt = this.message(a(1));
        const row = a(2) < TEXT_ROWS ? a(2) : this.inputRow;
        const col = a(2) < TEXT_ROWS ? a(3) : 0;
        this.text.write(row, col, prompt, this.textAttr());
        const ask = this.host.promptString;
        const value = ask
          ? ask.call(this.host, prompt, a(4), row, col).slice(0, Math.min(a(4), 39))
          : "";
        this.setString(a(0), value);
        this.text.write(row, col + prompt.length, value, this.textAttr());
        return next;
      }
      // parse: slot numbers outside the profile's range produce no parse (spec).
      case 0x75:
        if (a(0) < this.strings.length) this.parseInput(this.strings[a(0)]!);
        return next;
      case 0x76: {
        // get.num: prompt on the input row; the accepted number's low 8 bits
        // store into the destination variable (spec). No host prompt -> 0.
        const prompt = this.message(a(0));
        this.text.fill(this.inputRow, 0, this.inputRow, TEXT_COLS - 1, 0x20, this.textAttr());
        this.text.write(this.inputRow, 0, prompt, this.textAttr());
        const ask = this.host.promptNumber;
        const value = ask ? ask.call(this.host, prompt, this.inputRow, 0) & 0xff : 0;
        this.vars[a(1)] = value;
        this.text.write(this.inputRow, prompt.length, String(value), this.textAttr());
        this.drawInputRow();
        return next;
      }
      case 0x77:
        this.inputAccepted = false;
        this.drawInputRow();
        return next;
      case 0x78:
        this.inputAccepted = true;
        this.drawInputRow();
        return next;
      case 0x79: {
        // set.key: the script key map holds profile.keyMapCapacity entries
        // (spec "Mapped keys": 39, or 49 in 3.002.149). Further mappings are
        // dropped; rebinding an existing key still works.
        const key = a(0) | (a(1) << 8);
        if (this.keymap.has(key) || this.keymap.size < this.profile.keyMapCapacity) {
          this.keymap.set(key, a(2));
        }
        return next;
      }
      case 0x74: {
        // word.to.string copies the parsed token TEXT (spec: parser results),
        // not the dictionary id — "what is your name?" depends on it.
        this.setString(a(0), this.parsedWordTexts[a(1) - 1] ?? "");
        return next;
      }
      case 0x89:
        this.editLine = this.acceptedLine.slice(0, this.inputCapacity());
        this.drawInputRow();
        return next;
      case 0x8a:
        this.editLine = "";
        this.drawInputRow();
        return next;
      case 0x8b:
        /* init.joy: joystick calibration; no joystick in this target */ return next;
      // toggle.monitor: spec places the alternate display mode outside the
      // full-EGA target this engine implements.
      case 0x8c:
        return next;
      case 0x8d: {
        this.strings[0] = (this.host.versionString?.call(this.host) ?? "AGI IS HERE 1.0.0").slice(
          0,
          39,
        );
        return next;
      }
      case 0x90:
        this.host.logText?.call(this.host, this.message(a(0)));
        return next;
      case 0x91:
        this.scanStart.set(this.activation?.logic ?? 0, next);
        return next;
      case 0x92:
        this.scanStart.delete(this.activation?.logic ?? 0);
        return next;
      case 0x93: {
        const o = obj(0);
        o.x = a(1);
        o.y = a(2);
        o.newlyPositioned = true;
        this.placeObject(o);
        return next;
      }
      case 0x94: {
        const o = obj(0);
        o.x = this.vars[a(1)]!;
        o.y = this.vars[a(2)]!;
        o.newlyPositioned = true;
        this.placeObject(o);
        return next;
      }
      case 0x99:
        this.discardViewRecorded(this.vars[a(0)]!);
        return next;
      case 0x95:
        if (this.trace.active) return next + 1;
        if (this.flags[10] !== 0) this.trace.setActive(true);
        return next;
      case 0x96:
        this.loadLogic(a(0));
        this.trace.configure(a(0), a(1), a(2));
        return next;
      // print.at / print.at.v: temporary row/column/width overrides for one window.
      case 0x97:
        this.emitPrint(this.message(a(0)), { row: a(1), col: a(2), width: a(3) });
        return next;
      case 0x98:
        this.emitPrint(this.message(this.vars[a(0)]!), { row: a(1), col: a(2), width: a(3) });
        return next;
      // clear.text.rect: inclusive cell rectangle painted with the attribute.
      case 0x9a:
        this.text.fill(a(0), a(1), a(2), a(3), 0x20, attr(this.textFg, a(4)));
        this.host.clearLines?.(a(0), a(2), a(4));
        return next;
      case 0x9b:
        return next; // set.upper.left: ignored bytes, no effect in promoted profiles

      // session/misc
      case 0x7f:
        return next;
      case 0x80: {
        // restart.game: f16 bypasses the confirmation prompt in every promoted
        // profile except 2.411, which always displays it (spec "Restart").
        this.stopSound();
        if (
          (this.profile.restartPromptBypassedByF16 && this.flags[F_NO_PROMPT_RESTART] !== 0) ||
          this.confirmSessionAction("restart")
        ) {
          this.restart();
          throw new ContinuationAbort();
        }
        return next;
      }
      case 0x82: {
        const lo = a(0);
        const hi = a(1);
        const random = (this.host.randomWord?.() ?? Math.floor(Math.random() * 65536)) & 0xffff;
        this.vars[a(2)] = lo + (random % (hi - lo + 1));
        return next;
      }
      // program.control: v6 follows ego. player.control: ego follows v6. The
      // selected coupling is save block 1's object-0/global-direction selector.
      case 0x83:
        this.directionCoupling = 0;
        return next;
      case 0x84:
        this.directionCoupling = 1;
        return next;
      case 0x86:
        if (this.profile.exitAlwaysImmediate || a(0) === 1 || this.confirmSessionAction("quit")) {
          this.stopSound();
          this.terminated = true;
          this.host.quit?.();
          throw new ContinuationAbort();
        }
        return next;
      case 0x8e:
        this.scriptCapacity = a(0);
        return next;

      // menus
      // Menu construction exists only in the "full" profiles: 2.272 parses the
      // same bytecode and builds nothing (spec "Exit and menu actions").
      case 0x9c:
        if (this.profile.menuActions === "full" && !this.menuFinalized)
          this.menu.push({ title: this.message(a(0)), items: [], enabled: true, current: 0 });
        return next;
      case 0x9d:
        if (this.profile.menuActions === "full" && !this.menuFinalized && this.menu.length > 0) {
          this.menu[this.menu.length - 1]!.items.push({
            text: this.message(a(0)),
            id: a(1),
            enabled: true,
          });
        }
        return next;
      case 0x9e:
        if (this.profile.menuActions === "full") this.finalizeMenu();
        return next;
      case 0x9f:
        if (this.profile.menuActions === "full") this.setMenuItems(a(0), true);
        return next;
      case 0xa0:
        if (this.profile.menuActions === "full") this.setMenuItems(a(0), false);
        return next;
      case 0xa1:
        // menu.input: the v3 profiles add a separate menu-interaction gate set
        // by action 0xb1 (profile.menuInteractionGate); the v2 profiles gate on
        // f14 alone.
        if (
          this.profile.menuActions === "full" &&
          this.flags[F_MENU_ENABLED] !== 0 &&
          (!this.profile.menuInteractionGate || this.menuInteractionGate !== 0)
        ) {
          this.menuRequested = true;
        }
        return next;
      // set.game.id: copies up to seven message bytes into the runtime
      // signature, which names save files and validates restore candidates
      // (spec "Save names and signatures").
      case 0x8f:
        this.signature = this.message(a(0)).slice(0, 7);
        return next;
      // open.dialogue/close.dialogue: the fixed input-width override exists in
      // every profile except 3.002.149, where both actions do nothing (spec).
      case 0xa3:
        if (this.profile.inputWidthActions === "effect") this.inputWidthCap = 36;
        return next;
      case 0xa4:
        if (this.profile.inputWidthActions === "effect") this.inputWidthCap = null;
        return next;
      case 0xa9: {
        // close.window: restore an active text window if present and clear
        // the fixed input-width override even when no window is active.
        this.closeWindowOnTop();
        if (this.profile.closeWindowClearsInputWidth) this.inputWidthCap = null;
        return next;
      }
      // set.simple: copies the last selected/entered save description into a
      // string slot, using at most 31 bytes (spec "Save action outcomes").
      case 0xaa:
        this.setString(a(0), this.saveDescription.slice(0, 31));
        return next;
      // push.script/pop.script: replay-pair checkpoints (spec "Replay
      // checkpoints"). The checkpoint action saves the active pair count; the
      // rollback action restores it and moves the append position to the end
      // of the restored prefix, leaving later pairs outside the sequence. The
      // shadow record is the log of what was drawn and is not rolled back: a
      // cel added to the picture between the two stays on screen.
      case 0xab:
        this.replayCheckpoint = this.replay.length;
        return next;
      case 0xac:
        if (this.replayCheckpoint <= this.replay.length) this.replay.length = this.replayCheckpoint;
        return next;
      case 0xa5:
        this.vars[a(0)] = (this.vars[a(0)]! * a(1)) & 0xff;
        return next;
      case 0xa6:
        this.vars[a(0)] = (this.vars[a(0)]! * this.vars[a(1)]!) & 0xff;
        return next;
      case 0xa7:
        this.vars[a(0)] = Math.floor(this.vars[a(0)]! / a(1));
        return next;
      case 0xa8:
        this.vars[a(0)] = Math.floor(this.vars[a(0)]! / this.vars[a(1)]!);
        return next;
      case 0xad:
        // hold.key: the v2 and 3.002.086 profiles increment the release gate
        // modulo 256; 3.002.102 and 3.002.149 set it to one (spec "Tracked key
        // release"). 2.411/2.440 do not expose the action at all — their action
        // range rejects the byte before dispatch reaches here.
        this.keyReleaseGate =
          this.profile.releaseGateAction === "set" ? 1 : (this.keyReleaseGate + 1) & 0xff;
        return next;
      case 0xae:
        this.priorityBase = a(0);
        return next;
      case 0xaf:
        return next; // Spec: no runtime effect and no operand byte.
      case 0xb0:
      case 0xb2:
      case 0xb3:
      case 0xb4:
        return next; // Full-EGA profile no-ops, with profile-specific widths.
      case 0xb1:
        this.menuInteractionGate = a(0);
        return next;
      case 0xb5:
        this.keyReleaseGate = 0;
        return next;

      default:
        throw new UnimplementedOpcodeError(op, spec.name, this.activation?.logic ?? -1, pc);
    }
  }

  /** Shared new.room sequence: update room vars, reset objects, load, unwind. */
  private newRoom(room: number): never {
    if (this.host.prepareRoom?.(room, this.vars[V_ROOM]!) === false) {
      // A failed authoring attempt must not discard the room, objects or
      // replay sequence. Stop at the edge and let the player try again.
      this.vars[V_EGO_DIR] = 0;
      this.vars[V_EDGE] = 0;
      this.objects[0]!.direction = 0;
      this.emitPrint("That room is not available. Try again.");
      throw new ContinuationAbort();
    }
    this.stopSound();
    // Room transition step 2: reset the resource replay sequence, so a room's
    // recorded resource/draw pairs describe that room alone (spec "Room
    // transition").
    this.replay.length = 0;
    this.hostReplay.length = 0;
    this.hostReplayOverflow = false;
    this.pendingLogic = null;
    this.replayCheckpoint = 0;
    this.vars[V_PREV_ROOM] = this.vars[V_ROOM]!;
    this.vars[V_ROOM] = room;
    this.vars[V_EGO_VIEW] = this.objects[0]!.view;
    this.horizon = 36;
    this.blockRect = null;
    // Room entry restores player.control, including after stop.motion(ego).
    // Peter Kelly: https://agistudio.sourceforge.net/help/new_room.html
    this.directionCoupling = 1;
    this.vars[V_OBJ_HIT] = 0;
    this.vars[V_OBJ_EDGE] = 0;
    this.parsedWords = [];
    this.parsedWordTexts = [];
    this.parserCount = 0;
    this.lastInputLine = "";
    this.pictures.clear();
    this.pictureOrder.length = 0;
    this.views.clear();
    this.viewOrder.length = 0;
    this.sounds.clear();
    for (const num of this.logics.keys()) if (num !== 0) this.logics.delete(num);
    for (const num of this.scanStart.keys()) if (num !== 0) this.scanStart.delete(num);
    for (const o of this.objects) {
      o.stepSize = o.stepTime = o.stepCount = o.cycleTime = o.cycleCount = 1;
      o.newlyPositioned = false;
      o.cycleDelay = false;
    }
    this.unanimateAll();
    this.loadLogic(room);
    throw new RoomChange(room);
  }

  // ---------- helpers ----------

  private loadPicture(num: number): void {
    this.picturePayload(num); // validates presence
    // Loading an already loaded resource does not change its retention order.
    if (!this.pictures.has(num)) {
      this.pictures.add(num);
      this.pictureOrder.push(num);
    }
  }

  /**
   * Ordered discard (spec "Resource lifecycle"): removing a retained resource
   * also removes every resource loaded later in the same family. Discarding a
   * resource that is not retained has no effect.
   */
  private discardPicture(num: number): void {
    const at = this.pictureOrder.indexOf(num);
    if (at < 0) return;
    for (const later of this.pictureOrder.splice(at)) this.pictures.delete(later);
  }

  private discardView(num: number): void {
    const at = this.viewOrder.indexOf(num);
    if (at < 0) {
      this.views.delete(num);
      return;
    }
    for (const later of this.viewOrder.splice(at)) this.views.delete(later);
  }

  /** draw.pic: clear logical picture state, then decode the loaded picture. */
  private drawPicture(num: number): void {
    this.surface.reset();
    renderPicture(this.picturePayload(num), this.surface, { profile: this.profile });
    this.pictureShown = false;
    this.lastPicture = num;
  }

  /** overlay.pic: decode over the logical picture without clearing it first. */
  private overlayPicture(num: number): void {
    renderPicture(this.picturePayload(num), this.surface, { overlay: true, profile: this.profile });
    this.lastPicture = num;
  }

  private loadLogicRecorded(num: number): void {
    this.loadLogic(num);
    this.record(REPLAY_LOAD_LOGIC, num);
  }

  private loadViewRecorded(num: number): void {
    this.loadView(num);
    this.record(REPLAY_LOAD_VIEW, num);
  }

  private discardViewRecorded(num: number): void {
    this.discardView(num);
    this.record(REPLAY_DISCARD_VIEW, num);
  }

  /**
   * add.to.pic, recorded as the spec's four-pair transient-cel packet: after
   * `(5,0)` the next three pairs carry (view, loop), (cel, left_x) and
   * (baseline_y, packed_priority_control), whose final byte holds the staged
   * priority/control nibbles.
   */
  private addToPicRecorded(
    viewNum: number,
    loop: number,
    cel: number,
    x: number,
    y: number,
    priority: number,
    margin: number,
  ): void {
    this.addToPic(viewNum, loop, cel, x, y, priority, margin);
    this.record(REPLAY_ADD_TO_PIC, 0);
    this.record(viewNum, loop);
    this.record(cel, x);
    this.record(y, ((priority & 0x0f) << 4) | (margin & 0x0f));
  }

  /**
   * Append one replay pair. Recording appends only while f7 is clear and the
   * internal recording gate is enabled (spec "Resource replay sequence").
   * Exceeding a configured capacity is an engine error; a game that never
   * configured one (capacity 0) records freely and the save writes the active
   * count as its capacity.
   */
  private record(kind: number, value: number): void {
    if (!this.replayRecording) return;
    if (this.hostReplay.length < HOST_REPLAY_LIMIT) this.hostReplay.push({ kind, value });
    else this.hostReplayOverflow = true;
    if (this.flags[F_REPLAY_OFF] !== 0) return;
    if (this.replay.length >= this.scriptCapacity) {
      throw new RangeError(
        `resource replay sequence exceeded its ${this.scriptCapacity}-pair capacity`,
      );
    }
    this.replay.push({ kind, value });
    this.maximumReplayPairs = Math.max(this.maximumReplayPairs, this.replay.length);
  }

  private picturePayload(num: number): Uint8Array {
    const payload = this.container.getResource("picture", num);
    if (!payload) throw new Error(`picture resource ${num} not in container`);
    return payload;
  }

  private loadView(num: number): AgiView {
    const cached = this.views.get(num);
    if (cached) return cached;
    const payload = this.container.getResource("view", num);
    if (!payload) throw new Error(`view resource ${num} not in container`);
    const view = parseView(payload, this.profile);
    this.views.set(num, view);
    if (!this.viewOrder.includes(num)) this.viewOrder.push(num);
    return view;
  }

  private requireView(num: number): void {
    this.loadView(num);
  }

  /** Cel count for an object's selected loop (1 when view missing). */
  private celCount(o: ScreenObject): number {
    const view = this.views.get(o.view);
    const loop = view?.loops[o.loop];
    return loop ? loop.cels.length : 1;
  }

  private setMenuItems(id: number, enabled: boolean): void {
    for (const heading of this.menu) {
      for (const item of heading.items) {
        if (item.id === id) item.enabled = enabled;
      }
    }
  }

  private unanimateAll(): void {
    for (const o of this.objects) {
      o.active = false;
      o.update = false;
    }
  }

  /**
   * Accepted restart (spec "Restart"): stop sound and erase active input;
   * preserve the prior value of f9 across the reset; clear transient
   * allocation, resource, replay, menu, object, parser and display state to
   * startup-compatible values; rerun initial object/inventory setup; set f6;
   * and clear the engine's timing accumulators. The caller aborts the current
   * logic continuation.
   */
  private restart(): void {
    this.pendingLogic = null;
    const soundEnabled = this.flags[F_SOUND_ENABLED]!;
    this.playingSound = null;
    this.soundDoneFlag = null;
    this.soundPlayback = null;
    this.sounds.clear();
    this.host.stopSound?.();

    this.vars.fill(0);
    this.vars[22] = (this.host.soundDevice?.() ?? 1) === 0 ? 1 : 3;
    this.vars[26] = 3;
    this.flags.fill(0);
    this.controllers.fill(0);
    this.logics.clear();
    this.pictures.clear();
    this.pictureOrder.length = 0;
    this.views.clear();
    this.viewOrder.length = 0;
    this.scanStart.clear();
    this.replay.length = 0;
    this.hostReplay.length = 0;
    this.hostReplayOverflow = false;
    this.replayCheckpoint = 0;
    this.replayRecording = true;
    this.scriptCapacity = DEFAULT_REPLAY_CAPACITY;
    this.maximumReplayPairs = 0;
    this.menu = [];
    this.menuFinalized = false;
    this.menuHeading = 0;
    this.menuRequested = false;
    this.menuInteractionGate = 0;
    this.pendingController = null;
    this.parsedWords = [];
    this.parsedWordTexts = [];
    this.parserCount = 0;
    this.lastInputLine = "";
    for (const o of this.objects) Object.assign(o, newScreenObject());
    this.initInventory();
    this.modals.length = 0;
    this.persistentWindow = null;
    this.printsPending = 0;
    this.textMode = false;
    this.statusEnabled = false;
    this.statusRefreshRequested = false;
    this.inputAccepted = false;
    this.editLine = "";
    this.acceptedLine = "";
    this.blockRect = null;
    this.horizon = 36;
    this.priorityBase = 48;
    this.lastPicture = 0;
    this.keyReleaseGate = 0;
    this.inputQueue.clear();
    this.inputWidthCap = null;
    this.surface.reset();
    this.pictureShown = false;
    this.text.clear();
    // The two timing accumulators.
    this.timerTicks = 0;
    this.clockRemainderMs = 0;
    this.haveKeyPolls = 0;

    this.flags[F_SOUND_ENABLED] = soundEnabled;
    this.flags[F_NEW_ROOM] = 1;
    this.flags[F_RESTART] = 1;
    this.trace.setActive(false);
    if (this.trace.logic !== null) this.loadLogic(this.trace.logic);
  }

  // ---------- host inspection (live patching / agent perception) ----------

  /**
   * Game-visible state of every ACTIVE screen object, as plain data.
   *
   * `screenObjects` hands out the live internal records; this returns a
   * detached snapshot safe to postMessage across a worker boundary and to
   * hand to the authoring agent as a tool result.
   */
  readObjects(): ScreenObjectState[] {
    const out: ScreenObjectState[] = [];
    for (let num = 0; num < this.objects.length; num++) {
      const o = this.objects[num]!;
      if (!o.active) continue;
      out.push({
        num,
        view: o.view,
        loop: o.loop,
        cel: o.cel,
        x: o.x,
        y: o.y,
        width: o.width,
        height: o.height,
        priority: o.priority,
        fixedPriority: o.fixedPriority,
        direction: o.direction,
        stepSize: o.stepSize,
        stepTime: o.stepTime,
        cycling: o.cycling,
        cycleMode: o.cycleMode,
        cycleTime: o.cycleTime,
        motionMode: o.motionMode,
        update: o.update,
      });
    }
    return out;
  }

  /** A detached view of script-installed keys and their matching finalized menu items. */
  readControls(): GameControlBinding[] {
    const controls: GameControlBinding[] = [...this.keymap].map(([key, controller]) => ({
      key,
      controller,
      menuItems: this.menuFinalized
        ? this.menu.flatMap((heading) =>
            heading.items
              .filter((item) => item.id === controller)
              .map((item) => ({
                heading: heading.title,
                text: item.text,
                enabled: heading.enabled && item.enabled,
              })),
          )
        : [],
    }));
    // A mapped raw key becomes a controller before ordinary raw-key handling.
    // Advertise the trace shortcut only when that is the action it will perform.
    if (!this.keymap.has(0x4600) && (this.flags[10] !== 0 || this.trace.active))
      controls.push({
        key: 0x4600,
        controller: null,
        menuItems: [],
        label: this.trace.active ? "Hide trace" : "Show trace",
      });
    return controls;
  }

  /**
   * Scalar interpreter state as plain data: what the agent needs to reason
   * about a running game it may not have authored.
   */
  readState(): EngineStateReport {
    const ego = this.objects[0]!;
    return {
      profile: this.profile.id,
      room: this.vars[V_ROOM]!,
      previousRoom: this.vars[V_PREV_ROOM]!,
      egoX: ego.x,
      egoY: ego.y,
      egoDirection: this.vars[V_EGO_DIR]!,
      vars: Array.from(this.vars),
      flags: Array.from(this.flags),
      strings: [...this.strings],
      parsedWords: [...this.parsedWords],
      parsedWordTexts: [...this.parsedWordTexts],
      parserCount: this.parserCount,
      lastInputLine: this.lastInputLine,
      horizon: this.horizon,
      modalKind: this.modalKind,
      inputEnabled: this.inputAccepted,
      pictureShown: this.pictureShown,
      terminated: this.terminated,
      inventory: this.itemNames().map((name, num) => ({
        num,
        name,
        room: this.itemLocations[num]!,
      })),
    };
  }

  /**
   * Host-driven room re-entry, for live patching: after the harness patches
   * the current room's logic/picture/view it re-enters the room so the new
   * resources take effect, exactly as `new.room(v0)` from bytecode would.
   *
   * The RoomChange unwind that `newRoom` throws exists to abandon the
   * interpreter activation that issued it; there is no activation on the
   * stack when the HOST calls this, so it is caught here and the same
   * post-switch sequence tick() runs is applied directly.
   */
  reenterRoom(room: number = this.vars[V_ROOM]!): void {
    try {
      this.newRoom(room);
    } catch (rc) {
      if (!(rc instanceof RoomChange)) throw rc;
    }
    this.finishRoomChange(room);
  }
}

/** One active screen object, detached from the interpreter's live record. */
export interface ScreenObjectState {
  num: number;
  view: number;
  loop: number;
  cel: number;
  x: number;
  y: number;
  width: number;
  height: number;
  priority: number;
  fixedPriority: boolean;
  direction: number;
  stepSize: number;
  stepTime: number;
  cycling: boolean;
  /** 0 forward, 1 reverse, 2 end.of.loop, 3 reverse.loop. */
  cycleMode: number;
  cycleTime: number;
  /** 0 normal, 1 move.obj, 2 follow.ego, 3 wander. */
  motionMode: number;
  update: boolean;
}

/** Configured shortcuts are observable state; bindings do not guarantee a script will handle a key. */
export interface GameControlBinding {
  key: number;
  /** null for an interpreter service enabled by game state. */
  controller: number | null;
  label?: string;
  menuItems: { heading: string; text: string; enabled: boolean }[];
}

/** Scalar interpreter state, detached from the engine. */
export interface EngineStateReport {
  inputEnabled: boolean;
  pictureShown: boolean;
  terminated: boolean;
  profile: string;
  room: number;
  previousRoom: number;
  egoX: number;
  egoY: number;
  egoDirection: number;
  /** All 256 vars. */
  vars: number[];
  /** All 256 flags. */
  flags: number[];
  strings: string[];
  parsedWords: number[];
  parsedWordTexts: string[];
  parserCount: number;
  lastInputLine: string;
  horizon: number;
  modalKind: string | null;
  /** Current item locations, with 255 meaning carried. */
  inventory: { num: number; name: string; room: number }[];
}

function readS16(code: Uint8Array, at: number): number {
  const v = code[at]! | (code[at + 1]! << 8);
  return v >= 0x8000 ? v - 0x10000 : v;
}

function directionToward(dx: number, dy: number, band: number): number {
  const x = dx <= -band ? -1 : dx >= band ? 1 : 0;
  const y = dy <= -band ? -1 : dy >= band ? 1 : 0;
  if (x === 0) return y === 0 ? 0 : y < 0 ? 1 : 5;
  if (y === 0) return x < 0 ? 7 : 3;
  return x < 0 ? (y < 0 ? 8 : 6) : y < 0 ? 2 : 4;
}

function directionDelta(dir: number): [number, number] {
  switch (dir) {
    case 1:
      return [0, -1];
    case 2:
      return [1, -1];
    case 3:
      return [1, 0];
    case 4:
      return [1, 1];
    case 5:
      return [0, 1];
    case 6:
      return [-1, 1];
    case 7:
      return [-1, 0];
    case 8:
      return [-1, -1];
    default:
      return [0, 0];
  }
}
