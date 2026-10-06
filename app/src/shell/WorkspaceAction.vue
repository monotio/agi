<script setup lang="ts">
import { computed, ref } from "vue";
import { useWorkspaceEditor } from "./workspaceEditor.ts";
import { useEngineApi } from "../engine/engineContext.ts";
import ActionMenu from "../ui/ActionMenu.vue";
import UiButton from "../ui/UiButton.vue";
import UiDialog from "../ui/UiDialog.vue";
const editor = useWorkspaceEditor();
const engine = useEngineApi();
const discardOpen = ref(false);
const label = computed(() =>
  editor.changeCount.value
    ? editor.selectedLaunch.value === "my-game"
      ? "Update and return to my game"
      : `Update and restart ${editor.actionRoomName.value}`
    : editor.selectedLaunch.value === "my-game"
      ? "Play from my game"
      : editor.selectedLaunch.value === "beginning"
        ? "Play from beginning"
        : `${engine.roomMap.currentRoom.value === editor.actionRoom.value ? "Restart" : "Play"} ${editor.actionRoomName.value}`,
);
const selectedName = computed(() =>
  editor.selectedLaunch.value === "my-game"
    ? "From my game"
    : editor.selectedLaunch.value === "beginning"
      ? "From the beginning"
      : (editor.launchChoices.value.find((entry) => entry.id === editor.selectedLaunch.value)
          ?.name ?? "Carry over"),
);
async function discardChanges(): Promise<void> {
  try {
    await editor.discardDrafts.value?.();
    discardOpen.value = false;
  } catch (cause) {
    editor.error.value = cause instanceof Error ? cause.message : String(cause);
  }
}
</script>
<template>
  <div class="workspace-action">
    <UiButton
      size="sm"
      data-testid="workspace-update"
      :disabled="
        editor.busy.value || editor.readOnly.value || editor.actionRoom.value === undefined
      "
      :title="`${label} (⌘↵ / Ctrl+Enter) · ${selectedName}`"
      @click="editor.update.value?.()"
      >{{ label }}</UiButton
    >
    <ActionMenu
      label="Launch options"
      test-id="workspace-update-menu"
      icon-only
      size="sm"
      :disabled="
        editor.busy.value || editor.readOnly.value || editor.actionRoom.value === undefined
      "
    >
      <button
        v-for="choice in [
          { id: 'carry', name: 'Carry over' },
          { id: 'my-game', name: 'From my game' },
          { id: 'beginning', name: 'From the beginning' },
          ...editor.launchChoices.value,
        ]"
        :key="choice.id"
        type="button"
        role="menuitem"
        :aria-label="choice.name"
        :aria-current="editor.selectedLaunch.value === choice.id ? 'true' : undefined"
        @click="editor.selectLaunch.value?.(choice.id)"
      >
        <span aria-hidden="true">{{ editor.selectedLaunch.value === choice.id ? "✓" : "" }}</span
        >{{ choice.name }}
      </button>
      <div role="separator" />
      <button type="button" role="menuitem" @click="editor.requestLaunchEditor('new')">
        New launch…
      </button>
      <button type="button" role="menuitem" @click="editor.requestLaunchEditor('edit')">
        Edit launches…
      </button>
      <template v-if="editor.changeCount.value">
        <div role="separator" />
        <button type="button" role="menuitem" @click="editor.update.value?.(false)">
          Update and keep playing
        </button>
        <button type="button" role="menuitem" @click="discardOpen = true">Discard changes…</button>
      </template>
    </ActionMenu>
    <UiDialog
      v-model:open="discardOpen"
      title="Discard changes?"
      description="Your parts return to the game's last update."
    >
      <template #footer
        ><UiButton variant="ghost" @click="discardOpen = false">Cancel</UiButton
        ><UiButton :disabled="editor.busy.value" @click="discardChanges"
          >Discard changes</UiButton
        ></template
      >
    </UiDialog>
  </div>
</template>
<style scoped>
.workspace-action {
  display: inline-flex;
  flex-shrink: 0;
  gap: 2px;
}
@media (max-width: 600px) {
  .workspace-action {
    max-width: calc(100vw - 200px);
  }
  .workspace-action > button {
    min-width: 0;
    white-space: normal;
  }
}
</style>
