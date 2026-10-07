<script setup lang="ts">
import { computed, ref } from "vue";
import { useWorkspaceEditor } from "./workspaceEditor.ts";
import { useEngineApi } from "../engine/engineContext.ts";
import ActionMenu from "../ui/ActionMenu.vue";
import UiButton from "../ui/UiButton.vue";
import UiDialog from "../ui/UiDialog.vue";
import UiIcon from "../ui/UiIcon.vue";
import { launchAction, launchName } from "./launchAction.ts";
const editor = useWorkspaceEditor();
const engine = useEngineApi();
const discardOpen = ref(false);
const selectedName = computed(() =>
  launchName(editor.selectedLaunch.value, editor.launchChoices.value),
);
function actionFor(pending: boolean) {
  return launchAction({
    pending,
    launch: editor.selectedLaunch.value,
    launchName: selectedName.value,
    room: editor.actionRoomName.value,
    here: engine.roomMap.currentRoom.value === editor.actionRoom.value,
  });
}
const action = computed(() => actionFor(editor.changeCount.value > 0));
/** The other state's wording, laid under the label so the button keeps its width. */
const reserve = computed(() => actionFor(editor.changeCount.value === 0));
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
      :aria-label="action.label"
      :title="`${action.label} (⌘↵ / Ctrl+Enter)`"
      @click="editor.update.value?.()"
      ><span class="workspace-action__stack"
        ><span
          v-for="(row, index) in [action, reserve]"
          :key="index"
          class="workspace-action__label"
          :aria-hidden="index === 1 ? 'true' : undefined"
          ><span v-if="row.update">Update</span
          ><UiIcon :name="row.icon" :size="14" :stroke-width="2.5" /><span
            class="workspace-action__room"
            >{{ row.room
            }}<span v-if="row.launch" class="workspace-action__launch">
              · {{ row.launch }}</span
            ></span
          ></span
        ></span
      ></UiButton
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
/* Both wordings share one grid cell: the wider one sets the width, so
   pending changes and Update never move the bar. */
.workspace-action__stack {
  display: inline-grid;
  max-width: 360px;
}
.workspace-action__label {
  grid-area: 1 / 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  min-width: 0;
}
.workspace-action__label[aria-hidden="true"] {
  visibility: hidden;
}
.workspace-action__room {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.workspace-action__launch {
  font-weight: var(--weight-medium);
}
@media (max-width: 600px) {
  .workspace-action {
    max-width: calc(100vw - 200px);
  }
  .workspace-action > button {
    min-width: 0;
    padding-inline: var(--space-3);
    white-space: normal;
  }
  .workspace-action__stack {
    max-width: 100%;
  }
}
</style>
