/** Canonical editor and agent vocabulary. Platform-free; technical AGI terms stay on hover. */
export interface VocabularyTerm {
  readonly id: string;
  readonly label: string;
  readonly help: string;
  readonly technical: string;
}
export interface VocabularyAction extends VocabularyTerm {
  readonly tool: string;
}

export const WORDS_EDITOR_COPY = {
  unknown: "“{word}” is a new word, so the game stops reading there.",
  teach: "Teach “{word}”…",
  more: "More",
  newMeaning: "New meaning",
  skip: "Skip it like “the”",
  suggesting: "Suggesting…",
  addAll: "Add all",
  dismiss: "Dismiss",
  retry: "Retry",
  suggestionsFrom: "Suggestions from {model}",
  openChat: "Open chat",
  changed: "WORDS or the room changed. Try again with the current words.",
  existing: "These words already have meanings. Try another meaning.",
} as const;

export const WORDS_REPLY_COPY = {
  suggested: "Suggested {words} · shown in WORDS",
  suggestedCount: "Suggested {count} words · shown in WORDS",
  predicted: "Predicted {count} {commands} · see Players will likely try in {room}",
  command: "command",
  commands: "commands",
  unreadable: "The reply’s JSON could not be read.",
  emptyWords: "The reply contained no usable words.",
  emptyCommands: "The reply contained no usable commands.",
  retrySuggest: "Try ✦ Suggest again.",
  retryPredict: "Try ✦ Suggest sentences again.",
} as const;

