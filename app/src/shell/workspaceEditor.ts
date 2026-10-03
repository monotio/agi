/** Presentation shared by the Create host, top bar and keyboard adapter. */
import { computed, inject, provide, ref, shallowRef, type InjectionKey } from "vue";
import type { EngineApi } from "../engine/engineContext.ts";
import type { ChooserItem } from "./commands/chooserItems.ts";
import type { ReplyFormatter } from "../agent/workspaceAgent.ts";

export function createWorkspaceEditor(engine: EngineApi) {
  const debugCommand =
    shallowRef<
      (action: "start" | "stop" | "breakpoint" | "over" | "into" | "out") => Promise<void>
    >();
  const debugging = ref(false);
  const debugStatus = ref("");
  const flush = shallowRef<() => Promise<void>>();
  const discard = shallowRef<() => void>();
  const retry = shallowRef<() => Promise<void>>();
  const pictureLive = ref(false);
  const gameHost = shallowRef<HTMLElement | null>(null);
  const selected = ref<string>();
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
  const preview = ref<string>();
  const pendingAdmission = ref(false);
  const retained = ref<string[]>([]);
  const focus = ref(false);
  const panel = ref(false);
  const history = ref(false);
  const parts = shallowRef<readonly ChooserItem[]>([]);
  const save = ref("Saved");
  const canUndo = ref(false);
  const canRedo = ref(false);
  const busy = ref(false);
  const error = ref("");
  const split = ref(50);
  try {
    const stored = Number(localStorage.getItem("monotio_agi.workspaceSplit"));
    if (stored >= 25 && stored <= 75) split.value = stored;
  } catch {
    /* Use the default split. */
  }
  const effectiveSplit = computed(() =>
    kind.value === "view"
      ? Math.min(split.value, 30)
      : kind.value === "sound"
        ? Math.max(split.value, 60)
        : split.value,
  );
  const kind = computed(() => selected.value?.split(":")[0] ?? "");
  function pin(key: string): void {
    if (preview.value === key) preview.value = undefined;
  }
  function open(key: string, pinned = false): void {
    selected.value = key;
    agentContext.value = agentContexts[key] ?? null;
    if (!tabs.value.includes(key)) {
      if (!pinned && preview.value !== undefined) {
        const index = tabs.value.indexOf(preview.value);
        tabs.value.splice(index, 1, key);
      } else tabs.value.push(key);
      preview.value = pinned ? preview.value : key;
    }
    if (pinned) pin(key);
    if (!retained.value.includes(key)) retained.value.push(key);
    try {
      const pref = localStorage.getItem(`monotio_agi.workspaceFocus.${kind.value}`);
      focus.value = pref === null ? window.innerWidth < 1280 : pref === "on";
    } catch {
      focus.value = window.innerWidth < 1280;
    }
    if (focus.value) panel.value = history.value = false;
  }

  function close(key: string): void {
    if (preview.value === key) preview.value = undefined;
    const index = tabs.value.indexOf(key);
    tabs.value = tabs.value.filter((tab) => tab !== key);
    if (selected.value === key)
      selected.value = tabs.value[Math.min(index, tabs.value.length - 1)] ?? undefined;
  }
  function toggleFocus(): void {
    if (selected.value === undefined) return;
    focus.value = !focus.value;
    if (focus.value) panel.value = history.value = false;
    try {
      localStorage.setItem(`monotio_agi.workspaceFocus.${kind.value}`, focus.value ? "on" : "off");
    } catch {
      /* Remember for this page. */
    }
  }
  function resize(value: number): void {
    split.value = Math.min(75, Math.max(25, value));
    try {
      localStorage.setItem("monotio_agi.workspaceSplit", String(split.value));
    } catch {
      /* Remember for this page. */
    }
  }
  async function step(direction: "undo" | "redo"): Promise<void> {
    const session = engine.getProjectSession();
    if (!session || busy.value) return;
    busy.value = true;
    save.value = "Saving…";
    error.value = "";
    try {
      const outcome = await session[direction]();
      if (outcome && !["committed", "diagnostics", "unchanged"].includes(outcome.status))
        error.value = "This change needs a fresh room. Return to the room and retry.";
    } catch (cause) {
      error.value = String(cause instanceof Error ? cause.message : cause);
    } finally {
      busy.value = false;
    }
  }
  function reset(): void {
    selected.value = undefined;
    agentContext.value = null;
    agentPrefill.value = null;
    agentMessages.value = [];
    for (const key of Object.keys(agentContexts)) delete agentContexts[key];
    tabs.value = [];
    preview.value = undefined;
    pendingAdmission.value = false;
    retained.value = [];
    focus.value = false;
    panel.value = history.value = false;
    parts.value = [];
  }
  return {
    debugCommand,
    debugging,
    debugStatus,
    flush,
    discard,
    retry,
    pictureLive,
    gameHost,
    selected,
    agentContext,
    agentPrefill,
    returnFromAgent,
    agentMessages,
    setAgentContext,
    tabs,
    preview,
    pin,
    pendingAdmission,
    effectiveSplit,
    retained,
    focus,
    panel,
    history,
    parts,
    save,
    canUndo,
    canRedo,
    busy,
    error,
    split,
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
