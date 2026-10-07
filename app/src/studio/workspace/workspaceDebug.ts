import { numberedLabel } from "../../../../src/logic/numberedLabels.ts";
/** Source-aware debugging of the existing MAIN run. Loaded by an explicit debug action. */
import { computed, reactive, shallowRef } from "vue";
import { openContainer } from "../../../../src/container/container.ts";
import { disassembleLogic } from "../../../../src/logic/disassembler.ts";
import { PROFILES } from "../../../../src/runtime/profile.ts";
import { logicValues, type LogicValue } from "./debugValues.ts";
import { captureProjectBuild } from "../../../../src/authoring/projectBuild.ts";
import { readBindingsDocument } from "../../../../src/authoring/projectDocuments.ts";
import type { ProjectSnapshot } from "../../../../src/authoring/projectModel.ts";
import type {
  DebugBreakpointSpec,
  DebugBreakpointStatus,
} from "../../../../src/runtime/debugBreakpoints.ts";
import type { DebugValue } from "../../../../src/runtime/debugExpression.ts";
import type { ExecutionBoundary } from "../../../../src/runtime/engine.ts";
import type { ProfileId } from "../../../../src/runtime/profile.ts";
import type { createExecutionDebugLink } from "../../engine/executionDebugLink.ts";
import type { DebugResumeAction } from "../../worker/workerProtocol.ts";

