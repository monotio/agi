<script setup lang="ts">
import { ref } from "vue";
import UiButton from "./UiButton.vue";
import UiChip from "./UiChip.vue";
import UiDialog from "./UiDialog.vue";
import UiField from "./UiField.vue";
import UiIcon from "./UiIcon.vue";
import UiIconButton from "./UiIconButton.vue";
import UiKbd from "./UiKbd.vue";
import UiPanel from "./UiPanel.vue";
import UiSegmented from "./UiSegmented.vue";
import { ICONS, type IconName } from "./icons.ts";

/** Dev and test only (ui-gallery.html is not a build input): every primitive in every state. */
const lens = ref<"art" | "depth" | "walk">("depth");
const dialogOpen = ref(false);
const title = ref("The Clearing");
const pressed = ref(true);
const iconNames = Object.keys(ICONS) as IconName[];
const surfaces = ["surface-sunken", "surface-0", "surface-1", "surface-2", "surface-3"];
const inks = ["ink", "ink-2", "ink-3", "ink-disabled", "action", "ok", "warn", "danger"];
</script>

<template>
  <main class="gallery">
    <h1 class="wordmark">UI GALLERY</h1>

    <section>
      <h2>Buttons</h2>
      <div class="row">
        <UiButton variant="primary">Keep changes</UiButton>
        <UiButton variant="primary" icon="play">Play here</UiButton>
        <UiButton>Secondary</UiButton>
        <UiButton icon="map">World map</UiButton>
        <UiButton variant="ghost" icon="undo" shortcut="⌘Z">Undo</UiButton>
        <UiButton variant="danger" icon="trash">Delete</UiButton>
        <UiButton variant="primary" disabled>Disabled</UiButton>
        <UiButton disabled>Disabled</UiButton>
      </div>
      <div class="row">
        <UiButton variant="primary" size="sm">Small primary</UiButton>
        <UiButton size="sm" trailing-icon="chevron-down">Game</UiButton>
        <UiButton variant="ghost" size="sm" icon="sparkles">Ask</UiButton>
      </div>
      <div class="row">
        <UiIconButton
          icon="select"
          label="Select"
          shortcut="V"
          :pressed="pressed"
          @click="pressed = !pressed"
        />
        <UiIconButton icon="line" label="Line" shortcut="L" :pressed="false" />
        <UiIconButton icon="fill" label="Fill" shortcut="F" :pressed="false" />
        <UiIconButton icon="undo" label="Undo" />
        <UiIconButton icon="redo" label="Redo" disabled />
        <UiIconButton icon="x" label="Close" size="sm" />
      </div>
    </section>

    <section>
      <h2>Segmented, chips, keys</h2>
      <div class="row">
        <UiSegmented
          v-model="lens"
          label="Lens"
          :options="[
            { value: 'art', label: 'Art', shortcut: '1' },
            { value: 'depth', label: 'Depth', shortcut: '2' },
            { value: 'walk', label: 'Walk', shortcut: '3' },
          ]"
        />
        <UiSegmented
          v-model="lens"
          label="Lens (small)"
          size="sm"
          :options="[
            { value: 'art', label: 'Art' },
            { value: 'depth', label: 'Depth' },
            { value: 'walk', label: 'Walk', disabled: true },
          ]"
        />
      </div>
      <div class="row">
        <UiChip>room 1 · PIC 1</UiChip>
        <UiChip tone="action">pri 10</UiChip>
        <UiChip tone="ok" dot>Compiles exactly</UiChip>
        <UiChip tone="warn" dot>Not walk-tested</UiChip>
        <UiChip tone="danger" dot>Stale</UiChip>
        <span>Press <UiKbd>⌘</UiKbd> <UiKbd>K</UiKbd> for commands</span>
      </div>
    </section>

    <section class="split">
      <UiPanel title="Scene" flush>
        <template #actions><UiIconButton icon="plus" label="Add object" size="sm" /></template>
        <ul class="list">
          <li>Walls &amp; beams</li>
          <li class="selected">Bench occluder</li>
          <li>Floor edge</li>
        </ul>
        <template #footer>Art is locked in the Depth lens.</template>
      </UiPanel>
      <UiPanel title="Room">
        <div class="stack">
          <UiField v-slot="{ id, describedBy }" label="Name" hint="Shown on the map.">
            <input :id v-model="title" :aria-describedby="describedBy" />
          </UiField>
          <UiField
            v-slot="{ id, describedBy, invalid }"
            label="Exit to"
            error="Room 9 does not exist."
          >
            <input :id value="9" :aria-describedby="describedBy" :aria-invalid="invalid" />
          </UiField>
          <UiButton variant="primary" @click="dialogOpen = true">Open dialog</UiButton>
        </div>
      </UiPanel>
    </section>

    <section>
      <h2>Tokens</h2>
      <div class="row">
        <div
          v-for="name in surfaces"
          :key="name"
          class="swatch"
          :style="{ background: `var(--${name})` }"
        >
          {{ name }}
        </div>
      </div>
      <div class="row">
        <span v-for="name in inks" :key="name" class="ink" :style="{ color: `var(--${name})` }">{{
          name
        }}</span>
      </div>
      <div class="row">
        <i
          v-for="index in 16"
          :key="index"
          class="agi"
          :style="{ background: `var(--agi-${index - 1})` }"
        ></i>
      </div>
      <p class="type">
        <span style="font-size: var(--text-2xs)">2xs</span>
        <span style="font-size: var(--text-xs)">xs</span>
        <span style="font-size: var(--text-sm)">sm</span>
        <span style="font-size: var(--text-md)">md</span>
        <span style="font-size: var(--text-lg)">lg</span>
        <span style="font-size: var(--text-xl)">xl</span>
        <span style="font-size: var(--text-2xl)">2xl</span>
      </p>
    </section>

    <section>
      <h2>Icons ({{ iconNames.length }})</h2>
      <div class="icons">
        <figure v-for="name in iconNames" :key="name">
          <UiIcon :name />
          <figcaption>{{ name }}</figcaption>
        </figure>
      </div>
    </section>

    <UiDialog
      v-model:open="dialogOpen"
      title="Start fresh?"
      description="Stored data from an older build can't be read."
    >
      <p>
        This removes the unreadable copy of Adventure Department from this browser. Exported files
        are not affected.
      </p>
      <template #footer>
        <UiButton variant="ghost" @click="dialogOpen = false">Cancel</UiButton>
        <UiButton variant="danger" @click="dialogOpen = false">Start fresh</UiButton>
      </template>
    </UiDialog>
  </main>
