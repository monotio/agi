/**
 * A supplied shelf image loads once its card comes near the viewport,
 * through one session-wide queue that runs at most two renders at a time and
 * remembers every result in memory. Nothing here is persisted.
 */
import { onScopeDispose, ref, watch, type Ref } from "vue";
import { createThumbnailQueue } from "./thumbnailQueue.ts";

export interface ThumbnailSource {
  /** Identifies the rendered bytes: the same key is never rendered twice in a session. */
  key: string;
  render(): Promise<string>;
}

export type ThumbnailStatus = "idle" | "loading" | "ready" | "failed";

const queue = createThumbnailQueue(2);

/** How far outside the viewport a card starts rendering. */
const NEAR_VIEWPORT = "200px";

export function useLazyThumbnail(
  target: Readonly<Ref<Element | null | undefined>>,
  source: () => ThumbnailSource | undefined,
) {
  const src = ref<string>();
  const status = ref<ThumbnailStatus>("idle");
  let observer: IntersectionObserver | undefined;
  let controller: AbortController | undefined;
  let current: string | undefined;

  function release(): void {
    observer?.disconnect();
    observer = undefined;
    controller?.abort();
    controller = undefined;
  }

  function load(wanted: ThumbnailSource): void {
    status.value = "loading";
    controller = new AbortController();
    queue
      .request(wanted.key, () => wanted.render(), controller.signal)
      .then(
        (preview) => {
          if (current !== wanted.key) return;
          src.value = preview;
          status.value = "ready";
        },
        () => {
          if (current === wanted.key) status.value = "failed";
        },
      );
  }

  watch(
    [target, () => source()?.key] as const,
    ([element, key]) => {
      release();
      current = key;
      src.value = key ? queue.cached(key) : undefined;
      status.value = src.value ? "ready" : "idle";
      const wanted = source();
      if (!element || !wanted || src.value) return;
      if (typeof IntersectionObserver === "undefined") {
        load(wanted);
        return;
      }
      observer = new IntersectionObserver(
        (entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return;
          observer?.disconnect();
          observer = undefined;
          load(wanted);
        },
        { rootMargin: NEAR_VIEWPORT },
      );
      observer.observe(element);
    },
    { immediate: true },
  );
  onScopeDispose(release);

  return { src, status };
}
