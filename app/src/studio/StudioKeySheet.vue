<script setup lang="ts">
import UiDialog from "../ui/UiDialog.vue";
import UiKbd from "../ui/UiKbd.vue";
import type { KeySection } from "./studioHelp.ts";

/**
 * Every Studio key in one sheet, opened by `?` or the status bar's `?`
 * button; Esc or Close puts it away and focus returns where it was. The
 * canvas itself never carries keyboard help.
 */
const { name, sections } = defineProps<{
  /** "Room Studio" or "Sprite Studio". */
  name: string;
  sections: readonly KeySection[];
}>();
const open = defineModel<boolean>("open", { required: true });
</script>

<template>
  <UiDialog
    v-model:open="open"
    :title="`${name} keys`"
    description="Keys work while the canvas or the studio has focus. Text fields take typing."
    size="lg"
    data-testid="studio-key-sheet"
  >
    <div class="key-sheet">
      <section v-for="section in sections" :key="section.title" class="key-sheet__section">
        <h3 class="key-sheet__title">{{ section.title }}</h3>
        <dl class="key-sheet__rows">
          <template v-for="row in section.rows" :key="row.does">
            <dt>
              <template v-for="(key, k) in row.keys" :key="key">
                <span v-if="k > 0" class="key-sheet__or">/</span><UiKbd>{{ key }}</UiKbd>
              </template>
            </dt>
            <dd>{{ row.does }}</dd>
          </template>
        </dl>
      </section>
    </div>
  </UiDialog>
</template>

<style scoped>
.key-sheet {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
  gap: var(--space-6) var(--space-8);
}
.key-sheet__title {
  margin: 0 0 var(--space-3);
  color: var(--ink-3);
  font: var(--weight-bold) var(--text-2xs) / 1 var(--font-sans);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}
.key-sheet__rows {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: var(--space-2) var(--space-4);
  align-items: baseline;
  margin: 0;
  font-size: var(--text-sm);
}
.key-sheet__rows dt {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  align-items: baseline;
  justify-content: flex-end;
}
.key-sheet__rows dd {
  margin: 0;
  color: var(--ink-2);
}
.key-sheet__or {
  color: var(--ink-3);
  font-size: var(--text-2xs);
}
</style>
