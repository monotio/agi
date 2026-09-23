/** Live screen-object state and conversion to and from save-file object records. */
import type { SaveObjectRecord } from "./persistence.ts";

export interface ScreenObject {
  active: boolean;
  /** animate.obj membership; stop.update selects earlierPartition instead. */
  update: boolean;
  earlierPartition: boolean;
  newlyPositioned: boolean;
  cycleDelay: boolean;
  stationary: boolean;
  view: number;
  loop: number;
  cel: number;
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  /** Text-write count when the cel was last drawn; text written later is under a redraw. */
  drawSeq: number;
  /** Bounds of the cel as last drawn, the rectangle an erase restores. */
  drawnX: number;
  drawnY: number;
  drawnWidth: number;
  drawnHeight: number;
  /** Cel dimensions, refreshed on view/loop/cel selection. */
  width: number;
  height: number;
  stepSize: number;
  stepTime: number;
  stepCount: number;
  direction: number;
  /**
   * The object record's shared parameter bank, bytes 0x27..0x2a: whichever
   * handler wrote it last owns its meaning (docs/fidelity.md, "Original
   * motion and animation audit"). move.obj writes [targetX, targetY,
   * savedStep, completionFlag]; follow.ego writes [effectiveThreshold,
   * completionFlag, 255] and leaves the fourth byte — its retry delay lives
   * in the third; end.of.loop and reverse.loop write their completion flag
   * into the first byte, which the wander countdown also occupies. Handlers
   * preserve the bytes they do not write, including across mode changes.
   */
  paramBank: [number, number, number, number];
  priority: number;
  fixedPriority: boolean;
  cycling: boolean;
  cycleMode: number;
  cycleTime: number;
  cycleCount: number;
  motionMode: number; // 0 normal, 1 move.obj, 2 follow, 3 wander, 4 amiga click-move
  observeHorizon: boolean;
  observeBlocks: boolean;
  observeObjects: boolean;
  loopFixed: boolean;
  /** obj.on.water/obj.on.land footprint-scan gate (class-state flag 0). */
  waterGate: "on" | "off" | "both" | null;
}

export function newScreenObject(): ScreenObject {
  return {
    active: false,
    update: false,
    earlierPartition: false,
    newlyPositioned: false,
    cycleDelay: false,
    stationary: false,
    view: 0,
    loop: 0,
    cel: 0,
    x: 0,
    y: 0,
    prevX: 0,
    drawSeq: 0,
    drawnX: 0,
    drawnY: 0,
    drawnWidth: 0,
    drawnHeight: 0,
    prevY: 0,
    // Cold-boot records are zeroed 43-byte slots: animate.obj writes only the
    // flags word (0x70) and bytes 0x21..0x23, so cadence scalars and cel
    // dimensions stay zero until the game sets them. A zero movement countdown
    // is due every pass (moving stepSize 0); a zero animation countdown is
    // disabled. docs/fidelity.md: Startup and reconstruction.
    width: 0,
    height: 0,
    stepSize: 0,
    stepTime: 0,
    stepCount: 0,
    direction: 0,
    paramBank: [0, 0, 0, 0],
    priority: 0,
    fixedPriority: false,
    cycling: false,
    cycleMode: CYCLE_FORWARD,
    cycleTime: 0,
    cycleCount: 0,
    motionMode: 0,
    observeHorizon: true,
    observeBlocks: true,
    observeObjects: true,
    loopFixed: false,
    waterGate: null,
  };
}

export const MOTION_NORMAL = 0;
export const MOTION_MOVE_OBJ = 1;
export const MOTION_FOLLOW = 2;
export const MOTION_WANDER = 3;
/**
 * Amiga click-to-move mode (docs/fidelity.md "Amiga interpreter profiles"):
 * the 2.31x condition 0x13 tests this value. No host interaction selects
 * that mode, so the condition reads false under every current host.
 */
export const MOTION_CLICK_MOVE = 4;
export const CYCLE_FORWARD = 0;
export const CYCLE_REVERSE = 1;
export const CYCLE_END_OF_LOOP = 2;
export const CYCLE_REVERSE_LOOP = 3;

/**
 * Object state-flags word of a block-2 record. The spec names the field but
 * not its bit assignment, so this is the engine's own packing: restore
 * reconstructs drawing-list participation from these flags and then restores
 * the word (spec, "Profile 2.936 block 2").
 */
