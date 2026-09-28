<script setup lang="ts">
/**
 * The stage's note after a Start over that left earlier sessions on the
 * timeline: Undo start over returns to where the last one ended. It never
 * takes focus; its button is in the tab order. The note's lifetime lives
 * in useStartOverNote; afterwards the timeline's Started over mark is the
 * way back.
 */
import UiButton from "../ui/UiButton.vue";
import UiToast from "../ui/UiToast.vue";
import { useEngineApi } from "../engine/engineContext.ts";

const engine = useEngineApi();
const { state } = engine;
</script>

<template>
  <UiToast
    v-if="state.startOverNote && state.phase === 'running'"
    dismissible
    data-testid="start-over-note"
    @dismiss="engine.dismissStartOverNote()"
  >
    Started over.
    <UiButton size="sm" data-testid="btn-undo-start-over" @click="engine.undoStartOver()">
      Undo start over
    </UiButton>
  </UiToast>
</template>