export const VOCABULARY = {
  savedByNewer: {
    id: "savedByNewer",
    label: "Saved by a newer version of AGI IS HERE",
    help: "Download the saved project or remove it from this browser.",
    technical: "",
  },
  meaningButton: {
    id: "meaningButton",
    label: "+ Meaning",
    help: "Starts a row of words with a new meaning.",
    technical: "",
  },
  playtests: {
    id: "playtests",
    label: "from your playtests",
    help: "Sentences from your playtests.",
    technical: "",
  },
  sentenceParser: {
    id: "sentenceParser",
    label: "The game’s own parser reads it",
    help: "Reads the sentence with the current WORDS.",
    technical: "",
  },
  meanings: {
    id: "meanings",
    label: "Meanings",
    help: "Words that mean the same thing. The game treats every word in a meaning alike, so LOGIC that answers “look” also answers “examine”.",
    technical: "",
  },
  trySentence: {
    id: "trySentence",
    label: "Try a sentence",
    help: "The game’s own parser reads it.",
    technical: "",
  },
  playersTried: {
    id: "playersTried",
    label: "Players tried",
    help: "Sentences from your playtests.",
    technical: "",
  },
  findWord: {
    id: "findWord",
    label: "Find a word",
    help: "Find a word or a group number.",
    technical: "",
  },
  skippedWords: {
    id: "skippedWords",
    label: "Skipped",
    help: "The parser passes over these, so “look at the tree” reads as “look tree”.",
    technical: "",
  },
  typeSentence: {
    id: "typeSentence",
    label: "Type it in the game ↵",
    help: "Types this sentence into the running game.",
    technical: "",
  },
  readyResponse: {
    id: "readyResponse",
    label: "Ready for a response",
    help: "Add a response for this meaning.",
    technical: "",
  },
  addResponse: {
    id: "addResponse",
    label: "Answer it",
    help: "Adds a sentence and its answer to this room’s LOGIC.",
    technical: "",
  },
  predictCommands: {
    id: "predictCommands",
    label: "Suggest sentences",
    help: "Suggested by the agent from the room’s picture, objects and text.",
    technical: "",
  },
  suggestWords: {
    id: "suggestWords",
    label: "Suggest",
    help: "Proposes words with the same meaning.",
    technical: "",
  },
  sameAs: {
    id: "sameAs",
    label: "Same as…",
    help: "Adds the new word to a meaning.",
    technical: "",
  },
  moveWord: {
    id: "moveWord",
    label: "Move to…",
    help: "Moves a word to another meaning.",
    technical: "",
  },
  newWord: {
    id: "newWord",
    label: "new word",
    help: "The game stops reading at this word.",
    technical: "",
  },
  unreadWord: {
    id: "unreadWord",
    label: "not read",
    help: "The parser stops at the first new word or after ten words.",
    technical: "",
  },
  skippedWord: {
    id: "skippedWord",
    label: "skipped",
    help: "The parser passes over this word.",
    technical: "",
  },
  noResponse: {
    id: "noResponse",
    label: "This room has no response for it yet",
    help: "Add a response for the sentence.",
    technical: "",
  },
  orderWords: {
    id: "orderWords",
    label: "Order: most used",
    help: "Meanings with the most LOGIC uses appear first.",
    technical: "",
  },
  reviewCommands: {
    id: "reviewCommands",
    label: "Add all as changes to review",
    help: "Hands the gaps to the agent as a scoped editing task.",
    technical: "",
  },

  traceImage: {
    id: "traceImage",
    label: "Trace an image",
    help: "Bring in an image and draw over it with the picture tools.",
    technical: "Private project attachment and PICTURE tracing layer.",
  },
  makeCels: {
    id: "makeCels",
    label: "Make cels from an image",
    help: "Mark frames on a sheet, choose loops and add the cels to a VIEW.",
    technical: "Image regions become native VIEW cels.",
  },
  closeEditor: {
    id: "closeEditor",
    label: "Close editor",
    help: "Closes the active tab. Edits keep saving in the workspace.",
    technical: "",
  },
  lens: {
    id: "lens",
    label: "Lens",
    help: "Shows Art, Depth or Walk while you draw.",
    technical: "",
  },
  drawingDepth: {
    id: "drawingDepth",
    label: "Drawing depth",
    help: "The depth the drawing tools also paint. None leaves the existing depth as you draw.",
    technical: "PICTURE priority drawing value.",
  },
  none: {
    id: "none",
    label: "None",
    help: "Leaves the existing depth as you draw.",
    technical: "Priority plane disabled.",
  },
  waitingUpdate: {
    id: "waitingUpdate",
    label: "Updates when the game continues",
    help: "The game uses your edits when it continues.",
    technical: "Admission waits for a safe interpreter boundary.",
  },
  objectColumn: {
    id: "objectColumn",
    label: "Object",
    help: "Something the player can pick up and carry.",
    technical: "Entry in the OBJECT file.",
  },
  roomColumn: {
    id: "roomColumn",
    label: "Room",
    help: "Where the object starts. Room 255 puts it in the inventory.",
    technical: "OBJECT starting room.",
  },
  wordGroup: {
    id: "wordGroup",
    label: "Meaning",
    help: "Words in this row share a meaning. Add another word with Enter.",
    technical: "WORDS.TOK group",
  },
  addWord: {
    id: "addWord",
    label: "Add word",
    help: "Type a word and press Enter to add it to this meaning.",
    technical: "",
  },
  addGroup: {
    id: "addGroup",
    label: "Add meaning",
    help: "Starts a row of words with a new meaning.",
    technical: "Allocates an unused WORDS.TOK group, preserving reserved ids.",
  },
  ignoredWords: {
    id: "ignoredWords",
    label: "Ignored words",
    help: "The game skips these words when it reads a command.",
    technical: "WORDS.TOK group 0.",
  },
  anyWord: {
    id: "anyWord",
    label: "Any word",
    help: "Matches one word in a command.",
    technical: "Reserved WORDS.TOK group 1.",
  },
  restOfLine: {
    id: "restOfLine",
    label: "Remaining words",
    help: "Matches the rest of a command.",
    technical: "Reserved WORDS.TOK group 9999.",
  },
  room: {
    id: "room",
    label: "ROOM",
    help: "A place in your game. Each room has a LOGIC that says what happens and a PICTURE that shows where you are.",
    technical: "Room N is LOGIC N; new.room(N) enters it.",
  },
  logic: {
    id: "logic",
    label: "LOGIC",
    help: "The instructions that make your game respond.",
    technical: "Compiled AGI bytecode.",
  },
  sharedLogic: {
    id: "sharedLogic",
    label: "SHARED LOGIC",
    help: "LOGIC that runs in every room, like start-up, menus and game over.",
    technical: "LOGIC 0 runs every cycle; others are called.",
  },
  picture: {
    id: "picture",
    label: "PICTURE",
    help: "A room's background, drawn step by step with lines and fills.",
    technical: "Vector PICTURE resource, 160×168.",
  },
  view: {
    id: "view",
    label: "VIEW",
    help: "A character or thing that moves. It has loops for the directions it faces and cels for the frames of each loop.",
    technical: "VIEW resource.",
  },
  sound: {
    id: "sound",
    label: "SOUND",
    help: "Music and sound effects.",
    technical: "SOUND resource, up to four voices.",
  },
  objects: {
    id: "objects",
    label: "OBJECT",
    help: "Something the player can pick up and carry.",
    technical: "Entry in the OBJECT file.",
  },
  words: {
    id: "words",
    label: "WORDS",
    help: "The words the game understands when the player types.",
    technical: "WORDS.TOK; words with the same meaning share a group.",
  },
  item: {
    id: "item",
    label: "item",
    help: "A named part of a picture, like Tree or Cottage. Moving an item moves everything it draws.",
    technical: "A group of steps marked # @item.",
  },
  step: {
    id: "step",
    label: "step",
    help: "One drawing command. A picture draws its steps in order.",
    technical: "One AGI picture command.",
  },
  drawOrder: {
    id: "drawOrder",
    label: "draw order",
    help: "The order a picture draws its items. Later items cover earlier ones.",
    technical: "",
  },
  art: { id: "art", label: "Art", help: "What the player sees.", technical: "Visual plane." },
  depth: {
    id: "depth",
    label: "Depth",
    help: "What stands in front. Lower on the screen is nearer.",
    technical: "AGI calls this priority.",
  },
  depthBand: {
    id: "depthBand",
    label: "depth band",
    help: "Each row of the screen has a depth. A character's depth comes from the row its feet are on.",
    technical: "Priority band from set.pri.base.",
  },
  walk: {
    id: "walk",
    label: "Walk",
    help: "Where characters can go.",
    technical: "AGI calls this control.",
  },
  wall: { id: "wall", label: "Wall", help: "Characters stop here.", technical: "Control 0." },
  gate: {
    id: "gate",
    label: "Gate",
    help: "Characters stop here unless the room's LOGIC lets them through.",
    technical: "Control 1; ignore.blocks lets an actor pass.",
  },
  trigger: {
    id: "trigger",
    label: "Trigger",
    help: "Tells the room's LOGIC when the hero steps here.",
    technical: "Control 2; sets flag 3 while the hero's feet touch it.",
  },
  water: {
    id: "water",
    label: "Water",
    help: "Marks water. The room's LOGIC can keep a character on water or on land.",
    technical:
      "Control 3; object.on.water / object.on.land; flag 0 while the hero stands fully on water.",
  },
  horizon: {
    id: "horizon",
    label: "horizon",
    help: "The highest row characters can walk on.",
    technical: "set.horizon.",
  },
  baseLine: {
    id: "baseLine",
    label: "base line",
    help: "The row where an item touches the ground. Characters behind it are drawn behind the item.",
    technical: "",
  },
  addDepth: {
    id: "addDepth",
    label: "Add depth",
    help: "Characters walk behind it above its base line and in front of it below.",
    technical: "Fills the item's PRIORITY for the band of its base row.",
  },
  standIn: {
    id: "standIn",
    label: "Stand-in",
    help: "A still figure you place in the room to see what hides it and where it can walk.",
    technical: "Ghost probe (renders a VIEW cel against depth and walk).",
  },
  group: {
    id: "group",
    label: "Group",
    help: "Group joins neighbouring items into one item. Ungroup splits it into the parts it was made from.",
    technical: "",
  },
  lock: {
    id: "lock",
    label: "Lock",
    help: "A locked item keeps its place and colours until you unlock it.",
    technical: "",
  },
  brush: {
    id: "brush",
    label: "Brush",
    help: "Paints with a round or square pen; Speckled scatters dots.",
    technical: "AGI pen, splatter on.",
  },
  trace: {
    id: "trace",
    label: "Trace",
    help: "Shows an image under the picture so you can draw over it.",
    technical: "Underlay, not part of the game.",
  },
  loop: {
    id: "loop",
    label: "loop",
    help: "One direction a VIEW faces, like walking left.",
    technical: "Loop N; ego uses 0 right, 1 left, 2 toward you, 3 away.",
  },
  cel: { id: "cel", label: "cel", help: "One frame of a loop.", technical: "Cel N." },
  standingCel: {
    id: "standingCel",
    label: "standing cel",
    help: "Cel 0. Characters rest on it when they stop.",
    technical: "",
  },
  feet: {
    id: "feet",
    label: "feet",
    help: "The game places a character by its feet, the bottom row of its cel.",
    technical: "Baseline.",
  },
  mirrorLoop: {
    id: "mirrorLoop",
    label: "mirror loop",
    help: "Shows another loop flipped. Edit both changes the pair; editing one gives it its own cels.",
    technical: "Mirror bit, shared cel data.",
  },
  transparentColour: {
    id: "transparentColour",
    label: "transparent colour",
    help: "Pixels in this colour show the room behind the character.",
    technical: "Transparency index.",
  },
  onionSkin: {
    id: "onionSkin",
    label: "Onion skin",
    help: "Shows the cels before and after this one faintly, to line up the animation.",
    technical: "",
  },
  background: {
    id: "background",
    label: "Background",
    help: "The colour behind the cel while you draw. The game ignores it.",
    technical: "",
  },
  hero: {
    id: "hero",
    label: "hero",
    help: "The character the player controls.",
    technical: "ego, screen object 0 (o0).",
  },
  actor: {
    id: "actor",
    label: "actor",
    help: "A VIEW the room's LOGIC places on screen.",
    technical: "Screen object oN.",
  },
  message: {
    id: "message",
    label: "message",
    help: "Text the game shows in a window.",
    technical: "#message N, print(mN).",
  },
  command: {
    id: "command",
    label: "command",
    help: 'What the player types, like "look at tree".',
    technical: "Parsed with said(...).",
  },
  response: {
    id: "response",
    label: "response",
    help: "What the game answers to a command.",
    technical: "",
  },
  flag: {
    id: "flag",
    label: "flag",
    help: "An on/off value the game remembers.",
    technical: "fN.",
  },
  variable: {
    id: "variable",
    label: "variable",
    help: "A number the game remembers.",
    technical: "vN.",
  },
  exit: {
    id: "exit",
    label: "Exit",
    help: "An exit leads to another room. An edge exit is the screen's edge; a door is a box on the floor.",
    technical: "new.room from LOGIC.",
  },
  plan: {
    id: "plan",
    label: "Plan",
    help: "The map shows your rooms and how they connect. The plan says what each room is for; the agent reads it too.",
    technical: "World plan.",
  },
  voice: {
    id: "voice",
    label: "Voice",
    help: "One of the sound's parts that play together. The PC speaker plays one voice; Tandy and PCjr play three plus noise.",
    technical: "",
  },
  drums: {
    id: "drums",
    label: "Drums",
    help: "Kick, snare and hat use the noise voice.",
    technical: "SN76489 noise control, 0..7.",
  },
  grid: {
    id: "grid",
    label: "Grid",
    help: "Notes: time across, pitch up. Click to add or remove; drag to lengthen.",
    technical: "Positions and lengths use native 60 Hz ticks.",
  },
  tracker: {
    id: "tracker",
    label: "Tracker",
    help: "Edit each voice as note, length in ticks and volume from 0 to F.",
    technical: "Volume is 15 minus native attenuation.",
  },
  importMusic: {
    id: "importMusic",
    label: "Import MIDI or VGM…",
    help: "Bring music into the three voices and Drums.",
    technical: "SMF type 0/1 or SN76489 VGM 1.50/1.51, converted to native SOUND bytes.",
  },
  exportMidi: {
    id: "exportMidi",
    label: "Export MIDI",
    help: "Download music with one MIDI track per voice.",
    technical: "SMF type 1. Pitches use the nearest MIDI note; timing uses 60 Hz ticks.",
  },
  addSound: {
    id: "addSound",
    label: "Add SOUND",
    help: "Adds this music as a new SOUND.",
    technical: "Allocates a free SOUND resource number.",
  },
  startFrom: {
    id: "startFrom",
    label: "Start from",
    help: "Choose a preset to edit and play.",
    technical: "Replaces the SOUND with native preset events.",
  },
  note: {
    id: "note",
    label: "Note",
    help: "A note plays a pitch for a length of time; a rest is a pause.",
    technical: "",
  },
  volume: {
    id: "volume",
    label: "volume",
    help: "How loud a note is (0 silent to 15 loudest).",
    technical: "AGI attenuation is 15 minus volume: 0 loudest, 15 silent.",
  },
  pitch: {
    id: "pitch",
    label: "pitch",
    help: "Shown as a note name such as A4.",
    technical: "AGI stores a frequency divisor. Pitch names use the nearest musical note.",
  },
  saved: {
    id: "saved",
    label: "Saved",
    help: "Your changes are stored in this browser.",
    technical: "",
  },
  undo: { id: "undo", label: "Undo", help: "Steps back or forward one change.", technical: "" },
  history: {
    id: "history",
    label: "History",
    help: "Saved versions of your game. Restore brings back an earlier one; later versions stay in History.",
    technical: "",
  },
  nameVersion: {
    id: "nameVersion",
    label: "Name this version",
    help: "Names the game's last update so you can find it in History.",
    technical: "",
  },
  agent: {
    id: "agent",
    label: "Agent",
    help: "Tell the agent what to change; it can edit every part of your game.",
    technical: "",
  },
  review: {
    id: "review",
    label: "Review",
    help: "Review shows each change for you to approve. Auto-approve applies changes at once; Undo takes them back.",
    technical: "",
  },
  approve: {
    id: "approve",
    label: "Approve",
    help: "Approve applies the selected changes. Reject leaves your game as it was.",
    technical: "",
  },
  playCreate: {
    id: "playCreate",
    label: "Play / Create",
    help: "Play is your game full size. Create is where you build it, with the game running.",
    technical: "",
  },
  focus: {
    id: "focus",
    label: "Focus",
    help: "Gives the editor the whole screen. The game keeps running.",
    technical: "",
  },
  ungroup: {
    id: "ungroup",
    label: "Ungroup",
    help: "Group joins neighbouring items into one item. Ungroup splits it into the parts it was made from.",
    technical: "",
  },
  unlock: {
    id: "unlock",
    label: "Unlock",
    help: "A locked item keeps its place and colours until you unlock it.",
    technical: "",
  },
  redo: { id: "redo", label: "Redo", help: "Steps back or forward one change.", technical: "" },
  autoApprove: {
    id: "autoApprove",
    label: "Auto-approve",
    help: "Review shows each change for you to approve. Auto-approve applies changes at once; Undo takes them back.",
    technical: "",
  },
  reject: {
    id: "reject",
    label: "Reject",
    help: "Approve applies the selected changes. Reject leaves your game as it was.",
    technical: "",
  },
  breakpoint: {
    id: "breakpoint",
    label: "Breakpoint",
    help: "Pause here so you can see what the game is doing.",
    technical: "LOGIC bytecode address.",
  },
  stepOver: {
    id: "stepOver",
    label: "Step over",
    help: "Run this line; if it calls another LOGIC, stop when it returns.",
    technical: "",
  },
  stepInto: {
    id: "stepInto",
    label: "Step into",
    help: "Run this line and pause inside any LOGIC it calls.",
    technical: "",
  },
  stepOut: {
    id: "stepOut",
    label: "Step out",
    help: "Run until this LOGIC returns to its caller.",
    technical: "",
  },
  watch: {
    id: "watch",
    label: "Watch",
    help: "Shows a flag or variable while the game runs.",
    technical: "",
  },
  depthDerived: {
    id: "depthDerived",
    label: "Depth: from base line",
    help: "Depth follows the item when you move or reshape it.",
    technical: "# @depth base=N.",
  },
  depthPainted: {
    id: "depthPainted",
    label: "Depth: painted",
    help: "Depth was painted by hand.",
    technical: "Ordinary priority commands.",
  },
  gameTests: {
    id: "gameTests",
    label: "Game tests",
    help: "Game tests play part of your game automatically and check the result.",
    technical: "TESTS.JSON.",
  },
  playtest: {
    id: "playtest",
    label: "Playtest room",
    help: "Plays the room with scripted commands and reports what happened.",
    technical: "Isolated, bounded engine simulation.",
  },
  reserveName: {
    id: "reserveName",
    label: "Reserve name",
    help: "Claims a name and number for a resource, flag or variable before using it.",
    technical: "#define bindings.",
  },
  proposeChanges: {
    id: "proposeChanges",
    label: "Propose changes",
    help: "Offers changes for the player to approve (Review) or applies them (Auto-approve).",
    technical: "The active host decides admission.",
  },
  withdrawChanges: {
    id: "withdrawChanges",
    label: "Withdraw changes",
    help: "Removes the pending changes from Review.",
    technical: "Leaves resources unchanged.",
  },
  finish: {
    id: "finish",
    label: "Finish",
    help: "Runs every stored game test and hands the game back to the player.",
    technical: "Validates boot on the first handoff.",
  },
  referenceImage: {
    id: "referenceImage",
    label: "Reference image",
    help: "Shows an image under the picture so you can draw over it.",
    technical: "Reference raster; the game uses compiled AGI resources.",
  },
  diagnostic: {
    id: "diagnostic",
    label: "Diagnostic",
    help: "Explains a problem with a resource or tool call.",
    technical: "Paged diagnostic artifact.",
  },
  commandReference: {
    id: "commandReference",
    label: "Command reference",
    help: "Explains the AGI instructions for this interpreter profile.",
    technical: "Opcode signatures and operand types.",
  },
  authoringGuide: {
    id: "authoringGuide",
    label: "Authoring guide",
    help: "Explains how to build interactions, movement and puzzles.",
    technical: "Authoring patterns for real AGI bytecode.",
  },
  editContext: {
    id: "editContext",
    label: "Edit context",
    help: "Shows the selected items or cels and the changes available here.",
    technical: "Selection bounds and revision token.",
  },
  projectContext: {
    id: "projectContext",
    label: "Project context",
    help: "Shows the game documents and their current diagnostics.",
    technical: "Captured workspace document set.",
  },
  document: {
    id: "document",
    label: "Document",
    help: "The source text or bytes of one part of your game.",
    technical: "Exact authored document, including invalid source.",
  },
} as const satisfies Record<string, VocabularyTerm>;

