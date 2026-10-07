<script setup lang="ts">
import { numberedLabel, numberedSlot, documentLabel } from "../../../src/logic/numberedLabels.ts";
import { useProjectLabels } from "./useProjectLabels.ts";
import { ref, watch } from "vue";
import type { BindingInfo } from "../../../src/logic/projectNames.ts";
import { useEngineApi } from "../engine/engineContext.ts";
import { useWorkspaceEditor } from "./workspaceEditor.ts";
import { renameBindingInWorkspace, workspaceBindingInfos } from "./workspaceNames.ts";
import UiButton from "../ui/UiButton.vue";
import UiIconButton from "../ui/UiIconButton.vue";
const { info, rename = false } = defineProps<{ info: BindingInfo; rename?: boolean }>();
const emit = defineEmits<{ close: []; renamed: [info: BindingInfo] }>();
const labels = useProjectLabels();
const engine = useEngineApi();
const workspace = useWorkspaceEditor();
const editing = ref(rename);
const name = ref(info.name);
const busy = ref(false);
const error = ref("");
watch(
  () => [info.kind, info.num, info.name] as const,
  ([kind, num, value], [oldKind, oldNum]) => {
    if (kind === oldKind && num === oldNum && (editing.value || busy.value)) return;
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
    const newName = name.value.trim();
    const original = { name: info.name, kind: info.kind, num: info.num };
    await renameBindingInWorkspace(engine, workspace.flush.value, original.name, newName);
    const updated = engine.getProjectSession()!.workingSnapshot();
    const renamed = workspaceBindingInfos(
      updated,
      engine.roomMap.resources.value.profile?.id ?? "2.936",
    ).find((entry) => entry.name === newName);
    if (info.kind === original.kind && info.num === original.num) {
      editing.value = false;
      emit("renamed", renamed ?? { ...info, name: newName });
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy.value = false;
  }
}
function openUse(use: BindingInfo["uses"][number]): void {
  workspace.open(use.key);
  workspace.nameLocation.value = {
    key: use.key,
    line: use.range.start.line + 1,
    serial: Date.now(),
  };
  emit("close");
}
</script>
<template>
  <section
    class="binding-details"
    data-testid="binding-details"
    aria-label="Name details"
    @keydown.esc.stop.prevent="emit('close')"
  >
    <header>
      <div>
        <strong>{{ numberedLabel(info.kind, info.num, { name: info.name }) }}</strong>
        <small>{{ numberedSlot(info.kind, info.num) }}</small>
      </div>
      <UiIconButton icon="x" label="Close" size="sm" @click="emit('close')" />
    </header>
    <p>
      {{
        info.kind === "flag"
          ? "Remembers an on or off choice."
          : info.kind === "variable"
            ? "Holds a number from 0 to 255."
            : `Used in ${info.uses.length} ${info.uses.length === 1 ? "place" : "places"}.`
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
    <template v-if="['flag', 'variable'].includes(info.kind)">
      <p v-for="role in ['Set', 'Checked'] as const" :key="role">
        {{ role }}:
        {{
          [
            ...new Set(
              info.uses
                .filter((use) => use.role === role)
                .map((use) => documentLabel(use.key, labels)),
            ),
          ].join(", ") || "nowhere yet"
        }}
      </p>
    </template>
    <ul>
      <li
        v-for="use in info.uses"
        :key="`${use.key}:${use.range.start.line}:${use.range.start.character}`"
      >
        <button @click="openUse(use)">
          {{ use.role }} · {{ documentLabel(use.key, labels) }} · line {{ use.range.start.line + 1
          }}<small>{{ use.text }}</small>
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
header {
  flex-wrap: nowrap;
  align-items: flex-start;
}
header strong {
  min-width: 0;
  overflow-wrap: anywhere;
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
  display: block;
  overflow-wrap: anywhere;
}
</style>
