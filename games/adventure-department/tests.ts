/**
 * Stored game tests for the tutorial: one per exhibit, the walk between
 * them, the proximity rules and a room's own HELP. They ship inside the game archive as TESTS.JSON, so the app's
 * write tools rerun them after a remix and run_game_tests replays them on
 * demand. Each is a playtest_room scenario: the spawn stands where the
 * exhibit's posn() box expects the apprentice, an Enter clears the room's
 * opening window, the command solves the exhibit, and the expectations name
 * the flag, the score and the message the logic awards.
 */
import type { GameTest } from "../../src/agent/gameTestFormat.ts";

const step = (
  action: "command" | "move" | "enter" | "wait",
  command: string | null = null,
  ticks = 1,
): Record<string, unknown> => ({ action, command, direction: null, ticks, captureTicks: null });

const expecting = (fields: Record<string, unknown>): Record<string, unknown> => ({
  room: null,
  carriedItems: null,
  flags: null,
  vars: null,
  printed: null,
  text: null,
  ...fields,
});

export const TUTORIAL_GAME_TESTS: readonly GameTest[] = [
  {
    name: "paint the mural",
    room: 1,
    spawnX: 77,
    spawnY: 140,
    steps: [step("enter"), step("command", "paint mural"), step("enter")],
    expect: expecting({
      flags: [{ id: 30, value: true }],
      vars: [{ id: 3, value: 10 }],
      printed: "You paint a sun, mountains and a river.",
    }),
    cycleBudget: null,
  },
  {
    name: "the lever wakes the robot",
    room: 2,
    spawnX: 30,
    spawnY: 140,
    // The lever's end.of.loop completes after 16 cycles and prints message 3.
    steps: [step("enter"), step("command", "pull lever"), step("wait", null, 16), step("enter")],
    expect: expecting({
      flags: [{ id: 31, value: true }],
      vars: [{ id: 3, value: 10 }],
      // The payoff window breaks before its Studio line; the match ignores line breaks.
      printed: "Exhibit two repaired! Curious how it works?",
    }),
    cycleBudget: null,
  },
  {
    name: "Felix gets his priority back",
    room: 3,
    spawnX: 60,
    spawnY: 140,
    steps: [step("enter"), step("command", "fix priority"), step("enter")],
    expect: expecting({
      flags: [{ id: 32, value: true }],
      vars: [{ id: 3, value: 10 }],
      printed: "You change Felix from priority 15 to 10.",
    }),
    cycleBudget: null,
  },
  {
    name: "the exhibits connect east and west",
    room: 1,
    spawnX: null,
    spawnY: null,
    steps: [
      step("enter"),
      step("command", "east"),
      step("enter"),
      step("command", "east"),
      step("enter"),
      step("command", "west"),
      step("enter"),
    ],
    expect: expecting({ room: 2 }),
    cycleBudget: null,
  },
  {
    name: "the mural needs the painter nearby",
    room: 1,
    spawnX: null,
    spawnY: null,
    steps: [step("enter"), step("command", "paint mural"), step("enter")],
    expect: expecting({
      flags: [{ id: 30, value: false }],
      vars: [{ id: 3, value: 0 }],
      printed: "You're too far away. Walk up to the frame, then PAINT MURAL.",
    }),
    cycleBudget: null,
  },
  {
    // The lab's west doorway (18,151) is outside the lever's box (x 26-56).
    name: "the lever needs the apprentice nearby",
    room: 2,
    spawnX: null,
    spawnY: null,
    steps: [step("enter"), step("command", "pull lever"), step("enter")],
    expect: expecting({
      flags: [{ id: 31, value: false }],
      vars: [{ id: 3, value: 0 }],
      printed: "You're too far away. Walk over to the lever, then PULL LEVER.",
    }),
    cycleBudget: null,
  },
  {
    name: "the archive's HELP names its own commands",
    room: 3,
    spawnX: null,
    spawnY: null,
    steps: [step("enter"), step("command", "help"), step("enter")],
    expect: expecting({
      printed: "SHOW PRIORITY, FIX PRIORITY",
    }),
    cycleBudget: null,
  },
];
