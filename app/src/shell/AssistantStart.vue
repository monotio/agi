<script setup lang="ts">
/**
 * The Create assistant's resting state: what it does, the read-only notice
 * on a catalog or installed edition, and the button that opens it. After a
 * turn it keeps the trace the closing panel would otherwise wipe: the last
 * request and the assistant's answer, and — when that turn's first edit
 * forked a read-only edition into the player's own remix — which copy the
 * change went into. UI state only: it reads the conversation the session
 * already holds and notes the fork when the panel closes on a new game.
 */
import { computed, ref, watch } from "vue";
import UiButton from "../ui/UiButton.vue";
import UiIcon from "../ui/UiIcon.vue";
import { useEngineApi } from "../engine/engineContext.ts";
import { useShellBridge } from "./shellBridge.ts";
import { useShell } from "./useShell.ts";

const { phone } = defineProps<{ phone: boolean }>();

const { state, currentGame } = useEngineApi();
const bridge = useShellBridge();
const shell = useShell();

/** The latest request and the answer that followed it, if any. */
const lastTurn = computed(() => {
  const messages = state.powerUp.messages;
  const at = messages.findLastIndex((message) => message.role === "user");
  if (at < 0) return null;
  return { request: messages[at]!.text, reply: messages[at + 1]?.text ?? "" };
});

/** The remix copy the last turn forked into, while that copy is the game. */
const fork = ref<{ project: string; title: string }>();
let openedOn: { readOnly: boolean; project: string | undefined } | undefined;
watch(
  () => state.powerUp.open,
  (open) => {
    const game = currentGame();
    if (open) {
      openedOn = { readOnly: shell.readOnly.value, project: game?.projectId };
      return;
    }
    const forked =
      openedOn?.readOnly === true &&
      game?.projectId !== undefined &&
      game.projectId !== openedOn.project;
    if (forked) fork.value = { project: game.projectId!, title: game.title };
    openedOn = undefined;
  },
);
const forkShown = computed(() => {
  void state.patchTick;
  return fork.value !== undefined && currentGame()?.projectId === fork.value.project;
});
</script>

<template>
  <div class="assistant-start">
    <p class="dock-note">
      {{
        phone
          ? "Ask about this game. Editing needs a larger screen."
          : "Describe a change to your rooms, art, characters or logic. The assistant makes it while the game pauses."
      }}
    </p>
    <p v-if="forkShown" class="assistant-fork" role="status" data-testid="assistant-fork-note">
      <UiIcon name="check" :size="16" />
      <span
        >Your change went into your own copy, <strong>{{ fork!.title }}</strong
        >. The original edition is unchanged.</span
      >
    </p>
    <p v-else-if="shell.readOnly.value && !phone" class="dock-note" data-testid="create-read-only">
      Your first edit makes your own copy of this edition.
    </p>
    <section
      v-if="lastTurn"
      class="assistant-last"
      aria-label="Last request"
      data-testid="assistant-last-turn"
    >
      <p class="assistant-last__label">You asked</p>
      <p class="assistant-last__request">{{ lastTurn.request }}</p>
      <p v-if="lastTurn.reply" class="assistant-last__reply">{{ lastTurn.reply }}</p>
    </section>
    <UiButton
      variant="primary"
      icon="sparkles"
      data-testid="power-up"
      :disabled="state.recording.active || state.historyView.active"
      @click="bridge.togglePowerUp(phone ? 'ask' : 'remix')"
    >
      {{ phone ? "Ask" : "Ask or remix" }}
    </UiButton>
  </div>
</template>

<style scoped>
.assistant-fork {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: 0;
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--ok-line);
  border-radius: var(--radius);
  color: var(--ink);
  background: var(--ok-soft);
  font-size: var(--text-sm);
}
.assistant-fork .ui-icon {
  margin-top: 2px;
  color: var(--ok);
}
.assistant-last {
  display: grid;
  gap: var(--space-1);
  justify-self: stretch;
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  background: var(--surface-2);
}
.assistant-last p {
  margin: 0;
}
.assistant-last__label {
  color: var(--ink-3);
  font: var(--weight-bold) var(--text-2xs) / 1 var(--font-sans);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}
.assistant-last__request {
  color: var(--ink);
  font-size: var(--text-sm);
  overflow-wrap: anywhere;
}
.assistant-last__reply {
  color: var(--ink-2);
  font-size: var(--text-sm);
  overflow-wrap: anywhere;
}
</style>
