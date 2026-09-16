/**
 * Open-state for the reference-art upload dialog: the chat bubble and the
 * world map's room detail both raise it, and App.vue hosts the dialog once.
 * `room` pre-fills the room target when the map raised it for a room.
 */
import { reactive } from "vue";

export const referenceUpload = reactive<{ open: boolean; room: number | undefined }>({
  open: false,
  room: undefined,
});

export function openReferenceUpload(room?: number): void {
  referenceUpload.room = room;
  referenceUpload.open = true;
}
