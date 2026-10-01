<script setup lang="ts">
import { computed } from "vue";
import { byteLines } from "./logicWorkspace.ts";

/**
 * The read-only view of retained native bytes: an offset/hex/text dump, and
 * — for a LOGIC without provable authored source — a clearly derived
 * disassembly preview, marked derived so it is never taken for the original.
 */
const { bytes, derivedSource } = defineProps<{
  readonly bytes: Uint8Array;
  readonly derivedSource: string | undefined;
}>();
const lines = computed(() => byteLines(bytes));
</script>

<template>
  <div class="logic-bytes" data-testid="logic-bytes">
    <p class="logic-bytes__note">
      Binary document, {{ bytes.length.toLocaleString() }} byte{{ bytes.length === 1 ? "" : "s" }},
      read-only.
    </p>
    <pre class="logic-bytes__hex" aria-label="Byte dump"><code
      >{{ lines.join("\n") }}</code
    ></pre>
    <details v-if="derivedSource !== undefined" class="logic-bytes__derived">
      <summary>Derived preview</summary>
      <p class="logic-bytes__note">Disassembled from the bytes, for reading.</p>
      <pre class="logic-bytes__hex" data-testid="logic-derived-preview"><code
        >{{ derivedSource }}</code
      ></pre>
    </details>
  </div>
</template>

<style scoped>
.logic-bytes {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  overflow: auto;
  padding: var(--space-4);
}
.logic-bytes__note {
  margin: 0;
  color: var(--ink-3);
  font: var(--text-xs) / var(--leading) var(--font-sans);
}
.logic-bytes__hex {
  margin: 0;
  padding: var(--space-3);
  overflow: auto;
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-sm);
  color: var(--ink-2);
  background: var(--surface-sunken);
  font: var(--text-xs) / 1.6 var(--font-mono);
  white-space: pre;
}
.logic-bytes__derived summary {
  color: var(--ink-2);
  font: var(--weight-medium) var(--text-sm) / var(--leading) var(--font-sans);
  cursor: pointer;
}
</style>
