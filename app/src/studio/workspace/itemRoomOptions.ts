import { numberedLabel, type NumberedLabelContext } from "../../../../src/logic/numberedLabels.ts";

export function itemRoomOptions(context: NumberedLabelContext): { num: number; label: string }[] {
  return [
    { num: 255, label: "Carried by the player" },
    { num: 0, label: "Nowhere" },
    ...(context.rooms ?? [])
      .filter(({ room }) => room >= 1 && room <= 254)
      .sort((a, b) => a.room - b.room)
      .map(({ room }) => ({ num: room, label: numberedLabel("room", room, context, "row") })),
  ];
}
