/** Presentation shared by the Create host, top bar and keyboard adapter. */
import { buildZip } from "../archive/zip.ts";
import {
  computed,
  inject,
  markRaw,
  provide,
  ref,
  shallowReactive,
  shallowRef,
  type Component,
  type InjectionKey,
} from "vue";
import type { ProjectContent } from "../../../src/authoring/projectContent.ts";
import type { ResourceRevision } from "../../../src/gameIdentity.ts";
import type { EngineApi } from "../engine/engineContext.ts";
import type { ChooserItem } from "./commands/chooserItems.ts";
import type { LessonSession } from "../lessons/lessonCheck.ts";
import type { ReplyFormatter } from "../agent/workspaceAgent.ts";
import type { ComputedRoomRemovalReview } from "../project/projectSessionCore.ts";
import type { IconName } from "../ui/icons.ts";
import type { Launch } from "../../../src/authoring/launches.ts";

/** The dock a Create panel sits in. */
export type DockSide = "left" | "right";

/** A dock panel: one tab in the left or right dock. */
export interface CreatePanel {
  /** Stable id; the tab's test id is `dock-tab-<id>`. */
  readonly id: string;
  readonly dock: DockSide;
  readonly title: string;
  readonly icon?: IconName | undefined;
  /** Tabs sort by order, then registration. */
  readonly order?: number | undefined;
  /** The panel body. Without one the dock shows an empty placeholder. */
  readonly component?: Component | undefined;
}

/** A staged character-sheet candidate opened in the VIEW editor to repair before keeping. */
interface StagedViewRequest {
  /** The reference art the candidate was staged from. */
  readonly reference: string;
  readonly bytes: Uint8Array;
  /** The booted game's resource revision the bytes were read at. */
  readonly baseRevision: ResourceRevision;
}

/**
 * What a studio tab carries from whoever opened it: the Help guide lesson it
 * came from, the room that frames a picture, or a staged candidate.
 * Everything else the workspace reads live from the project.
 */
export interface StudioRequest {
  /** The tab key: `picture:N` or `view:N`. */
  readonly key: string;
  /** The room framing a picture: its Walk view and the room Update plays. */
  readonly room?: number | undefined;
  /** The Help guide lesson the editor opened from: its card and challenge. */
  readonly lesson?: LessonSession | undefined;
  readonly staged?: StagedViewRequest | undefined;
}

/** One group in the shared shortcut sheet (structural twin of KeySection). */
interface KeySheetSection {
  readonly title: string;
  readonly rows: readonly { keys: readonly string[]; does: string }[];
}
/** An editor's contribution to the shared shortcut sheet. */
export interface KeySheet {
  readonly name: string;
  readonly sections: readonly KeySheetSection[];
  /** Where the keys work, when the default line about the canvas does not fit. */
  readonly where?: string;
}
/** One rare action in the frame's ⋯ menu (Share a clip, Export…). */
export interface WorkspaceFrameAction {
  readonly id: string;
  readonly label: string;
  readonly disabled?: boolean | undefined;
  readonly title?: string | undefined;
  readonly testId?: string | undefined;
  readonly run: () => void;
}

