/**
 * The Studios' keyboard help, kept off the canvas: a tool's name and one
 * short line for the status bar, and the full key list the `?` sheet shows
 * (StudioKeySheet.vue). The keys themselves are studioKeys.ts and
 * spriteKeys.ts; this is only what they are called.
 */

import type { SpriteTool } from "./sprite/useSpriteTools.ts";
import type { StudioTool } from "./studioTools.ts";
import { keyLabel } from "../ui/keyLabel.ts";

/** Shift and Alt held on their own, in the viewer's keyboard words. */
const SHIFT = keyLabel("Shift");
const ALT = keyLabel("Alt");

export const ROOM_TOOL_NAMES: Record<StudioTool, string> = {
  select: "Select",
  point: "Points",
  line: "Line",
  rect: "Rectangle",
  polygon: "Polygon",
  fill: "Fill",
  brush: "Brush",
  pipette: "Pipette",
  hand: "Hand",
  walk: "Test walk",
  door: "Door box",
  edge: "Edge exit",
};

/** The status bar's one line for the active Room Studio tool. */
export const ROOM_TOOL_HINTS: Record<StudioTool, string> = {
  select: `Click an item · ${keyLabel("Shift+click")} adds one · drag moves · ${keyLabel("Alt+click")} adds a point`,
  point: "Drag a point's handle · the item itself stays put",
  line: "Click points · Enter or double-click finishes",
  rect: "Drag a rectangle · Shift keeps it square",
  polygon: "Click points · click the first point or Enter closes",
  fill: "Click where the fill starts · it spreads over white",
  brush: "Drag to place plot points, one per pixel",
  pipette: "Click to pick the colour and depth under the cursor",
  hand: "Drag to pan · Space pans with any tool",
  walk: "Click a start, then a goal · the game walks it",
  door: "Drag a door box on the floor",
  edge: "Click near an edge: walking off it changes room",
};

/** While a line or polygon has points, the status line says how to take them back. */
export const ROOM_PATH_HINT = "Backspace removes a point · Esc cancels";

/** With an item (or several) selected under Select: the editing keys. */
export const ROOM_EDIT_HINT = `Arrows nudge (${SHIFT} 8 px) · ${ALT} arrows next item · [ ] order`;

/** With several items selected: how they move, at the foot of the inspector. */
export const ROOM_GROUP_HINT = `Drag or arrows move them together (${SHIFT} 8 px) · [ ] reorder one at a time`;

export const SPRITE_TOOL_NAMES: Record<SpriteTool, string> = {
  pencil: "Pencil",
  eraser: "Eraser",
  fill: "Fill",
  line: "Line",
  rect: "Rectangle",
  select: "Select",
  pipette: "Pipette",
  recolor: "Recolour",
};

export const SPRITE_TOOL_HINTS: Record<SpriteTool, string> = {
  pencil: "Drag to paint · Space: pen down at the cursor",
  eraser: "Drag to paint ∅ transparent",
  fill: "Click to flood the area under the cursor",
  line: "Drag a line, or Space at each end",
  rect: "Drag a rectangle, or Space at each corner",
  select: `Drag a marquee · arrows move it (${ALT} copies) · H flips · Delete clears`,
  pipette: "Click to pick the paint colour",
  recolor: "Click a colour on the canvas to change it everywhere in scope",
};

interface KeyRow {
  /** Each entry is one key or chord; alternatives are separate entries. */
  readonly keys: readonly string[];
  readonly does: string;
}
export interface KeySection {
  readonly title: string;
  readonly rows: readonly KeyRow[];
}

/** What Space or Enter does at the keyboard cursor, per Room Studio tool that takes one. */
const ROOM_CLICK: Partial<Record<StudioTool, string>> = {
  line: "adds a point; on the last point, finishes",
  polygon: "adds a point; on the last point, closes",
  rect: "starts; arrows size it; again finishes",
  fill: "fills from there",
  brush: "puts the pen down or lifts it",
  pipette: "picks",
  walk: "sets the start, then the goal",
  door: "starts the box; arrows size it; again adds it",
  edge: "adds an exit by the nearest edge",
};

