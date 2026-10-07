<script setup lang="ts">
import { documentLabel } from "../../../../src/logic/numberedLabels.ts";
import { projectLabelContext } from "../../shell/projectLabelContext.ts";
import { computed, ref, shallowRef } from "vue";
import UiDialog from "../../ui/UiDialog.vue";
import UiButton from "../../ui/UiButton.vue";
import { prepareProjectRenumber } from "../../../../src/authoring/projectRenumber.ts";
import type { ProjectSnapshot } from "../../../../src/authoring/projectModel.ts";
import type { AgiProfile } from "../../../../src/runtime/profile.ts";
const { snapshot, resource, profile, busy, error, restartRequired } = defineProps<{
  snapshot: ProjectSnapshot;
  resource: string;
  profile: AgiProfile;
  busy: boolean;
  error: string;
  restartRequired: boolean;
}>();
const emit = defineEmits<{
  change: [
    plan: Extract<ReturnType<typeof prepareProjectRenumber>, { ok: true }>,
    restart: boolean,
  ];
}>();
const open = defineModel<boolean>("open", { required: true });
const labels = computed(() => projectLabelContext(snapshot.documents(), profile));
const number = ref(resource.split(":")[1]!);
const problem = ref("");
const plan = shallowRef<Extract<ReturnType<typeof prepareProjectRenumber>, { ok: true }>>();
function preview(): void {
  problem.value = "";
  try {
    const result = prepareProjectRenumber({
      documents: snapshot.documents(),
      key: resource,
      number: Number(number.value),
      profile,
    });
    if (!result.ok) {
      problem.value = result.reason;
      return;
    }
    plan.value = result;
    if (!result.computed.length) emit("change", result, false);
  } catch (cause) {
    problem.value = cause instanceof Error ? cause.message : String(cause);
  }
}
</script>
<template>
  <UiDialog v-model:open="open" title="Change number" size="sm">
    <form v-if="!plan" id="change-number" @submit.prevent="preview">
      <p>{{ documentLabel(resource, labels) }} and its references move together.</p>
      <label class="renumber-field"
        >Number
        <input
          v-model="number"
          type="number"
          :min="resource.startsWith('logic:') ? 1 : 0"
          max="255"
          step="1"
          autofocus
          required
          :disabled="busy"
        />
      </label>
    </form>
    <p v-if="plan">
      {{ documentLabel(resource, labels) }} →
      {{ documentLabel(plan.key, labels) }}
    </p>
    <div v-if="plan?.computed.length" data-testid="renumber-computed">
      <p>These lines choose a part from a variable. Check them after the change.</p>
      <ul class="renumber-uses">
        <li v-for="(use, index) in plan.computed" :key="index">
          <strong>{{ documentLabel(use.document, labels) }} · Line {{ use.line }}</strong>
          <code>{{ use.source.trim() }}</code>
        </li>
      </ul>
    </div>
    <p v-if="problem || error" role="alert">{{ problem || error }}</p>
    <template #footer>
      <UiButton variant="ghost" :disabled="busy" @click="open = false">Cancel</UiButton>
      <UiButton v-if="!plan" type="submit" form="change-number" :disabled="busy">Continue</UiButton>
      <UiButton v-else :disabled="busy" @click="emit('change', plan, restartRequired)">{{
        restartRequired ? "Update and restart" : "Change number"
      }}</UiButton>
    </template>
  </UiDialog>
</template>
<style scoped>
.renumber-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.renumber-field input {
  width: 100%;
  padding: var(--space-2);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  color: var(--ink);
  font: inherit;
  box-sizing: border-box;
}
.renumber-uses {
  margin: 0;
  padding-left: var(--space-4);
}
.renumber-uses li {
  margin-block: var(--space-3);
}
.renumber-uses code {
  display: block;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  margin-top: var(--space-1);
  font: var(--text-sm) / var(--leading) var(--font-mono);
}
</style>
