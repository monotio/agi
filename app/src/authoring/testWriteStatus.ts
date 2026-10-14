/** Hand edits inspect an existing Agent owner without loading its implementation. */
interface AgentTestWriteStatus {
  busy(): boolean;
  pending(): boolean;
}
interface TestWriteSession {
  chats?(): { readonly chats: readonly { readonly pendingReview?: unknown }[] };
}
const owners = new WeakMap<object, AgentTestWriteStatus>();

/** The Agent registers live getters; checking status never creates an AI session. */
export function registerAgentTestWriteStatus(session: object, status: AgentTestWriteStatus): void {
  owners.set(session, status);
}

/** Shared by Record, Save and the Tests panel's hand-edit controls. */
export function testsWriteBlockReason(session: TestWriteSession | null | undefined): string | null {
  const status = session ? owners.get(session) : undefined;
  if (status?.busy()) return "Wait for the Agent to finish before editing tests.";
  if (status?.pending() || session?.chats?.().chats.some((chat) => chat.pendingReview))
    return "Review the Agent's changes before editing tests.";
  return null;
}
