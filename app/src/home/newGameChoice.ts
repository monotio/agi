import { computed, ref } from "vue";
import type { StarterKind } from "../../../src/authoring/starterProject.ts";

export type NewGameChoice = StarterKind | "ai";

export const NEW_GAME_CHOICES: readonly {
  value: NewGameChoice;
  title: string;
  description: string;
}[] = [
  { value: "starter", title: "Starter", description: "One room with a hero." },
  {
    value: "boilerplate",
    title: "Boilerplate",
    description: "Menus, saving and game over.",
  },
  { value: "blank", title: "Blank", description: "An empty project." },
  {
    value: "ai",
    title: "Create with AI",
    description: "Describe an adventure. AI makes the rooms, art and story.",
  },
];

/** Selection and roving focus share the same card, including keyboard wrapping. */
export function createNewGameChoice(initial?: NewGameChoice) {
  const selected = ref<NewGameChoice | undefined>(initial);
  const aiVisible = computed(() => selected.value === "ai");
  function select(choice: NewGameChoice): void {
    selected.value = choice;
  }
  function key(choice: NewGameChoice, pressed: string): NewGameChoice | undefined {
    const index = NEW_GAME_CHOICES.findIndex((option) => option.value === choice);
    const offset =
      pressed === "ArrowRight" || pressed === "ArrowDown"
        ? 1
        : pressed === "ArrowLeft" || pressed === "ArrowUp"
          ? -1
          : 0;
    if (offset) {
      const next =
        NEW_GAME_CHOICES[(index + offset + NEW_GAME_CHOICES.length) % NEW_GAME_CHOICES.length]!
          .value;
      select(next);
      return next;
    }
    if (pressed === "Enter" || pressed === " ") {
      select(choice);
      return choice;
    }
    return undefined;
  }
  return { selected, aiVisible, select, key };
}
