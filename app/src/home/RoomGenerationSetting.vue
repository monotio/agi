<script setup lang="ts">
import { ref, watch } from "vue";
import type { ProjectId } from "../project/gameTypes.ts";
import { useEngineApi } from "../engine/engineContext.ts";
import { useGameLibrary } from "../library/useGameLibrary.ts";
import UiSwitch from "../ui/UiSwitch.vue";

const {
  projectId,
  enabled,
  generation = undefined,
  disabled = false,
} = defineProps<{
  projectId: ProjectId;
  enabled: boolean;
  generation?: number | undefined;
  disabled?: boolean;
}>();
const engine = useEngineApi();
const library = useGameLibrary();
const selected = ref(enabled);
const busy = ref(false);
const error = ref("");
watch(
  () => enabled,
  (value) => {
    selected.value = value;
  },
);
async function change(value: boolean): Promise<void> {
  if (busy.value || disabled) return;
  busy.value = true;
  selected.value = value;
  error.value = "";
  try {
    await engine.setRoomGeneration(projectId, value, generation);
    library.refreshLibrary();
  } catch (cause) {
    selected.value = enabled;
    error.value =
      cause instanceof Error && cause.name === "ConcurrencyConflictError"
        ? "This game changed in another tab. Reopen Details, then try again."
        : cause instanceof Error
          ? cause.message
          : String(cause);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div class="room-generation-setting">
    <UiSwitch
      size="sm"
      :model-value="selected"
      :disabled="disabled || busy"
      @update:model-value="change"
    >
      AI makes new rooms when the hero walks into one
    </UiSwitch>
    <p v-if="error" role="alert">{{ error }}</p>
  </div>
</template>
<style scoped>
.room-generation-setting {
  margin-top: var(--space-5);
}
p {
  color: var(--warn);
  font-size: var(--text-sm);
}
</style>