export const VOCABULARY_ACTIONS = {
  write_notes: {
    id: "write_notes",
    label: "Write notes",
    tool: "write_notes",
    help: "Keep the game’s style, tone and rules in its notes.",
    technical: "Private project document.",
  },
  trace_an_image: { ...VOCABULARY.traceImage, id: "trace_an_image", tool: "trace_an_image" },
  make_cels_from_an_image: {
    ...VOCABULARY.makeCels,
    id: "make_cels_from_an_image",
    tool: "make_cels_from_an_image",
  },
  read_room: { ...VOCABULARY.room, id: "read_room", label: "Read room", tool: "read_room" },
  read_logic: { ...VOCABULARY.logic, id: "read_logic", label: "Read logic", tool: "read_logic" },
  write_logic: {
    ...VOCABULARY.logic,
    id: "write_logic",
    label: "Write logic",
    tool: "write_logic",
  },
  edit_source: {
    ...VOCABULARY.logic,
    id: "edit_source",
    label: "Edit source",
    tool: "edit_source",
  },
  read_picture: {
    ...VOCABULARY.picture,
    id: "read_picture",
    label: "Read picture",
    tool: "read_picture",
  },
  write_picture: {
    ...VOCABULARY.picture,
    id: "write_picture",
    label: "Write picture",
    tool: "write_picture",
  },
  draw_picture_items: {
    ...VOCABULARY.picture,
    id: "draw_picture_items",
    label: "Draw picture items",
    tool: "draw_picture_items",
  },
  add_depth: { ...VOCABULARY.addDepth, id: "add_depth", label: "Add depth", tool: "add_depth" },
  read_view: { ...VOCABULARY.view, id: "read_view", label: "Read view", tool: "read_view" },
  write_view: { ...VOCABULARY.view, id: "write_view", label: "Write view", tool: "write_view" },
  edit_cels: { ...VOCABULARY.view, id: "edit_cels", label: "Edit cels", tool: "edit_cels" },
  read_words: { ...VOCABULARY.words, id: "read_words", label: "Read words", tool: "read_words" },
  write_words: {
    ...VOCABULARY.words,
    id: "write_words",
    label: "Write words",
    tool: "write_words",
  },
  write_objects: {
    ...VOCABULARY.objects,
    id: "write_objects",
    label: "Write objects",
    tool: "write_objects",
  },
  read_sound: { ...VOCABULARY.sound, id: "read_sound", label: "Read sound", tool: "read_sound" },
  write_sound: {
    ...VOCABULARY.sound,
    id: "write_sound",
    label: "Write sound",
    tool: "write_sound",
  },
  write_music: {
    ...VOCABULARY.sound,
    id: "write_music",
    label: "Write music",
    tool: "write_music",
  },
  play_sound: { ...VOCABULARY.sound, id: "play_sound", label: "Play sound", tool: "play_sound" },
  read_plan: { ...VOCABULARY.plan, id: "read_plan", label: "Read plan", tool: "read_plan" },
  update_plan: { ...VOCABULARY.plan, id: "update_plan", label: "Update plan", tool: "update_plan" },
  playtest_room: {
    ...VOCABULARY.playtest,
    id: "playtest_room",
    label: "Playtest room",
    tool: "playtest_room",
  },
  reserve_name: {
    ...VOCABULARY.reserveName,
    id: "reserve_name",
    label: "Reserve name",
    tool: "reserve_name",
  },
  propose_changes: {
    ...VOCABULARY.proposeChanges,
    id: "propose_changes",
    label: "Propose changes",
    tool: "propose_changes",
  },
  withdraw_changes: {
    ...VOCABULARY.withdrawChanges,
    id: "withdraw_changes",
    label: "Withdraw changes",
    tool: "withdraw_changes",
  },
  finish: { ...VOCABULARY.finish, id: "finish", label: "Finish", tool: "finish" },
  read_game_tests: {
    ...VOCABULARY.gameTests,
    id: "read_game_tests",
    label: "Read game tests",
    tool: "read_game_tests",
  },
  run_game_tests: {
    ...VOCABULARY.gameTests,
    id: "run_game_tests",
    label: "Run game tests",
    tool: "run_game_tests",
  },
  write_game_tests: {
    ...VOCABULARY.gameTests,
    id: "write_game_tests",
    label: "Write game tests",
    tool: "write_game_tests",
  },
  read_diagnostic: {
    ...VOCABULARY.diagnostic,
    id: "read_diagnostic",
    label: "Read diagnostic",
    tool: "read_diagnostic",
  },
  read_command_reference: {
    ...VOCABULARY.commandReference,
    id: "read_command_reference",
    label: "Read command reference",
    tool: "read_command_reference",
  },
  read_authoring_guide: {
    ...VOCABULARY.authoringGuide,
    id: "read_authoring_guide",
    label: "Read authoring guide",
    tool: "read_authoring_guide",
  },
  read_reference_image: {
    ...VOCABULARY.referenceImage,
    id: "read_reference_image",
    label: "Read reference image",
    tool: "read_reference_image",
  },
  write_room: { ...VOCABULARY.room, id: "write_room", label: "Write room", tool: "write_room" },
  edit_selection: {
    ...VOCABULARY.editContext,
    id: "edit_selection",
    label: "Edit selection",
    tool: "edit_selection",
  },
  withdraw_selection: {
    ...VOCABULARY.editContext,
    id: "withdraw_selection",
    label: "Withdraw selection",
    tool: "withdraw_selection",
  },
  propose_names: {
    ...VOCABULARY.reserveName,
    id: "propose_names",
    label: "Name game parts",
    tool: "propose_names",
  },
  read_edit_context: {
    ...VOCABULARY.editContext,
    id: "read_edit_context",
    label: "Read edit context",
    tool: "read_edit_context",
  },
  read_project_context: {
    ...VOCABULARY.projectContext,
    id: "read_project_context",
    label: "Read project context",
    tool: "read_project_context",
  },
  read_document: {
    ...VOCABULARY.document,
    id: "read_document",
    label: "Read document",
    tool: "read_document",
  },
} as const satisfies Record<string, VocabularyAction>;