export function roomKeySheet(tool: StudioTool): KeySection[] {
  const click = ROOM_CLICK[tool];
  return [
    {
      title: "Tools",
      rows: [
        { keys: ["V"], does: "Select and move" },
        { keys: ["A"], does: "Points only" },
        { keys: ["L", "R", "P"], does: "Line, rectangle, polygon" },
        { keys: ["F", "B", "I"], does: "Fill, brush, pipette" },
        { keys: ["T", "D", "E"], does: "Test walk, door box, edge exit (Walk lens)" },
        { keys: ["G"], does: "Ghost" },
        { keys: ["H"], does: "Hand; hold Space to pan with any tool" },
      ],
    },
    {
      title: `On the canvas${click ? ` · ${ROOM_TOOL_NAMES[tool]}` : ""}`,
      rows: [
        ...(click
          ? [
              { keys: ["←↑→↓"], does: `Move the drawing cursor (${SHIFT} 8 px)` },
              { keys: ["Space", "Enter"], does: `Click at the cursor: ${click}` },
              { keys: ["Backspace"], does: "Remove the last point" },
            ]
          : [
              { keys: ["←↑→↓"], does: `Nudge the selection 1 px (${SHIFT} 8 px)` },
              { keys: [keyLabel("Alt+←↑→↓")], does: "Previous or next item" },
              {
                keys: [keyLabel("Shift+Alt+←↑→↓")],
                does: "Add the previous or next item to the selection",
              },
              {
                keys: [keyLabel("Shift+click")],
                does: "Add an item to the selection, or take it away",
              },
              { keys: [keyLabel("Shift+drag")], does: "Select the items inside a box" },
              { keys: [keyLabel("Alt+click"), "Insert"], does: "Add a point to the selected line" },
            ]),
        { keys: ["Esc"], does: "Cancel one thing per press" },
        { keys: [keyLabel("Mod+\\")], does: "Hide or show the side panels (focus mode)" },
        { keys: ["Menu", keyLabel("Shift+F10")], does: "Canvas menu: Play here, test walks" },
      ],
    },
    {
      title: "Edit",
      rows: [
        { keys: ["Delete"], does: "Delete the selection" },
        { keys: [keyLabel("Mod+D")], does: "Duplicate the selection" },
        { keys: [keyLabel("Mod+G")], does: "Group the selected items" },
        { keys: [keyLabel("Mod+Shift+G")], does: "Ungroup the selected group" },
        { keys: ["[", "]"], does: "Move one item back or forward in draw order" },
        { keys: [keyLabel("Mod+Z"), keyLabel("Mod+Shift+Z")], does: "Undo, redo" },
        { keys: ["/"], does: "Ask about the selection" },
      ],
    },
    {
      title: "View",
      rows: [
        { keys: ["1", "2", "3"], does: "Art, Depth, Walk lens" },
        { keys: [",", "."], does: "Step the draw order back or forward" },
        { keys: ["Home", "End"], does: "Draw order to the start or the end" },
        { keys: ["+", "−", "0"], does: "Zoom in, out, to fit" },
        { keys: ["?"], does: "This list" },
      ],
    },
  ];
}

export function spriteKeySheet(): KeySection[] {
  return [
    {
      title: "Tools",
      rows: [
        { keys: ["B", "E", "G"], does: "Pencil, eraser, fill" },
        { keys: ["L", "R"], does: "Line, rectangle" },
        { keys: ["M", "I"], does: "Select, pipette" },
        { keys: ["C"], does: "Recolour" },
        { keys: ["H"], does: "Flip the selection, else the cel" },
      ],
    },
    {
      title: "On the canvas",
      rows: [
        {
          keys: ["←↑→↓"],
          does: `Move the cursor (${SHIFT} 8 px), or the selection (${ALT} copies)`,
        },
        {
          keys: ["Space", "Enter"],
          does: "Click at the cursor: pen down and up, a corner, where a fill starts",
        },
        { keys: ["Delete"], does: "Clear the selection" },
        { keys: ["Esc"], does: "Cancel, drop the selection or close a panel" },
      ],
    },
    {
      title: "Cels and view",
      rows: [
        { keys: [",", "."], does: "Previous or next cel" },
        { keys: ["<", ">"], does: "Previous or next loop" },
        { keys: ["+", "−", "0"], does: "Zoom in, out, to fit" },
        { keys: [keyLabel("Mod+Z"), keyLabel("Mod+Shift+Z")], does: "Undo, redo" },
        { keys: ["/"], does: "Ask about the cel or loop" },
        { keys: ["?"], does: "This list" },
      ],
    },
  ];
}
