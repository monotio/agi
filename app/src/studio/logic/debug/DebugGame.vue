<script setup lang="ts">
/**
 * The isolated Test run's private game preview. It composites the worker's
 * own frame stream — picture, priority and the engine-owned 40x25 text
 * surface — through compositeFrame into a GPU stage (WebGPU, WebGL fallback)
 * with the shared 320x200 2D probe canvas underneath. Game text is never
 * rendered as DOM: what the engine drew is what the canvas shows.
 *
 * The stage is created through a LateGuard: a preview closed while the GPU
 * is still initializing disposes the late stage and cannot be repainted by
 * it. Keyboard, click and direction route only to the Test worker while the
 * run is live — the workspace itself gates the phase.
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, useTemplateRef } from "vue";
import { AgiStage } from "../../../three/AgiStage.ts";
import { FRAME_HEIGHT, FRAME_WIDTH, compositeFrame } from "../../../render/composite.ts";
import { movementDirection, pcKey } from "../../../play/gameControls.ts";
import type { DebugPresentation } from "./debugPresentation.ts";
import type { DebugWorkspace } from "./logicDebugWorkspace.ts";
import { createLateGuard } from "./debugPresentation.ts";

const props = defineProps<{
  workspace: DebugWorkspace;
  bridge: DebugPresentation;
}>();

const gpuCanvas = useTemplateRef("gpuCanvas");
const flatCanvas = useTemplateRef("flatCanvas");
const gpuBackend = ref<string>();
let stage: AgiStage | null = null;
const stageGuard = createLateGuard();

/** The composed 320x200 RGBA frame shared by the probe canvas and the stage. */
const composed = new Uint8ClampedArray(FRAME_WIDTH * FRAME_HEIGHT * 4);
let imageData: ImageData | null = null;
const testMode = import.meta.env.MODE === "test";

/** The presented frame's input affordances — republished per frame. */
const frameMeta = shallowRef<{
  inputEnabled: boolean;
  inputReady: boolean;
  modal: string | null;
  textMode: boolean;
} | null>(null);

/**
 * Composite one worker frame. The 2D probe canvas always draws under test
 * (Playwright reads pixels) and whenever no stage exists; the GPU stage gets
 * the same composed bytes.
 */
function present(frame: {
  visual: Uint8Array;
  priority: Uint8Array;
  text: Uint8Array;
  picRow: number;
  modal: string | null;
  textMode: boolean;
  inputEnabled: boolean;
  inputReady: boolean;
}): void {
  frameMeta.value = {
    inputEnabled: frame.inputEnabled,
    inputReady: frame.inputReady,
    modal: frame.modal,
    textMode: frame.textMode,
  };
  compositeFrame(
    {
      visual: frame.visual,
      priority: frame.priority,
      text: frame.text,
      picRow: frame.picRow,
    },
    composed,
    "visual",
  );
  if (!stage || testMode) {
    const ctx = flatCanvas.value?.getContext("2d");
    if (ctx) {
      imageData ??= ctx.createImageData(FRAME_WIDTH, FRAME_HEIGHT);
      imageData.data.set(composed);
      ctx.putImageData(imageData, 0, 0);
    }
  }
  stage?.render(composed, true);
}

/** The workspace's presentation bridge hands every frame through here. */
function attach(): void {
  const last = props.bridge.lastFrame;
  if (last) present(last);
}

onMounted(() => {
  attach();
  const canvas = gpuCanvas.value;
  if (!canvas) return;
  void stageGuard
    .adopt(AgiStage.create(canvas), (late) => late.dispose())
    .then((created) => {
      // Null from the guard means the preview closed while init was in
      // flight; the stage was already disposed — nothing adopts it.
      if (!created) return;
      stage = created;
      gpuBackend.value = created.backend;
      const last = props.bridge.lastFrame;
      if (last) present(last);
    });
});

onBeforeUnmount(() => {
  stageGuard.close();
  stage?.dispose();
  stage = null;
});

/* ---- input: routed only while the run is live (the workspace gates) ---- */

const heldDirections = new Set<string>();

