/**
 * The in-app Help guide (HelpGuide.vue): short topics for players and game
 * makers. A topic may offer one "Show me" action that opens the real control;
 * the guide hides an action the current screen cannot perform.
 */

/** Controls a Help topic can open; HelpGuide.vue decides which are available. */
export type HelpAction =
  "controls" | "map" | "hint" | "remix" | "ai-settings" | "create" | "add-game";

export interface HelpTopic {
  readonly id: string;
  readonly title: string;
  /** Paragraphs of plain text. */
  readonly body: readonly string[];
  readonly action?: { readonly kind: HelpAction; readonly label: string };
}

export interface HelpSection {
  readonly id: string;
  readonly title: string;
  readonly topics: readonly HelpTopic[];
}

export const HELP_SECTIONS: readonly HelpSection[] = [
  {
    id: "playing",
    title: "Playing",
    topics: [
      {
        id: "walking",
        title: "Walking and talking",
        body: [
          "Arrow keys or the numpad walk your hero; press the same direction again to stop. On a phone, the on-screen pad does the same.",
          "Everything else is typed, the way it was in the eighties: LOOK, GET LAMP, OPEN DOOR, TALK TO GUARD. Press Enter to send.",
          "On the Amiga and Apple IIgs editions, a click on the screen walks the hero there, just like the originals.",
        ],
        action: { kind: "controls", label: "Show this game's controls" },
      },
      {
        id: "stuck",
        title: "Stuck?",
        body: [
          "Look at everything, then look again. Sierra hid a lot in the scenery.",
          "Ask for a hint gets a nudge without changing the game. The map shows the rooms you have walked, and games with a recorded walkthrough can play it for you — spoilers included.",
        ],
        action: { kind: "hint", label: "Ask for a hint" },
      },
      {
        id: "map",
        title: "The map",
        body: [
          "The map draws the rooms you have visited and the exits between them, and adds the rooms the game's own logic mentions as you explore. Pin a note to any room to remember what you found there.",
          "In Create the same map docks in the World panel, next to the room list and the picture each room draws.",
        ],
        action: { kind: "map", label: "Open the map" },
      },
      {
        id: "saving",
        title: "Saving and rewinding",
        body: [
          "The game's own Save and Restore work as they always did: most Sierra games save with F5 and restore with F7. The app also autosaves, so Resume picks up where you stopped.",
          "Every session records itself. Drag the timeline under the game to look back, then Resume from here to play on from that moment — or Undo rewind if you went too far.",
        ],
      },
      {
        id: "screen",
        title: "The screen",
        body: [
          "AGI games drew 320 × 200 pixels, and a monitor of the day stretched them to fill a 4:3 screen, so each pixel stood a little taller than wide. Original 4:3 in Settings shows them that way; turn it off for square pixels. Either way the game itself is unchanged.",
          "Game text uses this project's own 8 × 8 font in the originals' character grid, rather than each machine's built-in font. It draws English text and the box drawing the Sierra games use; other characters, such as the accented letters of some fan translations, show blank.",
        ],
      },
      {
        id: "sound",
        title: "Sound",
        body: [
          "PC games play through the Tandy sound chip or the PC speaker: Settings, then Advanced, then Sound chip. Amiga and Apple IIgs games play their own hardware's sound, emulated.",
        ],
      },
    ],
  },
  {
    id: "creating",
    title: "Creating",
    topics: [
      {
        id: "modes",
        title: "Play and Create",
        body: [
          "A running game has two modes, switched in the top bar. Play is the game as its players see it; the Ask button opens a drawer that answers questions without changing the game.",
          "Create docks the tools around it: the World panel on the left, the Assistant, Inspect and Activity tabs on the right. [ and ] fold the panels (in the game's command line they are just text). A catalog game opens read-only — your first change makes a remix copy of your own.",
        ],
        action: { kind: "remix", label: "Switch to Create" },
      },
      {
        id: "start",
        title: "Start an adventure",
        body: [
          "Pick a template, or describe your own hero, setting and trouble. An AI agent plans the world and builds the first room — artwork, characters and game logic — while you watch.",
          "It needs your own OpenAI or Anthropic key. The app talks to your provider straight from the browser; there is no server in between.",
        ],
        action: { kind: "create", label: "Go to Create" },
      },
      {
        id: "rooms",
        title: "Rooms appear as you walk",
        body: [
          "Walk into a room that does not exist yet and play pauses while the agent writes it. Everything it makes is real AGI — pictures, views, logic and sound — that you can inspect, download and play again.",
          "An exported copy cannot grow any further: rooms not built yet stop the game, so it is marked as a work in progress. Download game keeps the project, and the world can go on growing wherever it is imported.",
        ],
      },
      {
        id: "remix",
        title: "Change anything",
        body: [
          "In Play, the Ask button answers questions without touching the game. In Create, the Assistant panel changes it: give the guard a new personality, add a puzzle, or turn the courtyard into a swamp.",
          "It works on any game, including the ones you imported. Catalog games open read-only, and your first change makes a remix copy of your own.",
        ],
        action: { kind: "remix", label: "Open Remix" },
      },
      {
        id: "plan",
        title: "Plan the world",
        body: [
          "In Create's World panel you can rename rooms, edit their briefs and pin notes. The agent reads them when it builds that part of the world. You can also attach reference images for rooms and characters.",
        ],
        action: { kind: "map", label: "Open the map" },
      },
      {
        id: "studio",
        title: "Room Studio",
        body: [
          "Open in Studio, on a room in the World panel, reads that room's picture under three lenses: Art for what the player sees, Depth for how far each part of the scene sits, Walk for the control lines that steer the hero. Studio takes the whole window while the game waits paused; its back arrow returns to Create as you left it. It needs a larger screen than a phone.",
          "The scrubber replays the draw order command by command, the scene list names each thing the picture draws, and clicking a pixel shows which command put it there — or why a fill stopped.",
          "Select an item to edit it: drag it or its points, nudge it with the arrow keys (Shift for 8 pixels), or change its colour, priority and draw order in the inspector. Each lens locks what it is not about (the Depth lens keeps the art as it is) until you unlock it, and every change can be undone. Keep saves the picture into the game; closing with unkept changes asks first.",
        ],
      },
      {
        id: "keys",
        title: "Keys and cost",
        body: [
          "Your key is saved in this browser and sent to your provider, and only to your provider, with each request. Requests are billed to your provider account. Every task starts with a $5 estimated budget that you can change.",
          "What the agent writes comes from your provider's model and is not reviewed by this app. Play a game through before you share it, especially with children.",
        ],
        action: { kind: "ai-settings", label: "AI settings" },
      },
    ],
  },
  {
    id: "games",
    title: "Your games",
    topics: [
      {
        id: "add",
        title: "Add a game",
        body: [
          "Add game takes a ZIP or a folder of AGI files. The files stay in your browser. The app recognizes Sierra's releases — PC, Amiga and Apple IIgs — and picks the matching interpreter; for anything it does not know, it asks.",
          "No Sierra copies? Fans have made over a hundred free AGI games: the library links two long-running archives.",
        ],
        action: { kind: "add-game", label: "Add a game" },
      },
      {
        id: "share",
        title: "Export and share",
        body: [
          "Export game makes a ZIP of the playable game and its public details. Download game adds everything else: the authoring conversation, images, notes, tests, history and saves. Either one opens again with Add game, in any browser.",
        ],
      },
      {
        id: "profile",
        title: "Interpreter profile",
        body: [
          "Sierra shipped many interpreter versions, and they behave differently in small ways. A game's card menu shows which profile it runs under and lets you change it.",
        ],
      },
    ],
  },
  {
    id: "about",
    title: "About",
    topics: [
      {
        id: "authentic",
        title: "Authentic by design",
        body: [
          "AGI IS HERE is an independent interpreter checked against the original Sierra interpreters on PC, Amiga and Apple IIgs, down to their timing quirks. The evidence — addresses, hashes and all — is written up in the project's fidelity notes.",
        ],
      },
      {
        id: "privacy",
        title: "Your data",
        body: [
          "Games, saves and history live in this browser. Nothing is uploaded, except what you send to your own AI provider when you create or remix.",
        ],
      },
      {
        id: "source",
        title: "Open source",
        body: [
          "The interpreter, the app and the tools are MIT licensed on GitHub. No commercial game files are included — bring your own, or play the fan-made classics.",
        ],
      },
    ],
  },
];
