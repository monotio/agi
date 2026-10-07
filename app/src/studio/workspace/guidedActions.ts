export type RoomActionKind = "place-hero" | "response" | "door" | "play-sound";
export const ROOM_ACTION_LABELS: Record<RoomActionKind, string> = {
  "place-hero": "Place hero",
  response: "Answer a sentence",
  door: "Door",
  "play-sound": "Sound when…",
};