type Build = ReturnType<typeof captureProjectBuild>;
export function runningPosition(
  build: Build | null,
  logic: number,
  pc: number,
  kind?: string,
): { logic: number; line: number } | null {
  const entry = build?.logics.find((row) => row.num === logic);
  if (entry?.authored === undefined || entry.authoredStart === undefined) return null;
  const candidates = entry.sourceMap?.entries.filter((row) => pc >= row.pc && pc < row.endPc) ?? [];
  const chosen =
    candidates.find((row) => row.pc === pc && row.kind === kind) ??
    candidates.find((row) => row.pc === pc) ??
    candidates.sort((a, b) => a.endPc - a.pc - (b.endPc - b.pc))[0];
  if (!chosen || chosen.start < entry.authoredStart) return null;
  return {
    logic,
    line: entry.authored.slice(0, chosen.start - entry.authoredStart).split("\n").length,
  };
}
export function createWorkspaceDebug(input: {
  link: ReturnType<typeof createExecutionDebugLink>;
  snapshot(): ProjectSnapshot | undefined;
  profile(): ProfileId;
  reveal(position: { logic: number; line: number }): void;
  stopped(): void;
  current?(): boolean;
  breakpoints?: readonly DebugBreakpointSpec[];
  disabled?: boolean;
  remember?(breakpoints: readonly DebugBreakpointSpec[], disabled: boolean): void;
}) {
  const state = reactive({
    epoch: 0,
    busy: false,
    stepping: false,
    error: "",
    breakpoints: [...(input.breakpoints ?? [])] as DebugBreakpointSpec[],
    breakpointsDisabled: input.disabled ?? false,
    statuses: [] as DebugBreakpointStatus[],
    watches: [] as { id: number; expression: string; value: string }[],
  });
  const build = shallowRef<Build | null>(null);
  const bindings = shallowRef<ReturnType<typeof readBindingsDocument>>({});
  const sources = shallowRef<Record<string, string>>({});
  const valuesByLogic = shallowRef<Record<string, LogicValue[]>>({});
  const usedValues = computed(() => {
    const stop = input.link.stopped.value;
    if (stop?.buildId !== build.value?.identity.buildId) return [];
    const logic = stop?.location?.logic;
    return logic === undefined ? [] : (valuesByLogic.value[String(logic)] ?? []);
  });
  let revision = 0;
  let watchSerial = 0;
  let pendingBuildId: string | undefined;
  let pendingSources: Record<string, string> | undefined;
  let disposed = false;
  const position = computed(() => {
    const location = input.link.stopped.value?.location;
    return location && build.value?.identity.buildId === input.link.stopped.value?.buildId
      ? runningPosition(build.value, location.logic, location.pc, location.kind)
      : null;
  });
  const status = computed(() => {
    if (!input.link.stopped.value) return "";
    const at = position.value;
    const location = input.link.stopped.value.location;
    return at
      ? `Paused at ${numberedLabel("logic", at.logic, { bindings: bindings.value }, "row")}, line ${at.line}`
      : location
        ? `Paused at ${numberedLabel("logic", location.logic, { bindings: bindings.value }, "row")}, byte ${location.pc}`
        : "Paused";
  });
  function capture(override?: Record<string, string>): void {
    const image = input.snapshot()?.lastAdmissibleBuild;
    if (!image) throw new Error("Build the project before debugging.");
    const documents = image.documents();
    bindings.value =
      typeof documents["bindings"] === "string" ? readBindingsDocument(documents["bindings"]) : {};
    sources.value =
      override ??
      Object.fromEntries(
        Object.entries(documents)
          .filter(([key, text]) => key.startsWith("logic:") && typeof text === "string")
          .map(([key, text]) => [key.slice(6), text as string]),
      );
    const container = openContainer(image.files(), { profile: PROFILES[input.profile()] });
    valuesByLogic.value = Object.fromEntries(
      Array.from({ length: 256 }, (_, num) => {
        const payload = container.getResource("logic", num);
        if (!payload) return [];
        const source =
          sources.value[String(num)] ??
          disassembleLogic(payload, { profile: PROFILES[input.profile()] });
        return [[String(num), logicValues(source, bindings.value)]];
      }).flat(),
    );
    build.value = captureProjectBuild({
      files: Object.fromEntries(image.files()),
      profileId: input.profile(),
      sources: sources.value,
      bindings: bindings.value,
    });
  }
  async function configure(): Promise<void> {
    if (!state.epoch) return;
    const reply = await input.link.query("debugConfigure", {
      epoch: state.epoch,
      revision: ++revision,
      breakpoints: state.breakpoints.map((point) => ({
        ...point,
        enabled: point.enabled && !state.breakpointsDisabled,
      })),
    });
    state.statuses = [...reply.breakpoints];
  }
  async function start(): Promise<void> {
    if (input.current?.() === false) return;
    if (state.epoch) return;
    capture();
    const values = Object.fromEntries(
      Object.entries(bindings.value).filter(([, binding]) =>
        ["variable", "flag", "string"].includes(binding.kind),
      ),
    );
    const reply = await input.link.query("debugAttach", {
      sources: sources.value,
      sourceBindings: bindings.value,
      bindings: values,
    });
    if (disposed || input.current?.() === false) {
      await input.link.query("debugDetach", { epoch: reply.epoch });
      return;
    }
    state.epoch = reply.epoch;
    revision = 0;
    await configure();
  }
  async function resume(action: DebugResumeAction): Promise<void> {
    const stop = input.link.stopped.value;
    if (!stop) return;
    const wasStepping = state.stepping;
    state.stepping = action !== "continue";
    try {
      await input.link.query("debugResume", { epoch: state.epoch, stopId: stop.stopId, action });
    } catch (error) {
      state.stepping = wasStepping;
      throw error;
    }
  }
  async function stop(): Promise<void> {
    if (state.epoch) await input.link.query("debugDetach", { epoch: state.epoch });
  }
  async function toggle(logic: number, line: number, column?: number): Promise<void> {
    const id = `${logic}:${line}`;
    const previous = state.breakpoints;
    state.breakpoints = previous.some((row) => row.id === id)
      ? previous.filter((row) => row.id !== id)
      : [
          ...previous,
          {
            id,
            logic,
            line,
            ...(column === undefined ? {} : { column }),
            mode: "statement",
            enabled: true,
          },
        ];
    try {
      await configure();
      input.remember?.(state.breakpoints, state.breakpointsDisabled);
    } catch (error) {
      state.breakpoints = previous;
      throw error;
    }
  }
  function valueText(value: DebugValue | undefined): string {
    return value === undefined ? "" : String(value);
  }
  async function evaluateWatches(): Promise<void> {
    const stop = input.link.stopped.value;
    if (!stop) return;
    for (const watch of state.watches) {
      try {
        const reply = await input.link.query("debugEvaluate", {
          epoch: state.epoch,
          stopId: stop.stopId,
          expression: watch.expression,
        });
        if (input.link.stopped.value?.stopId !== stop.stopId) return;
        watch.value = reply.ok ? valueText(reply.value) : (reply.error ?? "Check the expression.");
      } catch (error) {
        watch.value = String(error instanceof Error ? error.message : error);
      }
    }
  }
  const unsubscribe = input.link.subscribe((event) => {
    if (event.type === "debugDetached") {
      state.epoch = 0;
      state.stepping = false;
      return;
    }
    if (event.type === "debugSessionReset") {
      state.stepping = false;
      state.epoch = event.epoch;
      state.statuses = [...event.breakpoints];
      pendingBuildId = event.buildId;
      pendingSources = event.sources;
    }
    if (event.type === "debugStopped") {
      state.stepping = false;
      // A value write re-announces the stop: refresh values, keep the open view.
      if (!event.reasons.length || !event.reasons.every((reason) => reason.kind === "mutated")) {
        input.stopped();
        const at = position.value;
        if (at) input.reveal(at);
      }
      void evaluateWatches();
    }
  });
  async function run(operation: () => Promise<void>): Promise<void> {
    if (state.busy || disposed) return;
    state.busy = true;
    state.error = "";
    try {
      await operation();
    } catch (error) {
      state.error = String(error instanceof Error ? error.message : error);
    } finally {
      state.busy = false;
    }
  }
  return {
    state,
    position,
    status,
    sources,
    bindings,
    usedValues,
    stopped: input.link.stopped,
    refresh(): void {
      if (
        !pendingBuildId ||
        input.snapshot()?.lastAdmissibleBuild?.identity.buildId !== pendingBuildId
      )
        return;
      capture(pendingSources);
      pendingBuildId = undefined;
      pendingSources = undefined;
      const at = position.value;
      if (at) input.reveal(at);
    },
    start,
    resume,
    stop,
    toggle,
    async setDisabled(disabled: boolean): Promise<void> {
      const previous = state.breakpointsDisabled;
      state.breakpointsDisabled = disabled;
      try {
        await configure();
        input.remember?.(state.breakpoints, disabled);
      } catch (error) {
        state.breakpointsDisabled = previous;
        throw error;
      }
    },
    run,
    framePosition(frame: ExecutionBoundary["frames"][number]) {
      return runningPosition(build.value, frame.logic, frame.pc);
    },
    async setValue(kind: "variable" | "flag", slot: number, value: number): Promise<void> {
      const stop = input.link.stopped.value;
      if (!stop) return;
      await input.link.query("debugSetValues", {
        epoch: state.epoch,
        stopId: stop.stopId,
        ...(kind === "variable" ? { vars: [[slot, value]] } : { flags: [[slot, value]] }),
      });
    },
    removeWatch(id: number): void {
      state.watches = state.watches.filter((row) => row.id !== id);
    },
    async addWatch(expression: string): Promise<void> {
      if (!expression.trim()) return;
      state.watches.push({
        id: ++watchSerial,
        expression: expression.trim(),
        value: "Pause to inspect.",
      });
      await evaluateWatches();
    },
    dispose() {
      disposed = true;
      unsubscribe();
      void stop().catch(() => {});
    },
  };
}
export type WorkspaceDebug = ReturnType<typeof createWorkspaceDebug>;
