export type RoomActionKind = "place-ego" | "response" | "door" | "play-sound";
export const ROOM_ACTION_LABELS: Record<RoomActionKind, string> = {
  "place-ego": "Place hero",
  response: "Answer a sentence",
  door: "Door",
  "play-sound": "Sound when…",
};