const OBJ_ACTIVE = 1 << 0;
const OBJ_UPDATE = 1 << 1;
const OBJ_CYCLING = 1 << 2;
const OBJ_FIXED_PRIORITY = 1 << 3;
const OBJ_OBSERVE_HORIZON = 1 << 4;
const OBJ_OBSERVE_BLOCKS = 1 << 5;
const OBJ_OBSERVE_OBJECTS = 1 << 6;
const OBJ_LOOP_FIXED = 1 << 7;
const OBJ_WATER_GATE_ON = 1 << 8;
const OBJ_WATER_GATE_OFF = 1 << 9;
const OBJ_EARLIER_PARTITION = 1 << 10;
const OBJ_NEWLY_POSITIONED = 1 << 11;
const OBJ_CYCLE_DELAY = 1 << 12;
const OBJ_STATIONARY = 1 << 13;

export function packObjectState(o: ScreenObject): number {
  let state = 0;
  if (o.active) state |= OBJ_ACTIVE;
  if (o.update) state |= OBJ_UPDATE;
  if (o.cycling) state |= OBJ_CYCLING;
  if (o.fixedPriority) state |= OBJ_FIXED_PRIORITY;
  if (o.observeHorizon) state |= OBJ_OBSERVE_HORIZON;
  if (o.observeBlocks) state |= OBJ_OBSERVE_BLOCKS;
  if (o.observeObjects) state |= OBJ_OBSERVE_OBJECTS;
  if (o.loopFixed) state |= OBJ_LOOP_FIXED;
  if (o.waterGate === "on" || o.waterGate === "both") state |= OBJ_WATER_GATE_ON;
  if (o.waterGate === "off" || o.waterGate === "both") state |= OBJ_WATER_GATE_OFF;
  if (o.earlierPartition) state |= OBJ_EARLIER_PARTITION;
  if (o.newlyPositioned) state |= OBJ_NEWLY_POSITIONED;
  if (o.cycleDelay) state |= OBJ_CYCLE_DELAY;
  if (o.stationary) state |= OBJ_STATIONARY;
  return state;
}

/**
 * The record's four motion parameter bytes are the live bank verbatim — the
 * mode-dependent interpretations above are views over the same storage, not
 * fields of their own (docs/fidelity.md, "Original motion and animation
 * audit").
 */
export function motionParams(o: ScreenObject): [number, number, number, number] {
  return [...o.paramBank];
}

/** Apply one block-2 record to a live object; a missing record resets it. */
export function applyObjectRecord(o: ScreenObject, record: SaveObjectRecord | undefined): void {
  if (!record) {
    Object.assign(o, newScreenObject());
    return;
  }
  o.stepTime = record.stepTime;
  o.stepCount = record.stepCount;
  o.x = record.x;
  o.y = record.y;
  o.view = record.view;
  o.loop = record.loop;
  o.cel = record.cel;
  o.prevX = record.prevX;
  o.prevY = record.prevY;
  o.width = record.width;
  o.height = record.height;
  o.stepSize = record.stepSize;
  o.cycleTime = record.cycleTime;
  o.cycleCount = record.cycleCount;
  o.direction = record.direction;
  o.motionMode = record.motionMode;
  o.cycleMode = record.cycleMode;
  o.priority = record.priority;
  const state = record.state;
  o.active = (state & OBJ_ACTIVE) !== 0;
  o.update = (state & OBJ_UPDATE) !== 0;
  o.earlierPartition = (state & OBJ_EARLIER_PARTITION) !== 0;
  o.newlyPositioned = (state & OBJ_NEWLY_POSITIONED) !== 0;
  o.cycleDelay = (state & OBJ_CYCLE_DELAY) !== 0;
  o.stationary = (state & OBJ_STATIONARY) !== 0;
  o.cycling = (state & OBJ_CYCLING) !== 0;
  o.fixedPriority = (state & OBJ_FIXED_PRIORITY) !== 0;
  o.observeHorizon = (state & OBJ_OBSERVE_HORIZON) !== 0;
  o.observeBlocks = (state & OBJ_OBSERVE_BLOCKS) !== 0;
  o.observeObjects = (state & OBJ_OBSERVE_OBJECTS) !== 0;
  o.loopFixed = (state & OBJ_LOOP_FIXED) !== 0;
  o.waterGate =
    (state & (OBJ_WATER_GATE_ON | OBJ_WATER_GATE_OFF)) === (OBJ_WATER_GATE_ON | OBJ_WATER_GATE_OFF)
      ? "both"
      : (state & OBJ_WATER_GATE_ON) !== 0
        ? "on"
        : (state & OBJ_WATER_GATE_OFF) !== 0
          ? "off"
          : null;
  const [p0, p1, p2, p3] = record.motionParams;
  o.paramBank = [p0, p1, p2, p3];
}
