<script setup lang="ts">
import AgentTaskControls from "./AgentTaskControls.vue";
import GameHeader from "./GameHeader.vue";
import AiSettingsDialog from "./AiSettings.vue";
import SoundPreview from "./SoundPreview.vue";
import TouchControls from "./TouchControls.vue";
import WalkthroughBar from "./WalkthroughBar.vue";
import WalkthroughTransport from "./WalkthroughTransport.vue";
import DebugDock from "./DebugDock.vue";
import type { DebugViewMode } from "./debugView.ts";
import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  onWatcherCleanup,
  ref,
  shallowRef,
  useTemplateRef,
  watch,
} from "vue";
import { useEngine, type Frame, type AutosaveRecord, type ModalKind } from "./useEngine.ts";
import { AgiStage } from "./three/AgiStage.ts";
import { FRAME_HEIGHT, FRAME_WIDTH, compositeFrame, type ScreenViewMode } from "./composite.ts";
import { GLYPH_CURSOR, TEXT_COLS } from "../../src/runtime/textSurface.ts";
import { MODEL_OPTIONS } from "./agent/llmClient.ts";
import { reconcileGameIndex } from "./gameStorage.ts";
import { type WalkthroughCheckpoint } from "./walkthrough.ts";
import { FUNCTION_KEYS, registeredKey, pcKey, movementDirection } from "./gameControls.ts";
import { AGI_KEY, DIRECTION_KEYS } from "../../src/runtime/keys.ts";

import { provideEngine } from "./engineContext.ts";
import { createShellBridge, provideShellBridge } from "./shellBridge.ts";
import { createAiSettings, provideAiSettings } from "./useAiSettings.ts";
import { createGameLibrary, provideGameLibrary } from "./useGameLibrary.ts";
import SetupPanel from "./SetupPanel.vue";

const canvas = useTemplateRef("canvas");
const testMode = import.meta.env.MODE === "test";
const gpuCanvas = useTemplateRef("gpuCanvas");
const inputLine = ref("");
const promptLine = ref("");
const composing = ref(false);
const touchControls = ref(
  localStorage.getItem("monotio_agi.touchControls") === "on" ||
    (localStorage.getItem("monotio_agi.touchControls") !== "off" &&
      matchMedia("(any-pointer: coarse)").matches),
);
const viewportHeight = ref(window.visualViewport?.height ?? window.innerHeight);
watch(touchControls, (enabled) =>
  localStorage.setItem("monotio_agi.touchControls", enabled ? "on" : "off"),
);
// Empty until a GPU stage exists, so the 2d fallback canvas stays visible when
// WebGPU/WebGL init fails or has not finished yet.
const gpuBackend = ref<string>();
const crtEnabled = ref<boolean>(
  testMode
    ? localStorage.getItem("monotio_agi.crt") === "on"
    : localStorage.getItem("monotio_agi.crt") !== "off",
);
let stage: AgiStage | null = null;
let lastFrame: Frame | null = null;
/** Composed 320x200 RGBA frame shared by the probe canvas and the GPU stage. */
const composed = new Uint8ClampedArray(FRAME_WIDTH * FRAME_HEIGHT * 4);
/** Text-only composite feeding the exploded view's front plane. */
const composedText = new Uint8ClampedArray(FRAME_WIDTH * FRAME_HEIGHT * 4);

watch(crtEnabled, (on) => {
  localStorage.setItem("monotio_agi.crt", on ? "on" : "off");
  if (stage) {
    stage.crt = on;
  }
});
const heldMovementKeys = new Set<string>();
let touchMovementActive = false;

function onMenuHashChange(): void {
  if (location.hash === "#create-adventure") shellBridge.openCreateSection(false);
}

/** AGI Inspector: open state, view mode, and the latest frame for the dock. */
const debugOpen = ref(false);
const debugViewMode = ref<DebugViewMode>("visual");
/** Visual/priority wipe position for the dock's Split mode (0..1 of frame width). */
const splitAt = ref(0.5);
const debugFrame = shallowRef<Frame | null>(null);

const engine = useEngine(
  (frame) => {
    lastFrame = frame;
    debugFrame.value = frame;
    present(frame);
  },
  {
    onPromptType: (text) => {
      promptLine.value = text;
      echoPrompt();
    },
  },
);
provideEngine(engine);
const {
  state,
  resumeAudio,
  discoverGames,
  bootAgentGame,
  startWalkthrough,
  stopWalkthrough,
  setWalkthroughSpeed,
  toggleWalkthroughPause,
  toggleWalkthroughPauseOnDialog,
  advanceDialog,
  resumeWalkthrough,
  seekToTick,
  seekToCheckpoint,
  sendInput,
  sendEdit,
  sendDirection,
  sendKey,
  dismissModal,
  submitPrompt,
  currentGame,
  clearAgentLog,
  releaseAgentAudioPreviews,
  openPowerUp,
  closePowerUp,
  submitPowerUp,
  stopAgent,
  continueAgent,
  discardAgent,
  resumeLastGame,
  resumeFromRecord,
  flushAutosave,
  lastAutosaveRecord,
  shutdownEngine,
  setDebugChannels,
  debugWrite,
  debugEventsSince,
  readEngineState,
} = engine;

const shellBridge = createShellBridge();
provideShellBridge(shellBridge);
const aiSettingsDialog = useTemplateRef<{ show(): void; close(): void }>("aiSettingsDialog");
const ai = createAiSettings(engine, {
  dialog: aiSettingsDialog,
  releaseMovement,
  createButtonEl: () => shellBridge.createButtonEl(),
  assistantInputEl: () => powerUpEl.value ?? null,
});
provideAiSettings(ai);
const {
  taskBudget,
  aiSettings,
  provider,
  model,
  aiConfigured,
  aiSettingsSaving,
  aiSettingsError,
  aiSettingsUnavailable,
  openAiSettings,
  applyAiSettings,
  onAiSettingsClosed,
  llmConfig,
} = ai;

const lib = createGameLibrary(engine, ai, shellBridge);
provideGameLibrary(lib);
const { exportBusy, exportRefusal, exportSavedProgressKey, activeTemplate } = lib;

const expandedLogIds = ref<Set<string>>(new Set());
const copyFeedback = ref<string>("");
async function onStartWalkthrough(targetGame: string): Promise<void> {
  await resumeAudio();
  clearPlayHash();
  await startWalkthrough(targetGame);
}
shellBridge.startWalkthrough = (target) => void onStartWalkthrough(target);

const PLAY_HASH_PREFIX = "#play/";

/** The target key the URL says is being played, or null outside a game. */
function playHashGameKey(): string | null {
  if (!location.hash.startsWith(PLAY_HASH_PREFIX)) return null;
  try {
    return decodeURIComponent(location.hash.slice(PLAY_HASH_PREFIX.length));
  } catch {
    return null;
  }
}

/** The URL is the source of truth for "a game is running": name it. */
function markPlayHash(targetKey: string): void {
  const target = `${PLAY_HASH_PREFIX}${encodeURIComponent(targetKey)}`;
  if (location.hash !== target) history.replaceState(null, "", target);
}

const WATCH_HASH_PREFIX = "#watch/";

/** The walkthrough the URL names, plus the tick the tape had reached. */
function watchHashTarget(): { alias: string; tick: number } | null {
  if (!location.hash.startsWith(WATCH_HASH_PREFIX)) return null;
  try {
    const [alias, tick] = decodeURIComponent(location.hash.slice(WATCH_HASH_PREFIX.length)).split(
      "/",
    );
    if (!alias) return null;
    const t = Number(tick);
    return { alias, tick: Number.isFinite(t) && t > 0 ? Math.floor(t) : 0 };
  } catch {
    return null;
  }
}

/** While a walkthrough runs the URL names it, so a reload re-enters playback. */
function markWatchHash(alias: string, tick = 0): void {
  const target = `${WATCH_HASH_PREFIX}${encodeURIComponent(alias)}${tick > 0 ? `/${tick}` : ""}`;
  if (location.hash !== target) history.replaceState(null, "", target);
}

/** Back at the picker the URL must not name a game any more. */
function clearPlayHash(): void {
  if (location.hash.startsWith(PLAY_HASH_PREFIX) || location.hash.startsWith(WATCH_HASH_PREFIX))
    history.replaceState(null, "", `${location.pathname}${location.search}`);
}

function toggleLogEntry(id: string): void {
  if (expandedLogIds.value.has(id)) {
    expandedLogIds.value.delete(id);
  } else {
    expandedLogIds.value.add(id);
  }
}

async function copyDebugBundle(): Promise<void> {
  const current = currentGame();
  const bundle = {
    exportedAt: new Date().toISOString(),
    game: current
      ? {
          projectId: current.projectId,
          alias: current.alias,
          hash: current.hash,
          title: current.title,
          revision: current.revision,
          source: current.installed ? "installed" : "authored",
        }
      : {
          projectId: activeTemplate.value.id,
          title: activeTemplate.value.title,
          source: "draft",
        },
    mode: state.walkthrough.active ? "walkthrough" : current ? "play" : "authoring",
    provider: provider.value,
    model: model.value,
    budgetUsd: taskBudget.value,
    phase: state.phase,
    error: state.error || null,
    textRows: state.rows,
    agentLog: state.agentLog.map((entry) => {
      const copy = { ...entry };
      delete copy.audio;
      return copy;
    }),
  };
  try {
    await navigator.clipboard.writeText(JSON.stringify(bundle, null, 2));
    copyFeedback.value = "Copied!";
    setTimeout(() => {
      copyFeedback.value = "";
    }, 2500);
  } catch {
    copyFeedback.value = "Copy failed";
    setTimeout(() => {
      copyFeedback.value = "";
    }, 2500);
  }
}

