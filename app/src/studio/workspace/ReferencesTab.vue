<script setup lang="ts">
import { computed, nextTick, useTemplateRef, watch } from "vue";
import ReferenceUses from "../../shell/ReferenceUses.vue";
import { useWorkspaceEditor } from "../../shell/workspaceEditor.ts";
import { workspaceReferenceInfo } from "../../shell/workspaceNames.ts";
import { numberedLabel } from "../../../../src/logic/numberedLabels.ts";
import type { ProjectSnapshot } from "../../../../src/authoring/projectModel.ts";
import type { ProfileId } from "../../../../src/runtime/profile.ts";
const { active, snapshot, profileId } = defineProps<{
  active: boolean;
  snapshot: ProjectSnapshot | undefined;
  profileId: ProfileId;
}>();
const workspace = useWorkspaceEditor();
const root = useTemplateRef("root");
const info = computed(() => {
  const request = workspace.references.value;
  return request && snapshot && request.kind !== "symbol"
    ? workspaceReferenceInfo(snapshot, profileId, request)
    : request;
});
watch(
  () => [active, workspace.references.value],
  async () => {
    if (!active) return;
    await nextTick();
    root.value?.focus();
  },
  { immediate: true },
);
</script>
<template>
  <section
    ref="root"
    class="workspace-references"
    tabindex="-1"
    aria-label="References"
    data-testid="workspace-references"
  >
    <h2>References</h2>
    <p v-if="info" role="status">{{ numberedLabel(info.kind, info.num, { name: info.name }) }}</p>
    <ReferenceUses :uses="info?.uses ?? []" />
  </section>
</template>
<style scoped>
.workspace-references {
  overflow: auto;
  padding: var(--space-4) var(--space-5);
}
h2 {
  margin: 0;
  font-size: var(--text-sm);
}
p {
  font-size: var(--text-xs);
  color: var(--ink-2);
}
</style>
