<script setup lang="ts">
/**
 * The "Your games" aside: saved-game cards with inline rename and a per-game
 * action menu, the leftover-autosave fallback card, the hosted-catalog error
 * block, and the ZIP/folder drop zone. The hosted and fixture cards inside
 * the gallery are CatalogPanel. Library state is the injected shared
 * controller — several of these elements feed App.vue's mount and hash
 * routing through it.
 */
import ActionMenu from "./ActionMenu.vue";
import CatalogPanel from "./CatalogPanel.vue";
import UiIcon from "./UiIcon.vue";
import { useGameLibrary } from "./useGameLibrary.ts";
import { useShellBridge } from "./shellBridge.ts";
import { hasWalkthrough } from "./walkthrough.ts";

const {
  savedGames,
  selectedProjectId,
  renaming,
  expandedProjectId,
  gameTitle,
  renameError,
  libraryAutosaves,
  pendingAutosave,
  hasLibraryContent,
  localGames,
  localGameAliases,
  availableCatalogEntries,
  hostedCatalogError,
  hostedCatalogBusy,
  libraryActionBusy,
  libraryActionError,
  importBusy,
  importError,
  importNotice,
  exportBusy,
  zipInput,
  folderInput,
  beginRename,
  setTitleInput,
  saveGameTitle,
  onGameDetailsToggle,
  libraryProvenance,
  onPlayLibraryGame,
  onStartLibraryGameOver,
  onCheckLibraryGame,
  onCopyLibraryGame,
  onExportLibraryGame,
  onRemoveLibraryGame,
  onResumeAutosave,
  onStartOver,
  onGameZip,
  onGameFolder,
  onGameDrop,
  refreshHostedCatalog,
} = useGameLibrary();
const bridge = useShellBridge();
</script>
<template>
  <aside
    id="your-games"
    class="library-pane"
    :class="{ 'empty-library': !hasLibraryContent }"
    :aria-labelledby="hasLibraryContent ? 'library-title' : undefined"
    :aria-label="hasLibraryContent ? undefined : 'Add game'"
  >
    <h2 v-if="hasLibraryContent" id="library-title">Your games</h2>
    <p v-if="libraryActionError" role="alert" class="library-error">
      {{ libraryActionError }}
    </p>
    <div v-if="hostedCatalogError" class="library-error" data-testid="hosted-catalog-error">
      <p role="alert">{{ hostedCatalogError }}</p>
      <button
        type="button"
        class="ui-button ui-button--secondary"
        :disabled="hostedCatalogBusy"
        @click="refreshHostedCatalog"
      >
        Retry game list
      </button>
    </div>

    <div
      v-if="savedGames.length || localGameAliases.length || availableCatalogEntries.length"
      class="saved-game-gallery"
      data-testid="saved-game-gallery"
    >
      <article
        v-for="game in savedGames"
        :key="game.projectId"
        class="saved-game-card"
        :class="{ selected: selectedProjectId === game.projectId }"
        :data-testid="`saved-game-card-${game.projectId}`"
        :data-project-id="game.projectId"
      >
        <div class="saved-game-media">
          <img
            v-if="libraryAutosaves[game.projectId]?.preview || game.library?.preview"
            class="library-thumbnail"
            data-testid="library-thumbnail"
            :data-preview-kind="libraryAutosaves[game.projectId]?.preview ? 'progress' : 'opening'"
            :src="libraryAutosaves[game.projectId]?.preview ?? game.library?.preview"
            :alt="
              libraryAutosaves[game.projectId]?.preview
                ? `${game.title}, current progress in room ${libraryAutosaves[game.projectId]?.room}`
                : `${game.title} opening scene`
            "
          />
          <div v-else class="saved-game-cover" aria-hidden="true">AGI</div>
          <span v-if="libraryAutosaves[game.projectId]" class="saved-world-badge">IN PROGRESS</span>
        </div>
        <div class="saved-game-card-body">
          <form
            v-if="renaming && selectedProjectId === game.projectId"
            class="game-rename"
            data-testid="rename-game-form"
            @submit.prevent="saveGameTitle"
          >
            <label :for="`game-title-${game.projectId}`">Game name</label>
            <input
              :id="`game-title-${game.projectId}`"
              :ref="setTitleInput"
              v-model="gameTitle"
              maxlength="100"
              required
              @keydown.esc="renaming = false"
            />
            <button
              type="submit"
              class="ui-button ui-button--secondary"
              :disabled="!gameTitle.trim()"
            >
              Save name
            </button>
            <button type="button" class="ui-button ui-button--secondary" @click="renaming = false">
              Cancel
            </button>
            <p v-if="renameError" role="alert">{{ renameError }}</p>
          </form>
          <div v-show="!(renaming && selectedProjectId === game.projectId)" class="saved-game-info">
            <div class="saved-game-heading">
              <h3 class="saved-world-title" data-testid="saved-game-title">
                {{ game.title }}
              </h3>
              <button
                type="button"
                class="ui-button ui-button--icon rename-icon"
                aria-label="Rename game"
                title="Rename game"
                data-testid="rename-game"
                @click="beginRename(game)"
              >
                <UiIcon name="pencil" />
              </button>
            </div>
            <p v-if="libraryProvenance(game)" class="saved-world-source">
              {{ libraryProvenance(game) }}
            </p>
            <p v-if="libraryAutosaves[game.projectId]" class="saved-world-time">
              Room {{ libraryAutosaves[game.projectId]?.room }} · Saved
              {{ new Date(libraryAutosaves[game.projectId]!.savedAt).toLocaleString() }}
            </p>
          </div>
          <div class="saved-game-play-row">
            <button
              type="button"
              class="ui-button ui-button--primary"
              data-testid="btn-resume-cached"
              :disabled="libraryActionBusy || importBusy"
              @click="onPlayLibraryGame(game)"
            >
              {{ libraryAutosaves[game.projectId] ? "Resume" : "Play" }}
            </button>
            <ActionMenu
              label="Game actions"
              icon="more"
              icon-only
              :test-id="`game-actions-${game.projectId}`"
            >
              <button
                v-if="hasWalkthrough(game.library?.alias ?? game.projectId)"
                type="button"
                role="menuitem"
                data-testid="run-walkthrough"
                @click="bridge.startWalkthrough(game.library?.alias ?? game.projectId)"
              >
                <span>Run walkthrough<small>Watch real-time playthrough</small></span>
              </button>
              <button
                v-if="libraryAutosaves[game.projectId]"
                type="button"
                role="menuitem"
                data-testid="start-library-game-over"
                @click="onStartLibraryGameOver(game)"
              >
                Start over
              </button>
              <button
                v-if="game.library?.validation.status === 'unverified'"
                type="button"
                role="menuitem"
                data-testid="check-library-game"
                :disabled="libraryActionBusy"
                @click="onCheckLibraryGame(game)"
              >
                Check opening
              </button>
              <button
                type="button"
                role="menuitem"
                data-testid="copy-library-game"
                :disabled="libraryActionBusy"
                @click="onCopyLibraryGame(game)"
              >
                Make a copy
              </button>
              <div role="separator"></div>
              <button
                type="button"
                role="menuitem"
                data-testid="btn-export-agi-zip"
                :disabled="exportBusy"
                @click="onExportLibraryGame(game)"
              >
                <span>Game export<small>Playable game</small></span>
              </button>
              <button
                type="button"
                role="menuitem"
                data-testid="btn-save-project"
                :disabled="exportBusy"
                @click="onExportLibraryGame(game, true)"
              >
                <span>Project<small>Game and editing history</small></span>
              </button>
              <div role="separator"></div>
              <button
                type="button"
                role="menuitem"
                class="danger"
                data-testid="remove-library-game"
                @click="onRemoveLibraryGame(game)"
              >
                Remove game
              </button>
            </ActionMenu>
          </div>
          <details
            class="library-details-disclosure"
            :open="expandedProjectId === game.projectId"
            :data-testid="`game-details-${game.projectId}`"
            @toggle="onGameDetailsToggle(game.projectId, $event)"
          >
            <summary>Details</summary>

            <div v-if="game.library" class="library-details">
              <p v-if="game.library.description">{{ game.library.description }}</p>
              <dl>
                <template v-if="game.library.author">
                  <dt>By</dt>
                  <dd>{{ game.library.author }}</dd>
                </template>
                <template v-if="game.library.license">
                  <dt>License</dt>
                  <dd>{{ game.library.license }}</dd>
                </template>
                <template v-if="game.library.catalog">
                  <dt>Version</dt>
                  <dd>{{ game.library.catalog.version }}</dd>
                </template>
              </dl>
            </div>
          </details>
        </div>
      </article>
      <CatalogPanel />
    </div>
    <!-- Autosave left over from an installed or unavailable game. -->
    <div
      v-if="
        pendingAutosave &&
        !savedGames.some((game) => game.projectId === pendingAutosave?.game.projectId) &&
        !localGames.some(
          (g) => g.hash === pendingAutosave?.game.hash || g.alias === pendingAutosave?.game.alias,
        )
      "
      class="saved-world-card autosave-fallback"
      data-testid="autosave-panel"
    >
      <img
        v-if="pendingAutosave.preview"
        class="library-thumbnail"
        data-testid="library-thumbnail"
        data-preview-kind="progress"
        :src="pendingAutosave.preview"
        :alt="`${pendingAutosave.game.alias ?? pendingAutosave.game.projectId ?? 'Saved game'}, current progress in room ${pendingAutosave.room}`"
      />
      <div class="saved-world-header">
        <div class="saved-world-tag">
          <span class="saved-world-badge">IN PROGRESS</span>
          <span class="saved-world-title">{{
            pendingAutosave.game.alias ?? pendingAutosave.game.projectId
          }}</span>
        </div>
        <span class="saved-world-time">
          Room {{ pendingAutosave.room }} · Saved
          {{ new Date(pendingAutosave.savedAt).toLocaleString() }}
        </span>
      </div>
      <div class="saved-game-play-row">
        <button
          type="button"
          class="ui-button ui-button--primary"
          data-testid="btn-resume-autosave"
          @click="onResumeAutosave"
        >
          Resume
        </button>
        <ActionMenu label="Game actions" icon="more" icon-only>
          <button
            type="button"
            role="menuitem"
            data-testid="btn-start-over-picker"
            title="Discard the autosave and play this game from the beginning"
            @click="onStartOver"
          >
            Start over
          </button>
        </ActionMenu>
      </div>
    </div>

    <section
      id="open-game"
      class="zip-drop-zone"
      aria-label="Add game"
      @dragover.prevent
      @drop.prevent="onGameDrop($event.dataTransfer ?? undefined)"
      data-testid="game-zip-drop"
    >
      <ActionMenu
        :label="importBusy ? 'Adding game…' : 'Add game'"
        test-id="open-game-menu"
        :disabled="importBusy"
      >
        <button
          type="button"
          role="menuitem"
          data-testid="open-game-zip"
          @click="zipInput?.click()"
        >
          ZIP file
        </button>
        <button
          type="button"
          role="menuitem"
          data-testid="open-game-folder"
          @click="folderInput?.click()"
        >
          Game folder
        </button>
      </ActionMenu>
      <input
        ref="zipInput"
        type="file"
        accept=".zip,application/zip"
        data-testid="game-zip-input"
        hidden
        @change="onGameZip(($event.target as HTMLInputElement).files?.[0])"
      />
      <p class="drop-hint">Or drop a ZIP or folder</p>
      <input
        ref="folderInput"
        type="file"
        multiple
        webkitdirectory
        data-testid="game-folder-input"
        hidden
        @change="onGameFolder(($event.target as HTMLInputElement).files ?? undefined)"
      />
      <p class="verified-games-hint" data-testid="verified-games-hint">
        Verified to boot: King's Quest I–IV, Space Quest I–II, Police Quest I, Leisure Suit Larry I,
        The Black Cauldron, Mixed-Up Mother Goose, Donald Duck's Playground, Gold Rush!, Manhunter
        1–2, demopac4.
      </p>
      <p v-if="importError" role="alert" data-testid="game-zip-error">{{ importError }}</p>
      <p v-if="importNotice" role="status" class="import-notice" data-testid="game-import-ready">
        {{ importNotice }}
      </p>
    </section>
  </aside>
