/**
 * Records a picture clip (paintClip.ts plans it, shareFrame.ts composes each
 * frame) as video: MediaRecorder on a canvas stream, 320×200 at an integer
 * scale with nearest-neighbour pixels. Frames are pushed on the recorder's
 * clock: each is drawn and handed to the stream with `requestFrame()` at its
 * own time on one steady 30 fps schedule measured from the start, so a late
 * timer never stretches the frames after it. A frame's picture is rendered
 * only when its command count changes, one frame per timer task, so the page
 * stays responsive while it records. A background tab's timers are
 * throttled to a second, which would stretch the clip, so hiding the tab
 * stops the recording with a note.
 */

import type { PictureSourceSpan } from "../../../../src/picture/source.ts";
import type { AgiProfile } from "../../../../src/runtime/profile.ts";
import { renderUpTo, type TimelineEntry } from "../../../../src/studio/pictureQuery.ts";
import { CLIP_FPS, commandCells, paintWeights, planClip } from "./paintClip.ts";
import {
  composeFrame,
  FRAME_HEIGHT,
  FRAME_WIDTH,
  frameToRgb,
  type ShareCaption,
} from "./shareFrame.ts";

/** Video types in order of preference; Safari records only MP4. */
const CLIP_TYPES = ["video/webm;codecs=vp9", "video/webm", "video/mp4"] as const;
/** The clip's integer scale: 960×600. */
const CLIP_SCALE = 3;
/** Enough for crisp EGA edges at 960×600 in VP9 or H.264. */
const BITS_PER_SECOND = 6_000_000;

/** The first video type this browser can record a canvas to, or null when it cannot. */
export function clipType(): string | null {
  if (typeof MediaRecorder === "undefined" || typeof HTMLCanvasElement === "undefined") return null;
  if (typeof HTMLCanvasElement.prototype.captureStream !== "function") return null;
  return CLIP_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
}

export interface ClipSource {
  compiled: { bytes: Uint8Array; spans: readonly PictureSourceSpan[] };
  timeline: readonly TimelineEntry[];
  profile: AgiProfile;
  caption: ShareCaption;
}

export interface RecordOptions {
  type: string;
  signal: AbortSignal;
  /** Fraction of the clip recorded, 0..1. */
  onProgress: (fraction: number) => void;
}

/** How long before a frame's time its timer fires; the rest is spun out. */
const SPIN_MS = 4;

/**
 * Wait until `performance.now()` reaches `time`, or the signal aborts. The
 * stream stamps a frame when it is handed over, and timers wake 1-4 ms
 * late, which shows as judder between frames: the timer wakes just short
 * of the time and a spin of at most SPIN_MS lands on it.
 */
async function until(time: number, signal: AbortSignal): Promise<void> {
  const wait = time - performance.now() - SPIN_MS;
  if (wait > 0)
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, wait);
      signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
    });
  while (!signal.aborted && performance.now() < time) {
    // Spin to the frame's time.
  }
}

/** Record the clip; rejects with an AbortError when the signal aborts. */
export async function recordClip(source: ClipSource, options: RecordOptions): Promise<Blob> {
  const { compiled, timeline, profile, caption } = source;
  const { type, signal, onProgress } = options;
  const frames = planClip(paintWeights(timeline, commandCells(compiled, profile)));

  const small = document.createElement("canvas");
  small.width = FRAME_WIDTH;
  small.height = FRAME_HEIGHT;
  const smallContext = small.getContext("2d")!;
  const canvas = document.createElement("canvas");
  canvas.width = FRAME_WIDTH * CLIP_SCALE;
  canvas.height = FRAME_HEIGHT * CLIP_SCALE;
  const context = canvas.getContext("2d", { alpha: false })!;
  context.imageSmoothingEnabled = false;

  let shown = "";
  /**
   * Put a frame on the canvas. It is drawn every time, even unchanged: the
   * stream skips a frame whose canvas was not drawn, and the held picture
   * and the caption would then last one frame each.
   */
  function draw(commands: number, captioned: boolean): void {
    const key = `${commands}:${captioned}`;
    if (key !== shown) {
      shown = key;
      const visual = renderUpTo(compiled, commands, profile).visual;
      const rgba = frameToRgb(composeFrame(visual, captioned ? caption : null), 1, 4);
      smallContext.putImageData(
        new ImageData(new Uint8ClampedArray(rgba.buffer), FRAME_WIDTH, FRAME_HEIGHT),
        0,
        0,
      );
    }
    context.drawImage(small, 0, 0, canvas.width, canvas.height);
  }

  // Frame 0 is on the canvas before the stream starts, so the video never opens blank.
  draw(frames[0]!.commands, frames[0]!.caption);
  let stream = canvas.captureStream(0);
  let track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined;
  if (typeof track?.requestFrame !== "function") {
    // No frame-by-frame capture: the browser samples the canvas at the clip's rate.
    for (const t of stream.getTracks()) t.stop();
    stream = canvas.captureStream(CLIP_FPS);
    track = undefined;
  }
  const recorder = new MediaRecorder(stream, {
    mimeType: type,
    videoBitsPerSecond: BITS_PER_SECOND,
  });
  const chunks: Blob[] = [];
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  });
  const stopped = new Promise<void>((resolve) =>
    recorder.addEventListener("stop", () => resolve(), { once: true }),
  );
  const period = 1000 / CLIP_FPS;
  try {
    recorder.start();
    const start = performance.now();
    for (let f = 0; f < frames.length && !signal.aborted; f++) {
      await until(start + f * period, signal);
      if (signal.aborted) break;
      if (document.hidden)
        throw new Error(
          "the tab went to the background. Bring this tab to the front and try again.",
        );
      draw(frames[f]!.commands, frames[f]!.caption);
      track?.requestFrame();
      onProgress((f + 1) / frames.length);
    }
    // The last frame lasts its own period before the recording closes.
    await until(start + frames.length * period, signal);
  } finally {
    if (recorder.state !== "inactive") {
      recorder.stop();
      await stopped;
    }
    for (const t of stream.getTracks()) t.stop();
  }
  if (signal.aborted) throw new DOMException("The clip was cancelled.", "AbortError");
  return new Blob(chunks, { type: type.split(";")[0]! });
}