/**
 * Present one engine frame: compose picture band + text cells into the
 * 320x200 frame, draw it on the 2D probe canvas (Playwright pixel probe and
 * no-GPU fallback) and upload it to the GPU stage when one exists.
 */
let cachedImageData: ImageData | null = null;
const composedPic = new Uint8ClampedArray(FRAME_WIDTH * FRAME_HEIGHT * 4);
let pendingPresentationFrame: Frame | null = null;
let pendingTextOverride: Uint8Array | undefined = undefined;
let presentationRaf: number | null = null;

function renderFrameNow(frame: Frame, textOverride?: Uint8Array): void {
  const mode = debugViewMode.value;
  // Explode composites normally — its GPU layers sample this texture and mask
  // against the priority buffer. With no stage it falls back to the flat
  // priority view (canvas2d has no layers).
  const compositeMode: ScreenViewMode = mode === "explode" ? (stage ? "visual" : "priority") : mode;
  // Explode needs the text surface as its own texture: baked into the frame
  // it would smear across every depth band a dialog happens to cover.
  const exploded = mode === "explode" && stage !== null;
  compositeFrame(
    {
      visual: frame.visual,
      priority: frame.priority,
      text: textOverride ?? frame.text,
      picRow: frame.picRow,
    },
    composed,
    compositeMode,
    splitAt.value,
    exploded ? "skip" : "compose",
  );
  if (exploded) {
    compositeFrame(
      {
        visual: frame.visual,
        priority: frame.priority,
        text: textOverride ?? frame.text,
        picRow: frame.picRow,
      },
      composedText,
      "visual",
      0.5,
      "only",
    );
    stage!.setTextLayer(composedText);
    stage!.setPriority(frame.priority, frame.picRow);
    // Exploded band layers sample the picture surface, not the composed
    // frame — otherwise a sprite would punch a hole in its own wall.
    const picVisual = frame.picVisual ?? frame.visual;
    const picPriority = frame.picPriority ?? frame.priority;
    compositeFrame(
      { visual: picVisual, priority: picPriority, text: frame.text, picRow: frame.picRow },
      composedPic,
      "visual",
      0.5,
      "skip",
    );
    stage!.setPictureData(composedPic, picPriority);
    if (frame.ownership) stage!.setOwnershipData(frame.ownership);
  }
  if (!stage || testMode) {
    const ctx = canvas.value?.getContext("2d");
    if (ctx) {
      cachedImageData ??= ctx.createImageData(FRAME_WIDTH, FRAME_HEIGHT);
      cachedImageData.data.set(composed);
      ctx.putImageData(cachedImageData, 0, 0);
    }
  }
  if (stage) {
    stage.render(composed, true);
  }
}

watch(splitAt, () => {
  if (lastFrame) renderFrameNow(lastFrame);
});

watch(debugViewMode, (mode) => {
  stage?.setExplodedMode(mode === "explode");
  // Exploded layers need the picture surface and ownership — arm them so the
  // next frame carries picVisual/picPriority/ownership.
  setDebugChannels(
    mode === "explode" ? { picture: true, objects: true, ownership: true } : { picture: false },
  );
  if (lastFrame) renderFrameNow(lastFrame);
});

watch(debugOpen, (open) => {
  // The dock needs the live object table and ownership buffer; the trace
  // channel stays opt-in from the Timeline tab.
  setDebugChannels({ objects: open, ownership: open });
  if (!open) {
    setDebugChannels({ trace: false, picture: false });
    debugViewMode.value = "visual";
    stage?.setExplodedMode(false);
    if (lastFrame) renderFrameNow(lastFrame);
  }
});

/** Exploded-view projection for the inspector overlay (null while flat). */
function debugProject(band: number, x: number, y: number) {
  return stage?.projectBandPoint(band, x, y) ?? null;
}
function debugPick3d(nx: number, ny: number) {
  return stage?.pickAt(nx, ny) ?? null;
}

/** Pointer parallax over the exploded priority layers. */
function onScreenPointerMove(ev: PointerEvent): void {
  if (!stage?.explodedMode) return;
  const el = ev.currentTarget as HTMLElement;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return;
  stage.setPointer(
    ((ev.clientX - r.left) / r.width) * 2 - 1,
    ((ev.clientY - r.top) / r.height) * 2 - 1,
  );
}

function present(frame: Frame, textOverride?: Uint8Array, immediate = false): void {
  lastFrame = frame;
  if (immediate || textOverride !== undefined || typeof requestAnimationFrame === "undefined") {
    if (presentationRaf !== null) {
      cancelAnimationFrame(presentationRaf);
      presentationRaf = null;
    }
    pendingPresentationFrame = null;
    pendingTextOverride = undefined;
    renderFrameNow(frame, textOverride);
    return;
  }
  pendingPresentationFrame = frame;
  pendingTextOverride = undefined;
  if (presentationRaf === null) {
    presentationRaf = requestAnimationFrame(() => {
      presentationRaf = null;
      const targetFrame = pendingPresentationFrame;
      const targetText = pendingTextOverride;
      pendingPresentationFrame = null;
      pendingTextOverride = undefined;
      if (targetFrame) {
        renderFrameNow(targetFrame, targetText);
      }
    });
  }
}

const hasKeyPrompt = computed(() =>
  state.rows.some((r) => r.toLowerCase().includes("press any key")),
);
/**
 * Name the keys that satisfy have.key for this screen. Keys the script maps
 * to controllers (set.key) are not raw keys — Enter on the demo pack selects
 * a demo instead of dismissing its "press any key" page.
 */
const keyPromptHint = computed(() => {
  const mapped = new Set(state.controls.map((b) => b.key));
  const usable = (
    [
      [AGI_KEY.ENTER, "Enter"],
      [0x20, "Space"],
    ] as [number, string][]
  ).filter(([key]) => !mapped.has(key));
  if (usable.length === 0) return "Press any key to start";
  return `Press ${usable.map(([, name]) => name).join(" / ")} to start`;
});

/** Pointer type of the last screen press; the click event carries none. */
let screenPointerType = "mouse";

function onScreenPointerDown(ev: PointerEvent): void {
  screenPointerType = ev.pointerType;
}

function onScreenClick(): void {
  resumeAudio();
  if (state.phase !== "running") return;
  if (state.walkthrough.active) {
    if (advanceDialog()) return;
    if (state.walkthrough.status === "paused") {
      resumeWalkthrough();
      return;
    }
  }
  if (state.prompt) {
    inputEl.value?.focus({ preventScroll: true });
    return;
  }
  // A tap (touch or pen) still advances title screens and acknowledges
  // message windows — touch devices have no hardware keyboard. A mouse click
  // only focuses the game for typing: it must never act as Enter, or
  // focusing the window could skip a screen, acknowledge a modal, or submit a
  // half-typed command. The pointer type decides, not the touch-controls
  // mode: `any-pointer: coarse` also matches hybrid laptops with a mouse.
  if (touchControls.value && screenPointerType !== "mouse") {
    if (state.modal !== null) {
      if (state.modal !== "save" && state.modal !== "restore") dismissModal();
      return;
    }
    // Empty Enter (0x000d) wakes have.key() e.g. title screens or prompts
    sendKey(0x000d);
    return;
  }
  inputEl.value?.focus({ preventScroll: true });
}
watch(
  () => state.phase,
  (phase) => {
    if (phase === "running" && !touchControls.value) {
      nextTick(() => {
        inputEl.value?.focus({ preventScroll: true });
      });
    }
  },
);

const inputEl = useTemplateRef("inputEl");
watch(
  () => state.gameEdit,
  (edit) => {
    if (edit) inputLine.value = edit.text;
  },
);

function triggerKey(code: number): void {
  resumeAudio();
  shellBridge.closeNavMenus();
  sendKey(code);
  if (!touchControls.value) inputEl.value?.focus({ preventScroll: true });
}

/**
 * Blocking get.string / get.num prompt: the engine drew the prompt and is
 * blocked in the worker, so the live edit is echoed here, straight into a
 * copy of the last frame's text cells after the prompt, with the cursor
 * glyph — still on the CRT, never in the DOM.
 */
watch(
  () => state.prompt,
  (prompt) => {
    promptLine.value = "";
    if (prompt && !state.walkthrough.seeking) echoPrompt();
  },
);

function echoPrompt(): void {
  if (state.walkthrough.seeking) return;
  const prompt = state.prompt;
  if (!prompt || !lastFrame) return;
  const text = lastFrame.text.slice();
  const start = prompt.col + prompt.prompt.length;
  const a = text[(prompt.row * TEXT_COLS + prompt.col) * 2 + 1] || 0x0f;
  for (let i = 0; i <= prompt.maxLen && start + i < TEXT_COLS; i++) {
    const at = (prompt.row * TEXT_COLS + start + i) * 2;
    const ch =
      i < promptLine.value.length
        ? promptLine.value.charCodeAt(i)
        : i === promptLine.value.length
          ? GLYPH_CURSOR
          : 0x20;
    text[at] = ch;
    text[at + 1] = a;
  }
  present(lastFrame, text);
}

function onPromptKey(ev: KeyboardEvent): void {
  const prompt = state.prompt!;
  // Native input/composition events own editable text, including Android IMEs.
  if (ev.target === inputEl.value && ev.key !== "Enter" && ev.key !== "Escape") return;
  ev.preventDefault();
  if (ev.key === "Escape") {
    submitPrompt("", true);
  } else if (ev.key === "Enter") {
    submitPrompt(promptLine.value);
  } else if (ev.key === "Backspace") {
    promptLine.value = promptLine.value.slice(0, -1);
    echoPrompt();
  } else if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
    if (prompt.kind === "getnum" && !/[0-9]/.test(ev.key)) return;
    if (promptLine.value.length >= prompt.maxLen) return;
    promptLine.value += ev.key;
    echoPrompt();
  }
}

