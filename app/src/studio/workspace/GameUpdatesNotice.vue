<script setup lang="ts">
import { computed, ref, shallowRef } from "vue";
import { gameUpdates, type GameUpdate } from "../../../../src/authoring/scriptSizeMigration.ts";
import type { ProjectSnapshot } from "../../../../src/authoring/projectModel.ts";
import type { ProjectSession } from "../../project/projectSession.ts";
import UiButton from "../../ui/UiButton.vue";
import UiDialog from "../../ui/UiDialog.vue";
const { session, snapshot, disabled } = defineProps<{
  session: ProjectSession | null;
  snapshot: ProjectSnapshot | undefined;
  disabled: boolean;
}>();
const rows = computed(() =>
  snapshot && session
    ? gameUpdates(
        snapshot.lastAdmissibleBuild!.documents(),
        Object.fromEntries(snapshot.lastAdmissibleBuild!.files()),
        session.legacyRoomMemory,
      )
    : [],
);
const open = ref(false);
const selected = shallowRef<{ row: GameUpdate; base: ProjectSnapshot }>();
const busy = ref(false);
const error = ref("");
function preview(row: GameUpdate): void {
  if (!snapshot) return;
  selected.value = { row, base: snapshot };
  error.value = "";
  open.value = true;
}
async function add(): Promise<void> {
  if (!session || !selected.value?.row.source || busy.value || disabled) return;
  const { row, base } = selected.value;
  if (session.workingSnapshot().documentId !== base.documentId) {
    error.value = "The code changed. Cancel and open Add again.";
    return;
  }
  busy.value = true;
  try {
    const result = await session.submit({
      proposal: session.model.propose(base, `Add ${row.title.toLowerCase()}`, [
        { key: "logic:0", content: row.source! },
      ]),
      label: `Add ${row.title.toLowerCase()}`,
      origin: "logic",
      author: "creator",
    });
    if (result.status !== "committed" && result.status !== "unchanged") {
      error.value = "The code could not be added. Cancel and open Add again.";
      return;
    }
    await session.flush();
    open.value = false;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section
    v-if="rows.length"
    class="game-updates"
    data-testid="game-updates"
    aria-label="Game updates"
  >
    <strong>Game updates</strong>
    <div
      v-for="row in rows"
      :key="row.kind"
      class="game-update"
      :data-testid="`game-update-${row.kind}`"
    >
      <span
        ><b>{{ row.title }}</b
        ><small>{{ row.message }}</small></span
      >
      <UiButton
        v-if="row.source"
        size="sm"
        :disabled
        :title="disabled ? 'Finish the current change first' : ''"
        @click="preview(row)"
        >Add</UiButton
      >
    </div>
  </section>
  <UiDialog v-model:open="open" title="Add lines" data-testid="game-update-preview">
    <p>{{ selected?.row.location }}</p>
    <pre class="update-source">{{ selected?.row.preview }}</pre>
    <p v-if="error" role="alert">{{ error }}</p>
    <template #footer>
      <UiButton :disabled="busy" @click="open = false">Cancel</UiButton>
      <UiButton :disabled="busy || disabled" @click="add">Add</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.game-updates {
  flex: 0 0 auto;
  padding: var(--space-3);
  border-bottom: 1px solid var(--hairline);
  background: var(--surface-2);
  font-size: var(--text-sm);
}
.game-update {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin-top: var(--space-2);
}
.game-update b,
.game-update small {
  display: block;
}
.game-update small {
  color: var(--ink-2);
}
.update-source {
  overflow: auto;
  max-height: 50dvh;
  padding: var(--space-3);
  background: var(--surface-2);
  font: var(--text-sm) / 1.5 var(--font-mono);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
