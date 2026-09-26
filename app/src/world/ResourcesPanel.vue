<script setup lang="ts">
/**
 * Create's Resources tab: every VIEW the game holds — its first cel, number,
 * description and the rooms whose logic uses it — each openable in Sprite
 * Studio. Catalog games and installed editions open too: the first Keep
 * forks a remix, as in Room Studio.
 */
import { computed } from "vue";
import UiButton from "../ui/UiButton.vue";
import { useEngineApi } from "../engineContext.ts";
import { useCreateWorkspace } from "../shell/useCreateWorkspace.ts";
import SpriteThumb from "../studio/sprite/SpriteThumb.vue";
import { usageText } from "../studio/sprite/spriteView.ts";
import { viewScan } from "./studioSource.ts";
import { useSpriteStudio } from "./useSpriteStudio.ts";

defineProps<{ readOnly: boolean }>();

const engine = useEngineApi();
const workspace = useCreateWorkspace();
const sprites = useSpriteStudio();
const views = computed(() => viewScan(engine.roomMap.resources.value).views);
const blocked = computed(() => workspace.studio.value !== null || !workspace.studioFits.value);
</script>

<template>
  <div class="resources-panel" data-testid="resources-panel">
    <h3 class="resources-panel__title">Views</h3>
    <p v-if="views.length === 0" class="resources-panel__empty">This game has no views.</p>
    <ul v-else class="resources-panel__list">
      <li
        v-for="entry in views"
        :key="entry.view"
        class="resources-panel__row"
        :data-testid="`resources-view-${entry.view}`"
      >
        <span class="resources-panel__thumb">
          <SpriteThumb v-if="entry.thumb" :cel="entry.thumb" :width="40" :height="40" />
        </span>
        <span class="resources-panel__text">
          <b>VIEW {{ entry.view }}</b>
          <span>{{ entry.description ?? (entry.thumb ? "" : "Does not decode") }}</span>
          <small>{{ usageText(entry.usage) }}</small>
        </span>
        <UiButton
          size="sm"
          :disabled="blocked || !entry.thumb"
          :aria-label="`Open VIEW ${entry.view} in Sprite Studio`"
          :data-testid="`resources-open-${entry.view}`"
          @click="sprites.open(entry.view)"
        >
          Open
        </UiButton>
      </li>
    </ul>
    <p v-if="!workspace.studioFits.value" class="resources-panel__empty">
      Sprite Studio needs a larger screen
    </p>
  </div>
</template>

<style scoped>
.resources-panel {
  display: grid;
  gap: var(--space-3);
}
.resources-panel__title {
  margin: 0;
  color: var(--ink-3);
  font: var(--weight-semibold) var(--text-2xs) / var(--leading) var(--font-sans);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}
.resources-panel__list {
  display: grid;
  gap: var(--space-1);
  margin: 0;
  padding: 0;
  list-style: none;
}
.resources-panel__row {
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius);
}
.resources-panel__row:hover {
  background: var(--surface-2);
}
.resources-panel__thumb {
  display: grid;
  place-items: end center;
  width: 48px;
  height: 44px;
  border-radius: var(--radius-sm);
  background: var(--surface-sunken);
}
.resources-panel__text {
  display: grid;
  min-width: 0;
  font-size: var(--text-xs);
}
.resources-panel__text b {
  font-family: var(--font-mono);
}
.resources-panel__text span,
.resources-panel__text small {
  overflow: hidden;
  color: var(--ink-2);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.resources-panel__text small {
  color: var(--ink-3);
  font-size: var(--text-2xs);
}
.resources-panel__empty {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--text-xs);
}
</style>