/** Keys while an engine modal (print window, inventory, menu…) is open. */
function onModalKey(ev: KeyboardEvent): void {
  const activeModal =
    state.walkthrough.active && window.__AGI_REPLAY__?.latest?.state.modalKind
      ? (window.__AGI_REPLAY__?.latest?.state.modalKind as ModalKind)
      : state.modal;
  if (state.waitingForKey || activeModal === "save" || activeModal === "restore") {
    const code = pcKey(ev);
    if (code !== undefined) {
      ev.preventDefault();
      sendKey(code);
    }
    return;
  }
  const dir = movementDirection(ev);
  if (dir !== undefined) {
    sendDirection(dir);
    ev.preventDefault();
    return;
  }
  const code =
    ev.key === "Enter"
      ? AGI_KEY.ENTER
      : ev.key === "Escape"
        ? AGI_KEY.ESCAPE
        : ev.key === "Home"
          ? AGI_KEY.HOME
          : ev.key === "End"
            ? AGI_KEY.END
            : ev.key === "PageUp"
              ? AGI_KEY.PAGE_UP
              : ev.key === "PageDown"
                ? AGI_KEY.PAGE_DOWN
                : ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey
                  ? ev.key.charCodeAt(0) & 0xff
                  : null;
  if (code === null) return;
  ev.preventDefault();
  sendKey(code);
}

/**
 * Whole-page keyboard trapping: the browser chrome should disappear. Arrows
 * always steer ego (even while the input line is focused — the classic AGI
 * feel); any printable keystroke jumps into the input line; Enter dismisses
 * the print modal first, then submits.
 */
/**
 * The remix: one round button on the
 * game frame. Click it and the world freezes at the next cycle boundary while
 * the agent takes your instruction; the bubble streams its tool calls; its
 * closing sentence closes the bubble, the room re-enters if it was patched,
 * and the interpreter resumes on exactly the cycle it parked on.
 */
const powerUpLine = ref("");
const powerUpEl = useTemplateRef("powerUpEl");

/** The live tool-call feed for this remix turn: the transcript tail. */
const asking = computed(() => state.powerUp.mode === "ask");
const creatingRoom = computed(() => state.powerUp.mode === "room");
const powerUpFeed = computed(() => {
  if (state.powerUp.feedStartSeq !== undefined) {
    return state.agentLog.filter((entry) => (entry.seq ?? 0) >= state.powerUp.feedStartSeq!);
  }
  return state.agentLog.slice(state.powerUp.feedStart);
});
const powerUpAudio = computed(() => powerUpFeed.value.flatMap((entry) => entry.audio ?? []));
const latestAgentAudio = computed(
  () => [...state.agentLog].reverse().find((entry) => entry.audio?.length)?.audio ?? [],
);

const conversationEl = useTemplateRef("conversationEl");
const followConversation = ref(true);
function onConversationScroll(): void {
  const el = conversationEl.value;
  if (el) followConversation.value = el.scrollHeight - el.clientHeight - el.scrollTop < 24;
}
watch(
  [
    () => state.powerUp.open,
    () => state.powerUp.messages.length,
    () => state.agentTask?.progress?.text,
  ],
  ([open, count], [wasOpen, previousCount]) => {
    if (!open) return;
    if (!wasOpen || (count !== previousCount && state.powerUp.messages.at(-1)?.role === "user"))
      followConversation.value = true;
    const el = conversationEl.value;
    if (el && followConversation.value) el.scrollTop = el.scrollHeight;
  },
  { flush: "post" },
);
const progressFeedEl = useTemplateRef("progressFeedEl");
const followProgress = ref(true);
const REMIX_ACTIVITY: Record<string, string> = {
  read_state: "Inspecting the game…",
  read_objects: "Inspecting the characters…",
  read_frames: "Looking at the scene…",
  read_logic: "Reading the room’s behavior…",
  read_picture: "Examining the scenery…",
  read_words: "Reading the vocabulary…",
  list_resources: "Exploring the game’s resources…",
  inspect_world_bible: "Checking the world…",
  write_view: "Drawing sprites…",
  write_picture: "Drawing the scenery…",
  write_logic_source: "Updating the room’s behavior…",
  write_words: "Adding vocabulary…",
  write_inventory_objects: "Updating inventory…",
  write_sound: "Composing sound…",
  playtest_room: "Checking the updated room…",
};
const remixActivity = computed(() => {
  const latest = powerUpFeed.value.at(-1);
  const tool = (latest?.data as { tool?: string } | undefined)?.tool;
  if (latest?.kind === "error") return "Adjusting after a problem…";
  if (tool && latest?.kind === "request")
    return (
      REMIX_ACTIVITY[tool] ??
      (creatingRoom.value
        ? "Building the next room…"
        : asking.value
          ? "Investigating…"
          : "Working on your changes…")
    );
  if (tool && latest?.kind === "response") return "Reviewing results…";
  return creatingRoom.value
    ? "Imagining the next room…"
    : state.powerUp.needsConfig
      ? "Connecting to your model…"
      : asking.value
        ? "Thinking…"
        : "Thinking about your changes…";
});

function onProgressScroll(): void {
  const el = progressFeedEl.value;
  if (el) followProgress.value = el.scrollHeight - el.clientHeight - el.scrollTop < 24;
}

function jumpToLatest(): void {
  followProgress.value = true;
  const el = progressFeedEl.value;
  if (el) {
    el.scrollTop = el.scrollHeight;
    el.focus({ preventScroll: true });
  }
}

watch(
  [() => state.powerUp.open, () => state.powerUp.feedStart, () => powerUpFeed.value.at(-1)?.id],
  ([open, start], [wasOpen, previousStart]) => {
    if (!open) return;
    if (!wasOpen || start !== previousStart) followProgress.value = true;
    const el = progressFeedEl.value;
    if (followProgress.value && el) el.scrollTop = el.scrollHeight;
  },
  { flush: "post" },
);
watch(
  () => state.powerUp.open,
  async (open, wasOpen) => {
    await nextTick();
    if (open && creatingRoom.value) progressFeedEl.value?.focus({ preventScroll: true });
    else if (!open && wasOpen && creatingRoom.value) inputEl.value?.focus({ preventScroll: true });
  },
);
watch(progressFeedEl, (el) => {
  if (!el) return;
  const observer = new ResizeObserver(() => {
    if (followProgress.value) el.scrollTop = el.scrollHeight;
  });
  observer.observe(el);
  onWatcherCleanup(() => observer.disconnect());
});

/** The power-up bubble is draggable by its head and collapsible to a strip. */
const bubblePos = ref<{ x: number; y: number }>();
const bubbleCollapsed = ref(false);
let bubbleDrag: { px: number; py: number; ox: number; oy: number } | null = null;

