/**
 * The top action's icon and accessible name: update while changes wait,
 * restart for the current room, play for another. The name includes the room
 * and selected Launch; the ▾ menu marks the choice.
 */
export interface LaunchActionInput {
  /** Changes wait to go into the game. */
  readonly pending: boolean;
  /** The selected Launch id: "carry", "my-game", "beginning" or the person's own. */
  readonly launch: string;
  readonly launchName: string;
  readonly room: string;
  /** The room is the one the game is in now. */
  readonly here: boolean;
}

export interface LaunchAction {
  readonly icon: "update" | "restart" | "play";
  readonly room: string;
  /** The Launch name shown after the room; empty for Carry over and From my game. */
  readonly launch: string;
  /** The full action, for the accessible name and the tooltip. */
  readonly label: string;
}

export function launchAction(input: LaunchActionInput): LaunchAction {
  if (input.launch === "my-game")
    return {
      icon: input.pending ? "update" : "play",
      room: "My game",
      launch: "",
      label: input.pending ? "Update and return to my game" : "Play from my game",
    };
  const restart = input.pending || input.here;
  const launch = input.launch === "carry" ? "" : input.launchName;
  const verb = input.pending ? "Update and restart" : restart ? "Restart" : "Play";
  return {
    icon: input.pending ? "update" : restart ? "restart" : "play",
    room: input.room,
    launch,
    label: `${verb} ${input.room}${launch ? ` with the launch ${launch}` : ""}`,
  };
}

/** The selected Launch's name: a built-in one or the person's own. */
export function launchName(
  selected: string,
  choices: readonly { readonly id: string; readonly name: string }[],
): string {
  return selected === "my-game"
    ? "From my game"
    : selected === "beginning"
      ? "From the beginning"
      : (choices.find((entry) => entry.id === selected)?.name ?? "Carry over");
}
