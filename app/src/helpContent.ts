/**
 * The in-app Help guide (HelpGuide.vue): short topics for players and game
 * makers. A topic may offer one "Show me" action that opens the real control;
 * the guide hides an action the current screen cannot perform.
 */

/** Controls a Help topic can open; HelpGuide.vue decides which are available. */
type HelpAction = "controls" | "map" | "hint" | "remix" | "ai-settings" | "create" | "add-game";

/** Open a Studio on one resource of the current game, switching to Create first. */
type HelpStudioAction =
  | { readonly kind: "openRoomStudio"; readonly picture: number }
  | { readonly kind: "openSpriteStudio"; readonly view: number };

/** What a topic's "Show me" asks for: a control, or a Studio on a resource. */
export type HelpRequest = { readonly kind: HelpAction } | HelpStudioAction;
export type HelpActionKind = HelpRequest["kind"];

interface HelpTopic {
  readonly id: string;
  readonly title: string;
  /** Paragraphs of plain text. */
  readonly body: readonly string[];
  readonly action?: HelpRequest & { readonly label: string };
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
          "Create docks the tools around it: the World and Resources tabs on the left, the Assistant, Inspect and Activity tabs on the right. World holds the map and the room list; Resources lists every view the game holds, each openable in Sprite Studio. [ and ] fold the panels (in the game's command line they are just text). A catalog game opens read-only — your first change makes a remix copy of your own. This guide opens from the home screen's Help button and a running game's Help menu.",
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
          "Open in Studio, on a room in the World panel, reads that room's picture under three lenses: Art for what the player sees, Depth for how far each part of the scene sits, Walk for the control lines that steer the hero. Studio takes the whole window while the game waits paused — Help and the other menus stay outside it — and its back arrow returns to Create as you left it. It needs a larger screen than a phone: if the window narrows or the device rotates while changes are unkept, Studio waits under a notice, with Keep and Discard, until it fits again.",
          "The scrubber replays the draw order command by command, the scene list names each thing the picture draws, and clicking a pixel shows which command put it there — or why a fill stopped.",
          "Select an item to edit it: drag it or its points, nudge it with the arrow keys (Shift for 8 pixels), or change its colour, priority and draw order in the inspector. To add a point to a selected line, Alt+click it (a plus shows where while Alt is held) and drag the new point into place, or press Alt+Enter (or Insert) to add one where the line passes nearest the keyboard cursor. Each lens locks what it is not about (the Depth lens keeps the art as it is) until you unlock it, and every change can be undone, even after Keep. Keep saves the picture into the game; leaving Studio, switching to Play or exiting the game with unkept changes asks first.",
          "The tool rail on the left starts with Select (V), which moves an item, and Point (A), which moves only its points; the rest draw new items: Line (L), Rectangle (R), Polygon (P), Fill (F) and Brush (B), with the colour and priority under the tools. New content goes where the scrubber stands in the draw order. The pipette (I) picks values from the picture, H or Space pans, and G stands a ghost actor from the game's views on the picture to show whether it would be drawn in front or behind. Every tool works from the keyboard too: on the focused canvas the arrow keys move a crosshair (Shift for 8 pixels) and Space or Enter clicks where it stands.",
          "The Walk lens tests walks and wires doors. Test walk (T): click a start, or a door to start where the player comes in through it, then a goal; a door box counts as a goal, and the walk goes through it. The real game walks it in a throwaway copy and says Reached, Blocked at what was in the way, Went to room N, or A message stopped the walk. The green tint is an estimate of where the player can stand. Door box (D) and Edge exit (E) add exits: choose where each leads, the flag that opens it and the art it follows, so moving a doorway moves its door in the same Keep. Exits written in the room's own logic stay read-only. Right-click a spot, or press the Menu key, and choose Play here to jump into the game there. The same menu starts a test walk at that spot, or with a start chosen, Test walk to here walks to it.",
          'Ask about this selection, under the item in the inspector (or / on the keyboard, or Ask beside the selection), has your connected AI change just the selected item: "make this bridge walkable without changing the art". Its proposal shows on the canvas, Before or After, with the changed cells outlined; Accept makes it one undo step that Keep saves like any edit, and Reject or Stop leaves the picture as it was. The lens\'s locks hold for the AI as they do for you: it may move the item or copy it once, as Duplicate does, but no more. While it works, the box shows what is left of the budget; if the budget runs out, the request pauses until you Continue with another allowance or Discard it. Ask again… under a proposal sends a follow-up about the same selection, and the AI remembers what you asked before.',
        ],
      },
      {
        id: "sprites",
        title: "Sprite Studio",
        body: [
          "Open in Sprite Studio, on a view in a room's card in the World panel or in the Resources tab, edits a character's or object's cels: one loop per facing, each a row of animation frames in the timeline under the canvas. A character-sheet candidate from reference art opens here too, to repair before you keep it.",
          "Draw with the Pencil (B), Eraser (E), Fill (G), Line (L) and Rectangle (R) in any colour of the fixed palette; the cel's transparent colour, marked ∅, is only ever written by the eraser. Select (M) moves, copies (Alt), flips (H) or deletes a region; the pipette (I) picks a colour. Recolour (C) swaps one colour for another in a cel, a loop or the whole view. On the focused canvas the arrow keys move a cursor and Space or Enter clicks where it stands. The Contact sheet shows every cel at once, and a cel's menu copies or moves it to another loop.",
          "A loop that mirrors another shares its pixels. Editing it makes it a separate copy and leaves the other facing as it is; choose Edit loop N instead to change both. The previews play the loop at the game's speed beside its partner, and stand the cel in a room that uses the view with the room's real depth. Keep saves the view into the game; every change can be undone.",
          'Ask about this selection works here too, on the selected cel or its whole loop, while every other loop stays protected: "make the robot\'s eyes blue". The canvas and the previews switch between Before and After until you accept or reject it.',
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
        id: "verified",
        title: "Games verified to boot",
        body: [
          "PC: King's Quest I–IV, Space Quest I–II, Police Quest I, Leisure Suit Larry I, The Black Cauldron, Mixed-Up Mother Goose, Donald Duck's Playground, Gold Rush!, Manhunter 1–2 and demopac4.",
          "Amiga: King's Quest II, Space Quest I–II, Police Quest I, Gold Rush! and Manhunter 2. Apple IIgs: Space Quest II.",
          "Other editions and fan games often run too; the library says when it does not know a game.",
        ],
      },
      {
        id: "share",
        title: "Export and share",
        body: [
          "Both live in Settings → This game. Export game makes a ZIP of the playable game and its public details. Download game adds everything else: the authoring conversation, images, notes, tests, history and saves. Either one opens again with Add game, in any browser.",
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