function onBubbleHeadDown(ev: PointerEvent): void {
  const t = ev.target as HTMLElement;
  if (t.closest("button,input,textarea,select,a,summary")) return;
  const bubble = (ev.currentTarget as HTMLElement).closest(".agent-bubble");
  if (!(bubble instanceof HTMLElement)) return;
  const r = bubble.getBoundingClientRect();
  bubblePos.value = { x: r.left, y: r.top };
  bubbleDrag = { px: ev.clientX, py: ev.clientY, ox: r.left, oy: r.top };
  (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
  ev.preventDefault();
}

function onBubbleHeadMove(ev: PointerEvent): void {
  if (!bubbleDrag) return;
  bubblePos.value = {
    x: Math.min(Math.max(bubbleDrag.ox + ev.clientX - bubbleDrag.px, -160), window.innerWidth - 80),
    y: Math.min(Math.max(bubbleDrag.oy + ev.clientY - bubbleDrag.py, 0), window.innerHeight - 40),
  };
}

function onBubbleHeadUp(): void {
  bubbleDrag = null;
}

/** Split-mode wipe handle: a thin drag strip tracking the composited divider. */
let splitDragEl: HTMLElement | null = null;

function onSplitDown(ev: PointerEvent): void {
  splitDragEl = ev.currentTarget as HTMLElement;
  splitDragEl.setPointerCapture(ev.pointerId);
  ev.preventDefault();
}

function onSplitMove(ev: PointerEvent): void {
  if (!splitDragEl) return;
  const rect = splitDragEl.parentElement?.getBoundingClientRect();
  if (!rect || rect.width <= 0) return;
  splitAt.value = Math.min(0.98, Math.max(0.02, (ev.clientX - rect.left) / rect.width));
}

function onSplitUp(): void {
  splitDragEl = null;
}

async function onPowerUp(): Promise<void> {
  if (state.powerUp.busy) return;
  if (state.powerUp.open) {
    closePowerUp();
    inputEl.value?.focus({ preventScroll: true });
    return;
  }
  powerUpLine.value = "";
  await openPowerUp(llmConfig());
  await nextTick();
  powerUpEl.value?.focus({ preventScroll: true });
}

async function onPowerUpSubmit(): Promise<void> {
  const text = powerUpLine.value.trim();
  if (text.length === 0 || state.powerUp.busy) return;
  followProgress.value = true;
  powerUpLine.value = "";
  await submitPowerUp(text);
  if (!state.powerUp.open) inputEl.value?.focus({ preventScroll: true });
  else {
    await nextTick();
    powerUpEl.value?.focus({ preventScroll: true });
  }
}

function onPowerUpKey(ev: KeyboardEvent): void {
  if (ev.key === "Enter" && !ev.shiftKey) {
    ev.preventDefault();
    void onPowerUpSubmit();
    return;
  }
  if (ev.key !== "Escape") return;
  ev.preventDefault();
  ev.stopPropagation();
  closePowerUp();
  inputEl.value?.focus({ preventScroll: true });
}

function onGlobalKeydown(ev: KeyboardEvent): void {
  resumeAudio();
  const isInputReady = state.walkthrough.active ? true : state.inputReady;
  if (state.phase !== "running" || !isInputReady) return;
  if (
    state.walkthrough.active &&
    (state.walkthrough.status === "playing" ||
      state.walkthrough.status === "paused" ||
      state.walkthrough.status === "completed")
  ) {
    // The walkthrough drives the game; human keys own playback shortcuts only.
    if (ev.key === " " && !state.powerUp.open) {
      ev.preventDefault();
      toggleWalkthroughPause();
      return;
    }
    if (ev.key === "Enter" && !state.powerUp.open) {
      ev.preventDefault();
      if (state.walkthrough.status === "paused") {
        resumeWalkthrough();
        return;
      }
      if (advanceDialog()) return;
    }
    return;
  }
  if (ev.isComposing || ev.keyCode === 229) return;
  if (ev.target instanceof Element && ev.target.closest("dialog[open]")) return;
  // The bubble owns the keyboard while it is open: the world is frozen and
  // nothing typed here may reach the interpreter's input line.
  if (state.powerUp.open) {
    if (ev.key === "Escape") {
      ev.preventDefault();
      closePowerUp();
      if (!state.powerUp.open) inputEl.value?.focus({ preventScroll: true });
    }
    return;
  }
  // Page controls keep native keyboard behavior. The invisible input owns
  // game keys; Shift+Tab lets a player leave it even during a game modal.
  const target = ev.target;
  if (
    (target instanceof Element &&
      target !== inputEl.value &&
      target.closest("button, input, textarea, select, a, audio, summary, dialog")) ||
    (ev.key === "Tab" && ev.shiftKey)
  ) {
    return;
  }
  if (ev.key === "ScrollLock") {
    ev.preventDefault();
    sendKey(0x4600);
    return;
  }
  if (state.prompt) {
    onPromptKey(ev);
    return;
  }
  const activeModal =
    state.walkthrough.active && window.__AGI_REPLAY__?.latest?.state.modalKind
      ? (window.__AGI_REPLAY__?.latest?.state.modalKind as ModalKind)
      : state.modal;
  if (activeModal !== null) {
    onModalKey(ev);
    return;
  }

  // Text screens can ask a specific question: preserve the actual key.
  if (
    state.textMode ||
    state.waitingForKey ||
    (state.walkthrough.active && window.__AGI_REPLAY__?.latest?.blocked === "waitkey")
  ) {
    const key = pcKey(ev);
    if (key !== undefined) {
      ev.preventDefault();
      sendKey(key);
    }
    return;
  }

  // Intercept Function Keys F1..F10 (prevent browser reload, help, devtools)
  if (ev.key in FUNCTION_KEYS && !ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey) {
    ev.preventDefault();
    triggerKey(FUNCTION_KEYS[ev.key]!);
    return;
  }

  const dir = movementDirection(ev);
  if (dir !== undefined) {
    const physicalKey = ev.code && ev.code !== "Unidentified" ? ev.code : ev.key;
    if (!ev.repeat && !heldMovementKeys.has(physicalKey)) {
      heldMovementKeys.add(physicalKey);
      sendDirection(dir);
    }
    ev.preventDefault();
    return;
  }

  const shortcut = registeredKey(ev, state.controls);
  if (shortcut !== undefined) {
    ev.preventDefault();
    triggerKey(shortcut);
    return;
  }

  if (!state.inputEnabled) {
    const code = pcKey(ev);
    if (code !== undefined) {
      ev.preventDefault();
      sendKey(code);
    }
    return;
  }

  if (ev.key === "Escape") {
    ev.preventDefault();
    sendKey(0x001b);
    return;
  }

  const input = inputEl.value;
  // When input field is NOT focused:
  if (!input || ev.target !== input) {
    // If Enter or Space pressed while not typing, forward raw key event to wake have.key() (e.g. title screens)
    if (ev.key === "Enter" || ev.key === " ") {
      sendKey(ev.key === "Enter" ? 0x000d : 0x0020);
      ev.preventDefault();
      return;
    }
    if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      // Mirror the character into the input line exactly like the focused
      // path does: through the edit message only. The engine also appends
      // printable key events to its edit line, and a sendKey here would be
      // buffered until the next engine tick while the edit applies at once —
      // so the same character landed twice (the "llook" after Start over).
      // No waitKey can be pending here: a blocking key wait sets
      // state.waitingForKey, handled by the raw-key branch above.
      input?.focus({ preventScroll: true });
      inputLine.value += ev.key;
      sendEdit(inputLine.value);
      ev.preventDefault();
    }
    return;
  }

  // When input field IS focused:
  if (ev.key === "Enter") {
    ev.preventDefault();
    submit();
  }
}

function onGlobalKeyup(ev: KeyboardEvent): void {
  const physicalKey = ev.code && ev.code !== "Unidentified" ? ev.code : ev.key;
  if (!heldMovementKeys.delete(physicalKey)) return;
  if (state.phase === "running" && !state.walkthrough.active) {
    sendDirection(0);
    ev.preventDefault();
  }
}

/** The DOM input is the keyboard capture; its text lives on the engine's input row. */
function onInputEdit(event: Event): void {
  const input = event.target as HTMLInputElement;
  if (composing.value || (event instanceof InputEvent && event.isComposing)) return;
  if (state.prompt) {
    const prompt = state.prompt;
    promptLine.value = (
      prompt.kind === "getnum" ? input.value.replace(/[^0-9]/g, "") : input.value
    ).slice(0, Math.min(39, prompt.maxLen));
    input.value = promptLine.value;
    echoPrompt();
  } else {
    // An IME may insert or replace several characters without keydown. Only
    // that inserted range is new input; the rest may be an unfinished command.
    const previous = inputLine.value;
    const next = input.value;
    let start = 0;
    while (start < previous.length && start < next.length && previous[start] === next[start])
      start++;
    let oldEnd = previous.length;
    let newEnd = next.length;
    while (oldEnd > start && newEnd > start && previous[oldEnd - 1] === next[newEnd - 1]) {
      oldEnd--;
      newEnd--;
    }
    if (state.textMode || state.waitingForKey || state.modal !== null || !state.inputEnabled) {
      const entered =
        event instanceof InputEvent || event instanceof CompositionEvent
          ? (event.data ?? next.slice(start, newEnd))
          : next.slice(start, newEnd);
      for (const char of entered) sendKey(char.charCodeAt(0));
      // Raw-key answers do not edit the parser command that preceded them.
      input.value = previous;
      return;
    }
    let inserted = "";
    for (const char of next.slice(start, newEnd)) {
      const code = char.charCodeAt(0);
      if (state.controls.some((binding) => binding.key === code)) sendKey(code);
      else inserted += char;
    }
    inputLine.value = next.slice(0, start) + inserted + next.slice(newEnd);
    if (input.value !== inputLine.value) input.value = inputLine.value;
    sendEdit(inputLine.value);
  }
}

function onCompositionEnd(event: CompositionEvent): void {
  composing.value = false;
  onInputEdit(event);
}

function onTouchDirection(dir: number): void {
  resumeAudio();
  if (dir === 0) {
    // Match the release to its press: walking may have opened a dialog, and
    // a navigation gesture may end after that dialog has already closed.
    const wasWalking = touchMovementActive;
    touchMovementActive = false;
    if (wasWalking && state.phase === "running") sendDirection(0);
    return;
  }
  if (state.phase !== "running" || state.powerUp.open || state.prompt) return;
  touchMovementActive = state.modal === null && !state.waitingForKey;
  if (state.waitingForKey || state.modal === "save" || state.modal === "restore")
    sendKey(DIRECTION_KEYS[dir]!);
  else sendDirection(dir);
}

function onVirtualKey(code: number): void {
  resumeAudio();
  if (state.phase !== "running" || state.powerUp.open || composing.value) return;
  if (state.prompt) {
    if (code === AGI_KEY.ENTER || code === AGI_KEY.ESCAPE) {
      submitPrompt(code === AGI_KEY.ESCAPE ? "" : promptLine.value, code === AGI_KEY.ESCAPE);
    } else if (code === AGI_KEY.BACKSPACE) {
      promptLine.value = promptLine.value.slice(0, -1);
      echoPrompt();
    } else if (
      code >= AGI_KEY.SPACE &&
      code <= 126 &&
      promptLine.value.length < Math.min(39, state.prompt.maxLen)
    ) {
      const char = String.fromCharCode(code);
      if (state.prompt.kind !== "getnum" || /[0-9]/.test(char)) promptLine.value += char;
      echoPrompt();
    }
    return;
  }
  const activeModal =
    state.walkthrough.active && window.__AGI_REPLAY__?.latest?.state.modalKind
      ? (window.__AGI_REPLAY__?.latest?.state.modalKind as ModalKind)
      : state.modal;
  if (
    activeModal !== null ||
    state.textMode ||
    state.waitingForKey ||
    !state.inputEnabled ||
    state.controls.some((binding) => binding.key === code)
  ) {
    sendKey(code);
  } else if (code === AGI_KEY.ENTER) submit();
  else if (code === AGI_KEY.BACKSPACE || (code >= AGI_KEY.SPACE && code <= 126)) {
    inputLine.value =
      code === AGI_KEY.BACKSPACE
        ? inputLine.value.slice(0, -1)
        : inputLine.value + String.fromCharCode(code);
    sendEdit(inputLine.value);
  } else sendKey(code);
}