export function createWorkspaceEditor(engine: EngineApi) {
  const debugCommand =
    shallowRef<
      (action: "start" | "stop" | "breakpoint" | "over" | "into" | "out") => Promise<void>
    >();
  const debugging = ref(false);
  const debugStatus = ref("");
  const flush = shallowRef<() => Promise<void>>();
  const discard = shallowRef<() => Promise<void>>();
  const retry = shallowRef<() => Promise<void>>();
  const update = shallowRef<(restartRoom?: boolean) => Promise<void>>();
  const discardDrafts = shallowRef<() => Promise<void>>();
  const changeCount = ref(0);
  const problemCount = ref(0);
  const updatedParts = ref(0);
  const updateResult = ref("");
  const actionRoom = ref<number>();
  const actionRoomName = ref("");
  const launchChoices = shallowRef<readonly Launch[]>([]);
  const selectedLaunch = ref("carry");
  const selectLaunch = shallowRef<(id: string) => Promise<void>>();
  const openLaunchEditor = shallowRef<(mode: "new" | "edit", room: number) => void>();
  function requestLaunchEditor(mode: "new" | "edit"): void {
    const room = actionRoom.value;
    if (room === undefined) return;
    if (openLaunchEditor.value) openLaunchEditor.value(mode, room);
    else error.value = "The Launch editor is still opening. Try again.";
  }
  const phonePlaytest = ref(false);
  const removalReview = shallowRef<ComputedRoomRemovalReview>();
  const studioRequests = shallowRef<Readonly<Record<string, StudioRequest>>>({});
  const panels = shallowReactive(new Map<string, CreatePanel>());
  /** Add (or replace, by id) a dock panel. Returns the unregister function. */
  function registerPanel(panel: CreatePanel): () => void {
    const entry: CreatePanel = panel.component
      ? { ...panel, component: markRaw(panel.component) }
      : panel;
    panels.set(panel.id, entry);
    return () => {
      if (panels.get(panel.id) === entry) panels.delete(panel.id);
    };
  }
  // The shell's docks: the world map left, the assistant right.
  registerPanel({ id: "world", dock: "left", title: "World", icon: "map", order: 0 });
  registerPanel({ id: "assistant", dock: "right", title: "Assistant", icon: "sparkles", order: 0 });
  /** The dock a panel id sits in, when it is registered. */
  function panelDock(id: string): DockSide | undefined {
    return panels.get(id)?.dock;
  }

  const selected = ref<string>();
  /** The one shortcut sheet: open flag and per-tab section providers. */
  const keysOpen = ref(false);
  const keySheets = shallowRef<Record<string, () => KeySheet | undefined>>({});
  /** Register an editor's key-sheet provider under its tab key; returns unregister. */
  function registerKeySheet(tabKey: string, provider: () => KeySheet | undefined): () => void {
    keySheets.value = { ...keySheets.value, [tabKey]: provider };
    return () => {
      const next = { ...keySheets.value };
      delete next[tabKey];
      keySheets.value = next;
    };
  }
  /** The shared status bar's quiet size note per tab (e.g. "2.1 KB · 214 commands"). */
  const statusMeta = shallowRef<Record<string, () => string>>({});
  function registerStatusMeta(tabKey: string, provider: () => string): () => void {
    statusMeta.value = { ...statusMeta.value, [tabKey]: provider };
    return () => {
      const next = { ...statusMeta.value };
      delete next[tabKey];
      statusMeta.value = next;
    };
  }
  /** Rare frame actions an editor contributes under its tab key (the ⋯ menu). */
  const frameActions = shallowRef<Record<string, () => readonly WorkspaceFrameAction[]>>({});
  function registerFrameActions(
    tabKey: string,
    actions: () => readonly WorkspaceFrameAction[],
  ): () => void {
    frameActions.value = { ...frameActions.value, [tabKey]: actions };
    return () => {
      const next = { ...frameActions.value };
      delete next[tabKey];
      frameActions.value = next;
    };
  }
  const nameLocation = shallowRef<{ key: string; line: number; serial: number }>();
  const agentPrefill = shallowRef<{
    text: string;
    context?: string;
    readOnly: boolean;
    formatReply?: ReplyFormatter;
  } | null>(null);
  const returnFromAgent = shallowRef<() => void>();
  const agentMessages = shallowRef<readonly { role: string; text: string; context?: string }[]>([]);
  const agentContext = shallowRef<{ label: string; text: string } | null>(null);
  const agentContexts: Record<string, { label: string; text: string } | null> = {};
  function setAgentContext(key: string, context: { label: string; text: string } | null): void {
    agentContexts[key] = context;
    if (selected.value === key) agentContext.value = context;
  }
  const tabs = ref<string[]>([]);
  const pendingAdmission = ref(false);
  const retained = ref<string[]>([]);
  const focus = ref(false);
  const partsOpen = ref(false);
  const partsScroll = ref(0);
  const history = ref(false);
  const parts = shallowRef<readonly ChooserItem[]>([]);
  const save = ref("Saved");
  const readOnly = ref(false);
  const pendingChanges = ref(false);
  const unsavedEdits = shallowRef<() => Readonly<Record<string, ProjectContent>>>();
  const canUndo = ref(false);
  const canRedo = ref(false);
  const busy = ref(false);
  const error = ref("");
  const exitRefusal = ref(false);
  const split = ref(50);
  const chosenSplit = ref(false);
  const splitAxis = ref<"horizontal" | "vertical">("vertical");
  try {
    if (localStorage.getItem("monotio_agi.workspaceSplitAxis") === "horizontal")
      splitAxis.value = "horizontal";
  } catch {
    /* Stay stacked. */
  }
  /** Viewport queries the frame layout shares: phones, and the narrow
      fallback that turns Side by side into Stacked instead of squeezing. */
  const phoneFrame = ref(false);
  const narrowFrame = ref(false);
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    const narrow = window.matchMedia("(max-width: 1023px)");
    const phone = window.matchMedia("(max-width: 600px)");
    narrowFrame.value = narrow.matches;
    phoneFrame.value = phone.matches;
    narrow.addEventListener("change", (event) => (narrowFrame.value = event.matches));
    phone.addEventListener("change", (event) => (phoneFrame.value = event.matches));
  }
  /** The arrangement the frame actually shows. */
  const stackedLayout = computed(
    () => phoneFrame.value || narrowFrame.value || splitAxis.value === "vertical",
  );
  function setSplitAxis(axis: "horizontal" | "vertical"): void {
    splitAxis.value = axis;
    try {
      localStorage.setItem("monotio_agi.workspaceSplitAxis", axis);
    } catch {
      /* Remember for this page. */
    }
  }
  try {
    const stored = Number(localStorage.getItem("monotio_agi.workspaceSplit"));
    if (stored >= 25 && stored <= 75) {
      split.value = stored;
      chosenSplit.value = true;
    }
  } catch {
    /* Use the default split. */
  }
  const effectiveSplit = computed(() =>
    chosenSplit.value
      ? split.value
      : kind.value === "view"
        ? Math.min(split.value, 30)
        : kind.value === "sound"
          ? Math.max(split.value, 60)
          : split.value,
  );
  const kind = computed(() => selected.value?.split(":")[0] ?? "");
  /** Open or focus a tab; tabs stay until the person closes them. */
  function open(key: string): void {
    phonePlaytest.value = false;
    selected.value = key;
    agentContext.value = agentContexts[key] ?? null;
    if (!tabs.value.includes(key)) tabs.value.push(key);
    if (!retained.value.includes(key)) retained.value.push(key);
    try {
      const pref = localStorage.getItem(`monotio_agi.workspaceFocus.${kind.value}`);
      focus.value = pref === "on";
    } catch {
      focus.value = false;
    }
    if (focus.value) history.value = false;
  }

  function close(key: string): void {
    const index = tabs.value.indexOf(key);
    tabs.value = tabs.value.filter((tab) => tab !== key);
    if (selected.value === key)
      selected.value = tabs.value[Math.min(index, tabs.value.length - 1)] ?? undefined;
  }
  function toggleFocus(): void {
    if (selected.value === undefined) return;
    focus.value = !focus.value;
    if (focus.value) history.value = false;
    try {
      localStorage.setItem(`monotio_agi.workspaceFocus.${kind.value}`, focus.value ? "on" : "off");
    } catch {
      /* Remember for this page. */
    }
  }
  function resize(value: number): void {
    chosenSplit.value = true;
    split.value = Math.min(75, Math.max(25, value));
    try {
      localStorage.setItem("monotio_agi.workspaceSplit", String(split.value));
    } catch {
      /* Remember for this page. */
    }
  }
  async function step(
    direction: "undo" | "redo",
    review?: ComputedRoomRemovalReview,
  ): Promise<void> {
    const session = engine.getProjectSession();
    if (!session || busy.value || readOnly.value) return;
    busy.value = true;
    updatedParts.value = 0;
    updateResult.value = "";
    save.value = "Saving…";
    error.value = "";
    try {
      const outcome = direction === "undo" ? await session.undo(review) : await session.redo();
      if (outcome?.status === "reviewRequired") {
        removalReview.value = outcome.review;
        return;
      }
      removalReview.value = undefined;
      if (outcome?.status === "diagnostics") {
        const problem =
          outcome.diagnostics.find(
            (d) => d.severity === "error" && d.code !== "computed-room-jump",
          ) ?? outcome.diagnostics.find((d) => d.severity === "error");
        if (problem) error.value = `${problem.message} Change its references and try Undo again.`;
      } else if (
        outcome &&
        !["committed", "draft", "diagnostics", "unchanged", "restartRequired"].includes(
          outcome.status,
        )
      )
        error.value =
          ("diagnostics" in outcome &&
            outcome.diagnostics.find((d) => d.severity === "error")?.message) ||
          "This change needs a fresh room. Return to the room and retry.";
    } catch (cause) {
      error.value = String(cause instanceof Error ? cause.message : cause);
    } finally {
      busy.value = false;
    }
  }
  async function downloadUnsavedEdits(): Promise<void> {
    error.value = "";
    try {
      const buffers = unsavedEdits.value?.() ?? {};
      const files = Object.entries(buffers).map(([key, content]) => ({
        name: `unsaved-edits/${key.replace(":", "-")}.${typeof content === "string" ? "txt" : "bin"}`,
        data: typeof content === "string" ? new TextEncoder().encode(content) : content.slice(),
      }));
      const url = URL.createObjectURL(new Blob([buildZip(files)], { type: "application/zip" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "agi-unsaved-edits.zip";
      link.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      const message = (cause instanceof Error ? cause.message : String(cause)).replace(/[.]+$/, "");
      error.value = `Could not download unsaved edits: ${message}. Try Download unsaved edits again.`;
    }
  }
  function reset(): void {
    changeCount.value = problemCount.value = updatedParts.value = 0;
    updateResult.value = "";
    actionRoom.value = undefined;
    actionRoomName.value = "";
    launchChoices.value = [];
    selectedLaunch.value = "carry";
    nameLocation.value = undefined;
    studioRequests.value = {};
    selected.value = undefined;
    removalReview.value = undefined;
    phonePlaytest.value = false;
    agentContext.value = null;
    agentPrefill.value = null;
    agentMessages.value = [];
    for (const key of Object.keys(agentContexts)) delete agentContexts[key];
    tabs.value = [];
    pendingAdmission.value = false;
    retained.value = [];
    focus.value = false;
    partsOpen.value = false;
    partsScroll.value = 0;
    keysOpen.value = false;
    keySheets.value = {};
    statusMeta.value = {};
    frameActions.value = {};
    history.value = false;
    parts.value = [];
  }
  return {
    studioRequests,
    registerPanel,
    panelDock,
    debugCommand,
    debugging,
    debugStatus,
    flush,
    discard,
    retry,
    update,
    discardDrafts,
    changeCount,
    problemCount,
    updatedParts,
    updateResult,
    actionRoom,
    actionRoomName,
    launchChoices,
    selectedLaunch,
    selectLaunch,
    openLaunchEditor,
    requestLaunchEditor,
    phonePlaytest,
    removalReview,
    selected,
    nameLocation,
    agentContext,
    agentPrefill,
    returnFromAgent,
    agentMessages,
    setAgentContext,
    tabs,
    pendingAdmission,
    effectiveSplit,
    retained,
    focus,
    partsOpen,
    partsScroll,
    keysOpen,
    keySheets,
    registerKeySheet,
    statusMeta,
    registerStatusMeta,
    frameActions,
    registerFrameActions,
    stackedLayout,
    narrowFrame,
    phoneFrame,
    history,
    parts,
    save,
    readOnly,
    pendingChanges,
    unsavedEdits,
    downloadUnsavedEdits,
    canUndo,
    canRedo,
    busy,
    error,
    exitRefusal,
    split,
    splitAxis,
    setSplitAxis,
    kind,
    open,
    close,
    toggleFocus,
    resize,
    step,
    reset,
  };
}
const key: InjectionKey<ReturnType<typeof createWorkspaceEditor>> = Symbol("workspace-editor");
export function provideWorkspaceEditor(editor: ReturnType<typeof createWorkspaceEditor>): void {
  provide(key, editor);
}
export function useWorkspaceEditor() {
  const editor = inject(key);
  if (!editor) throw new Error("The workspace editor is unavailable.");
  return editor;
}
/** The frame's editor, or null where an editor mounts outside the workspace (dev harness). */
export function useMaybeWorkspaceEditor() {
  return inject(key, null);
}
