/** Workspace adapter; source mapping and debugger panels load on first activity. */
import { nextTick, onBeforeUnmount, shallowRef, watch, type ShallowRef } from "vue";
import type { ProjectSnapshot } from "../../../../src/authoring/projectModel.ts";
import type { ProfileId } from "../../../../src/runtime/profile.ts";
import type { EngineApi } from "../../engine/engineContext.ts";
import type { createWorkspaceEditor } from "../../shell/workspaceEditor.ts";
import type { DebugBreakpointSpec } from "../../../../src/runtime/debugBreakpoints.ts";
import type { WorkspaceDebug } from "./workspaceDebug.ts";
export interface LogicEditorHandle {
  cursor(): { lineNumber: number; column: number } | null | undefined;
  displayedSource(): string | undefined;
  navigate(line: number): void;
}
export function useWorkspaceDebug(input: {
  creating(): boolean;
  engine: EngineApi;
  editor: ReturnType<typeof createWorkspaceEditor>;
  snapshot: ShallowRef<ProjectSnapshot | undefined>;
  profile(): ProfileId;
}) {
  const { engine, editor, snapshot } = input;
  const debug = shallowRef<WorkspaceDebug>();
  const logicEditors = new Map<string, LogicEditorHandle>();
  let loading: Promise<WorkspaceDebug> | undefined;
  let retired = false;
  const project = engine.currentGame()?.projectId;
  const storageKey = project ? `monotio_agi.workspaceBreakpoints.${project}` : undefined;
  let points: DebugBreakpointSpec[] = [];
  try {
    const saved = JSON.parse(storageKey ? (localStorage.getItem(storageKey) ?? "null") : "null");
    if (Array.isArray(saved?.breakpoints))
      points = saved.breakpoints.filter(
        (point: DebugBreakpointSpec) =>
          typeof point.id === "string" &&
          Number.isInteger(point.logic) &&
          point.logic >= 0 &&
          point.logic <= 255 &&
          Number.isInteger(point.line) &&
          point.line > 0 &&
          point.mode === "statement" &&
          typeof point.enabled === "boolean",
      );
    editor.breakpointsDisabled.value = saved?.disabled === true;
  } catch {
    /* Keep this session's breakpoints when storage is unavailable. */
  }
  function remember(breakpoints: readonly DebugBreakpointSpec[], disabled: boolean): void {
    points = breakpoints.map((point) => ({ ...point }));
    editor.breakpointsDisabled.value = disabled;
    try {
      if (storageKey)
        localStorage.setItem(storageKey, JSON.stringify({ breakpoints: points, disabled }));
    } catch {
      /* Keep this session's breakpoints when storage is unavailable. */
    }
  }
  async function reveal(logic: number, line: number): Promise<void> {
    const key = `logic:${logic}`;
    if (!snapshot.value?.keys.includes(key)) return;
    if (editor.selected.value !== key) editor.open(key);
    await nextTick();
    logicEditors.get(key)?.navigate(line);
  }
  function load(): Promise<WorkspaceDebug> {
    loading ??= import("./workspaceDebug.ts").then(async ({ createWorkspaceDebug }) => {
      const controller = createWorkspaceDebug({
        link: await engine.loadExecutionDebug(),
        breakpoints: points,
        disabled: editor.breakpointsDisabled.value,
        remember,
        snapshot: () => snapshot.value,
        profile: input.profile,
        current: () => !retired && input.creating(),
        reveal: (at) => {
          void reveal(at.logic, at.line);
        },
        stopped: () => {
          editor.open("debug:variables");
        },
      });
      debug.value = controller;
      if (retired) controller.dispose();
      return controller;
    });
    return loading;
  }
  async function toggleBreakpoint(key: string, line: number, column?: number): Promise<void> {
    const controller = await load();
    if (
      controller.state.epoch &&
      logicEditors.get(key)?.displayedSource() !== controller.sources.value[key.slice(6)]
    ) {
      controller.state.error = "Show running source to set a breakpoint in this build.";
      editor.open("debug:breakpoints");
      return;
    }
    await controller.run(() => controller.toggle(Number(key.slice(6)), line, column));
  }
  editor.debugCommand.value = async (action) => {
    if (!input.creating()) return;
    const key = editor.selected.value;
    const cursor = key ? logicEditors.get(key)?.cursor() : undefined;
    if (action === "breakpoint") {
      if (key?.startsWith("logic:") && cursor)
        await toggleBreakpoint(key, cursor.lineNumber, cursor.column);
      return;
    }
    const controller = await load();
    if (!input.creating()) return;
    await controller.run(async () => {
      if (action === "start") await controller.resume("continue");
      else if (action === "stop") await controller.stop();
      else await controller.resume(action);
    });
  };
  editor.disableBreakpoints.value = async (disabled) => {
    if (debug.value) await debug.value.run(() => debug.value!.setDisabled(disabled));
    else remember(points, disabled);
  };
  async function armRun(): Promise<void> {
    if (loading) await loading;
    const breakpoints = debug.value?.state.breakpoints ?? points;
    if (!editor.breakpointsDisabled.value && breakpoints.some((point) => point.enabled)) {
      const controller = await load();
      await controller.start();
    } else if (debug.value?.state.epoch) await debug.value.stop();
  }
  if (points.length) void load();
  watch(
    () => debug.value?.status.value ?? "",
    (status) => {
      editor.debugStatus.value = status;
    },
  );
  watch(
    () => debug.value?.state.epoch ?? 0,
    (epoch) => {
      editor.debugging.value = epoch > 0;
    },
  );
  watch(snapshot, () => debug.value?.refresh());
  watch(
    () => debug.value?.state.error,
    (error) => {
      if (error) editor.open("problems");
    },
  );
  watch(input.creating, (creating) => {
    if (!creating) void debug.value?.stop().catch(() => {});
  });
  watch(
    editor.selected,
    (key) => {
      if (key === "problems" || key?.startsWith("debug:")) void load();
    },
    { immediate: true },
  );
  onBeforeUnmount(() => {
    retired = true;
    debug.value?.dispose();
    editor.debugCommand.value = undefined;
    editor.disableBreakpoints.value = undefined;
    editor.breakpointsDisabled.value = false;
    editor.debugging.value = false;
    editor.debugStatus.value = "";
  });
  return { debug, logicEditors, reveal, toggleBreakpoint, armRun };
}