function releaseMovement(): void {
  if (!state.walkthrough.active && heldMovementKeys.size) sendDirection(0);
  heldMovementKeys.clear();
}

function onTakeControl(): void {
  releaseMovement();
  stopWalkthrough(true);
  nextTick(() => {
    inputEl.value?.focus({ preventScroll: true });
  });
}

function onWalkthroughSeekTick(tick: number): void {
  void seekToTick(tick);
}

function onWalkthroughSeekCheckpoint(cp: WalkthroughCheckpoint): void {
  void seekToCheckpoint(cp);
}

function onWalkthroughScrubbing(active: boolean): void {
  state.walkthrough.scrubbing = active;
}

function resizeViewport(): void {
  viewportHeight.value = window.visualViewport?.height ?? window.innerHeight;
}

function submit(): void {
  if (composing.value) return;
  if (state.prompt) {
    submitPrompt(promptLine.value);
    return;
  }
  const text = inputLine.value.trim();
  if (text.length === 0) {
    // Empty Enter sends raw Enter key (0x000d) to wake have.key() loops (e.g. title screens)
    sendKey(0x000d);
    return;
  }
  sendInput(text);
  inputLine.value = "";
  if (inputEl.value) inputEl.value.value = "";
  sendEdit("");
}

/**
 * The page is going away: ask for one last snapshot before it does. A reload
 * is the case this whole path exists for, and `visibilitychange` is the last
 * event that still reliably gets a turn of the event loop.
 */
function onPageHidden(): void {
  if (document.visibilityState === "hidden") {
    releaseMovement();
    if (state.walkthrough.active && state.walkthrough.alias)
      markWatchHash(state.walkthrough.alias, state.walkthrough.tick);
    void flushAutosave();
  }
}

function onPageHide(): void {
  if (state.walkthrough.active && state.walkthrough.alias)
    markWatchHash(state.walkthrough.alias, state.walkthrough.tick);
  void flushAutosave();
}

/**
 * Vite HMR (development only; the whole block is dead code in a build).
 *
 * A dev reload is a reload like any other, but it is one we get told about in
 * advance — and Vite awaits both of these hooks, so the flush is real rather
 * than best-effort:
 *
 * - `vite:beforeFullReload` fires before `location.reload()` and its listeners
 *   are awaited (`Promise.allSettled` in the client's `notifyListeners`), so a
 *   bounded flush lands in localStorage before the page goes. Editing anything
 *   the engine imports (useEngine.ts, engine.worker.ts, src/) takes this path.
 * - `dispose` is awaited before the replacement module is imported. Editing
 *   THIS component hot-reloads it without a page reload, which re-runs setup
 *   and builds a new engine, so the freshest image is handed over in memory
 *   through `import.meta.hot.data` and the resume needs no storage round trip
 *   and no reload at all. The old instance's worker is terminated in
 *   `onUnmounted` rather than here: a template-only update disposes the module
 *   but keeps the running instance, and killing its engine would be wrong.
 * - `vite:beforeUpdate` is belt and braces for the updates that do neither.
 */
if (import.meta.hot) {
  import.meta.hot.on("vite:beforeFullReload", async () => {
    await flushAutosave(500);
  });
  import.meta.hot.on("vite:beforeUpdate", async () => {
    await flushAutosave(300);
  });
  import.meta.hot.dispose(async (data: Record<string, unknown>) => {
    await flushAutosave(500);
    data["monotio_agi_resume"] = lastAutosaveRecord();
  });
}

onMounted(async () => {
  window.addEventListener("blur", releaseMovement);
  window.visualViewport?.addEventListener("resize", resizeViewport);
  window.addEventListener("resize", resizeViewport);
  window.addEventListener("keydown", onGlobalKeydown);
  window.addEventListener("keyup", onGlobalKeyup);
  window.addEventListener("hashchange", onMenuHashChange);
  document.addEventListener("visibilitychange", onPageHidden);
  window.addEventListener("pagehide", onPageHide);
  try {
    await reconcileGameIndex();
    lib.refreshLibrary();
  } catch (error) {
    lib.libraryActionError.value = `Your saved game library could not be refreshed: ${String(error).replace(/^Error: /, "")}`;
  }
  lib.mountCatalog();
  onMenuHashChange();
  await discoverGames();
  // Nobody loses progress to a reload: while a game runs the URL names it
  // (`#play/<aliasOrProjectId>`), and only a reload carrying that hash boots straight back
  // into the autosave. A reload from the picker lands on the picker, which
  // keeps offering the Resume card from the pending autosave.
  // A hot module update hands the running game over in memory: no reload
  // happened, so there is nothing to read back and the resume is instant.
  const handover = import.meta.hot?.data?.["monotio_agi_resume"] as AutosaveRecord | undefined;
  if (import.meta.hot?.data) delete import.meta.hot.data["monotio_agi_resume"];
  lib.refreshPendingAutosave();
  const playKey = playHashGameKey();
  const watchTarget = watchHashTarget();
  if (handover) await resumeFromRecord(handover, llmConfig());
  else if (watchTarget)
    // startWalkthrough drives the tape to completion: await would suspend the
    // rest of mount — including the GPU stage the walkthrough paints into.
    void startWalkthrough(watchTarget.alias, { initialTick: watchTarget.tick }).catch((e) => {
      state.phase = "error";
      state.error = e instanceof Error ? e.message : String(e);
    });
  else if (
    playKey &&
    (playKey === lib.pendingAutosave.value?.game.projectId ||
      (lib.pendingAutosave.value?.game.installed &&
        (playKey === lib.pendingAutosave.value?.game.folder ||
          playKey === lib.pendingAutosave.value?.game.hash ||
          playKey === lib.pendingAutosave.value?.game.alias)))
  )
    await resumeLastGame(llmConfig());
  if (state.phase === "idle") clearPlayHash();
  if (gpuCanvas.value) {
    stage = await AgiStage.create(gpuCanvas.value);
    gpuBackend.value = stage?.backend;
    if (stage) {
      stage.crt = crtEnabled.value;
      if (lastFrame) present(lastFrame);
    }
  }
});

onUnmounted(() => {
  lib.unmountCatalog();
  releaseMovement();
  window.removeEventListener("blur", releaseMovement);
  window.visualViewport?.removeEventListener("resize", resizeViewport);
  window.removeEventListener("resize", resizeViewport);
  if (presentationRaf !== null && typeof cancelAnimationFrame !== "undefined") {
    cancelAnimationFrame(presentationRaf);
    presentationRaf = null;
  }
  stage?.dispose();
  stage = null;
  window.removeEventListener("keydown", onGlobalKeydown);
  window.removeEventListener("keyup", onGlobalKeyup);
  window.removeEventListener("hashchange", onMenuHashChange);
  document.removeEventListener("visibilitychange", onPageHidden);
  window.removeEventListener("pagehide", onPageHide);
  releaseAgentAudioPreviews();
  // Development only: this instance is being replaced by a hot update, and its
  // worker would otherwise keep ticking (and autosaving) behind the new one.
  if (import.meta.hot) shutdownEngine();
});
// The URL is the source of truth for "a game is running": name it while the
// game runs. A remix can turn the running game into a new game without
// leaving the running phase, so the unpause after a remix turn re-asserts the
// hash from whatever is booted then. Back at the picker (the player ejected,
// or a boot failed) the hash is cleared and the autosave slot is re-read so
// the offer below matches storage.
watch(
  () => [state.phase, state.paused, state.walkthrough.active, state.walkthrough.tick] as const,
  ([phase, paused, watching]) => {
    if (phase === "running") {
      if (!paused) {
        if (watching && state.walkthrough.alias) {
          markWatchHash(state.walkthrough.alias, state.walkthrough.tick);
        } else {
          const game = currentGame();
          const playIdentifier = game?.installed
            ? (game.folder ?? game.hash ?? game.alias)
            : game?.projectId;
          if (playIdentifier) markPlayHash(playIdentifier);
        }
      }
      return;
    }
    if (phase === "idle" || phase === "error") {
      clearPlayHash();
      lib.syncMenuPhase();
    }
  },
);
</script>

