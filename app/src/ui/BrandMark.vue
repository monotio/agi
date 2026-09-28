<script setup lang="ts">
/**
 * The brand's one mark: the cyan square of the wordmark's full stop. It sits
 * where a full stop would, after "AGI" in the header lockup, and is the
 * favicon (public/favicon.svg). Its size follows the surrounding text.
 */
</script>

<template>
  <span class="brand-mark" aria-hidden="true"></span>
</template>

<style scoped>
/* The engine font's full stop is two pixels of an eight-pixel cell: about a
   third of the em once hinted up to read at header size, on the baseline. */
.brand-mark {
  display: inline-block;
  width: 0.32em;
  height: 0.32em;
  margin-left: 0.08em;
  background: var(--action);
  vertical-align: baseline;
}
</style>
