<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useTemplateRef, watch } from "vue";
import DebugDock from "./DebugDock.vue";
import TouchControls from "./TouchControls.vue";
import WalkthroughTransport from "./WalkthroughTransport.vue";
import { useEngineApi } from "./engineContext.ts";
import { usePresentation } from "./usePresentation.ts";
import { useShellBridge } from "./shellBridge.ts";
import type { ModalKind } from "./useEngine.ts";
import type { WalkthroughCheckpoint } from "./walkthrough.ts";
import { pcKey, movementDirection } from "./gameControls.ts";
import { AGI_KEY, DIRECTION_KEYS } from "../../src/runtime/keys.ts";
import { GLYPH_CURSOR, TEXT_COLS } from "../../src/runtime/textSurface.ts";

const props = defineProps<{ touchControls: boolean; crtEnabled: boolean }>();

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
  submitPrompt,
  setWalkthroughSpeed,
  toggleWalkthroughPause,
  toggleWalkthroughPauseOnDialog,
  seekToTick,
  seekToCheckpoint,
  setDebugConsumer,
  debugWrite,
  debugEventsSince,
  readEngineState,
} = engine;
const presentation = usePresentation();
const { gpuBackend, debugOpen, debugViewMode, splitAt, debugFrame } = presentation;
const bridge = useShellBridge();

/** The DOM input is the keyboard capture; its text lives on the engine's input row. */
const inputEl = useTemplateRef("inputEl");
const inputLine = ref("");
const promptLine = ref("");
const composing = ref(false);

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
        inputEl.value?.focus({ preventScroll: true });
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

const hasKeyPrompt = computed(() =>
  state.rows.some((r) => r.toLowerCase().includes("press any key")),
);
const creatingRoom = computed(() => state.powerUp.mode === "room");
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

watch(splitAt, () => presentation.repaint());

watch(debugViewMode, (mode) => {
  presentation.setExplodedMode(mode === "explode");
  // Exploded layers need the picture surface and ownership; registering the
  // consumer arms them while any other consumer's needs stay unioned in.
  setDebugConsumer("exploded", mode === "explode");
  presentation.repaint();
});

watch(debugOpen, (open) => {
  // The dock needs the live object table and ownership buffer; the trace
  // consumer stays opt-in from the Timeline tab.
  setDebugConsumer("dock", open);
  if (!open) {
    setDebugConsumer("trace", false);
    debugViewMode.value = "visual";
    presentation.setExplodedMode(false);
    presentation.repaint();
  }
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
  if (props.touchControls && screenPointerType !== "mouse") {
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

function focusInput(): void {
  inputEl.value?.focus({ preventScroll: true });
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
  if (state.walkthrough.seeking) return;
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

function onWalkthroughSeekTick(tick: number): void {
  void seekToTick(tick);
}

function onWalkthroughSeekCheckpoint(cp: WalkthroughCheckpoint): void {
  void seekToCheckpoint(cp);
}

function onWalkthroughScrubbing(active: boolean): void {
  state.walkthrough.scrubbing = active;
}

onMounted(() => {
  void presentation.initStage(props.crtEnabled);
  bridge.focusGameInput = focusInput;
});

defineExpose({
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
        @click.stop="bridge.togglePowerUp()"
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
        :trace-dropped="state.debugTraceDropped"
        :channels="state.debugChannels"
        :view-mode="debugViewMode"
        :has-gpu="!!gpuBackend"
        :read-state="readEngineState"
        :events-since="debugEventsSince"
        :write="debugWrite"
        :project="presentation.debugProject"
        :pick3d="presentation.debugPick3d"
        @set-consumer="setDebugConsumer"
        @set-view-mode="debugViewMode = $event"
        @close="debugOpen = false"
      />

      <slot />
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
</template>

<style scoped>
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

.power-up.armed {
  border-color: #ffff55;
  color: #ffff55;
  box-shadow: 0 0 18px rgba(255, 255, 85, 0.55);
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
</style>
