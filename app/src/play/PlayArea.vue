<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  nextTick,
  onBeforeUnmount,
  onMounted,
  onWatcherCleanup,
  ref,
  useTemplateRef,
  watch,
} from "vue";
import { layoutDragging } from "./layoutDrag.ts";
import { guidedPlacement } from "./guidedPlacement.ts";
import { PAGE_CONTROLS } from "./useGameKeys.ts";

import TouchControls from "./TouchControls.vue";
import UiIconButton from "../ui/UiIconButton.vue";
import TransportBar from "../history/TransportBar.vue";
import { useEngineApi } from "../engine/engineContext.ts";
import { usePresentation } from "./usePresentation.ts";
import { useShellBridge } from "../shell/shellBridge.ts";
import { crtFramePoint } from "../three/crtAmount.ts";
import { stageScreenWidth } from "./viewportLayout.ts";
import { FRAME_HEIGHT, FRAME_WIDTH } from "../render/composite.ts";
import type { ModalKind } from "../engine/useEngine.ts";
import { pcKey, movementDirection } from "./gameControls.ts";
import { PROFILES, type ProfileId } from "../../../src/runtime/profile.ts";
import { AGI_KEY, DIRECTION_KEYS } from "../../../src/runtime/keys.ts";
import { GLYPH_CURSOR, TEXT_COLS } from "../../../src/runtime/textSurface.ts";

const props = defineProps<{
  touchControls: boolean;
  crtAmount: number;
  originalAspect: boolean;
  /** Create's Inspect tab hosts the inspector's controls: no floating dock. */
  inspectorDocked?: boolean;
}>();

const DebugDock = defineAsyncComponent(() => import("../inspector/DebugDock.vue"));
const GuidedPlacement = defineAsyncComponent(() => import("./GuidedPlacement.vue"));
const InspectorOverlay = defineAsyncComponent(() => import("../inspector/InspectorOverlay.vue"));

const engine = useEngineApi();
const {
  state,
  resumeAudio,
  advanceDialog,
  resumeWalkthrough,
  dismissModal,
  sendInput,
  sendEdit,
  sendDirection,
  sendKey,
  sendClick,
  submitPrompt,
} = engine;
const presentation = usePresentation();
const { gpuBackend, debugOpen, debugViewMode, splitAt } = presentation;
const bridge = useShellBridge();
const agentBlocksGame = computed(() => state.powerUp.open && !props.inspectorDocked);

/** The DOM input is the keyboard capture; its text lives on the engine's input row. */
const inputEl = useTemplateRef("inputEl");
/**
 * Whether keys reach the game: its input has focus, or in Play the page
 * itself does (useGameKeys). Every page control keeps its own keys. The
 * stage and the strip show the answer.
 */
const gameFocused = ref(false);
const keyHelpOpen = ref(false);
const keyHelpPinned = ref(false);
const keyHelpEl = useTemplateRef("keyHelpEl");
function closeKeyHelp(): void {
  keyHelpOpen.value = false;
  keyHelpPinned.value = false;
}
function onHelpEscape(ev: KeyboardEvent): void {
  if (ev.key === "Escape" && keyHelpOpen.value) {
    ev.preventDefault();
    ev.stopImmediatePropagation();
    closeKeyHelp();
  }
}
function onHelpOutside(ev: PointerEvent): void {
  if (ev.target instanceof Node && !keyHelpEl.value?.contains(ev.target)) closeKeyHelp();
}
function toggleKeyHelp(): void {
  keyHelpPinned.value = !keyHelpPinned.value;
  keyHelpOpen.value = keyHelpPinned.value;
}
function readKeyboard(): void {
  const active = document.activeElement;
  if (
    active instanceof Element &&
    active !== inputEl.value &&
    active.closest(PAGE_CONTROLS) &&
    !keyHelpEl.value?.contains(active)
  )
    closeKeyHelp();
  gameFocused.value =
    document.hasFocus() &&
    (active === inputEl.value ||
      (!props.inspectorDocked && !(active instanceof Element && active.closest(PAGE_CONTROLS))));
}
/** Focus moves out of one element before it lands on the next; read after both. */
function onFocusMove(): void {
  setTimeout(readKeyboard, 0);
}
onMounted(() => {
  document.addEventListener("keydown", onHelpEscape, true);
  document.addEventListener("pointerdown", onHelpOutside);
  document.addEventListener("focusin", onFocusMove);
  document.addEventListener("focusout", onFocusMove);
  window.addEventListener("focus", onFocusMove);
  window.addEventListener("blur", onFocusMove);
  readKeyboard();
});
onBeforeUnmount(() => {
  document.removeEventListener("keydown", onHelpEscape, true);
  document.removeEventListener("pointerdown", onHelpOutside);
  document.removeEventListener("focusin", onFocusMove);
  document.removeEventListener("focusout", onFocusMove);
  window.removeEventListener("focus", onFocusMove);
  window.removeEventListener("blur", onFocusMove);
});
watch(() => props.inspectorDocked, readKeyboard);
watch(
  [gameFocused, () => props.inspectorDocked, () => props.touchControls, () => state.phase],
  ([focused, creating, touch, phase]) =>
    presentation.setAttention(focused, !focused && !creating && !touch && phase === "running"),
  { immediate: true },
);
const screenEl = useTemplateRef("screenEl");
const stageEl = useTemplateRef("stageEl");

