<script setup lang="ts">
import UiButton from "../ui/UiButton.vue";
import { emptyProject } from "./emptyProjectRoute.ts";
import type { CachedGameData } from "../project/gameTypes.ts";
defineProps<{ project: CachedGameData }>();
function goHome(): void {
  emptyProject.value = null;
  history.pushState(null, "", location.pathname + location.search);
}
</script>

<template>
  <section class="empty-project" aria-label="Create" data-testid="empty-project-stage">
    <header>
      <div>
        <span>Create</span>
        <h1>{{ project.title }}</h1>
      </div>
      <UiButton @click="goHome">Home</UiButton>
    </header>
    <div class="empty-stage" role="status">Nothing to play yet. Add a LOGIC 0 to start.</div>
  </section>
</template>

<style scoped>
.empty-project {
  width: 100%;
  padding: var(--space-7) 0;
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-5);
}
header span {
  color: var(--ink-2);
  font-size: var(--text-sm);
}
h1 {
  margin: 0;
  font-size: var(--text-xl);
}
.empty-stage {
  display: grid;
  place-items: center;
  min-height: 60dvh;
  margin-top: var(--space-7);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-lg);
  color: var(--ink-2);
  background: var(--surface-0);
  text-align: center;
  padding: var(--space-7);
}
</style>
