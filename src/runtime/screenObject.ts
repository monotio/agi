/** Live screen-object state and conversion to and from save-file object records. */
import type { SaveObjectRecord } from "./persistence.ts";

export interface ScreenObject {
  active: boolean;
  update: boolean;
  earlierPartition: boolean;
  newlyPositioned: boolean;
  cycleDelay: boolean;
  stationary: boolean;
  wanderCount: number;
  view: number;
  loop: number;
  cel: number;
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  /** Cel dimensions, refreshed on view/loop/cel selection. */
  width: number;
  height: number;
  stepSize: number;
  stepTime: number;
  stepCount: number;
  direction: number;
  /** move.obj target/params (motionMode 1). */
  moveTarget: { x: number; y: number; savedStep: number; flag: number } | null;
  /** follow.ego params (motionMode 2). */
  follow: { threshold: number; flag: number; retryDelay: number } | null;
  /** end.of.loop / reverse.loop completion flag. */
  cycleFlag: number | null;
  priority: number;
  fixedPriority: boolean;
  cycling: boolean;
  cycleMode: number;
  cycleTime: number;
  cycleCount: number;
  motionMode: number; // 0 normal, 1 move.obj, 2 follow, 3 wander
  observeHorizon: boolean;
  observeBlocks: boolean;
  observeObjects: boolean;
  loopFixed: boolean;
  /** obj.on.water/obj.on.land footprint-scan gate (class-state flag 0). */
  waterGate: "on" | "off" | null;
}

export function newScreenObject(): ScreenObject {
  return {
    active: false,
    update: false,
    earlierPartition: false,
    newlyPositioned: false,
    cycleDelay: false,
    stationary: false,
    wanderCount: 0,
    view: 0,
    loop: 0,
    cel: 0,
    x: 0,
    y: 0,
    prevX: 0,
    prevY: 0,
    width: 8,
    height: 8,
    stepSize: 1,
    stepTime: 1,
    stepCount: 1,
    direction: 0,
    moveTarget: null,
    follow: null,
    cycleFlag: null,
    priority: 0,
    fixedPriority: false,
    cycling: true,
    cycleMode: CYCLE_FORWARD,
    cycleTime: 1,
    cycleCount: 1,
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
  if (o.waterGate === "on") state |= OBJ_WATER_GATE_ON;
  if (o.waterGate === "off") state |= OBJ_WATER_GATE_OFF;
  if (o.earlierPartition) state |= OBJ_EARLIER_PARTITION;
  if (o.newlyPositioned) state |= OBJ_NEWLY_POSITIONED;
  if (o.cycleDelay) state |= OBJ_CYCLE_DELAY;
  if (o.stationary) state |= OBJ_STATIONARY;
  return state;
}

/**
 * The record's four mode-dependent motion parameter bytes. Their meaning is
 * selected by the record's autonomous-motion mode, as the spec specifies:
 *
 * - target motion: target X, target Y, saved step size, completion flag;
 * - approach motion: near threshold, completion flag, cel-cycling completion
 *   flag, retry delay;
 * - normal and random motion: cel-cycling completion flag, wander countdown,
 *   then zeros.
 *
 * A pending cel-cycling completion flag therefore has no byte of its own while
 * target motion is running; that is the only state this packing cannot carry.
 */
export function motionParams(o: ScreenObject): [number, number, number, number] {
  const cycleFlag = o.cycleFlag ?? 0;
  if (o.motionMode === MOTION_MOVE_OBJ && o.moveTarget) {
    const t = o.moveTarget;
    return [t.x & 0xff, t.y & 0xff, t.savedStep & 0xff, t.flag & 0xff];
  }
  if (o.motionMode === MOTION_FOLLOW && o.follow) {
    return [
      o.follow.threshold & 0xff,
      o.follow.flag & 0xff,
      cycleFlag & 0xff,
      o.follow.retryDelay & 0xff,
    ];
  }
  return [cycleFlag & 0xff, o.wanderCount & 0xff, 0, 0];
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
    (state & OBJ_WATER_GATE_ON) !== 0 ? "on" : (state & OBJ_WATER_GATE_OFF) !== 0 ? "off" : null;
  const [p0, p1, p2, p3] = record.motionParams;
  o.moveTarget =
    record.motionMode === MOTION_MOVE_OBJ ? { x: p0, y: p1, savedStep: p2, flag: p3 } : null;
  o.follow =
    record.motionMode === MOTION_FOLLOW ? { threshold: p0, flag: p1, retryDelay: p3 } : null;
  o.wanderCount = record.motionMode === MOTION_WANDER ? p1 : 0;
  const cycleFlag =
    record.motionMode === MOTION_FOLLOW ? p2 : record.motionMode === MOTION_MOVE_OBJ ? 0 : p0;
  o.cycleFlag = cycleFlag === 0 ? null : cycleFlag;
}
