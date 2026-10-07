/** Edited document versions and History actions needed to reproduce an accepted capture. */
import type { ReviewedRenumbering } from "../../../src/authoring/projectEdit.ts";
import type { ProjectChange } from "../../../src/authoring/projectContent.ts";
import type { ProjectCommitMetadata } from "../../../src/authoring/projectHistoryData.ts";
import type { AgentChats } from "../../../src/agent/chats.ts";

export type ProjectJournalOperation =
  | { readonly kind: "capture" }
  | {
      readonly kind: "edit";
      readonly changes: readonly (ProjectChange & { readonly version: number })[];
      readonly metadata: ProjectCommitMetadata;
      readonly action?: {
        readonly direction: "undo" | "redo" | "restore";
        readonly target: string;
      };
      readonly reviewedRenumbering?: ReviewedRenumbering;
      readonly beforeRenumber?: readonly ProjectChange[];
      readonly reviewedComputedRoomJumps?: readonly string[];
    }
  | { readonly kind: "tag"; readonly name: string }
  | { readonly kind: "renameTag"; readonly name: string; readonly next: string | null }
  | { readonly kind: "chats"; readonly chats: AgentChats }
  | { readonly kind: "roomGeneration"; readonly enabled: boolean };
