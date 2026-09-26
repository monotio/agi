/**
 * A shelf card's opening-screen thumbnail when it has no stored picture:
 * rendered by the preview worker only once the card comes near the viewport,
 * through one session-wide queue that runs at most two renders at a time and
 * remembers every result in memory. Nothing here is persisted.
 */
import { onScopeDispose, ref, watch, type Ref } from "vue";
import { loadAuthoredGame, type CachedGameMeta } from "../gameStorage.ts";
import { fetchFixtureFiles } from "../gameDiscovery.ts";
import { previewGame } from "../gamePreview.ts";
import type { InstalledGameDescriptor } from "../gameTypes.ts";
import { parseWordsTok } from "../../../src/logic/words.ts";
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

/** A saved project's opening, run from its stored resources under its chosen interpreter. */
export function projectThumbnail(game: CachedGameMeta): ThumbnailSource {
  return {
    key: `project:${game.projectId}:${game.generation ?? 0}:${game.library?.revision ?? ""}`,
    async render() {
      const data = await loadAuthoredGame(game.projectId);
      if (!data) throw new Error("This game is no longer in your library.");
      return (await previewGame(data, data.library?.profile)).preview;
    },
  };
}

/** An installed development fixture's opening, fetched the way a boot fetches it. */
export function installedThumbnail(game: InstalledGameDescriptor): ThumbnailSource {
  const target = game.folder ?? game.hash;
  return {
    key: `installed:${target}:${game.revision ?? ""}`,
    async render() {
      const files = await fetchFixtureFiles(target);
      const vocabulary = files["WORDS.TOK"];
      if (!vocabulary) throw new Error("The game has no WORDS.TOK.");
      const words = parseWordsTok(vocabulary).map(
        (entry) => [entry.word, entry.id] as [string, number],
      );
      return (await previewGame({ files, words })).preview;
    },
  };
}