<template>
  <div
    class="app-container"
    :class="{ 'at-menu': state.phase === 'idle' || state.phase === 'error' }"
    :style="{ '--visible-height': `${viewportHeight}px` }"
  >
    <GameHeader
      :touch-controls="touchControls"
      :crt-enabled="crtEnabled"
      :gpu-backend="gpuBackend"
      :debug-open="debugOpen"
      :export-busy="exportBusy"
      :export-refusal="exportRefusal"
      :export-saved-progress-key="exportSavedProgressKey"
      @update:touch-controls="touchControls = $event"
      @update:crt-enabled="crtEnabled = $event"
      @update:debug-open="debugOpen = $event"
      @trigger-key="triggerKey"
      @export-zip="(project, savedProgress) => lib.onExportAgiZip(true, project, savedProgress)"
      @start-over="lib.onStartOver"
      @start-walkthrough="onStartWalkthrough"
    >
      <WalkthroughBar
        v-if="state.walkthrough.active"
        :walkthrough="state.walkthrough"
        @take-control="onTakeControl"
      />
      <p
        v-if="!state.walkthrough.active && state.walkthrough.error"
        class="export-refusal"
        data-testid="walkthrough-error"
        role="alert"
      >
        {{ state.walkthrough.error }}
      </p>
    </GameHeader>
    <AiSettingsDialog
      ref="aiSettingsDialog"
      :settings="aiSettings"
      :budget-usd="taskBudget"
      :models="MODEL_OPTIONS"
      :allow-stub="testMode"
      :saving="aiSettingsSaving"
      :error="aiSettingsError"
      @save="applyAiSettings"
      @closed="onAiSettingsClosed"
    />

    <SetupPanel />

    <!-- Screen Area (Hidden until game is running) -->
    <div class="play-area" :class="{ 'with-touch': touchControls && state.phase === 'running' }">
      <div
        v-show="state.phase === 'running'"
        class="screen"
        :class="{
          active: state.phase === 'running',
          shake: state.shake,
          remixing: state.powerUp.open,
        }"
        @click="onScreenClick"
        @pointerdown="onScreenPointerDown"
        @pointermove="onScreenPointerMove"
      >
        <canvas
          v-show="!!gpuBackend"
          ref="gpuCanvas"
          class="game-surface"
          width="960"
          height="600"
          data-testid="gpu-canvas"
        />
        <!-- The composed 320x200 frame: Playwright pixel probe and no-GPU fallback. -->
        <canvas
          v-show="!gpuBackend"
          ref="canvas"
          class="game-surface"
          width="320"
          height="200"
          data-testid="game-canvas"
        />

        <!-- Native keyboard/IME capture; the engine renders the only visible command line. -->
        <form
          v-if="state.phase === 'running'"
          class="input-row"
          @click.stop
          @submit.prevent="onVirtualKey(AGI_KEY.ENTER)"
        >
          <input
            id="game-command"
            :disabled="state.powerUp.open || (!state.inputReady && !state.walkthrough.active)"
            aria-label="Game command"
            aria-describedby="game-input-help"
            ref="inputEl"
            :value="state.prompt ? promptLine : inputLine"
            :inputmode="state.prompt?.kind === 'getnum' ? 'numeric' : 'text'"
            data-testid="input-line"
            autocomplete="off"
            autocapitalize="off"
            enterkeyhint="send"
            spellcheck="false"
            @input="onInputEdit"
            @compositionstart="composing = true"
            @compositionend="onCompositionEnd"
          />
        </form>

        <!-- The remix: freeze the world and ask the agent to change it. -->
        <button
          type="button"
          class="power-up"
          :class="{ armed: state.powerUp.open }"
          data-testid="power-up"
          :disabled="(creatingRoom && state.powerUp.open) || state.recording.active"
          :aria-label="
            creatingRoom && state.powerUp.open
              ? 'Creating the next room'
              : state.powerUp.open
                ? 'Close assistant'
                : 'Ask or remix this game'
          "
          :aria-expanded="state.powerUp.open"
          :title="state.powerUp.open ? 'Back to game (Esc)' : 'Ask, remix, or inspect this game'"
          @click.stop="onPowerUp"
        >
          <span class="power-up-glyph">✦</span>
        </button>

        <!-- Draggable visual/priority wipe for the dock's Split mode. -->
        <div
          v-if="debugViewMode === 'split' && debugOpen"
          class="split-handle"
          :style="{ left: `${splitAt * 100}%` }"
          data-testid="split-handle"
          role="slider"
          aria-label="Split position"
          :aria-valuenow="Math.round(splitAt * 100)"
          aria-valuemin="0"
          aria-valuemax="100"
          title="Drag to move the split"
          @pointerdown.stop="onSplitDown"
          @pointermove="onSplitMove"
          @pointerup="onSplitUp"
          @pointercancel="onSplitUp"
          @click.stop
        >
          <span class="split-grip">◂▸</span>
        </div>

        <DebugDock
          v-if="debugOpen && state.phase === 'running'"
          :frame="debugFrame"
          :objects="state.debugObjects"
          :trace="state.debugTrace"
          :channels="state.debugChannels"
          :view-mode="debugViewMode"
          :has-gpu="!!gpuBackend"
          :read-state="readEngineState"
          :events-since="debugEventsSince"
          :write="debugWrite"
          :project="debugProject"
          :pick3d="debugPick3d"
          @set-channels="setDebugChannels"
          @set-view-mode="debugViewMode = $event"
          @close="debugOpen = false"
        />

        <div
          v-if="state.powerUp.open"
          class="agent-bubble"
          :class="{ floating: bubblePos !== undefined, collapsed: bubbleCollapsed }"
          :style="bubblePos ? { left: `${bubblePos.x}px`, top: `${bubblePos.y}px` } : {}"
          data-testid="agent-bubble"
          @click.stop
          @pointerdown.stop
        >
          <div
            class="agent-bubble-head"
            data-testid="agent-bubble-head"
            title="Drag to move"
            @pointerdown="onBubbleHeadDown"
            @pointermove="onBubbleHeadMove"
            @pointerup="onBubbleHeadUp"
            @pointercancel="onBubbleHeadUp"
          >
            <span class="agent-bubble-grip">⠿</span>
            <span v-if="creatingRoom" class="agent-bubble-title">{{
              state.powerUp.error ? "Could not create this room" : "Creating the next room"
            }}</span>
            <div v-else class="agent-mode-switch" role="group" aria-label="Agent mode">
              <button
                type="button"
                data-testid="agent-mode-ask"
                :aria-pressed="asking"
                :disabled="state.powerUp.busy"
                title="Ask questions without changing the game"
                @click="state.powerUp.mode = 'ask'"
              >
                Ask
              </button>
              <button
                type="button"
                data-testid="agent-mode-remix"
                :aria-pressed="!asking"
                :disabled="state.powerUp.busy"
                title="Make changes to this game"
                @click="state.powerUp.mode = 'remix'"
              >
                Remix
              </button>
            </div>
            <button
              type="button"
              class="agent-inspect"
              :class="{ on: debugOpen }"
              data-testid="inspect-toggle"
              :aria-pressed="debugOpen"
              title="AGI inspector: priority views, objects, vars, flags, trace"
              @click="debugOpen = !debugOpen"
            >
              ◈ Inspect
            </button>
            <span class="agent-bubble-right">
              <span class="agent-bubble-room" data-testid="agent-bubble-room"
                >{{ asking ? "Read-only" : "Paused" }} ·
                {{ state.powerUp.room > 0 ? `room ${state.powerUp.room}` : "…" }}</span
              >
              <button
                type="button"
                class="bubble-icon"
                data-testid="agent-bubble-collapse"
                :title="bubbleCollapsed ? 'Expand' : 'Collapse to the title bar'"
                @click="bubbleCollapsed = !bubbleCollapsed"
              >
                {{ bubbleCollapsed ? "+" : "−" }}
              </button>
              <button
                v-if="!creatingRoom || !state.powerUp.busy"
                type="button"
                class="bubble-icon bubble-close remix-close"
                data-testid="agent-bubble-close"
                aria-label="Back to game"
                title="Back to game (Esc)"
                :disabled="state.powerUp.busy"
                @click="onPowerUp"
              >
                ×
              </button>
            </span>
          </div>
          <div v-if="!creatingRoom && !aiConfigured" class="ai-connect assistant-connect">
            <p>Connect your AI provider to ask about or remix this game.</p>
            <button
              type="button"
              class="ui-button ui-button--primary"
              data-testid="connect-assistant-ai"
              :disabled="aiSettingsUnavailable"
              @click="openAiSettings($event, 'assistant')"
            >
              Connect AI
            </button>
          </div>
          <div
            v-if="!creatingRoom && state.powerUp.messages.length"
            ref="conversationEl"
            class="agent-conversation"
            data-testid="agent-conversation"
            @scroll="onConversationScroll"
            role="log"
            aria-label="Conversation"
            aria-live="polite"
          >
            <div
              v-for="(message, index) in state.powerUp.messages"
              :key="index"
              class="agent-message"
              :class="message.role"
            >
              {{ message.text }}
            </div>
            <div
              v-if="asking && state.powerUp.busy && state.agentTask?.progress?.text"
              class="agent-message assistant"
              data-testid="agent-stream-text"
              aria-live="off"
            >
              {{ state.agentTask.progress.text }}
            </div>
          </div>
          <div
            v-if="
              state.powerUp.busy &&
              state.agentTask?.status !== 'paused' &&
              !state.agentTask?.progress
            "
            class="remix-progress"
          >
            <span
              role="status"
              aria-live="polite"
              aria-atomic="true"
              data-testid="remix-progress-status"
            >
              {{ remixActivity }}
            </span>
            <progress
              :aria-label="
                creatingRoom
                  ? 'Room generation in progress'
                  : asking
                    ? 'Investigation in progress'
                    : 'Remix in progress'
              "
            ></progress>
          </div>
          <AgentTaskControls
            :task="state.agentTask"
            :show-text="!asking"
            @stop="stopAgent"
            @resume="continueAgent"
            @discard="discardAgent"
          />
          <details class="agent-activity" :open="creatingRoom || state.powerUp.busy">
            <summary>Activity</summary>
            <div
              ref="progressFeedEl"
              class="agent-bubble-feed"
              data-testid="agent-bubble-feed"
              role="region"
              :aria-label="creatingRoom ? 'Room generation activity' : 'Agent activity'"
              tabindex="0"
              @scroll.passive="onProgressScroll"
            >
              <div
                v-for="entry in powerUpFeed"
                :key="entry.id"
                class="agent-bubble-line"
                :class="entry.kind"
              >
                {{ entry.detail }}
                <SoundPreview v-if="entry.audio?.length" :audio="entry.audio" />
              </div>
            </div>
            <div v-if="!followProgress" class="remix-follow-controls">
              <button
                type="button"
                class="ui-button ui-button--secondary"
                data-testid="remix-jump-latest"
                @click="jumpToLatest"
              >
                Jump to latest
              </button>
            </div>
          </details>
          <SoundPreview
            v-if="!state.powerUp.busy && powerUpAudio.length"
            :audio="powerUpAudio"
            data-testid="agent-bubble-sound-preview"
          />
          <form
            v-if="!creatingRoom && !state.powerUp.needsConfig"
            class="agent-bubble-form"
            @submit.prevent="onPowerUpSubmit"
          >
            <textarea
              rows="2"
              ref="powerUpEl"
              v-model="powerUpLine"
              data-testid="agent-bubble-input"
              :aria-label="asking ? 'Ask about this game' : 'What would you like to change?'"
              autocomplete="off"
              spellcheck="false"
              :disabled="state.powerUp.busy"
              :placeholder="asking ? 'Ask about this game…' : 'What would you like to change?'"
              @keydown="onPowerUpKey"
            ></textarea>
            <button
              type="submit"
              class="ui-button ui-button--primary"
              data-testid="agent-bubble-send"
              :disabled="state.powerUp.busy || !powerUpLine.trim()"
            >
              {{ state.powerUp.busy ? "Working…" : asking ? "Ask" : "Remix" }}
            </button>
          </form>
          <p v-if="state.powerUp.error" class="agent-bubble-error" data-testid="agent-bubble-error">
            {{ state.powerUp.error }}
          </p>
        </div>
      </div>

      <!-- Walkthrough Transport Bar (Directly below the CRT screen) -->
      <WalkthroughTransport
        v-if="state.walkthrough.active && state.phase === 'running'"
        :walkthrough="state.walkthrough"
        @toggle-pause="toggleWalkthroughPause"
        @set-speed="setWalkthroughSpeed"
        @toggle-pause-on-dialog="toggleWalkthroughPauseOnDialog"
        @seek-tick="onWalkthroughSeekTick"
        @seek-checkpoint="onWalkthroughSeekCheckpoint"
        @scrubbing="onWalkthroughScrubbing"
      />

      <!-- Captions under the screen (never overlays: all game text is on the CRT) -->
      <TouchControls
        v-if="touchControls && state.phase === 'running'"
        :disabled="state.powerUp.open || state.paused"
        :navigating="state.modal !== null"
        :hold="state.holdToMove"
        @direction="onTouchDirection"
        @key="onVirtualKey"
        @keyboard="inputEl?.focus({ preventScroll: true })"
      />
    </div>
    <div v-if="state.phase === 'running'" class="screen-captions">
      <template v-if="!state.walkthrough.seeking">
        <span v-if="state.resumed" class="caption resume-caption" data-testid="resume-caption">
          Resumed where you left off
        </span>
        <span v-if="state.prompt" class="caption" data-testid="prompt-hint">
          [ Type your answer on the screen, Enter to accept, Esc to cancel ]
        </span>
        <span v-else-if="state.textMode" class="caption" data-testid="text-mode-hint">
          [ Use the keys requested by the game ]
        </span>
        <span v-else-if="hasKeyPrompt" class="caption" data-testid="title-prompt-hint">
          [ {{ touchControls ? `Tap screen or: ${keyPromptHint}` : keyPromptHint }} ]
        </span>
        <span v-else-if="state.modal === 'menu'" class="caption" data-testid="menu-hint">
          [ Arrows to navigate, Enter to select, Esc to close ]
        </span>
        <span v-else-if="state.modal === 'inventory'" class="caption" data-testid="inventory-hint">
          [ Arrows to select, Enter to choose, Esc to return ]
        </span>
        <span v-else-if="state.modal !== null" class="caption" data-testid="modal-hint">
          [ Press Enter to continue ]
        </span>
      </template>
    </div>

    <p v-if="state.phase === 'running'" id="game-input-help" class="input-help">
      {{
        touchControls
          ? "Type to open keyboard · Enter to send · Keys for F1–F10 and more"
          : "Click the game to type · Enter to send · Arrows or numpad to walk · Home / PgUp / End / PgDn for diagonals"
      }}
    </p>

    <SoundPreview
      v-if="!state.powerUp.open && latestAgentAudio.length"
      :audio="latestAgentAudio"
      data-testid="latest-sound-preview"
    />

    <!-- Live Agent Debug Activity Panel -->
    <details v-if="state.agentLog.length || testMode" class="agent-panel" data-testid="agent-panel">
      <summary data-testid="developer-activity-summary">Developer activity</summary>
      <div class="agent-panel-header">
        <span class="backend-tag" data-testid="gpu-backend">{{ gpuBackend || "canvas2d" }}</span>
        <div class="agent-panel-actions">
          <button
            type="button"
            class="telemetry-btn"
            data-testid="btn-copy-trace"
            title="Copy entire debug trace to clipboard"
            @click="copyDebugBundle"
          >
            📋 Copy Debug Bundle
          </button>
          <button
            type="button"
            class="telemetry-btn secondary"
            data-testid="btn-clear-trace"
            title="Clear telemetry logs"
            @click="clearAgentLog"
          >
            Clear
          </button>
          <span v-if="copyFeedback" class="copy-feedback">{{ copyFeedback }}</span>
        </div>
      </div>
      <button
        v-if="testMode && (state.phase === 'idle' || state.phase === 'error')"
        class="ui-button ui-button--secondary"
        data-testid="boot-agent"
        @click="
          resumeAudio();
          bootAgentGame();
        "
      >
        Run test game
      </button>
      <div class="agent-entries">
        <div
          v-for="entry in state.agentLog.slice(-50)"
          :key="entry.id"
          class="agent-entry"
          :class="[entry.kind, { expandable: Boolean(entry.data) }]"
          @click="entry.data ? toggleLogEntry(entry.id) : null"
        >
          <div class="agent-entry-row">
            <span class="agent-kind">{{ entry.kind }}</span>
            <span class="agent-detail">{{ entry.detail }}</span>
            <span v-if="entry.data" class="agent-expand-toggle">
              {{ expandedLogIds.has(entry.id) ? "▲ collapse" : "▼ inspect" }}
            </span>
          </div>
          <pre v-if="entry.data && expandedLogIds.has(entry.id)" class="agent-data-preview">{{
            JSON.stringify(entry.data, null, 2)
          }}</pre>
          <SoundPreview v-if="entry.audio?.length" :audio="entry.audio" />
        </div>
      </div>
    </details>
  </div>