</template>

<style scoped>
.zip-drop-zone {
  padding: 1.25rem;
  border: 1px dashed #777;
  border-radius: 8px;
  text-align: center;
}
.zip-drop-zone p {
  margin: 0.75rem 0 0;
}
.library-pane.empty-library {
  width: 100%;
  align-self: stretch;
  padding: 20px;
  background: #0b1213;
}
.library-pane.empty-library h2 {
  margin-bottom: 10px;
  font-size: 20px;
}
.library-pane {
  min-width: 0;
  padding: 26px;
  box-sizing: border-box;
  border: 1px solid #294346;
  border-radius: 12px;
  background: linear-gradient(145deg, #102021, #0b1012 60%);
  font-family: system-ui, sans-serif;
}
.library-pane h2 {
  margin: 0 0 18px;
  color: #e4eeee;
  font-size: 24px;
}
.library-pane .stub-btn {
  margin-bottom: 20px;
}
.library-pane .zip-drop-zone {
  margin-top: 20px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 16px;
  padding: 16px;
  border-color: #405457;
  border-radius: 8px;
  text-align: left;
}
.library-pane.empty-library .zip-drop-zone {
  margin-top: 0;
  padding: 0;
  border: 0;
}
.library-pane .zip-drop-zone p {
  margin: 0;
  font-size: 13px;
}
.library-pane .zip-drop-zone p.verified-games-hint {
  width: 100%;
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.45;
  color: #7d9c9e;
}
.library-pane .saved-world-header {
  align-items: flex-start;
}
.library-pane .saved-world-tag {
  flex-wrap: wrap;
}
.library-pane .saved-world-title {
  overflow-wrap: anywhere;
}
.autosave-fallback {
  margin-top: 20px;
}
/* Centre the 44px button on the first title line rather than on the whole title. */
.rename-icon {
  margin: calc((19px * 1.25 - 44px) / 2) 0;
  color: #91b9bc;
  background: transparent;
}
.rename-icon:hover {
  color: var(--ui-action);
  background: #14282a;
}
.game-rename {
  width: 100%;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}

.game-rename label {
  width: 100%;
  color: #bce3d0;
}

.game-rename input {
  flex: 1 1 14rem;
  min-width: 0;
  padding: 0.6rem;
  color: #fff;
  background: #081910;
  border: 1px solid #579873;
  border-radius: 4px;
  font: inherit;
}
</style>
