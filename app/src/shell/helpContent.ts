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
          "Ask for a hint gets a nudge and leaves the game as it is. The map shows the rooms you have walked, and games with a recorded walkthrough can play it for you, spoilers included.",
        ],
        action: { kind: "hint", label: "Ask for a hint" },
      },
      {
        id: "map",
        title: "The map",
        body: [
          "The map draws the rooms you have visited and the exits between them, and adds the rooms the game's own logic mentions as you explore. Pin a note to any room to remember what you found there.",
          "In Create the same map docks in the World panel, above a list of the rooms and the picture each one draws. It opens on the room you are in and follows you until you pick another; All rooms goes back to the list. Expand, beside Fit, opens the map in a full window; Esc closes it.",
        ],
        action: { kind: "map", label: "Open the map" },
      },
      {
        id: "saving",
        title: "Saving and rewinding",
        body: [
          "The game's own Save and Restore work as they always did: most Sierra games save with F5 and restore with F7. The app also autosaves, so Resume picks up where you stopped.",
          "Every session records itself. Drag the timeline under the game to look back, then Resume from here to play on from that moment. Undo rewind takes you back if you went too far.",
          "Start over keeps your earlier sessions: Undo start over, offered just after, returns to where you left off, and after that the timeline's mark where you started over is the way back.",
        ],
      },
      {
        id: "screen",
        title: "The screen",
        body: [
          "AGI games drew 320 × 200 pixels, and a monitor of the day stretched them to fill a 4:3 screen, so each pixel stood a little taller than wide. Original 4:3 in Settings shows them that way; turn it off for square pixels. Either way the game itself is unchanged.",
          "Game text uses this project's own 8 × 8 font in the originals' character grid. It draws English text and the box drawing the Sierra games use; other characters, such as the accented letters of some fan translations, show blank.",
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
          "A running game has two modes, switched in the top bar. Play is the game as its players see it; the Ask button opens a drawer that answers questions and leaves the game as it is.",
          "Create docks the tools around it: the World and Resources tabs on the left, the Assistant, Inspect and Activity tabs on the right. World holds the map and the room list; Resources lists every view the game holds, each openable in Sprite Studio. [ and ] fold the panels (in the game's command line they are just text). A catalog game opens read-only; your first change makes a remix copy of your own. This guide opens from the home screen's Help button and a running game's Help menu.",
        ],
        action: { kind: "remix", label: "Switch to Create" },
      },
      {
        id: "start",
        title: "Start an adventure",
        body: [
          "Pick a template, or describe your own hero, setting and trouble. An AI agent plans the world and builds the first room while you watch: artwork, characters and game logic.",
          "It needs your own OpenAI or Anthropic key. The app talks to your provider straight from the browser; there is no server in between.",
        ],
        action: { kind: "create", label: "Go to Create" },
      },
      {
        id: "rooms",
        title: "Rooms appear as you walk",
        body: [
          "Walk into a room that is still unbuilt and play pauses while the agent writes it. Everything it makes is real AGI: pictures, views, logic and sound that you can inspect, download and play again.",
          "An exported copy cannot grow any further: rooms not built yet stop the game, so it is marked as a work in progress. Download game keeps the project, and the world can go on growing wherever it is imported.",
        ],
      },
      {
        id: "remix",
        title: "Change anything",
        body: [
          "In Play, the Ask button answers questions and leaves the game as it is. In Create, the Assistant panel changes it: give the guard a new personality, add a puzzle, or turn the courtyard into a swamp.",
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
        id: "studio-basics",
        title: "Studio basics",
        body: [
          "Room Studio shows one picture through three lenses. Art is what the player sees, Depth says what stands in front, and Walk says where the hero can go; press 1, 2 or 3 to switch. Every item in the Scene list is a few drawing steps: click a name to select it, and drag the slider under the canvas to watch the picture paint itself.",
          "Sprite Studio edits a character's loops and cels: one loop per direction, one cel per frame. Pixels in the transparent colour ∅ show the room behind the character, and the eraser paints it.",
          "Keep puts your changes in the game, and Undo works before and after. Each Studio shows a short tour the first time it opens; Tour in its ? key list plays it again.",
        ],
      },
      {
        id: "studio-lenses",
        title: "Room Studio",
        body: [
          "Open in Studio, on a room in the World panel, reads that room's picture under three lenses: Art for what the player sees, Depth for what stands in front, Walk for the walk lines that steer the hero. Press 1, 2 or 3 to switch. Studio takes the whole window while the game waits paused, with Help and the other menus outside it, and its back arrow or its × returns to Create as you left it.",
          "Esc lets go of what you are handling, one thing per press: a menu, a drawing in progress, a door, a tool; Studio stays open. Focus mode hides the side panels for a full-width canvas: press ⌘\\ on a Mac or Ctrl+\\ elsewhere, or the panel button in the status bar, beside the ? button that lists every key. Studio needs a larger screen than a phone: if the window narrows or the device rotates while changes are unkept, Studio waits under a notice, with Keep and Discard, until it fits again.",
          "Every ⓘ in Studio says in one sentence what the thing beside it is, and Learn more opens the part of this guide about it. Details at the foot of a panel holds the expert parts: the steps, the pixel under the pointer, point tables and colour lists. Studio remembers whether you left it open.",
        ],
      },
      {
        id: "studio-locks",
        title: "Locks",
        body: [
          "Each lens locks the planes outside its job, and the chip beside the lens tabs names them: the Art lens keeps depth as it is, the Depth lens keeps the art, and the Walk lens keeps both and draws walk lines 0–3 only. Its ⓘ holds Unlock for now (Unlock art and Allow depth in the Walk lens), which lasts until you close Studio. The AI's Ask works under the same locks.",
          "An item's own Lock, in the inspector, keeps that item's place and colours until you unlock it.",
        ],
      },
      {
        id: "studio-depth",
        title: "Depth",
        body: [
          "Depth says what stands in front. Every pixel of the picture has a depth value from 0 to 15 besides its colour, and a character is drawn behind any pixel whose depth is greater than its own. AGI calls this plane priority, and so do its commands.",
          "A character's own depth comes from the band it stands in: the screen is cut into bands by height, and lower on the screen means nearer. The Depth lens shows the bands as guides. Values 0 to 3 are walk lines, which the Walk lens draws.",
        ],
      },
      {
        id: "studio-order",
        title: "Draw order and steps",
        body: [
          "A picture is a list of steps, each one AGI drawing command, and the game paints them in order: a later step covers an earlier one. The Scene list names each thing the picture draws, in that order, and the scrubber under the canvas replays it step by step. Clicking a pixel shows which step put it there, or why a fill stopped.",
          "New shapes go where the scrubber stands in the draw order: the options bar says after which step, and → Last moves it to the end so they draw on top of everything. Steps that belong to no item show as Loose at the end of the Scene list.",
        ],
      },
      {
        id: "studio-select",
        title: "Select, move and group",
        body: [
          "Select an item to edit it: drag it or its points, nudge it with the arrow keys (Shift for 8 pixels), or change its colour, depth and draw order in the inspector. To add a point to a selected line, Alt+click it (a plus shows where while Alt is held) and drag the new point into place, or press Alt+Enter (or Insert) to add one where the line passes nearest the keyboard cursor.",
          "To work on several items at once, Shift+click them on the canvas or in the Scene list, click a group row, Shift+drag a box around them, or press Shift+Alt+arrows to add the next one; dragging or nudging then moves them all as one step, so an imported bush's outline and its fill travel together, and Group (⌘G, or Ctrl+G) in the bar above the canvas turns neighbours in the draw order into one named item, keeping every pixel as it is. Ungroup (⇧⌘G, or Ctrl+Shift+G) splits a group back into the items it was made of, or an item into its drawing elements.",
        ],
      },
      {
        id: "studio-tools",
        title: "Drawing tools",
        body: [
          "The tool rail on the left starts with Select (V), which moves an item, and Points (A), which moves only its points; the rest draw new items: Line (L), Rectangle (R), Polygon (P), Fill (F) and Brush (B), with the art colour and the depth under the tools. The brush can stipple, the dotted pattern AGI brushes paint; Pattern picks which dots. The pipette (I) picks values from the picture, and H or Space pans.",
          "Every tool works from the keyboard too: on the focused canvas the arrow keys move a crosshair (Shift for 8 pixels) and Space or Enter clicks where it stands.",
        ],
      },
      {
        id: "studio-fill",
        title: "Fill",
        body: [
          "An AGI fill spreads only over white. On coloured ground the options bar says the fill stops there; Why? names what painted the spot, and Draw before moves your drawing ahead of that background fill, where a filled shape lands on white.",
        ],
      },
      {
        id: "studio-ghost",
        title: "Ghost",
        body: [
          "G stands a ghost from the game's views on the picture to show whether it would be drawn in front or behind: drag it by its body, and read its card at the top of the inspector. It stands still where you drop it; a test walk in the Walk lens shows where the game really goes.",
        ],
      },
      {
        id: "studio-walk",
        title: "Walk lens",
        body: [
          "The Walk lens tests walks and wires doors. Test walk (T): click a start, or a door to start where the player comes in through it, then a goal; a door box counts as a goal, and the walk goes through it. The real game walks it in a throwaway copy and says Reached, Blocked at what was in the way, Went to room N, or A message stopped the walk. The green tint is an estimate of where the player can stand.",
          "Door box (D) and Edge exit (E) add exits: choose where each leads, the flag that opens it and the art it follows, so moving a doorway moves its door in the same Keep. Exits written in the room's own logic stay read-only; Edit as text shows them. Right-click a spot, or press the Menu key, and choose Play here to jump into the game there. The same menu starts a test walk at that spot, or with a start chosen, Test walk to here walks to it.",
        ],
      },
      {
        id: "studio-ask",
        title: "Ask",
        body: [
          'Ask, under the selection in the inspector (or / on the keyboard, or Ask in the bar above the canvas), has your connected AI change just the selected items: "make this bridge walkable without changing the art". Attach a reference image and the AI can look at it while it works. Its proposal shows on the canvas, Before or After, with the changed cells outlined; Accept makes it one undo step that Keep saves like any edit, and Reject or Stop leaves the picture as it was.',
          "The lens's locks hold for the AI as they do for you: it may move each selected item or copy it once, as Duplicate does, but no more. While it works, the box shows what is left of the budget; if the budget runs out, the request pauses until you Continue with another allowance or Discard it. Ask again… under a proposal sends a follow-up about the same selection, and the AI remembers what you asked before.",
        ],
      },
      {
        id: "studio-source",
        title: "Rebuilt pictures",
        body: [
          "A picture made in Studio keeps its item names and groups as notes beside the bytes. A picture from an imported game has none, so Studio rebuilds its steps from the game's bytes and names the items itself; the status bar says Rebuilt. Your first Keep stores the rebuilt text as the picture's source, and the bytes stay exactly what the game draws.",
        ],
      },
      {
        id: "studio-keep",
        title: "Keep",
        body: [
          "Keep saves the picture into the game, and every change can be undone, even after Keep. Leaving Studio, switching to Play or exiting the game with unkept changes asks first. While a Keep runs, or when the game needs a reload first, the picture is view only.",
        ],
      },
      {
        id: "sprites-loops",
        title: "Sprite Studio",
        body: [
          "Open in Sprite Studio, on a view in a room's card in the World panel or in the Resources tab, edits a character's or object's cels: one loop per facing, each a row of animation frames in the timeline under the canvas. A character-sheet candidate from reference art opens here too, to repair before you keep it.",
          "Onion shows the cels before and after the one you draw on, tinted, so a motion lines up; All cels shows every cel at once, and a cel's menu copies or moves it to another loop. The chip at the top lists the rooms that use the character: Keep saves the view into the game, in every one of them, and every change can be undone.",
        ],
      },
      {
        id: "sprites-tools",
        title: "Drawing cels",
        body: [
          "Draw with the Pencil (B), Eraser (E), Fill (G), Line (L) and Rectangle (R) in any colour of the fixed palette. Select (M) moves, copies (Alt), flips (H) or deletes a region; the pipette (I) picks a colour. Recolour (C) swaps one colour for another in a cel, a loop or the whole view. On the focused canvas the arrow keys move a cursor and Space or Enter clicks where it stands.",
          "Details in the side panel resizes the cel, shifts its pixels (they wrap around the edges) and chooses another transparent colour.",
        ],
      },
      {
        id: "sprites-transparent",
        title: "Transparent colour",
        body: [
          "The eraser writes the cel's transparent colour, marked ∅. That colour is part of the view: in the game it lets the room show through. The Backdrop above the canvas (a dark or light checker, a solid colour, or a room that uses the view) shows behind transparent pixels while you draw and stays out of the view.",
        ],
      },
      {
        id: "sprites-mirror",
        title: "Mirror loops",
        body: [
          "A loop that mirrors another shares its pixels, drawn flipped: the VIEW file stores it once with a mirror bit. Editing it makes it a separate copy and leaves the other facing as it is; choose Edit both instead to change the pair. The previews play the loop at the game's speed beside its partner.",
        ],
      },
      {
        id: "sprites-feet",
        title: "Feet and depth",
        body: [
          "The game places a character by its feet, the bottom row of the cel, and reads its depth there. Baseline marks that row on the canvas. In room stands the cel in a room that uses the view, with the room's real depth, and says whether it is fully visible.",
        ],
      },
      {
        id: "sprites-ask",
        title: "Ask in Sprite Studio",
        body: [
          'Ask works here too, on the selected cel or its whole loop, while every other loop stays protected: "make the robot\'s eyes blue". The canvas and the previews switch between Before and After until you accept or reject it.',
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
          "Add game takes a ZIP or a folder of AGI files. The files stay in your browser. The app recognizes Sierra's PC, Amiga and Apple IIgs releases and picks the matching interpreter; for anything else, it asks.",
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
          "AGI IS HERE is an independent interpreter checked against the original Sierra interpreters on PC, Amiga and Apple IIgs, down to their timing quirks. The project's fidelity notes record the evidence, with addresses and hashes.",
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
          "The interpreter, the app and the tools are MIT licensed on GitHub. Bring your own Sierra copies, or play the free fan-made games the library links to.",
        ],
      },
    ],
  },
];