</template>

<style scoped>
/* ---- The remix: one round button on the game frame (.screen is relative) ---- */
.power-up {
  position: absolute;
  right: 12px;
  bottom: 12px;
  width: 46px;
  height: 46px;
  border-radius: 50%;
  border: 2px solid #55ffff;
  background: radial-gradient(circle at 35% 30%, #1b3b4a, #06131a);
  color: #55ffff;
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
  display: grid;
  place-items: center;
  box-shadow: 0 0 12px rgba(85, 255, 255, 0.35);
  transition:
    transform 0.12s ease,
    box-shadow 0.12s ease;
  z-index: 3;
}

.power-up:hover {
  transform: scale(1.08);
}

/* Split-mode wipe: a wide invisible drag strip with a visible edge and grip. */
.split-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 24px;
  margin-left: -12px;
  cursor: ew-resize;
  touch-action: none;
  z-index: 2;
}

.split-handle::before {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 2px;
  margin-left: -1px;
  background: rgba(255, 255, 255, 0.9);
  box-shadow: 0 0 4px rgba(0, 0, 0, 0.7);
}

.split-grip {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  background: rgba(6, 12, 20, 0.92);
  border: 1px solid #55ffff;
  color: #55ffff;
  border-radius: 6px;
  padding: 3px 5px;
  font-size: 10px;
  line-height: 1;
  white-space: nowrap;
  pointer-events: none;
}

@media (any-pointer: coarse) {
  .split-handle {
    width: 44px;
    margin-left: -22px;
  }
}

.power-up.armed {
  border-color: #ffff55;
  color: #ffff55;
  box-shadow: 0 0 18px rgba(255, 255, 85, 0.55);
}

/* Inspector entry inside the power-up header: same segmented control
   language, but a toggle (the dock outlives the bubble). */
.agent-inspect {
  background: #081217;
  border: 1px solid #38515b;
  border-radius: 8px;
  color: var(--ui-action);
  font: inherit;
  font-size: 12px;
  padding: 5px 10px;
  cursor: pointer;
  white-space: nowrap;
}

.agent-inspect:hover {
  border-color: var(--ui-action-hover);
  color: var(--ui-action-hover);
  background: var(--ui-action-surface-hover);
}

.agent-inspect.on {
  color: var(--ui-action-ink);
  background: var(--ui-action);
  border-color: var(--ui-action);
}

.agent-bubble {
  font-family: system-ui, sans-serif;
  position: fixed;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: min(560px, calc(100vw - 32px));
  max-height: calc(100dvh - 32px);
  overflow-y: auto;
  box-sizing: border-box;
  background: rgba(6, 12, 20, 0.96);
  border: 1px solid #55ffff;
  border-radius: 10px;
  padding: 16px;
  text-align: left;
  z-index: 4;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.6);
  transition:
    opacity 160ms ease-out,
    transform 160ms ease-out;
}

@starting-style {
  .agent-bubble {
    opacity: 0;
  }
}

/* Dragged free of its centred position, or collapsed to the title strip. */
.agent-bubble.floating {
  transform: none;
}