/** Start a tool contract with the same plain help the editor displays. */
export function toolDescription(name: keyof typeof VOCABULARY_ACTIONS, contract: string): string {
  return `${VOCABULARY_ACTIONS[name].help} ${contract}`;
}

const PARAMETER_TERMS: Readonly<Record<string, keyof typeof VOCABULARY>> = {
  room: "room",
  picture: "picture",
  egoView: "hero",
  itemId: "item",
  baseY: "baseLine",
  priority: "depth",
  priorityBase: "depthBand",
  plane: "art",
  loop: "loop",
  cel: "cel",
  cels: "cel",
  rows: "cel",
  flag: "flag",
  flags: "flag",
  completedFlag: "flag",
  variable: "variable",
  variables: "variable",
  command: "command",
  printed: "message",
  text: "message",
  words: "words",
  groups: "words",
  ignored: "words",
  exits: "exit",
  tracks: "voice",
  channel: "voice",
  note: "pitch",
  attenuation: "volume",
  volume: "volume",
  objects: "objects",
  spawn: "hero",
  spawnX: "feet",
  spawnY: "feet",
  facts: "plan",
  quests: "plan",
};

/** The plain opening of a parameter's contract, shared with editor terms. */
export function parameterHelp(name: keyof typeof VOCABULARY_ACTIONS, field: string): string {
  const term = PARAMETER_TERMS[field];
  return term === undefined ? VOCABULARY_ACTIONS[name].help : VOCABULARY[term].help;
}

