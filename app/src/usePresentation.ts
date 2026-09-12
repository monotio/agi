/**
 * Presentation state: the canvases, the GPU stage, the composed frame buffers
 * and the inspector dock's view state (debug open, view mode, split wipe).
 * App.vue creates it so the engine's frame callback can present before
 * PlayArea exists; PlayArea injects it and binds the canvas elements.
 */
import { inject, provide, ref, shallowRef } from "vue";
import type { InjectionKey } from "vue";
import { AgiStage } from "./three/AgiStage.ts";
import { FRAME_HEIGHT, FRAME_WIDTH, compositeFrame, type ScreenViewMode } from "./composite.ts";
import type { DebugViewMode } from "./debugView.ts";
import type { Frame } from "./useEngine.ts";

export function createPresentation() {
  const testMode = import.meta.env.MODE === "test";

  const canvasEl = ref<HTMLCanvasElement>();
  const gpuCanvasEl = ref<HTMLCanvasElement>();
  // Empty until a GPU stage exists, so the 2d fallback canvas stays visible when
  // WebGPU/WebGL init fails or has not finished yet.
  const gpuBackend = ref<string>();
  let stage: AgiStage | null = null;
  const lastFrame = shallowRef<Frame | null>(null);
  /** Composed 320x200 RGBA frame shared by the probe canvas and the GPU stage. */
  const composed = new Uint8ClampedArray(FRAME_WIDTH * FRAME_HEIGHT * 4);
  /** Text-only composite feeding the exploded view's front plane. */
  const composedText = new Uint8ClampedArray(FRAME_WIDTH * FRAME_HEIGHT * 4);

  /** AGI Inspector: open state, view mode, and the latest frame for the dock. */
  const debugOpen = ref(false);
  const debugViewMode = ref<DebugViewMode>("visual");
  /** Visual/priority wipe position for the dock's Split mode (0..1 of frame width). */
  const splitAt = ref(0.5);
  const debugFrame = shallowRef<Frame | null>(null);

  let cachedImageData: ImageData | null = null;
  const composedPic = new Uint8ClampedArray(FRAME_WIDTH * FRAME_HEIGHT * 4);
  let pendingPresentationFrame: Frame | null = null;
  let pendingTextOverride: Uint8Array | undefined = undefined;
  let presentationRaf: number | null = null;

  /**
   * Present one engine frame: compose picture band + text cells into the
   * 320x200 frame, draw it on the 2D probe canvas (Playwright pixel probe and
   * no-GPU fallback) and upload it to the GPU stage when one exists.
   */
  function renderFrameNow(frame: Frame, textOverride?: Uint8Array): void {
    const mode = debugViewMode.value;
    // Explode composites normally — its GPU layers sample this texture and mask
    // against the priority buffer. With no stage it falls back to the flat
    // priority view (canvas2d has no layers).
    const compositeMode: ScreenViewMode =
      mode === "explode" ? (stage ? "visual" : "priority") : mode;
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
      // An absent channel means unknown, not "as last frame": clear the mask
      // so sprite layers and picking never use stale ownership.
      stage!.setOwnershipData(frame.ownership ?? null);
      // Same contract for the show.obj preview: an absent mask means closed.
      stage!.setPreviewMask(frame.preview ?? null);
    }
    if (!stage || testMode) {
      const ctx = canvasEl.value?.getContext("2d");
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

  function present(frame: Frame, textOverride?: Uint8Array, immediate = false): void {
    lastFrame.value = frame;
    debugFrame.value = frame;
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

  /** Re-composite the last frame after a dock view change. */
  function repaint(): void {
    if (lastFrame.value) renderFrameNow(lastFrame.value);
  }

  /** Re-composite with a text overlay (the live prompt echo). */
  function presentWithText(text: Uint8Array): void {
    if (lastFrame.value) present(lastFrame.value, text);
  }

  function setCrt(on: boolean): void {
    if (stage) stage.crt = on;
  }

  function setExplodedMode(on: boolean): void {
    stage?.setExplodedMode(on);
  }

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

  /** Create the GPU stage once the canvas is mounted. */
  async function initStage(crt: boolean): Promise<void> {
    if (!gpuCanvasEl.value) return;
    stage = await AgiStage.create(gpuCanvasEl.value);
    gpuBackend.value = stage?.backend;
    if (stage) {
      stage.crt = crt;
      if (lastFrame.value) present(lastFrame.value);
    }
  }

  function dispose(): void {
    if (presentationRaf !== null && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(presentationRaf);
      presentationRaf = null;
    }
    stage?.dispose();
    stage = null;
  }

  return {
    testMode,
    canvasEl,
    gpuCanvasEl,
    gpuBackend,
    lastFrame,
    debugFrame,
    debugOpen,
    debugViewMode,
    splitAt,
    present,
    repaint,
    presentWithText,
    setCrt,
    setExplodedMode,
    debugProject,
    debugPick3d,
    onScreenPointerMove,
    initStage,
    dispose,
  };
}

export type Presentation = ReturnType<typeof createPresentation>;

export const presentationKey: InjectionKey<Presentation> = Symbol("agi-presentation");

export function providePresentation(presentation: Presentation): void {
  provide(presentationKey, presentation);
}

export function usePresentation(): Presentation {
  const presentation = inject(presentationKey);
  if (!presentation) throw new Error("usePresentation: App.vue did not provide presentation");
  return presentation;
}
