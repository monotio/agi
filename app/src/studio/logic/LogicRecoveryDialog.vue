<script setup lang="ts">
import UiButton from "../../ui/UiButton.vue";
import UiChip from "../../ui/UiChip.vue";
import UiDialog from "../../ui/UiDialog.vue";
import { documentLabel } from "./logicWorkspace.ts";
import type { LogicRecoveryEntry } from "./logicRecovery.ts";

/**
 * The reopen review: every draft the project carries, offered explicitly.
 * A current draft can be restored or discarded; a stale one can be reviewed,
 * downloaded or discarded, but never restored over the kept project. The
 * dialog never auto-restores — Open keeps the workspace as stored.
 */
const { entries, busy } = defineProps<{
  readonly entries: readonly LogicRecoveryEntry[];
  readonly busy: boolean;
}>();
const emit = defineEmits<{
  restore: [entry: LogicRecoveryEntry];
  discard: [entry: LogicRecoveryEntry];
  download: [entry: LogicRecoveryEntry];
  openStored: [];
}>();
const open = defineModel<boolean>("open", { required: true });

function describe(entry: LogicRecoveryEntry): string {
  const names = entry.keys.map(documentLabel);
  const shown = names.slice(0, 4).join(", ");
  const rest = names.length > 4 ? ` and ${names.length - 4} more` : "";
  return `${names.length} document${names.length === 1 ? "" : "s"}: ${shown}${rest}`;
}
</script>

<template>
  <UiDialog
    v-model:open="open"
    title="Unfinished work"
    size="lg"
    description="Restore continues unfinished edits. Download saves a draft as a file; Discard deletes it. For an outdated draft, choose Download or Discard."
    data-testid="logic-recovery-dialog"
  >
    <ul class="logic-recovery__list">
      <li
        v-for="(entry, index) in entries"
        :key="index"
        class="logic-recovery__entry"
        :data-testid="`logic-recovery-${index}`"
      >
        <div class="logic-recovery__meta">
          <span class="logic-recovery__name">
            {{ entry.kind === "stored" ? "Unsaved draft" : "Imported draft" }}
          </span>
          <UiChip :tone="entry.status === 'current' ? 'ok' : 'warn'" dot>
            {{ entry.status === "current" ? "Current" : "Outdated" }}
          </UiChip>
        </div>
        <p class="logic-recovery__desc">{{ describe(entry) }}</p>
        <div class="logic-recovery__actions">
          <UiButton
            v-if="entry.status === 'current'"
            variant="primary"
            size="sm"
            :disabled="busy"
            data-testid="logic-recovery-restore"
            @click="emit('restore', entry)"
          >
            Restore
          </UiButton>
          <UiButton variant="ghost" size="sm" :disabled="busy" @click="emit('download', entry)">
            Download
          </UiButton>
          <UiButton
            v-if="entry.kind === 'stored'"
            variant="danger"
            size="sm"
            :disabled="busy"
            data-testid="logic-recovery-discard"
            @click="emit('discard', entry)"
          >
            Discard
          </UiButton>
        </div>
      </li>
    </ul>
    <template #footer>
      <UiButton variant="ghost" data-testid="logic-recovery-open" @click="emit('openStored')">
        Open as saved
      </UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.logic-recovery__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}
.logic-recovery__entry {
  padding: var(--space-3);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-sm);
  background: var(--surface-sunken);
}
.logic-recovery__meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}
.logic-recovery__name {
  font: var(--weight-semibold) var(--text-sm) / var(--leading) var(--font-sans);
}
.logic-recovery__desc {
  margin: var(--space-1) 0 var(--space-2);
  color: var(--ink-2);
  font: var(--text-xs) / var(--leading) var(--font-sans);
}
.logic-recovery__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
</style>