function onKeydown(ev: KeyboardEvent): void {
  if (ev.isComposing || ev.keyCode === 229) return;
  const dir = movementDirection(ev);
  if (dir !== undefined) {
    // Routed keys are game input, not dock shortcuts — the screen's F5 opens
    // the engine's save selector rather than pausing the run.
    ev.preventDefault();
    ev.stopPropagation();
    const held = ev.code && ev.code !== "Unidentified" ? ev.code : ev.key;
    if (!ev.repeat && !heldDirections.has(held)) {
      heldDirections.add(held);
      props.workspace.direction(dir);
    }
    return;
  }
  const code = pcKey(ev);
  if (code !== undefined) {
    ev.preventDefault();
    ev.stopPropagation();
    props.workspace.key(code);
  }
}

function onKeyup(ev: KeyboardEvent): void {
  const held = ev.code && ev.code !== "Unidentified" ? ev.code : ev.key;
  if (heldDirections.delete(held)) {
    ev.preventDefault();
    props.workspace.direction(0, true);
  }
}

/** Logical 320x200 click coordinates from the displayed (scaled) surface. */
function onPointerDown(ev: PointerEvent): void {
  const el = ev.currentTarget as HTMLElement;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  const x = Math.floor(((ev.clientX - rect.left) / rect.width) * 320);
  const y = Math.floor(((ev.clientY - rect.top) / rect.height) * 200);
  if (x < 0 || x > 319 || y < 0 || y > 199) return;
  el.focus();
  props.workspace.click(x, y);
}

/* The command line is host chrome: it submits a completed line through the
   session's input surface. The engine's own row — echoed by key input —
   still draws on the canvas. */
const command = ref("");
const inputShown = computed(() => frameMeta.value?.inputEnabled === true);

function submitCommand(): void {
  const text = command.value;
  if (text === "") return;
  command.value = "";
  props.workspace.submitInput(text);
}

defineExpose({ present });
</script>

<template>
  <div
    class="debug-game"
    data-testid="debug-game"
    :data-has-frame="bridge.view.hasFrame || undefined"
    :data-backend="gpuBackend ?? '2d'"
  >
    <div
      class="debug-game__screen"
      tabindex="0"
      role="application"
      aria-label="Test game preview"
      data-testid="debug-game-screen"
      :data-modal="bridge.view.modal ?? undefined"
      @keydown="onKeydown"
      @keyup="onKeyup"
      @pointerdown="onPointerDown"
    >
      <canvas
        v-show="!!gpuBackend"
        ref="gpuCanvas"
        class="debug-game__surface"
        width="960"
        height="600"
        data-testid="debug-gpu-canvas"
      />
      <!-- The composed 320x200 frame: pixel probe and no-GPU fallback. -->
      <canvas
        v-show="!gpuBackend"
        ref="flatCanvas"
        class="debug-game__surface"
        width="320"
        height="200"
        data-testid="debug-canvas"
      />
    </div>
    <div class="debug-game__status">
      <span
        v-if="bridge.view.waitingForKey"
        class="debug-game__hint"
        data-testid="debug-waiting-key"
      >
        Waiting for a key
      </span>
      <span
        v-else-if="bridge.view.inputEdit"
        class="debug-game__hint"
        data-testid="debug-input-edit"
      >
        {{ bridge.view.inputEdit }}
      </span>
      <form
        v-if="inputShown"
        class="debug-game__command"
        data-testid="debug-command-form"
        @submit.prevent="submitCommand"
      >
        <input
          v-model="command"
          class="debug-game__command-input"
          aria-label="Test game command"
          data-testid="debug-command-input"
          autocomplete="off"
          autocapitalize="off"
          enterkeyhint="send"
          spellcheck="false"
          @keydown.stop
        />
      </form>
    </div>
  </div>
</template>

<style scoped>
.debug-game {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.debug-game__screen {
  position: relative;
  aspect-ratio: 8 / 5;
  background: var(--surface-sunken);
  outline: none;
}
.debug-game__screen:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -2px;
}
.debug-game__surface {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  image-rendering: pixelated;
}
.debug-game__status {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--control-h);
  padding: 0 var(--space-2);
  border-top: 1px solid var(--hairline-strong);
  background: var(--surface-1);
}
.debug-game__hint {
  color: var(--ink-3);
  font: var(--text-2xs) / var(--leading) var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.debug-game__command {
  flex: 1;
  display: flex;
  min-width: 0;
}
.debug-game__command-input {
  flex: 1;
  min-width: 0;
  padding: 0 var(--space-2);
  border: 0;
  color: var(--ink);
  background: transparent;
  font: var(--text-xs) / var(--leading) var(--font-mono);
}
.debug-game__command-input:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -2px;
}
</style>
