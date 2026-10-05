<script setup lang="ts">
import { computed, ref, watch } from "vue";
import UiButton from "../ui/UiButton.vue";
import { tipDismissed, dismissTip, tipRevision } from "./workspaceTips.ts";
const { id, text } = defineProps<{ id: string; text: string }>();
const dismissed = ref(false);
watch(tipRevision, () => {
  dismissed.value = false;
});
const visible = computed(() => {
  void tipRevision.value;
  return !dismissed.value && !tipDismissed(id);
});
</script>
<template>
  <aside
    v-if="visible"
    class="workspace-tip"
    :data-testid="`${id === 'workspace' ? 'workspace' : 'editor'}-tip`"
  >
    <span>{{ text }}</span
    ><UiButton
      size="sm"
      variant="ghost"
      @click="
        dismissTip(id);
        dismissed = true;
      "
      >Got it</UiButton
    >
  </aside>
</template>
<style scoped>
.workspace-tip {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-shrink: 0;
  color: var(--ink-2);
  font-size: var(--text-xs);
  padding: var(--space-2);
  border-bottom: 1px solid var(--hairline);
}
.workspace-tip span {
  flex: 1;
}
</style>
