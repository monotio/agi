/**
 * The AGI inspector's state, shared by its three pieces: the overlay over the
 * stage (object boxes, horizon, the pick), the controls (Screen, State and
 * Timeline) and whichever frame hosts those controls — the floating dock in
 * Play mode or the Inspect tab in Create mode. App.vue creates one; it polls
 * the worker only while the inspector is on, and switching it off releases
 * every debug channel it armed.
 */
import { inject, provide, ref, watch, type InjectionKey } from "vue";
import type { EngineApi } from "../engineContext.ts";
import type { Presentation } from "../usePresentation.ts";
import { latchIsStale, type DebugEvent, type LatchedPick, type PickPoint } from "../debugView.ts";

export interface InspectorStateReport {
  vars: number[];
  flags: number[];
  horizon: number;
  priorityBase: number;
  patchGeneration: number;
  room: number;
  egoX: number;
  egoY: number;
  egoDirection: number;
}

export type InspectorTab = "screen" | "state" | "timeline";

const EMPTY_REPORT: InspectorStateReport = {
  vars: [],
  flags: [],
  horizon: 0,
  priorityBase: 0,
  patchGeneration: 0,
  room: 0,
  egoX: 0,
  egoY: 0,
  egoDirection: 0,
};

export function createInspector(
  engine: Pick<
    EngineApi,
    "state" | "setDebugConsumer" | "readEngineState" | "debugEventsSince" | "debugWrite"
  >,
  presentation: Pick<
    Presentation,
    "debugOpen" | "debugViewMode" | "debugFrame" | "setExplodedMode" | "repaint"
  >,
) {
  const { debugOpen, debugViewMode } = presentation;
  const tab = ref<InspectorTab>("screen");
  const overlayOn = ref(true);
  const inspectArmed = ref(false);
  const hover = ref<{
    point: PickPoint;
    inspection: { color: number; priority: number; owner: number | null } | null;
  }>();
  const picked = ref<(LatchedPick & { cropUrl: string }) | undefined>();

  // A new game, restore, or seek regresses the cycle — the latched
  // observation described a frame that no longer exists, so drop it.
  watch(presentation.debugFrame, (f) => {
    if (picked.value && latchIsStale(picked.value, f)) picked.value = undefined;
  });

  // ---- state polling -----------------------------------------------------------

  const report = ref<InspectorStateReport>();
  const changedVars = ref<Set<number>>(new Set());
  const changedFlags = ref<Set<number>>(new Set());
  let prevVars: number[] = [];
  let prevFlags: number[] = [];

  function changed(prev: number[], next: number[]): Set<number> {
    const out = new Set<number>();
    if (prev.length === 256) for (let i = 0; i < 256; i++) if (next[i] !== prev[i]) out.add(i);
    return out;
  }

  async function pollState(): Promise<void> {
    try {
      const r: InspectorStateReport = (await engine.readEngineState()) ?? EMPTY_REPORT;
      changedVars.value = changed(prevVars, r.vars);
      changedFlags.value = changed(prevFlags, r.flags);
      prevVars = r.vars;
      prevFlags = r.flags;
      report.value = r;
    } catch {
      // Worker gone (eject / HMR) — stop polling.
      stopPoll();
    }
  }

  const events = ref<DebugEvent[]>([]);
  let lastEventSeq = 0;

  async function pollEvents(): Promise<void> {
    try {
      const r = await engine.debugEventsSince(lastEventSeq);
      const batch = (r["events"] as DebugEvent[] | undefined) ?? [];
      if (batch.length) {
        events.value = [...events.value, ...batch].slice(-800);
        lastEventSeq = Number(r["latestSeq"] ?? lastEventSeq);
      }
    } catch {
      /* same story as pollState */
    }
  }

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  function stopPoll(): void {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // ---- writes ------------------------------------------------------------------

  const pinnedVars = ref<Set<number>>(new Set());
  const pinnedFlags = ref<Set<number>>(new Set());
  const varEdit = ref<{ index: number; text: string }>();

  async function applyVar(): Promise<void> {
    const e = varEdit.value;
    if (!e) return;
    const v = Number.parseInt(e.text, 10);
    if (Number.isInteger(v) && v >= 0 && v <= 255) await engine.debugWrite([[e.index, v]], []);
    varEdit.value = undefined;
  }

  async function toggleFlag(i: number): Promise<void> {
    const cur = report.value?.flags[i] ?? 0;
    await engine.debugWrite([], [[i, cur ? 0 : 1]]);
  }

  function setOverlay(on: boolean): void {
    overlayOn.value = on;
    engine.setDebugConsumer("overlay", on);
  }

  function setInspectArmed(on: boolean): void {
    inspectArmed.value = on;
    engine.setDebugConsumer("inspect", on);
  }

  function toggleTrace(): void {
    engine.setDebugConsumer("trace", !engine.state.debugChannels.trace);
  }

  // ---- on and off --------------------------------------------------------------

  watch(debugViewMode, (mode) => {
    presentation.setExplodedMode(mode === "explode");
    // Exploded layers need the picture surface and ownership; registering
    // the consumer arms them while any other consumer's needs stay unioned.
    engine.setDebugConsumer("exploded", mode === "explode");
    presentation.repaint();
  });

  watch(debugOpen, (open) => {
    // The inspector needs the live object table and ownership buffer; the
    // trace consumer stays opt-in from the Timeline tab.
    engine.setDebugConsumer("dock", open);
    stopPoll();
    if (open) {
      void pollState();
      void pollEvents();
      pollTimer = setInterval(() => {
        void pollState();
        void pollEvents();
      }, 500);
      return;
    }
    // Off: release every channel this surface armed and forget the
    // session's observations; tab and pins are the viewer's to keep.
    engine.setDebugConsumer("overlay", false);
    engine.setDebugConsumer("inspect", false);
    engine.setDebugConsumer("trace", false);
    overlayOn.value = true;
    inspectArmed.value = false;
    hover.value = undefined;
    picked.value = undefined;
    varEdit.value = undefined;
    report.value = undefined;
    prevVars = [];
    prevFlags = [];
    events.value = [];
    lastEventSeq = 0;
    debugViewMode.value = "visual";
    presentation.setExplodedMode(false);
    presentation.repaint();
  });

  return {
    debugOpen,
    tab,
    overlayOn,
    inspectArmed,
    hover,
    picked,
    report,
    changedVars,
    changedFlags,
    events,
    pinnedVars,
    pinnedFlags,
    varEdit,
    applyVar,
    toggleFlag,
    setOverlay,
    setInspectArmed,
    toggleTrace,
  };
}

export type Inspector = ReturnType<typeof createInspector>;

const inspectorKey: InjectionKey<Inspector> = Symbol("agi-inspector");

export function provideInspector(inspector: Inspector): void {
  provide(inspectorKey, inspector);
}

export function useInspector(): Inspector {
  const inspector = inject(inspectorKey);
  if (!inspector) throw new Error("useInspector: App.vue did not provide the inspector");
  return inspector;
}
