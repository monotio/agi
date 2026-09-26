<script setup lang="ts">
/**
 * One card on the Home shelf, with one anatomy for every kind of card: the
 * 8:5 screen, the title, one line of detail and a footer row with the card's
 * action and its ⋯ menu. The screen is the first of: a known picture
 * (autosave progress or a stored opening), an opening rendered lazily near
 * the viewport, a quiet placeholder while that runs, and the monogram. With
 * `playLabel` set, clicking the screen does what the footer's main button
 * does; the pill it shows on hover (or while that button has keyboard focus)
 * is decoration, and keyboard and assistive users reach the footer button.
 */
import { useTemplateRef } from "vue";
import UiChip from "../ui/UiChip.vue";
import UiIcon from "../ui/UiIcon.vue";
import { useLazyThumbnail, type ThumbnailSource } from "./useLazyThumbnail.ts";

export interface CardImage {
  src: string;
  alt: string;
  kind: "progress" | "opening";
}

const {
  image = undefined,
  lazy = undefined,
  lazyAlt = "",
  pending = false,
  badge = undefined,
  meta = undefined,
  titleTestId = undefined,
  headingHidden = false,
  playLabel = undefined,
  playDisabled = false,
} = defineProps<{
  title: string;
  monogram: string;
  image?: CardImage | undefined;
  /** Renders the opening when there is no known picture. */
  lazy?: ThumbnailSource | undefined;
  lazyAlt?: string;
  /** Something else is fetching the picture; show the placeholder. */
  pending?: boolean;
  badge?: string | undefined;
  /** The card's one line of detail. */
  meta?: string | undefined;
  titleTestId?: string | undefined;
  headingHidden?: boolean;
  /** The screen's click action, named on its hover pill ("Play", "Resume"). */
  playLabel?: string | undefined;
  playDisabled?: boolean;
}>();
const emit = defineEmits<{ play: [] }>();

const root = useTemplateRef("root");
const rendered = useLazyThumbnail(root, () => (image ? undefined : lazy));

function onScreenClick(): void {
  if (playLabel && !playDisabled) emit("play");
}
</script>

<template>
  <article ref="root" class="game-card">
    <div
      class="game-card__media"
      :class="{ 'game-card__media--playable': playLabel && !playDisabled }"
      @click="onScreenClick"
    >
      <slot name="media">
        <img
          v-if="image"
          class="game-card__image"
          data-testid="library-thumbnail"
          :data-preview-kind="image.kind"
          :src="image.src"
          :alt="image.alt"
        />
        <img
          v-else-if="rendered.src.value"
          class="game-card__image"
          data-testid="library-thumbnail"
          data-preview-kind="opening"
          :src="rendered.src.value"
          :alt="lazyAlt"
        />
        <div
          v-else-if="pending || rendered.status.value === 'loading'"
          class="game-card__placeholder"
          data-testid="thumbnail-placeholder"
          aria-hidden="true"
        ></div>
        <div v-else class="game-card__monogram" aria-hidden="true">{{ monogram }}</div>
      </slot>
      <UiChip v-if="badge" class="game-card__badge">{{ badge }}</UiChip>
      <span v-if="playLabel && !playDisabled" class="game-card__pill" aria-hidden="true">
        <UiIcon name="play" :size="16" />{{ playLabel }}
      </span>
    </div>
    <div class="game-card__body">
      <div v-show="!headingHidden" class="game-card__heading">
        <h3 class="game-card__title" :data-testid="titleTestId">{{ title }}</h3>
        <p v-if="meta" class="game-card__meta">{{ meta }}</p>
      </div>
      <slot />
      <div v-if="$slots['actions']" class="game-card__actions">
        <slot name="actions" />
      </div>
    </div>
  </article>
</template>

<style scoped>
.game-card {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-lg);
  background: var(--surface-1);
  transition: border-color var(--duration-fast) var(--ease-out);
}
.game-card:hover,
.game-card:focus-within {
  border-color: var(--hairline-strong);
}
.game-card__media {
  position: relative;
  flex: none;
  aspect-ratio: 8 / 5;
  overflow: hidden;
  background: var(--agi-0);
}
.game-card__media--playable {
  cursor: pointer;
}
.game-card__image {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  image-rendering: pixelated;
}
.game-card__placeholder {
  height: 100%;
  background: linear-gradient(
    100deg,
    var(--surface-sunken) 30%,
    var(--surface-2) 50%,
    var(--surface-sunken) 70%
  );
  background-size: 300% 100%;
  animation: game-card-shimmer 1.6s linear infinite;
}
@keyframes game-card-shimmer {
  from {
    background-position: 100% 0;
  }
  to {
    background-position: 0 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .game-card__placeholder {
    animation: none;
  }
}
.game-card__monogram {
  display: grid;
  height: 100%;
  box-sizing: border-box;
  place-items: center;
  padding: var(--space-4);
  overflow: hidden;
  overflow-wrap: anywhere;
  color: var(--ink-3);
  background: linear-gradient(145deg, var(--surface-3), var(--surface-sunken));
  font: var(--weight-bold) var(--text-xl) / 1.1 var(--font-mono);
  letter-spacing: 0.15em;
  text-align: center;
}
.game-card__badge {
  position: absolute;
  z-index: 1;
  top: var(--space-3);
  left: var(--space-3);
  background: var(--surface-overlay);
}
/* The screen's action, shown under the pointer or while its button has keyboard focus. */
.game-card__pill {
  position: absolute;
  z-index: 1;
  top: 50%;
  left: 50%;
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-5) var(--space-2) var(--space-4);
  border: 1px solid var(--action-line);
  border-radius: var(--radius-pill);
  color: var(--action);
  background: var(--surface-overlay);
  box-shadow: var(--shadow-pop);
  font: var(--weight-semibold) var(--text-sm) / var(--leading-tight) var(--font-sans);
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
  transform: translate(-50%, -50%) scale(0.96);
  transition:
    opacity var(--duration-fast) var(--ease-out),
    transform var(--duration-fast) var(--ease-out);
}
.game-card__media--playable::after {
  position: absolute;
  inset: 0;
  background: var(--scrim);
  content: "";
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--duration-fast) var(--ease-out);
}
.game-card__media--playable:hover .game-card__pill,
.game-card:has(.game-card__actions > :first-child:focus-visible) .game-card__pill {
  opacity: 1;
  transform: translate(-50%, -50%);
}
.game-card__media--playable:hover::after,
.game-card:has(.game-card__actions > :first-child:focus-visible)
  .game-card__media--playable::after {
  opacity: 0.5;
}
.game-card__body {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
  padding: var(--space-4);
}
.game-card__heading {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}
.game-card__title {
  margin: 0;
  overflow: hidden;
  color: var(--ink);
  font: var(--weight-semibold) var(--text-md) / var(--leading-tight) var(--font-sans);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.game-card__meta {
  margin: 0;
  overflow: hidden;
  color: var(--ink-3);
  font-size: var(--text-xs);
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}
:slotted(.game-card__alert) {
  margin: 0;
  color: var(--danger);
  font-size: var(--text-xs);
  line-height: 1.4;
}
.game-card__actions {
  display: flex;
  gap: var(--space-2);
  margin-top: auto;
  padding-top: var(--space-2);
}
:slotted(.game-card__actions-main) {
  flex: 1 1 auto;
  min-width: 0;
}
@media (max-width: 520px) {
  .game-card__body {
    padding: var(--space-3);
  }
  .game-card__monogram {
    font-size: var(--text-md);
  }
}
</style>
