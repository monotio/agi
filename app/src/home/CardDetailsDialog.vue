<script setup lang="ts">
/**
 * The dialog a card's "Details…" menu item opens (see cardDetails.ts). A
 * stored game's details carry two live rows — the interpreter it runs under
 * and whether its opening has been checked — re-read from the library so a
 * check or a profile change that just finished shows without reopening.
 * "Change…" replaces this dialog with the profile picker, never stacks on it.
 */
import { computed, nextTick, watch } from "vue";
import UiButton from "../ui/UiButton.vue";
import UiDialog from "../ui/UiDialog.vue";
import EarlierProgressSection from "./EarlierProgressSection.vue";
import RoomGenerationSetting from "./RoomGenerationSetting.vue";
import { shownDetails } from "./cardDetails.ts";
import { describeGameProfile } from "../library/profileChoice.ts";
import { useGameLibrary } from "../library/useGameLibrary.ts";

const {
  savedGames,
  identityTitle,
  libraryActionBusy,
  onCheckLibraryGame,
  openLibraryProfileChoice,
  profileChoiceState,
} = useGameLibrary();

const open = computed({
  get: () => shownDetails.value !== undefined,
  set: (value) => {
    if (!value) shownDetails.value = undefined;
  },
});

/** The stored game the details are about, re-read live from the library. */
const liveGame = computed(() => {
  const projectId = shownDetails.value?.projectId;
  return projectId ? savedGames.value.find((game) => game.projectId === projectId) : undefined;
});

/** The control the last details were opened from; it takes focus back on close. */
let returnFocus: HTMLElement | undefined;
watch(shownDetails, (details) => {
  if (details) returnFocus = details.returnFocus;
});

function onClosed(): void {
  const target = returnFocus;
  returnFocus = undefined;
  if (target === undefined) return;
  if (target.isConnected) {
    target.focus({ preventScroll: true });
    return;
  }
  // The opener left the shelf with its card: a stable control takes the
  // focus — the Earlier progress link when it is present, else Add game.
  // Never land behind a dialog that replaced this one.
  if (document.querySelector("dialog[open]")) return;
  const fallback =
    document.querySelector<HTMLElement>("[data-testid='earlier-progress-link']") ??
    document.querySelector<HTMLElement>("[data-testid='open-game-menu']");
  fallback?.focus({ preventScroll: true });
}

/**
 * The picker replaces this dialog: closing Details first hands focus back to
 * the card's ⋯ trigger, so the picker is the modal the browser restores from.
 * The picker's own <dialog> restores no focus, so its close returns to the
 * same trigger — Details' opener, still the originating control.
 */
async function changeInterpreter(): Promise<void> {
  const game = liveGame.value;
  const target = returnFocus;
  shownDetails.value = undefined;
  if (!game) return;
  await nextTick();
  openLibraryProfileChoice(game);
  const stop = watch(profileChoiceState, async (choice) => {
    if (choice !== undefined) return;
    stop();
    await nextTick();
    // A focus hand-off never lands behind another open modal.
    if (target?.isConnected && !document.querySelector("dialog[open]"))
      target.focus({ preventScroll: true });
  });
}
</script>

<template>
  <UiDialog
    v-model:open="open"
    :title="shownDetails?.title ?? 'Details'"
    size="sm"
    :data-testid="shownDetails?.testId ?? 'card-details'"
    @closed="onClosed"
  >
    <template v-if="shownDetails">
      <p v-if="shownDetails.description" class="details-description">
        {{ shownDetails.description }}
      </p>
      <dl v-if="shownDetails.rows.length || liveGame" class="details-rows">
        <template v-for="[term, value] in shownDetails.rows" :key="term">
          <dt>{{ term }}</dt>
          <dd>{{ value }}</dd>
        </template>
        <template v-if="liveGame">
          <template v-if="liveGame.library?.parent">
            <dt>Remix of</dt>
            <dd>{{ identityTitle(liveGame.library.parent) }}</dd>
          </template>
          <dt>Interpreter</dt>
          <dd>
            {{ describeGameProfile(liveGame) }}
            <UiButton
              size="sm"
              variant="ghost"
              aria-label="Change interpreter"
              data-testid="interpreter-profile-menu-item"
              @click="changeInterpreter"
            >
              Change…
            </UiButton>
          </dd>
          <dt>Opening</dt>
          <dd>
            {{
              liveGame.library?.validation.status === "unverified"
                ? "Not checked yet"
                : (liveGame.library?.validation.message ?? "Not checked yet")
            }}
            <UiButton
              v-if="liveGame.library?.validation.status === 'unverified'"
              size="sm"
              variant="ghost"
              aria-label="Check opening"
              data-testid="check-library-game"
              :disabled="libraryActionBusy"
              @click="onCheckLibraryGame(liveGame)"
            >
              {{ libraryActionBusy ? "Checking…" : "Check" }}
            </UiButton>
          </dd>
        </template>
      </dl>
      <RoomGenerationSetting
        v-if="liveGame"
        :key="liveGame.projectId"
        :project-id="liveGame.projectId"
        :enabled="liveGame.roomGeneration === true"
        :generation="liveGame.generation"
      />
      <EarlierProgressSection v-if="shownDetails.earlier" :context="shownDetails.earlier" />
    </template>
  </UiDialog>
</template>

<style scoped>
.details-description {
  margin: 0 0 var(--space-5);
  color: var(--ink-2);
}
.details-rows {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: var(--space-2) var(--space-5);
  margin: 0;
  font-size: var(--text-sm);
}
.details-rows dt {
  color: var(--ink-3);
}
.details-rows dd {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
  margin: 0;
  overflow-wrap: anywhere;
}
</style>
