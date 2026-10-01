import { VOCABULARY } from "../../../src/vocabulary.ts";
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
          "Agent for a hint gets a nudge and leaves the game as it is. The map shows the rooms you have walked, and games with a recorded walkthrough can play it for you, spoilers included.",
        ],
        action: { kind: "hint", label: "Agent for a hint" },
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
          VOCABULARY.playCreate.help,
          "Choose a part from the list to edit it beside the running game. Focus gives the editor the whole screen. The agent, debugger and History open beside your work.",
        ],
        action: { kind: "remix", label: "Switch to Create" },
      },
      {
        id: "start",
        title: "Start an adventure",
        body: [
          "Starter includes a hero, original art, menus and saving. Boilerplate includes start-up LOGIC, menus and death handling. Blank starts an empty project.",
          "Create with AI starts from a template or your own premise. Choose a model in Settings; the agent records a plan and builds the opening room.",
        ],
        action: { kind: "create", label: "Go to Create" },
      },
      {
        id: "rooms",
        title: "Rooms appear as you walk",
        body: [
          "Walk into a room that is still unbuilt and play pauses while the agent writes it. Everything it makes is real AGI: pictures, views, logic and sound that you can inspect, download and play again.",
          "Export game makes a playable ZIP of the rooms you have built. An unfinished room stops play there. Download game carries the editable project so you can keep building after importing it.",
        ],
      },
      {
        id: "remix",
        title: "Change anything",
        body: [VOCABULARY.agent.help, VOCABULARY.review.help, VOCABULARY.approve.help],
        action: { kind: "remix", label: "Switch to Create" },
      },
      {
        id: "plan",
        title: "Plan the world",
        body: [
          VOCABULARY.plan.help,
          "Rename rooms, describe their purpose and connect exits. The agent reads the plan when building each room.",
        ],
        action: { kind: "map", label: "Open the map" },
      },
      {
        id: "studio-basics",
        title: "Studio basics",
        body: [VOCABULARY.saved.help, VOCABULARY.undo.help, VOCABULARY.history.help],
      },
      {
        id: "studio-lenses",
        title: "PICTURE editor",
        body: [
          VOCABULARY.picture.help,
          "Choose PICTURE in the parts list. Art, Depth and Walk show what the player sees, what stands in front and where characters can go. Press 1, 2 or 3 to switch lenses.",
          VOCABULARY.focus.help,
        ],
      },
      {
        id: "studio-locks",
        title: "Locks",
        body: [
          VOCABULARY.lock.help,
          "Each lens protects the other parts while you paint. Moving, copying or deleting a whole item carries its Art, Depth and Walk together. Unlock enables editing until you close the editor.",
        ],
      },
      {
        id: "studio-depth",
        title: VOCABULARY.depth.label,
        body: [
          VOCABULARY.depth.help,
          VOCABULARY.depth.technical,
          VOCABULARY.depthBand.help,
          VOCABULARY.addDepth.help,
        ],
      },
      {
        id: "studio-order",
        title: VOCABULARY.drawOrder.label,
        body: [
          VOCABULARY.drawOrder.help,
          VOCABULARY.step.help,
          "Drag the slider under the canvas to preview each step. New steps go at the marker. Select unassigned steps and Group them into a named item.",
        ],
      },
      {
        id: "studio-select",
        title: "Select, move and group",
        body: [
          VOCABULARY.item.help,
          VOCABULARY.group.help,
          "Click an item to select it; drag it or use the arrow keys to move it. Shift adds to the selection. Points moves individual points; Alt+click adds a point to a line.",
        ],
      },
      {
        id: "studio-tools",
        title: "Drawing tools",
        body: [
          "Line, Rectangle and Polygon draw with your Art colour and Depth value. Fill colours an enclosed area. Pipette picks colour and Depth. Hand pans the canvas.",
          VOCABULARY.brush.help,
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
        title: VOCABULARY.standIn.label,
        body: [
          VOCABULARY.standIn.help,
          VOCABULARY.standIn.technical,
          "Press G to place a stand-in, then drag it by its body. Its card reports visibility and contact with Walls, Gates, Triggers and Water.",
        ],
      },
      {
        id: "studio-walk",
        title: VOCABULARY.walk.label,
        body: [
          VOCABULARY.walk.help,
          ...[VOCABULARY.wall, VOCABULARY.gate, VOCABULARY.trigger, VOCABULARY.water].map(
            (term) => `${term.label}: ${term.help} ${term.technical}`,
          ),
          "Test walk plays movement between two points.",
        ],
      },
      {
        id: "studio-ask",
        title: VOCABULARY.agent.label,
        body: [
          VOCABULARY.agent.help,
          VOCABULARY.review.help,
          "Select items and describe your change. The preview shows Before, After and the changed pixels. Approve applies the change as one Undo step.",
        ],
      },
      {
        id: "studio-source",
        title: "Rebuilt pictures",
        body: [
          "Imported pictures are rebuilt into editable steps and named items. Rebuilt identifies source recovered from bytes. Editing saves that source alongside the picture.",
        ],
      },
      {
        id: "studio-keep",
        title: VOCABULARY.saved.label,
        body: [VOCABULARY.saved.help, VOCABULARY.history.help, VOCABULARY.nameVersion.help],
      },
      {
        id: "sprites-loops",
        title: VOCABULARY.view.label,
        body: [
          VOCABULARY.view.help,
          VOCABULARY.loop.help,
          VOCABULARY.cel.help,
          VOCABULARY.onionSkin.help,
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
        title: VOCABULARY.transparentColour.label,
        body: [VOCABULARY.transparentColour.help, VOCABULARY.background.help],
      },
      {
        id: "sprites-mirror",
        title: VOCABULARY.mirrorLoop.label,
        body: [VOCABULARY.mirrorLoop.help, VOCABULARY.mirrorLoop.technical],
      },
      {
        id: "sprites-feet",
        title: VOCABULARY.feet.label,
        body: [
          VOCABULARY.feet.help,
          "The Feet guide marks the bottom row of the cel. In room previews the cel against the room’s real Depth.",
        ],
      },
      {
        id: "sprites-ask",
        title: VOCABULARY.agent.label,
        body: [
          VOCABULARY.agent.help,
          VOCABULARY.review.help,
          "Select a cel or loop and describe the change. Edit both changes mirrored loops together. Before and After show the result.",
        ],
      },
      {
        id: "keys",
        title: "Keys and cost",
        body: [
          "Your key is saved in this browser and sent to your provider, and only to your provider, with each request. Requests are billed to your provider account. Every task starts with a $5 estimated budget that you can change.",
          "What the agent writes comes from your provider's model. Play through the game to review it before sharing, especially with children.",
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
          "Explore over a hundred free AGI games made by fans through the two archives linked in your library.",
        ],
        action: { kind: "add-game", label: "Add a game" },
      },
      {
        id: "verified",
        title: "Games verified to boot",
        body: [
          "PC: King's Quest I–IV, Space Quest I–II, Police Quest I, Leisure Suit Larry I, The Black Cauldron, Mixed-Up Mother Goose, Donald Duck's Playground, Gold Rush!, Manhunter 1–2 and demopac4.",
          "Amiga: King's Quest II, Space Quest I–II, Police Quest I, Gold Rush! and Manhunter 2. Apple IIgs: Space Quest II.",
          "Other editions and fan games often run too; the library asks you to choose an interpreter for an unrecognized game.",
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
          "Games, saves and history live in this browser. AI requests send the game content they need to your chosen provider.",
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
