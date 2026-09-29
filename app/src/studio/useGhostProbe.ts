/**
 * State behind the Room Studio ghost-actor probe (GhostProbe.vue): which
 * VIEW/loop/cel stands where, and what the engine would do with it there.
 * The verdicts come from src/studio/probe.ts, which shares the engine's cel
 * blit and footprint scan; this module only chooses inputs and keys.
 */

import { computed, ref, toValue, watch, type MaybeRefOrGetter } from "vue";
import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../../../src/types.ts";
import { openContainer } from "../../../src/container/container.ts";
import type { AgiProfile } from "../../../src/runtime/profile.ts";
import { probeActor, type ProbeResult } from "../../../src/studio/probe.ts";
import {
  forEachPaintedPixel,
  parseView,
  selectViewCel,
  type AgiView,
  type ViewCel,
} from "../../../src/view/view.ts";

export interface GhostView {
  readonly number: number;
  readonly view: AgiView;
}

/** Every VIEW in the game's container files that parses, by number. */
export function listGameViews(
  files: ReadonlyMap<string, Uint8Array>,
  profile: Pick<AgiProfile, "packedViewLoopHeader">,
): GhostView[] {
  const container = openContainer(files);
  const views: GhostView[] = [];
  for (let number = 0; number < 256; number++) {
    try {
      const payload = container.getResource("view", number);
      if (payload) views.push({ number, view: parseView(payload, profile) });
    } catch {
      // A damaged or absent record is simply not offered.
    }
  }
  return views;
}

/** One placed cel pixel: its cell, colour, and whether the picture hides it. */
export interface GhostPixel {
  cell: number;
  color: number;
  hidden: boolean;
}

export interface GhostProbeOptions {
  views: MaybeRefOrGetter<readonly GhostView[]>;
  picture: MaybeRefOrGetter<{ readonly visual: Uint8Array; readonly priority: Uint8Array }>;
  profile: MaybeRefOrGetter<AgiProfile>;
  /** The room's set.pri.base when known. */
  priorityBase?: MaybeRefOrGetter<number | undefined>;
}

const wrap = (value: number, count: number): number => ((value % count) + count) % count;

export function useGhostProbe(options: GhostProbeOptions) {
  const active = ref(false);
  const viewNumber = ref<number>();
  const loop = ref(0);
  const celIndex = ref(0);
  const x = ref(70);
  const baselineY = ref(120);
  /** A fixed priority, or "band" for the baseline's band. */
  const priority = ref<number | "band">("band");

  const views = computed(() => toValue(options.views));
  const picture = computed(() => toValue(options.picture));
  const entry = computed(
    () => views.value.find((v) => v.number === viewNumber.value) ?? views.value[0],
  );
  const loopCount = computed(() => entry.value?.view.loops.length ?? 0);
  const celCount = computed(() => entry.value?.view.loops[loop.value]?.cels.length ?? 0);

  // Selection mirrors shared pixels in place, as the engine's set.loop does;
  // the probe keeps its own copy so a later alias cannot change it.
  const cel = computed<ViewCel | undefined>(() => {
    const view = entry.value?.view;
    const selected = view && selectViewCel(view, loop.value, celIndex.value);
    return selected && { ...selected, pixels: selected.pixels.slice() };
  });

  watch(
    () => entry.value?.number,
    () => {
      loop.value = 0;
      celIndex.value = 0;
    },
  );

  /** Keep the object where the engine keeps one: on the surface, baseline under its top. */
  function clamp(): void {
    const c = cel.value;
    if (!c) return;
    x.value = Math.min(Math.max(x.value, 0), Math.max(0, SCREEN_WIDTH - c.width));
    baselineY.value = Math.min(Math.max(baselineY.value, c.height - 1), SCREEN_HEIGHT - 1);
  }
  watch(cel, clamp);

  const result = computed<ProbeResult | undefined>(() => {
    const c = cel.value;
    if (!c) return undefined;
    return probeActor({
      picture: picture.value,
      cel: c,
      x: x.value,
      baselineY: baselineY.value,
      priority: priority.value,
      priorityBase: toValue(options.priorityBase),
      profile: toValue(options.profile),
    });
  });

  /** The cel's opaque pixels where the engine's blit places them. */
  const pixels = computed<GhostPixel[]>(() => {
    const c = cel.value;
    const r = result.value;
    if (!c || !r) return [];
    const out: GhostPixel[] = [];
    forEachPaintedPixel(picture.value, c, x.value, baselineY.value, 15, (cell, color) =>
      out.push({ cell, color, hidden: r.hiddenMask[cell] === 1 }),
    );
    return out;
  });

  function moveTo(nx: number, ny: number): void {
    x.value = Math.round(nx);
    baselineY.value = Math.round(ny);
    clamp();
  }
  function cycleLoop(step: 1 | -1): void {
    if (loopCount.value === 0) return;
    loop.value = wrap(loop.value + step, loopCount.value);
    celIndex.value = Math.min(celIndex.value, Math.max(0, celCount.value - 1));
  }
  function cycleCel(step: 1 | -1): void {
    if (celCount.value === 0) return;
    celIndex.value = wrap(celIndex.value + step, celCount.value);
  }
  function toggle(): void {
    active.value = !active.value;
  }

  /** The studio-level shortcut: G toggles the probe. Returns whether it handled the key. */
  function handleStudioKey(event: KeyboardEvent): boolean {
    if (event.metaKey || event.ctrlKey || event.altKey) return false;
    if (event.key !== "g" && event.key !== "G") return false;
    toggle();
    event.preventDefault();
    return true;
  }

  return {
    active,
    views,
    picture,
    viewNumber: computed({
      get: () => entry.value?.number,
      set: (n: number | undefined) => (viewNumber.value = n),
    }),
    loop,
    celIndex,
    loopCount,
    celCount,
    x,
    baselineY,
    priority,
    cel,
    result,
    pixels,
    moveTo,
    cycleLoop,
    cycleCel,
    toggle,
    handleStudioKey,
  };
}

export type GhostProbe = ReturnType<typeof useGhostProbe>;