/** Attach input contracts while retaining the schema's validation and strict-mode shape. */
export function parameterDescriptions<T extends { readonly properties: Record<string, unknown> }>(
  name: keyof typeof VOCABULARY_ACTIONS,
  parameters: T,
): T {
  function describe(value: unknown, field: string): unknown {
    if (value === null || typeof value !== "object") return value;
    const schema = value as Record<string, unknown>;
    const next = { ...schema };
    const types = Array.isArray(schema["type"]) ? schema["type"] : [schema["type"]];
    const bounds = ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"]
      .filter((key) => schema[key] !== undefined)
      .map((key) => `${key} ${schema[key]}`);
    const values = Array.isArray(schema["enum"])
      ? ` Allowed values: ${JSON.stringify(schema["enum"])}.`
      : "";
    const existing = typeof schema["description"] === "string" ? ` ${schema["description"]}` : "";
    next["description"] =
      `${parameterHelp(name, field)} Input ${field}: ${types.join(" or ")}${bounds.length ? `; ${bounds.join(", ")}` : ""}.${values}${existing} ${types.includes("null") ? "Null uses the default or omits this option as specified by the tool contract." : "Supply this field when its containing object is present."}`;
    if (schema["properties"] && typeof schema["properties"] === "object")
      next["properties"] = Object.fromEntries(
        Object.entries(schema["properties"]).map(([key, child]) => [key, describe(child, key)]),
      );
    if (schema["items"]) next["items"] = describe(schema["items"], `${field} entry`);
    return next;
  }
  return {
    ...parameters,
    properties: Object.fromEntries(
      Object.entries(parameters.properties).map(([key, value]) => [key, describe(value, key)]),
    ),
  };
}

/** Retired visible wording; identifiers and technical hover retain AGI vocabulary. */
export const RETIRED_UI_TERMS: Readonly<Record<string, string>> = {
  Ghost: "Stand-in",
  Keep: "Saved",
  "Studio Assist": "Agent",
  sprite: "actor",
  Stipple: "Speckled",
  Backdrop: "Background",
  occluder: "Depth",
  "world bible": "plan",
  "departure asset": "reference image",
  "actor probe": "Stand-in",
  "drawing element": "item",
  "key colour": "transparent colour",
  "1 blocks until a flag": "Gate",
  Onion: "Onion skin",
  Ask: "Agent",
  Assistant: "Agent",
  proposal: "changes",
  candidate: "changes",
  checkpoint: "Name this version",
};
