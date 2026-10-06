// Source activity boundaries shared by the static import and emitted bundle checks.
// Paths are relative to the repository root, including Vue bundle query suffixes.

/** The module script in app/index.html; the bundle gate verifies this entry. */
export const HOME_ENTRY = "app/src/main.ts";

/** Home checks for earlier progress without loading its export tools. */
export const HOME_START = ["app/src/project/earlierProgress.ts"];

/** Modules requested when a cold catalog game starts, including the GPU stage. */
export const PLAY_START = [
  "games/adventure-department/game.ts",
  "app/src/play/PlayArea.vue",
  "app/src/three/AgiStage.ts",
  "app/src/audio/AgiAudio.ts",
  "app/src/library/gamePreview.ts",
  "app/src/library/gameLibrary.ts",
  "app/src/project/projectHistoryStorage.ts",
  "app/src/world/useRoomMap.ts",
  "app/src/history/useHistoryView.ts",
  "app/src/history/useHistoryController.ts",
  "app/src/agent/agentLog.ts",
];

const HOME_DEFERRED_MODULES = [
  /^app\/src\/agent\/.*\.(ts|vue)(?:$|\?)/,
  /^app\/src\/authoring\/(AgentBubble|AgentLogPanel|AgentTaskControls|SoundPreview)\.vue(?:$|\?)/,
  /^app\/src\/authoring\/useAuthoringController\.ts$/,
  /^src\/agent\/(agentState|history|worldPlan|roomPictures|viewUsage|toolTransport|gameTestFormat|tools|prompt|playtest)\.ts$/,
  /^app\/src\/engine\/(executionDebugLink|useEngineDebug)\.ts$/,
  /^app\/src\/inspector\/.*\.vue(?:$|\?)/,
  /^app\/src\/project\/playerSentences\.ts$/,
  /^app\/src\/settings\/AiSettings\.vue(?:$|\?)/,
  /^src\/sound\/.*\.ts$/,
  /^app\/src\/audio\/(AgiAudio|iigsSynth|soundAudition)\.ts$/,
  /^src\/runtime\/(engine|debugExpression|debugBreakpoints|debugStep|debugWatchpoints)\.ts$/,
  /^app\/src\/(worker\/engine|library\/preview)\.worker\.ts$/,
  /^app\/node_modules\/(openai|@anthropic-ai\/sdk|monaco-editor)\//,
];

/**
 * Studio code loads when Room Studio or Sprite Studio opens, never on the way
 * to a Play frame: the Studio components and every Studio kernel, the walk-
 * route kernel with its worker among them. Helpers Play shares with the
 * Studios (the walkable mask, view usage, the sprite document) live outside
 * the studio folders, as `npm run lint:deps` enforces.
 */
export const STUDIO_MODULES = [/^app\/src\/studio\//, /^src\/studio\//];

/** Identify lazy editor code. */
/** @param {string} module */
export function isStudioModule(module) {
  return STUDIO_MODULES.some((pattern) => pattern.test(module));
}

/** Identify code that belongs to an activity after Home. */
/** @param {string} module */
export function isHomeDeferredModule(module) {
  return (
    isStudioModule(module) ||
    HOME_DEFERRED_MODULES.some((pattern) => pattern.test(module)) ||
    AUTHORING_MODULES.some((pattern) => pattern.test(module)) ||
    ROOM_ANALYSIS_MODULES.some((pattern) => pattern.test(module))
  );
}

/**
 * The execution debugger loads on the first debug/Test action through the
 * one dynamic import in app/src/worker/debugLoader.ts: the controller and
 * the breakpoint, step, watchpoint and expression machinery behind it. A
 * player who never opens the debugger or a test never downloads it — and a
 * startup worker that statically reaches any of them fails the check.
 */
export const DEBUGGER_MODULES = [
  /^app\/src\/worker\/(debugController|previewAdmission|projectAdmission)\.ts$/,
  /^src\/runtime\/(debugExpression|debugBreakpoints|debugStep|debugWatchpoints)\.ts$/,
];

/**
 * The AI authoring stack loads on the first AI action, through the one
 * dynamic import in app/src/agent/authoringLoader.ts: its lazy entry, the
 * agent session and the stub agent, the LLM clients with the provider SDKs,
 * the tool registry and prompts, and the Studio edit and sprite kernels the
 * assist tools drive. A player who never uses AI never downloads it.
 */
export const AUTHORING_MODULES = [
  /^app\/src\/agent\/(authoringStack|agentSession|llmClient|stubAgent|selectionStub|referenceStub|workspaceAgent|workspaceAgentTools|workspaceSelection)\.ts$/,
  /^app\/src\/references\/referenceHandles\.ts$/,
  /^src\/agent\/(tools|selectionTools|namingTools|authoringTools|roomTools|pictureTools|referenceTools|prompt|playtest)\.ts$/,
  /^src\/studio\/(editOperations|editValidation|pictureDocument|probe|lensRules|assistScope)\.ts$/,
  /^src\/studio\/sprite\/(spriteOperations|spriteCels)\.ts$/,
  /^app\/node_modules\/(openai|@anthropic-ai\/sdk)\//,
];

/** Room-flow analysis starts with the map or Create, in its own worker. */
export const ROOM_ANALYSIS_MODULES = [
  /^src\/agent\/(roomMap|roomFlow)\.ts$/,
  /^app\/src\/world\/roomAnalysis(Runner|\.worker)\.ts$/,
];