/**
 * The desktop stage, in Play and in Create's centre column, fits the screen to
 * the largest aspect-correct fit (viewportLayout.ts). Touch layouts keep the
 * phone rules in app.css, which size the screen from the viewport instead.
 */
const stageBox = ref<{ width: number; height: number }>();
watch(stageEl, (el) => {
  if (!el) return;
  const observer = new ResizeObserver(([entry]) => {
    if (entry && !layoutDragging.value)
      stageBox.value = { width: entry.contentRect.width, height: entry.contentRect.height };
  });
  observer.observe(el);
  onWatcherCleanup(() => observer.disconnect());
});
watch(layoutDragging, (dragging) => {
  const el = stageEl.value;
  if (!dragging && el) stageBox.value = { width: el.clientWidth, height: el.clientHeight };
});
const stageStyle = computed(() => {
  const box = stageBox.value;
  if (props.touchControls || !box || box.width <= 0 || box.height <= 0) return undefined;
  const ratio = props.originalAspect ? 4 / 3 : FRAME_WIDTH / FRAME_HEIGHT;
  return { "--game-width": `${stageScreenWidth(box.width, box.height, ratio)}px` };
});
const inputLine = ref("");
const promptLine = ref("");
const composing = ref(false);
// v-model preserves the native IME draft across renders. Keep its buffer
// separate from the engine line so onInputEdit can compare the previous text.
const nativeInput = ref("");
watch(
  [inputLine, promptLine, () => state.prompt],
  () => {
    nativeInput.value = state.prompt ? promptLine.value : inputLine.value;
  },
  { flush: "sync" },
);

function bindCanvas(el: unknown): void {
  presentation.canvasEl.value = el instanceof HTMLCanvasElement ? el : undefined;
}
function bindGpuCanvas(el: unknown): void {
  presentation.gpuCanvasEl.value = el instanceof HTMLCanvasElement ? el : undefined;
}

watch(
  () => state.phase,
  (phase) => {
    if (phase === "running" && !props.touchControls) {
      nextTick(() => {
        claimGameFocus();
      });
    }
  },
);
watch(
  () => state.gameEdit,
  (edit) => {
    if (edit) inputLine.value = edit.text;
  },
);

/**
 * Escape opens a menu only when the game binds it (the template's
 * set.key(27,0,c) → menu.input) and has submitted a menu; the key help names
 * it only then. A menu shows up as the menu items of its keyed bindings.
 */
const escOpensMenu = computed(
  () =>
    state.controls.some((control) => control.key === AGI_KEY.ESCAPE) &&
    state.controls.some((control) => control.menuItems.length > 0),
);
const hasKeyPrompt = computed(() =>
  state.rows.some((r) => r.toLowerCase().includes("press any key")),
);
/**
 * The keys that satisfy have.key for this screen. A key the script maps to a
 * controller (set.key) reaches a once-per-cycle poll as that controller, not
 * as a raw key — Enter on the demo pack selects a demo instead of dismissing
 * its "press any key" page (docs/fidelity.md, "Script key mappings and
 * have.key").
 */
const keyPromptKeys = computed(() => {
  const mapped = new Set(state.controls.map((b) => b.key));
  return (
    [
      [AGI_KEY.ENTER, "Enter"],
      [AGI_KEY.SPACE, "Space"],
    ] as [number, string][]
  ).filter(([key]) => !mapped.has(key));
});
const keyPromptHint = computed(() => {
  const usable = keyPromptKeys.value;
  if (usable.length === 0) return "Press any key to start";
  return `Press ${usable.map(([, name]) => name).join(" / ")} to start`;
});

