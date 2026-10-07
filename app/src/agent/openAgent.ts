/**
 * The one way editors open the agent: a drawer over the workspace with a
 * prepared request. The blank stage (a project without a boot LOGIC) has no
 * running game, so its drawer opens on its own flag instead of powerUp.
 */
import { nextTick, ref } from "vue";
import { useEngineApi } from "../engine/engineContext.ts";
import { useWorkspaceEditor } from "../shell/workspaceEditor.ts";
import { useCreateWorkspace } from "../shell/useCreateWorkspace.ts";
import { emptyProject } from "../home/emptyProjectRoute.ts";
import type { ReplyFormatter } from "./workspaceAgent.ts";

/** The blank stage's drawer state; a booted game uses state.powerUp.open. */
export const blankAgentOpen = ref(false);

export interface AgentPrompt {
  /** Request context the composer sends without showing it in the input. */
  context?: string;
  /** Ask only: the agent answers without preparing changes. */
  readOnly?: boolean;
  formatReply?: ReplyFormatter;
}

export function useOpenAgent() {
  const engine = useEngineApi();
  const editor = useWorkspaceEditor();
  const workspace = useCreateWorkspace();
  return function openAgentWith(prompt?: string, prepared?: AgentPrompt): void {
    if (prompt !== undefined)
      editor.agentPrefill.value = {
        text: prompt,
        readOnly: prepared?.readOnly ?? false,
        ...(prepared?.context !== undefined ? { context: prepared.context } : {}),
        ...(prepared?.formatReply !== undefined ? { formatReply: prepared.formatReply } : {}),
      };
    if (emptyProject.value) {
      blankAgentOpen.value = true;
      return;
    }
    workspace.showPanel("assistant");
    engine.state.powerUp.mode = "remix";
    engine.state.powerUp.open = true;
    void nextTick().then(() => {
      document.querySelector<HTMLElement>(".assistant-host textarea")?.focus();
    });
  };
}
