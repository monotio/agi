/**
 * Open-state for the reference-art upload dialog: the chat bubble and the
 * world map's room detail both raise it, and App.vue hosts the dialog once.
 * `room` pre-fills the room target when the map raised it for a room.
 */
import { reactive } from "vue";
import type { ProjectId } from "../../src/gameIdentity.ts";

/** Composer selection is transient; the art itself remains in project storage. */
export const pendingReferences = reactive<{ id: string; project: ProjectId; label: string }[]>([]);

export function removePendingReference(id: string): void {
  const index = pendingReferences.findIndex((reference) => reference.id === id);
  if (index !== -1) pendingReferences.splice(index, 1);
}

export const referenceUpload = reactive<{ open: boolean; room: number | undefined }>({
  open: false,
  room: undefined,
});

export function openReferenceUpload(room?: number): void {
  referenceUpload.room = room;
  referenceUpload.open = true;
}
