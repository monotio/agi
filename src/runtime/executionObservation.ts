/**
 * Engine execution observation and resumable stop records (see
 * ExecutionBoundary for the before-instruction half of the same surface).
 * All of this is session-local: no record below is ever serialized into
 * replay state, host images, tapes or save files.
 *
 * The model is one stop latch reached by three roads:
 *
 * - instruction observations fire after an actually executed action, an
 *   actually evaluated predicate, a goto/if resolution or a return pop —
 *   their cause carries the exact responsible boundary;
 * - phase observations fire after an atomic engine phase (input, clock,
 *   host-answer application, the post-logic tail…) that has no responsible
 *   LOGIC instruction — the cause names the phase rather than blaming the
 *   next instruction;
 * - `pauseExecution` overlays whatever the engine is already doing — an
 *   in-flight host request, a modal wait or plain idle — with a wait cause.
 *
 * A `true` observer return latches a stop; `resumeExecution` clears it once
 * and the next tick continues the interrupted operation or phase cursor,
 * never re-running completed work.
 */
import type { ExecutionBoundary, PendingInteraction } from "./engine.ts";

/**
 * Atomic engine work that can change vars, flags, controllers or resources
 * without a responsible LOGIC instruction. The names are the cycle's own
 * phases plus the two out-of-cycle clocks.
 */
export type ExecutionPhaseKind =
  /** Pass preamble: presentation flag, tick counter, controller/flag clears. */
  | "cycle-entry"
  /** Queued key/direction/controller events, the input line, the menu open. */
  | "input"
  /** Autonomous direction updates, ego/object direction coupling, status memory. */
  | "pre-logic"
  /** A delivered host answer applied to the parked interaction. */
  | "host-answer"
  /** finishRoomChange: edge placement, f5, controller clear, text refresh. */
  | "room"
  /** Restart/restore re-entry clears (v9, v4, v5, f2) before logic resumes. */
  | "reset"
  /** Score/sound status check and the object-event/cycle flag clears. */
  | "cycle-tail"
  /** Post-logic object update, cycling and the f1 visibility write. */
  | "motion"
  /** The completed-cycle serial advance. */
  | "cycle-end"
  /** `advanceClock`: v11..v14 plus the fractional carry. */
  | "clock"
  /** `soundTick`: playback outputs and the completion flag. */
  | "sound";

/**
 * The wait a stop can overlay, or null when nothing is outstanding. The
 * pending-interaction kinds report verbatim; "modal" covers windows that are
 * not a pending interaction, "clock" a parked busy-wait, "idle" an engine
 * between cycles with nothing parked.
 */
export type ExecutionWaitKind = PendingInteraction["kind"] | "modal" | "clock" | "idle";

/** What completed immediately before an observation or a stop. */
export type ExecutionCause =
  | {
      readonly type: "instruction";
      /**
       * The exact responsible operation: logic, PC, opcode PC, invocation
       * identity and a detached, frozen stack snapshot. For a predicate the
       * boundary keeps the gate's convention — `pc` at the term (a NOT inside
       * an OR group) and `opcodePc` at the predicate byte — and `pc` stays the
       * statement address for every other kind.
       */
      readonly boundary: ExecutionBoundary;
    }
  | {
      readonly type: "phase";
      /**
       * Completed work with no responsible LOGIC instruction: cycle phases,
       * host-answer application and the out-of-cycle clocks.
       */
      readonly phase: ExecutionPhaseKind;
    }
  | {
      readonly type: "wait";
      /** An explicit pause overlaying the wait the engine was already in. */
      readonly wait: ExecutionWaitKind;
    };

/** How the observed operation ended. */
export type ExecutionObservationOutcome =
  /** The operation ran to completion. */
  | "completed"
  /** The operation threw HostWait: the engine is now waiting on the host. */
  | "awaiting-host"
  /** The operation abandoned the pass: new.room's unwind or a session abort. */
  | "unwind";

/**
 * One completed operation or phase, handed to the observer after the work is
 * fully applied. `sequence` is the monotonic emission serial — it increments
 * per delivered observation, so callback order is total even though a cause
 * boundary is allocated before its operation dispatches. Frozen and safe to
 * retain.
 */
export interface ExecutionObservation {
  readonly sequence: number;
  readonly cause: ExecutionCause;
  readonly outcome: ExecutionObservationOutcome;
  /** An evaluated predicate's raw handler result, before the surrounding NOT applies. */
  readonly result?: boolean;
}

/**
 * After-operation debugger callback. Runs only while armed; must be bounded
 * and observational — the engine faults the run rather than dropping a
 * requested stop when the callback throws. Return true to stop execution
 * before the next operation or phase runs.
 */
export type ExecutionObserver = (observation: ExecutionObservation) => boolean | void;

/**
 * The latched stop. `executionStop` continues to report a before-instruction
 * gate boundary for existing consumers; this record is authoritative for
 * every stop kind.
 */
export interface ExecutionStopInfo {
  /** Monotonic session serial distinguishing overlapping stops. */
  readonly stopId: number;
  readonly cause: ExecutionCause;
  /**
   * Detached resume point when a logic stack is parked, else null — a pure
   * phase or idle stop has no instruction to point at.
   */
  readonly location: ExecutionBoundary | null;
  /** The wait this stop overlays, when one is outstanding. */
  readonly wait: ExecutionWaitKind | null;
}