.agent-bubble.collapsed {
  width: auto;
  max-width: calc(100vw - 32px);
  padding-bottom: 10px;
}

.agent-bubble.collapsed > *:not(.agent-bubble-head) {
  display: none;
}

.agent-bubble.collapsed .agent-bubble-head {
  margin-bottom: 0;
}

.agent-bubble-grip {
  color: #3d5a6e;
  font-size: 10px;
  flex: none;
}

.bubble-icon {
  background: none;
  border: none;
  border-radius: 4px;
  color: #7e9aac;
  font: inherit;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  padding: 2px 6px;
  white-space: nowrap;
}

.bubble-icon:hover {
  color: var(--ui-action-hover);
}

.bubble-icon.bubble-close:hover {
  color: var(--ui-danger-hover);
}

/* The close button keeps a 44px hit area at every pointer size; negative
   margins keep the compact header row from growing. */
.bubble-icon.bubble-close {
  min-width: 44px;
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin: -11px -7px;
}

.bubble-icon:disabled {
  opacity: 0.4;
  cursor: default;
}

/* Finger-sized targets on touch devices. */
@media (any-pointer: coarse) {
  .bubble-icon {
    min-width: 44px;
    min-height: 44px;
    padding: 10px;
    font-size: 18px;
  }
}

.agent-bubble-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  cursor: grab;
  touch-action: none;
  user-select: none;
  font-size: 12px;
  letter-spacing: 0.02em;
  color: #55ffff;
  margin-bottom: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid #1d3a46;
}

.agent-bubble-right {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  align-self: flex-start;
}

.agent-bubble-head:active {
  cursor: grabbing;
}

.agent-bubble-head button {
  cursor: pointer;
}

.agent-bubble-room {
  color: #aaaaaa;
}

.agent-bubble-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: stretch;
  gap: 8px;
  margin-top: 12px;
}
.agent-mode-switch {
  display: flex;
  padding: 3px;
  background: #081217;
  border: 1px solid #38515b;
  border-radius: 8px;
}
.agent-mode-switch button {
  min-height: 44px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: #a9bac0;
  padding: 7px 12px;
  font:
    700 14px/1.4 system-ui,
    sans-serif;
  cursor: pointer;
}

/* Desktop: the switch shares the header row with small icon buttons — keep
   the 44px target but tighten padding and type so the head stays compact. */
@media (any-pointer: fine) {
  .agent-mode-switch button {
    padding: 5px 10px;
    font-size: 12px;
  }
}
.agent-mode-switch button[aria-pressed="true"] {
  background: #20454e;
  color: #a5ffff;
}
.agent-bubble.collapsed .agent-bubble-head {
  border-bottom: none;
  padding-bottom: 0;
}
.agent-conversation {
  max-height: min(32dvh, 260px);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px 0;
  font:
    14px/1.55 system-ui,
    sans-serif;
}
.agent-message {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.agent-message.user {
  align-self: flex-end;
  max-width: 90%;
  background: #173039;
  padding: 8px 12px;
  border-radius: 10px 10px 2px 10px;
}
.agent-message.assistant {
  color: #e3ecee;
}
.agent-activity {
  font-size: 12px;
  color: #8da4ac;
  margin-top: 10px;
}
.agent-activity summary {
  cursor: pointer;
}
.agent-bubble button:disabled {
  opacity: 0.5;
  cursor: default;
}
.agent-bubble-form textarea {
  box-sizing: border-box;
  resize: none;
  margin: 0;
  flex: 1;
  min-width: 0;
  background: #04080c;
  border: 1px solid #2a4a55;
  color: #e8e8e8;
  padding: 10px 12px;
  font: inherit;
  font-size: 14px;
  border-radius: 4px;
}

.agent-bubble-form button {
  margin: 0;
  min-width: 72px;
  align-self: stretch;
}

.remix-progress {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 0 8px;
  color: #a8eeee;
  font-size: 12px;
  border-bottom: 1px solid #294047;
}

.remix-progress progress {
  width: 48px;
  height: 4px;
  flex-shrink: 0;
  accent-color: #55ffff;
}

.agent-bubble-feed {
  margin-top: 8px;
  max-height: 160px;
  min-height: 0;
  overflow-y: auto;
  overflow-anchor: none;
  overscroll-behavior: contain;
  scrollbar-color: #48666e transparent;
  scrollbar-width: thin;
  font-size: 12px;
  line-height: 1.5;
}

.remix-follow-controls {
  display: flex;
  justify-content: flex-end;
  padding-top: 6px;
}

.agent-bubble-line {
  color: #c8d6d9;
  white-space: pre-wrap;
  word-break: break-word;
}

.agent-bubble-line.error {
  color: #ff5555;
}

.agent-bubble-line.hint {
  color: #b4c8cc;
}

.agent-bubble-error {
  color: #ff5555;
  font-size: 11px;
  margin: 6px 0 0;
}

.screen {
  position: relative;
  border: 2px solid #33455c;
  background: #000;
  box-shadow:
    0 0 0 4px #090e17,
    0 0 0 5px #223047,
    0 0 56px #55ffff0d;
  transition:
    box-shadow 180ms ease-out,
    border-color 180ms ease-out;
}

.screen.active {
  border-color: #567087;
}

.screen.remixing {
  border-color: #ffff55;
  box-shadow:
    0 0 0 4px #090e17,
    0 0 0 5px #6e7045,
    0 0 64px #ffff551c;
}

.game-surface {
  display: block;
  width: var(--game-width);
  aspect-ratio: 8 / 5;
  height: auto;
  image-rendering: pixelated;
  outline: none;
  background: #000;
}

.screen-captions {
  width: var(--game-width);
  min-height: 1.4rem;
  margin-top: 0.35rem;
  text-align: center;
}

.caption {
  display: inline-block;
  border: 1px solid #5af;
  color: #5af;
  font-family: monospace;
  font-size: 0.8rem;
  font-weight: bold;
  padding: 0.2rem 0.6rem;
  border-radius: 3px;
  white-space: normal;
}

/* The resume notice states a fact rather than asking for a keystroke, so it
   sits still and fades out on its own instead of pulsing like the hints. */
.resume-caption {
  border-color: #7d7;
  color: #7d7;
  margin-right: 0.4rem;
  animation: resume-fade 10s ease-in forwards;
}

@keyframes resume-fade {
  0%,
  70% {
    opacity: 1;
  }
  100% {
    opacity: 0.25;
  }
}

.backend-tag {
  font-size: 0.7rem;
  color: #555;
  letter-spacing: 0.15em;
}

.screen.shake {
  animation: screen-shake 0.1s linear infinite;
}

@keyframes screen-shake {
  0% {
    transform: translate(2px, 1px);
  }
  25% {
    transform: translate(-2px, -1px);
  }
  50% {
    transform: translate(1px, -2px);
  }
  75% {
    transform: translate(-1px, 2px);
  }
  100% {
    transform: translate(2px, 1px);
  }
}

.input-help {
  font-size: 12px;
  color: #aaa;
  text-align: center;
  max-width: var(--game-width);
  margin: 12px 0 0;
}

.input-row {
  position: absolute;
  bottom: 0;
  left: 50%;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.input-row input {
  font-size: 16px;
}

.screen:has(.input-row input:focus-visible) {
  outline: 2px solid #55ffff;
  outline-offset: 4px;
}

.agent-panel {
  width: var(--shell-width);
  margin-top: 1rem;
  border-top: 1px solid #333;
  max-height: 280px;
  overflow-y: auto;
  font-size: 0.75rem;
}

.agent-panel summary {
  cursor: pointer;
  padding: 12px 0;
  color: #aaa;
  font-size: 12px;
}

.agent-panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin: 0.5rem 0;
}

.agent-panel-actions {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.telemetry-btn {
  font-size: 0.65rem;
  padding: 0.2rem 0.5rem;
  background: #1c2838;
  border: 1px solid #3a5578;
  color: #7bb5f5;
  border-radius: 3px;
  cursor: pointer;
  font-family: inherit;
}

.telemetry-btn:hover {
  background: #253952;
  border-color: #5b87bf;
  color: #fff;
}

.telemetry-btn.secondary {
  background: #222;
  border-color: #444;
  color: #888;
}

.telemetry-btn.secondary:hover {
  background: #333;
  border-color: #666;
  color: #ccc;
}

.copy-feedback {
  font-size: 0.7rem;
  color: #5f5;
  font-weight: bold;
}

.agent-entries {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.agent-entry {
  padding: 3px 0;
  color: #999;
  font-family: monospace;
}

.agent-entry.expandable {
  cursor: pointer;
}

.agent-entry-row {
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
}

.agent-entry .agent-kind {
  color: #5af;
  font-weight: bold;
}

.agent-entry.response .agent-kind {
  color: #7d7;
}

.agent-entry.error .agent-kind {
  color: #f66;
}

.agent-entry.log .agent-kind {
  color: #fa0;
}

.agent-entry.telemetry .agent-kind {
  color: #b8f;
}

.agent-entry.input .agent-kind {
  color: #5ce1e6;
}

.agent-detail {
  flex: 1;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: break-word;
}

.agent-expand-toggle {
  font-size: 0.65rem;
  color: #5af;
  opacity: 0.8;
  padding: 0 4px;
}

.agent-data-preview {
  margin: 0.3rem 0 0.5rem 1rem;
  padding: 0.4rem 0.6rem;
  background: #111;
  border: 1px solid #333;
  border-radius: 3px;
  color: #bbb;
  font-size: 0.7rem;
  max-height: 180px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
}

.assistant-connect {
  margin-top: 12px;
}
</style>
