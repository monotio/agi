/** Cloneable test-run messages shared by the browser client and its worker. */
import type { ProfileId } from "../../../src/runtime/profile.ts";
import type { ProjectContent } from "../../../src/authoring/projectContent.ts";
import type { AgentToolResult } from "../../../src/agent/agentState.ts";

export interface TestsWorkerInbound {
  readonly files: Record<string, Uint8Array>;
  readonly documents: Readonly<Record<string, ProjectContent>>;
  readonly profileId: ProfileId;
  readonly allowMissingRooms: boolean;
  readonly names: readonly string[] | null;
}
export type TestsWorkerOutbound = { result: AgentToolResult } | { error: string };
export interface TestsWorkerPort {
  onmessage: ((event: MessageEvent<TestsWorkerInbound>) => void) | null;
  postMessage(message: TestsWorkerOutbound): void;
}