watch(splitAt, () => presentation.repaint());

/** Pointer type of the last screen press; the click event carries none. */
let screenPointerType = "mouse";

function onScreenPointerDown(ev: PointerEvent): void {
  screenPointerType = ev.pointerType;
}

function onScreenClick(ev: MouseEvent): void {
  resumeAudio();
  if (state.phase !== "running") return;
  // The tape is a recording — screen clicks can't interact with it.
  if (state.historyView.active) return;
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
  if (props.touchControls && screenPointerType !== "mouse") {
    if (state.modal !== null) {
      if (state.modal !== "save" && state.modal !== "restore") dismissModal();
      return;
    }
    // A tap is Enter, which wakes have.key() on title screens and prompts —
    // or, on a "press any key" screen whose script maps Enter, the key the
    // hint names instead.
    sendKey(hasKeyPrompt.value ? (keyPromptKeys.value[0]?.[0] ?? AGI_KEY.ENTER) : AGI_KEY.ENTER);
    return;
  }
  // A mouse click is also pointer input on click-move profiles (Amiga, IIgs).
  if (screenPointerType === "mouse") sendScreenClick(ev);
  inputEl.value?.focus({ preventScroll: true });
}

/** The live game's click-move mode; PC profiles and unknown ids ignore clicks. */
const screenClickMove = computed(() => {
  const profile = state.profile;
  if (profile === null || !Object.hasOwn(PROFILES, profile)) return "none";
  return PROFILES[profile as ProfileId].clickMove;
});

/**
 * Click-to-walk: map a mouse click on the visible surface into the 320x200
 * frame's pixels. The canvas fills `.screen`'s content box (its 2px border
 * stays outside the frame), so the canvas rect is the exact map.
 */
function sendScreenClick(ev: MouseEvent): void {
  if (screenClickMove.value === "none") return;
  if (
    state.walkthrough.active ||
    state.paused ||
    agentBlocksGame.value ||
    state.modal !== null ||
    state.waitingForKey
  ) {
    return;
  }
  const canvas = gpuBackend.value ? presentation.gpuCanvasEl.value : presentation.canvasEl.value;
  const rect = canvas?.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) return;
  const point = crtFramePoint(
    (ev.clientX - rect.left) / rect.width,
    (ev.clientY - rect.top) / rect.height,
    gpuBackend.value ? props.crtAmount : 0,
  );
  if (point) sendClick(Math.floor(point.x), Math.floor(point.y));
}

function focusInput(): void {
  inputEl.value?.focus({ preventScroll: true });
}

/** A late-loaded surface respects the control the player already chose. */
function claimGameFocus(): void {
  if (document.activeElement === document.body) focusInput();
}

function triggerKey(code: number): void {
  resumeAudio();
  bridge.closeNavMenus();
  sendKey(code);
  if (!props.touchControls) inputEl.value?.focus({ preventScroll: true });
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

function handlePromptType(text: string): void {
  promptLine.value = text;
  echoPrompt();
}

function echoPrompt(): void {
  if (state.walkthrough.seeking || state.historyView.active) return;
  const prompt = state.prompt;
  const lastFrame = presentation.lastFrame.value;
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
  presentation.present(lastFrame, text);
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
      nativeInput.value = previous;
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
    nativeInput.value = inputLine.value;
    if (input.value !== inputLine.value) input.value = inputLine.value;
    sendEdit(inputLine.value);
  }
}

function onCompositionEnd(event: CompositionEvent): void {
  composing.value = false;
  onInputEdit(event);
}

let touchMovementActive = false;

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
  if (state.phase !== "running" || agentBlocksGame.value || state.prompt) return;
  touchMovementActive = state.modal === null && !state.waitingForKey;
  if (state.waitingForKey || state.modal === "save" || state.modal === "restore")
    sendKey(DIRECTION_KEYS[dir]!);
  else sendDirection(dir);
}

