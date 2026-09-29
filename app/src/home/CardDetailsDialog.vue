<script setup lang="ts">
/** The dialog a card's "Details…" menu item opens (see cardDetails.ts). */
import { computed } from "vue";
import UiDialog from "../ui/UiDialog.vue";
import { shownDetails } from "./cardDetails.ts";

const open = computed({
  get: () => shownDetails.value !== undefined,
  set: (value) => {
    if (!value) shownDetails.value = undefined;
  },
});
</script>

<template>
  <UiDialog
    v-model:open="open"
    :title="shownDetails?.title ?? 'Details'"
    size="sm"
    :data-testid="shownDetails?.testId ?? 'card-details'"
  >
    <template v-if="shownDetails">
      <p v-if="shownDetails.description" class="details-description">
        {{ shownDetails.description }}
      </p>
      <dl v-if="shownDetails.rows.length" class="details-rows">
        <template v-for="[term, value] in shownDetails.rows" :key="term">
          <dt>{{ term }}</dt>
          <dd>{{ value }}</dd>
        </template>
      </dl>
    </template>
  </UiDialog>
</template>

<style scoped>
.details-description {
  margin: 0 0 var(--space-5);
  color: var(--ink-2);
}
.details-rows {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: var(--space-2) var(--space-5);
  margin: 0;
  font-size: var(--text-sm);
}
.details-rows dt {
  color: var(--ink-3);
}
.details-rows dd {
  margin: 0;
  overflow-wrap: anywhere;
}
</style>
