/**
 * The AI authoring stack's lazy entry: the one module the app reaches through
 * a dynamic import (authoringLoader.ts). Everything behind it — the agent
 * session, the LLM clients and provider SDKs, the tool registries, the Studio
 * edit and sprite kernels the assist tools use, and the prompts — loads on the
 * first AI action, never on the way to a Play frame;
 * scripts/check-bundle-budget.ts fails a build that puts it back on the boot
 * path. Export only what a boot-path caller needs, and import its types with
 * `import type` elsewhere.
 */
export { AgentSession } from "./agentSession.ts";
export { executeAgentTool } from "../../../src/agent/tools.ts";
export { prepareRoomPatch } from "../../../src/agent/roomPatch.ts";