function onVirtualKey(code: number): void {
  resumeAudio();
  if (state.phase !== "running" || agentBlocksGame.value || composing.value) return;
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

const heldMovementKeys = new Set<string>();

/** Movement-key half of the global keydown arbitration (App.vue calls in). */
function movementKeyDown(ev: KeyboardEvent): boolean {
  const dir = movementDirection(ev);
  if (dir === undefined) return false;
  const physicalKey = ev.code && ev.code !== "Unidentified" ? ev.code : ev.key;
  if (!ev.repeat && !heldMovementKeys.has(physicalKey)) {
    heldMovementKeys.add(physicalKey);
    sendDirection(dir);
  }
  ev.preventDefault();
  return true;
}

/** The global keyup half: release the direction the key was holding. */
function movementKeyUp(ev: KeyboardEvent): void {
  const physicalKey = ev.code && ev.code !== "Unidentified" ? ev.code : ev.key;
  if (!heldMovementKeys.delete(physicalKey)) return;
  if (state.phase === "running" && !state.walkthrough.active) {
    sendDirection(0);
    ev.preventDefault();
  }
}

function releaseMovement(): void {
  if (!state.walkthrough.active && heldMovementKeys.size) sendDirection(0);
  heldMovementKeys.clear();
}

/**
 * A printable keystroke that arrived outside the input line mirrors into it
 * exactly like the focused path does: through the edit message only. The
 * engine also appends printable key events to its edit line, and a sendKey
 * here would be buffered until the next engine tick while the edit applies
 * at once — so the same character landed twice (the "llook" after Start over).
 * No waitKey can be pending here: a blocking key wait sets
 * state.waitingForKey, handled by the raw-key branch above.
 */
function mirrorPrintableChar(char: string): void {
  inputEl.value?.focus({ preventScroll: true });
  inputLine.value += char;
  sendEdit(inputLine.value);
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

onMounted(() => {
  void presentation.initStage(props.crtAmount);
  if (!props.touchControls) nextTick(claimGameFocus);
  // Callers close whatever held the keyboard first (the assistant, a sheet);
  // the input re-enables on the next render, so focus lands after it.
  bridge.focusGameInput = () => void nextTick(focusInput);
});

/** Scroll the game screen to the top of the visible viewport (keyboard up). */
function revealScreen(): void {
  screenEl.value?.scrollIntoView({ block: "start" });
}

defineExpose({
  revealScreen,
  inputEl,
  focusInput,
  triggerKey,
  onPromptKey,
  onModalKey,
  movementKeyDown,
  movementKeyUp,
  releaseMovement,
  mirrorPrintableChar,
  submit,
  handlePromptType,
});
</script>

<template>
  <div
    class="play-area"
    :class="{
      'with-touch': touchControls && state.phase === 'running',
      inspecting: debugOpen && state.phase === 'running' && !inspectorDocked,
    }"
    :style="stageStyle"
  >
    <div v-show="state.phase === 'running'" ref="stageEl" class="stage">
      <div
        ref="screenEl"
        class="screen"
        :class="{
          active: state.phase === 'running',
          'gpu-stage': !!gpuBackend,
          tube: !!gpuBackend && crtAmount > 0,
          shake: state.shake,
          remixing: state.powerUp.open && state.powerUp.mode !== 'ask',
        }"
        @click="onScreenClick"
        @pointerdown="onScreenPointerDown"
        @pointermove="presentation.onScreenPointerMove"
      >
        <canvas
          v-show="!!gpuBackend"
          :ref="bindGpuCanvas"
          class="game-surface"
          width="960"
          height="600"
          data-testid="gpu-canvas"
        />
        <!-- The composed 320x200 frame: Playwright pixel probe and no-GPU fallback. -->
        <canvas
          v-show="!gpuBackend"
          :ref="bindCanvas"
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
            :disabled="
              agentBlocksGame ||
              state.historyView.active ||
              (!state.inputReady && !state.walkthrough.active)
            "
            aria-label="Game command"
            aria-describedby="game-input-help"
            ref="inputEl"
            v-model="nativeInput"
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

        <!-- Notes about the game in play sit just above the engine's bottom
             text rows, where the command line is drawn, at every size. -->
        <div
          v-if="state.phase === 'running' && $slots['screen-notes']"
          class="screen-notes"
          @click.stop
          @pointerdown.stop
        >
          <slot name="screen-notes" />
        </div>

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

        <GuidedPlacement
          v-if="inspectorDocked && guidedPlacement"
          :pic-row="presentation.lastFrame.value?.picRow ?? 1"
        />
        <InspectorOverlay v-if="debugOpen && state.phase === 'running' && !guidedPlacement" />
        <DebugDock
          v-if="debugOpen && state.phase === 'running' && !inspectorDocked"
          @close="debugOpen = false"
        />
      </div>
      <!-- Notices over the stage's corner (toasts), with the transport's
           floating card beside them, never over them. -->
      <div class="stage-actions">
        <div id="transport-card-host" class="transport-card-host"></div>
        <slot name="stage-actions" />
      </div>
    </div>

    <TouchControls
      v-if="touchControls && state.phase === 'running'"
      :disabled="agentBlocksGame || state.paused"
      :navigating="state.modal !== null"
      :hold="state.holdToMove"
      @direction="onTouchDirection"
      @key="onVirtualKey"
      @keyboard="inputEl?.focus({ preventScroll: true })"
    />

    <!-- The slim strip under the stage: the one transport, then quiet key hints.
         Captions never overlay the game: all game text is on the CRT. -->
    <div v-if="state.phase === 'running'" class="play-strip">
      <TransportBar
        v-if="engine.transport"
        :model="engine.transport"
        card-host="#transport-card-host"
      />
      <div class="play-hints">
        <div
          ref="keyHelpEl"
          class="key-help"
          @mouseenter="keyHelpOpen = true"
          @mouseleave="keyHelpOpen = keyHelpPinned"
        >
          <button
            type="button"
            class="keys-led"
            :class="{ on: gameFocused }"
            data-testid="game-keys"
            aria-controls="game-input-help"
            :aria-expanded="keyHelpOpen"
            @mousedown.prevent
            @click="toggleKeyHelp"
          >
            <span class="led" aria-hidden="true"></span>
            <span class="keys-led-label">
              <span>{{ gameFocused ? "Keys go to the game" : "Click the game to play" }}</span>
            </span>
          </button>
          <div
            v-if="keyHelpOpen"
            id="game-input-help"
            class="key-help-bubble"
            data-testid="game-key-help"
            data-shell-keys
            role="region"
            aria-label="Game keys"
          >
            <template v-if="!state.walkthrough.seeking && !state.historyView.active">
              <p v-if="state.prompt" class="caption" data-testid="prompt-hint">
                Type your answer on the screen · Enter to accept · Esc to cancel
              </p>
              <p v-else-if="state.modal === 'menu'" class="caption" data-testid="menu-hint">
                Game menu: arrows to move, Enter to choose, Esc to close
              </p>
              <p
                v-else-if="state.modal === 'inventory'"
                class="caption"
                data-testid="inventory-hint"
              >
                Arrows to select · Enter to choose · Esc to return
              </p>
              <p v-else-if="state.modal !== null" class="caption" data-testid="modal-hint">
                A message is open: press Enter to continue
              </p>
              <p v-else-if="state.textMode" class="caption" data-testid="text-mode-hint">
                Use the keys requested by the game
              </p>
              <p v-else-if="hasKeyPrompt" class="caption" data-testid="title-prompt-hint">
                {{ touchControls ? `Tap screen or: ${keyPromptHint}` : keyPromptHint }}
              </p>
            </template>

            <p v-if="state.resumed" class="caption resume-caption" data-testid="resume-caption">
              Resumed where you left off
            </p>
            <strong>Game keys</strong>
            <UiIconButton
              class="key-help-close"
              icon="x"
              label="Close"
              size="sm"
              @click="closeKeyHelp"
            />
            <ul>
              <li>Type to talk</li>
              <li>Arrows or numpad to walk</li>
              <li>Enter answers a message</li>
              <li v-if="escOpensMenu">Esc for the game menu</li>
              <li>Shift+Tab leaves the game</li>
              <li v-if="touchControls">Type opens the keyboard · Keys opens F1–F10</li>
            </ul>
          </div>
        </div>
        <!-- Shell actions docked in the strip (Play's Ask), clear of the stage. -->
        <slot name="strip-actions" />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Desktop: the stage takes every row the bar and strip leave and centres the
   screen on black; its size is the fit from the script (stageScreenWidth). */
.play-area:not(.with-touch) {
  flex: 1;
  min-width: 0;
  min-height: 0;
}
.play-area:not(.with-touch) .stage {
  flex: 1 1 0;
  width: 100%;
  min-height: 0;
}
.stage {
  position: relative;
  display: grid;
  place-items: center;
  min-width: 0;
}
/* The inspector docks just outside the screen's right edge on wide windows. */
@media (min-width: 1341px) {
  .play-area.inspecting:not(.with-touch) .stage {
    box-sizing: border-box;
    padding-right: 344px;
  }
}
.stage-actions {
  position: absolute;
  right: var(--space-2);
  bottom: var(--space-3);
  z-index: 3;
  display: flex;
  align-items: flex-end;
  justify-content: flex-end;
  gap: var(--space-2);
  max-width: calc(100% - 2 * var(--space-2));
  pointer-events: none;
}
.stage-actions > :deep(*) {
  pointer-events: auto;
}
.with-touch .stage-actions {
  right: var(--space-1);
  bottom: var(--space-1);
}
.screen-notes {
  position: absolute;
  right: var(--space-2);
  /* The bottom three of the 25 text rows hold the command line (row 22 by default). */
  bottom: calc(100% * 3 / 25);
  z-index: 3;
  display: flex;
  justify-content: flex-end;
  max-width: calc(100% - 2 * var(--space-2));
  pointer-events: none;
}
.screen-notes > :deep(*) {
  pointer-events: auto;
}
.transport-card-host {
  display: flex;
  min-width: 0;
}
.transport-card-host:empty {
  display: none;
}

.screen {
  position: relative;
  background: var(--agi-0);
  box-shadow: 0 0 0 1px var(--hairline);
  transition: box-shadow var(--duration) var(--ease-out);
}
.screen.tube {
  box-shadow: none;
}
.screen.remixing {
  box-shadow: 0 0 0 2px var(--warn-line);
}

.game-surface {
  display: block;
  width: var(--game-width);
  aspect-ratio: var(--game-aspect);
  height: auto;
  image-rendering: pixelated;
  outline: none;
  background: var(--agi-0);
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
  background: var(--ink);
  box-shadow: 0 0 4px var(--scrim);
}
.split-grip {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  padding: 3px 5px;
  border: 1px solid var(--action);
  border-radius: var(--radius);
  color: var(--action);
  background: var(--surface-overlay);
  font-size: var(--text-2xs);
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

/* The key status takes one row; its bubble floats above the strip. */
.play-strip {
  position: relative;
  container: play-strip / inline-size;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-5);
  width: 100%;
  min-height: var(--shell-strip-h);
  box-sizing: border-box;
  padding: var(--space-2) var(--space-6);
  border-top: 1px solid var(--hairline);
  background: var(--surface-0);
}
.play-hints {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-3);
  margin-left: auto;
  color: var(--ink-3);
  font: var(--text-xs) / var(--leading-tight) var(--font-sans);
}
.key-help {
  position: relative;
}
.key-help-bubble {
  position: absolute;
  z-index: 10;
  bottom: 100%;
  right: 0;
  width: min(300px, calc(100vw - 32px));
  box-sizing: border-box;
  padding: var(--space-4);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius);
  background: var(--surface-overlay);
  box-shadow: var(--shadow-pop);
  color: var(--ink-2);
  text-align: left;
  font: var(--text-sm) / var(--leading) var(--font-sans);
}
.key-help-bubble .caption {
  margin: 0 0 var(--space-3);
  padding-right: var(--control-h-sm);
  color: var(--ink);
}
.key-help-bubble ul {
  list-style: none;
  padding: 0;
  margin: var(--space-2) 0 0;
}
.key-help-close {
  position: absolute;
  top: var(--space-1);
  right: var(--space-1);
}
@media (max-width: 900px) {
  .play-strip {
    gap: var(--space-2) var(--space-4);
    padding: var(--space-2) var(--space-4);
  }
  .play-hints {
    flex-basis: 100%;
    justify-content: center;
  }
  .key-help-bubble {
    right: auto;
    left: 0;
  }
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
  font-size: var(--text-lg);
}
/* The GPU stage lights its own glass while the game has the keyboard
   (AgiStage setAttention); the 2D fallback keeps an outline. */
.screen:not(.gpu-stage):has(.input-row input:focus) {
  outline: 2px solid var(--action-line);
  outline-offset: 3px;
}
.keys-led {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
  height: 24px;
  padding: 0 var(--space-2);
  border: 0;
  border-radius: var(--radius-pill);
  background: none;
  color: var(--ink-3);
  font: inherit;
  white-space: nowrap;
  cursor: pointer;
}
/* Reserve the widest label so focus cannot reflow the strip during a click. */
.keys-led-label {
  display: grid;
}
.keys-led-label > span,
.keys-led-label::after {
  grid-area: 1 / 1;
}
.keys-led-label::after {
  content: "Click the game to play";
  visibility: hidden;
}
.keys-led:hover {
  color: var(--ink);
}
.keys-led.on {
  color: var(--ink-2);
}
.led {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ink-disabled);
  transition:
    background var(--duration) var(--ease-out),
    box-shadow var(--duration) var(--ease-out);
}
.keys-led.on .led {
  background: var(--action);
  box-shadow: 0 0 6px var(--action);
}
</style>
