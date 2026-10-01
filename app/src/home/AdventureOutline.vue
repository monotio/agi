<script setup lang="ts">
import { computed } from "vue";
import { parseOutline } from "./adventureOutline.ts";

const { source } = defineProps<{ source: string }>();
const blocks = computed(() => parseOutline(source));
</script>

<template>
  <article
    class="outline"
    aria-label="Adventure outline"
    data-testid="adventure-outline-preview"
    tabindex="0"
  >
    <template v-for="(block, index) in blocks" :key="index">
      <component :is="`h${Math.min(block.level + 1, 6)}`" v-if="block.kind === 'heading'">
        {{ block.text }}
      </component>
      <p v-else-if="block.kind === 'paragraph'">{{ block.text }}</p>
      <component :is="block.ordered ? 'ol' : 'ul'" v-else-if="block.kind === 'list'">
        <li v-for="(item, itemIndex) in block.items" :key="itemIndex">{{ item }}</li>
      </component>
      <table v-else-if="block.kind === 'table'">
        <thead>
          <tr>
            <th v-for="(cell, column) in block.rows[0]" :key="column" scope="col">{{ cell }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, rowIndex) in block.rows.slice(1)" :key="rowIndex">
            <td v-for="(cell, column) in row" :key="column">{{ cell }}</td>
          </tr>
        </tbody>
      </table>
    </template>
  </article>
</template>

<style scoped>
.outline {
  box-sizing: border-box;
  max-height: 360px;
  overflow: auto;
  padding: var(--space-6);
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  background: var(--surface-1);
  color: var(--ink-2);
  font: var(--text-sm) / 1.6 var(--font-sans);
  overflow-wrap: anywhere;
}
.outline h2 {
  margin: 0 0 var(--space-5);
  color: var(--ink);
  font-size: var(--text-lg);
  line-height: var(--leading-tight);
}
.outline :is(h3, h4, h5, h6) {
  margin: var(--space-6) 0 var(--space-2);
  color: var(--ink);
  font-size: var(--text-sm);
}
.outline :is(p, ul, ol) {
  margin: 0 0 var(--space-3);
}
.outline :is(ul, ol) {
  padding-left: var(--space-6);
}
.outline li + li {
  margin-top: var(--space-2);
}
.outline table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-xs);
}
.outline :is(th, td) {
  padding: var(--space-2);
  border-bottom: 1px solid var(--hairline);
  text-align: left;
  vertical-align: top;
}
.outline th {
  color: var(--ink);
}
.outline > :first-child {
  margin-top: 0;
}
.outline > :last-child {
  margin-bottom: 0;
}
</style>
