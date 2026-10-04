<script setup lang="ts">
import { ref, watch } from "vue";
import type { BindingInfo } from "../../../src/logic/projectNames.ts";
import { useEngineApi } from "../engine/engineContext.ts";
import { useWorkspaceEditor } from "./workspaceEditor.ts";
import { renameWorkspaceBinding, workspaceBindingInfos } from "./workspaceNames.ts";
import UiButton from "../ui/UiButton.vue";
const { info, rename = false } = defineProps<{ info: BindingInfo; rename?: boolean }>();
const emit = defineEmits<{ close: []; renamed: [info: BindingInfo] }>();
const engine = useEngineApi();
const workspace = useWorkspaceEditor();
const editing = ref(rename);
const name = ref(info.name);
const busy = ref(false);
const error = ref("");
watch(
  () => info.name,
  (value) => {
    name.value = value;
    editing.value = rename;
    error.value = "";
  },
);
async function save(): Promise<void> {
  if (busy.value || workspace.readOnly.value) return;
  busy.value = true;
  error.value = "";
  try {
    await workspace.flush.value?.();
    const snapshot = engine.getProjectSession()?.model.capture();
    if (!snapshot) throw new Error("Open a project to rename its parts.");
    await renameWorkspaceBinding(
      engine,
      snapshot,
      engine.roomMap.resources.value.profile?.id ?? "2.936",
      info.name,
      name.value.trim(),
    );
    const updated = engine.getProjectSession()!.model.capture();
    const renamed = workspaceBindingInfos(
      updated,
      engine.roomMap.resources.value.profile?.id ?? "2.936",
    ).find((entry) => entry.name === name.value.trim());
    editing.value = false;
    emit("renamed", renamed ?? { ...info, name: name.value.trim() });
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy.value = false;
  }
}
function openUse(use: BindingInfo["uses"][number]): void {
  workspace.open(use.key, true);
  workspace.nameLocation.value = {
    key: use.key,
    line: use.range.start.line + 1,
    serial: Date.now(),
  };
  emit("close");
}
</script>
<template>
  <section class="binding-details" data-testid="binding-details" aria-label="Name details">
    <header>
      <strong
        >{{ info.name }} ·
        {{
          info.kind === "flag"
            ? "Flag"
            : info.kind === "variable"
              ? "Variable"
              : info.kind.toUpperCase()
        }}
        {{ info.num }}</strong
      ><UiButton size="sm" variant="ghost" @click="emit('close')">Close</UiButton>
    </header>
    <p>
      {{
        info.kind === "flag"
          ? "Remembers an on or off choice."
          : info.kind === "variable"
            ? "Holds a number from 0 to 255."
            : `Used in ${info.uses.length} places.`
      }}
    </p>
    <UiButton v-if="!editing" size="sm" :disabled="workspace.readOnly.value" @click="editing = true"
      >Rename</UiButton
    >
    <form v-else @submit.prevent="save">
      <label>Name<input v-model="name" aria-label="Name" :disabled="busy" /></label
      ><UiButton
        type="submit"
        size="sm"
        :disabled="busy || !name.trim() || workspace.readOnly.value"
        >Save name</UiButton
      ><UiButton size="sm" variant="ghost" :disabled="busy" @click="editing = false"
        >Cancel</UiButton
      >
    </form>
    <p v-if="error" role="alert">{{ error }}</p>
    <ul>
      <li
        v-for="use in info.uses"
        :key="`${use.key}:${use.range.start.line}:${use.range.start.character}`"
      >
        <button @click="openUse(use)">
          {{ use.role }} · {{ use.key.replace(":", " ").toUpperCase() }} · line
          {{ use.range.start.line + 1 }}<small>{{ use.text }}</small>
        </button>
      </li>
    </ul>
    <p v-if="!info.uses.length">Ready to use in your LOGIC.</p>
  </section>
</template>
<style scoped>
.binding-details {
  padding: var(--space-4);
  background: var(--surface-1);
  border: 1px solid var(--hairline);
  color: var(--ink);
  max-height: 60vh;
  overflow: auto;
}
header,
form {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  flex-wrap: wrap;
}
p,
small {
  color: var(--ink-2);
  font-size: var(--text-xs);
}
label {
  display: grid;
  gap: var(--space-1);
}
input {
  font: inherit;
  background: var(--surface-0);
  color: var(--ink);
  border: 1px solid var(--hairline-strong);
  padding: var(--space-2);
}
ul {
  padding: 0;
  list-style: none;
}
li button {
  display: grid;
  width: 100%;
  gap: var(--space-1);
  padding: var(--space-2);
  text-align: left;
  font: var(--text-xs) var(--font-sans);
  color: var(--action);
  background: transparent;
  border: 0;
  cursor: pointer;
}
small {
  overflow-wrap: anywhere;
}
</style>