</template>

<style scoped>
.gallery {
  box-sizing: border-box;
  width: min(1120px, 100%);
  margin: 0 auto;
  padding: var(--space-8) var(--space-5);
  color: var(--ink);
  font: var(--text-md) / var(--leading) var(--font-sans);
}
.wordmark {
  margin: 0 0 var(--space-7);
  font: var(--weight-bold) var(--text-2xl) var(--font-mono);
  letter-spacing: 0.04em;
}
section {
  margin-bottom: var(--space-8);
}
h2 {
  margin: 0 0 var(--space-4);
  color: var(--ink-3);
  font: var(--weight-bold) var(--text-2xs) var(--font-sans);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}
.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
}
.split {
  display: grid;
  grid-template-columns: 260px 1fr;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-lg);
  overflow: hidden;
}
.split > :first-child {
  border-right: 1px solid var(--hairline);
}
.list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.list li {
  padding: var(--space-2) var(--space-5);
  color: var(--ink-2);
}
.list li.selected {
  color: var(--ink);
  background: var(--action-soft);
  box-shadow: inset 2px 0 var(--action);
}
.stack {
  display: grid;
  gap: var(--space-5);
  max-width: 360px;
}
.swatch {
  display: grid;
  place-items: end start;
  width: 120px;
  height: 64px;
  padding: var(--space-2);
  box-sizing: border-box;
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  color: var(--ink-3);
  font: var(--text-2xs) var(--font-mono);
}
.ink {
  font: var(--weight-semibold) var(--text-sm) var(--font-mono);
}
.agi {
  width: 24px;
  height: 24px;
  border-radius: var(--radius-sm);
  box-shadow: inset 0 0 0 1px var(--hairline-strong);
}
.type span {
  margin-right: var(--space-4);
}
.icons {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
  gap: var(--space-3);
}
.icons figure {
  display: grid;
  justify-items: center;
  gap: var(--space-2);
  margin: 0;
  padding: var(--space-4) var(--space-1);
  border-radius: var(--radius);
  color: var(--ink-2);
  background: var(--surface-1);
}
.icons figcaption {
  color: var(--ink-3);
  font: var(--text-2xs) var(--font-mono);
}
</style>
