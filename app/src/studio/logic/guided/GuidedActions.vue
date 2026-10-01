<script setup lang="ts">
/**
 * The optional Guided actions panel inside Logic Studio: five provider-free
 * operations over the open project's real draft. Each fills a small form,
 * prepares a detached preview (Show code reads the proposed source/diff before
 * anything is written), applies as one atomic, undoable draft transaction and
 * reports the backend's typed refusals exactly — including a jump to custom
 * code it will not rewrite. The panel never Keeps, never runs the game and
 * never needs a provider or key.
 */
import { computed, nextTick, reactive, ref, useId, useTemplateRef, watch, watchEffect } from "vue";
import UiButton from "../../../ui/UiButton.vue";
import UiDialog from "../../../ui/UiDialog.vue";
import UiDisclosure from "../../../ui/UiDisclosure.vue";
import UiField from "../../../ui/UiField.vue";
import UiSelect from "../../../ui/UiSelect.vue";
import UiSwitch from "../../../ui/UiSwitch.vue";
import { openContainer } from "../../../../../src/container/container.ts";
import { renderPicture } from "../../../../../src/picture/renderer.ts";
import { compilePictureSource } from "../../../../../src/picture/source.ts";
import { PROFILES } from "../../../../../src/runtime/profile.ts";
import { SCREEN_HEIGHT, SCREEN_WIDTH, createPictureSurface } from "../../../../../src/types.ts";
import {
  buildView,
  parseView,
  selectViewCel,
  type AgiView,
  type BuildViewInput,
} from "../../../../../src/view/view.ts";
import type { EditableProject } from "../../../project/editableProject.ts";
import { EGA_PALETTE } from "../../../render/palette.ts";
import { documentLabel } from "../logicWorkspace.ts";
import type { GuidedOperationKind } from "../../../../../src/authoring/guidedProject.ts";
import { createGuidedActions, type GuidedInputs } from "./guidedActions.ts";
import {
  commandHints,
  compactDiff,
  diffLines,
  regionRules,
  resourceOptions,
  roomOptions,
  roomPictureNumber,
  type GuidedDiffLine,
  type GuidedOption,
} from "./guidedPreview.ts";

const props = defineProps<{
  /** The mounted workspace the actions write into; undefined while opening. */
  project: EditableProject | undefined;
  /** The open document's key — seeds the room pickers. */
  activeKey: string | null;
  /** The host's draft revision: re-reads options and staleness as it moves. */
  revision: number;
  /** Navigate to a real document's 1-based line in the editor. */
  navigate: (target: { key: string; line: number }) => void;
  /** Open the picture/view editor on a draft document, when the host offers it. */
  openResource?: ((key: string) => void) | undefined;
}>();
const emit = defineEmits<{ draftChanged: [keys: readonly string[]] }>();

const guided = createGuidedActions({
  context() {
    const ws = props.project;
    if (!ws) throw new Error("No project is open.");
    return { draft: ws.draft, files: ws.storedData().files, profileId: ws.profileId };
  },
  revisionTick: () => props.revision,
  onDraftChanged: (keys) => emit("draftChanged", keys),
});
// A swapped or reopened project voids every held outcome.
watch(
  () => props.project,
  () => guided.close(),
);
// A cleared outcome — applied, cancelled or voided — leaves nothing to
// review, so the code dialog closes with it rather than showing empty.
watch(
  () => guided.pending.value,
  (pending) => {
    if (pending === null) codeOpen.value = false;
  },
);

const ACTIONS: readonly { kind: GuidedOperationKind; label: string; teaches: string }[] = [
  {
    kind: "add-room",
    label: "Add room",
    teaches: "Add a room and its picture to your world.",
  },
  {
    kind: "place-hero",
    label: "Place hero",
    teaches: "Set where your hero enters the room.",
  },
  {
    kind: "respond-to-command",
    label: "Respond",
    teaches: "Choose a player command and the reply it prints.",
  },
  {
    kind: "connect-door",
    label: "Connect door",
    teaches: "Create a doorway that leads to another room.",
  },
  {
    kind: "play-sound",
    label: "Play sound",
    teaches: "Play a sound on a command or at a place.",
  },
];

const headingId = useId();
const open = ref<GuidedOperationKind>();
const codeOpen = ref(false);
const formHost = useTemplateRef("formHost");
const appliedCard = useTemplateRef("appliedCard");
const actionButtons = new Map<GuidedOperationKind, HTMLElement>();
const setActionButton = (kind: GuidedOperationKind) => (el: unknown) => {
  const element = (el as { $el?: HTMLElement } | null)?.$el;
  if (element) actionButtons.set(kind, element);
};
/** Focus returns to the button that opened the form (or whose preview ended). */
function focusAction(kind: GuidedOperationKind): void {
  void nextTick(() => actionButtons.get(kind)?.focus({ preventScroll: true }));
}

/* --- The draft's documents, re-read as the revision ticks ------------------ */

const documents = computed<Record<string, string | Uint8Array>>(() => {
  void props.revision;
  const ws = props.project;
  if (!ws) return {};
  const snapshot = ws.draft.capture();
  const docs: Record<string, string | Uint8Array> = {};
  for (const key of snapshot.keys) docs[key] = snapshot.read(key)!.content;
  return docs;
});
const bindingsText = computed(() => {
  const content = documents.value["bindings"];
  return typeof content === "string" ? content : undefined;
});
const worldText = computed(() => {
  const content = documents.value["world"];
  return typeof content === "string" ? content : undefined;
});
function docText(key: string): string | undefined {
  const content = documents.value[key];
  return typeof content === "string" ? content : undefined;
}
function roomSource(num: number): string {
  return docText(`logic:${num}`) ?? "";
}

const rooms = computed<GuidedOption[]>(() => roomOptions(documents.value, worldText.value));
const views = computed<GuidedOption[]>(() =>
  resourceOptions(documents.value, bindingsText.value, "view"),
);
const sounds = computed<GuidedOption[]>(() =>
  resourceOptions(documents.value, bindingsText.value, "sound"),
);
/** The selected room's answered commands (the cue's suggestions). */
const cueCommands = computed(() => commandHints(roomSource(cue.room)));
const cueRegions = computed(() => regionRules(roomSource(cue.room)));

function activeRoom(): number {
  const match = props.activeKey === null ? null : /^logic:(\d+)$/.exec(props.activeKey);
  const num = match === null ? null : Number(match[1]);
  return num !== null && num >= 1 && num <= 254 ? num : (rooms.value[0]?.value ?? 1);
}

/* --- The forms ------------------------------------------------------------- */

const numberField = (text: string): number | undefined => {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  return Number(trimmed); // NaN flows through: prepare refuses it precisely.
};
const word = (text: string): string | undefined => {
  const trimmed = text.trim();
  return trimmed === "" ? undefined : trimmed;
};

const addRoom = reactive({
  title: "",
  logicId: "",
  pictureId: "",
  roomName: "",
  pictureName: "",
  hero: false,
  view: "",
  x: "",
  y: "",
  horizon: "",
});
const placeHero = reactive({ room: 1, view: "", x: "", y: "" });
const respond = reactive({ room: 1, command: "", response: "", replace: false });
const door = reactive({
  from: 1,
  to: "",
  x1: "140",
  y1: "60",
  x2: "159",
  y2: "90",
  label: "",
  id: "",
  twoWay: false,
  retX1: "",
  retY1: "",
  retX2: "",
  retY2: "",
  arrivalX: "",
  arrivalY: "",
});
const cue = reactive({
  room: 1,
  sound: "",
  on: "command" as "command" | "region",
  command: "",
  rule: "",
  message: "",
  flag: "",
  startFlag: "",
});

function openForm(kind: GuidedOperationKind): void {
  if (open.value === kind) {
    open.value = undefined;
    return;
  }
  const room = activeRoom();
  if (kind === "place-hero") placeHero.room = room;
  if (kind === "respond-to-command") respond.room = room;
  if (kind === "connect-door") door.from = room;
  if (kind === "play-sound") cue.room = room;
  open.value = kind;
  void nextTick(() => formHost.value?.querySelector<HTMLElement>("input, select")?.focus());
}

function buildInput(kind: GuidedOperationKind): GuidedInputs[GuidedOperationKind] {
  switch (kind) {
    case "add-room": {
      const logicId = numberField(addRoom.logicId);
      const pictureId = numberField(addRoom.pictureId);
      const x = numberField(addRoom.x);
      const y = numberField(addRoom.y);
      const horizon = numberField(addRoom.horizon);
      return {
        title: addRoom.title.trim(),
        ...(logicId !== undefined ? { logicId } : {}),
        ...(pictureId !== undefined ? { pictureId } : {}),
        ...(word(addRoom.roomName) !== undefined ? { roomName: addRoom.roomName.trim() } : {}),
        ...(word(addRoom.pictureName) !== undefined
          ? { pictureName: addRoom.pictureName.trim() }
          : {}),
        ...(addRoom.hero && addRoom.view !== "" ? { heroView: Number(addRoom.view) } : {}),
        ...(addRoom.hero && x !== undefined && y !== undefined
          ? { spawn: { x, y, ...(horizon !== undefined ? { horizon } : {}) } }
          : {}),
      } satisfies GuidedInputs["add-room"];
    }
    case "place-hero": {
      const x = numberField(placeHero.x);
      const y = numberField(placeHero.y);
      return {
        room: placeHero.room,
        ...(placeHero.view !== "" ? { view: Number(placeHero.view) } : {}),
        ...(x !== undefined ? { x } : {}),
        ...(y !== undefined ? { y } : {}),
      } satisfies GuidedInputs["place-hero"];
    }
    case "respond-to-command":
      return {
        room: respond.room,
        command: respond.command,
        response: respond.response,
        ...(respond.replace ? { replaceExisting: true } : {}),
      } satisfies GuidedInputs["respond-to-command"];
    case "connect-door": {
      const retX1 = numberField(door.retX1);
      const retY1 = numberField(door.retY1);
      const retX2 = numberField(door.retX2);
      const retY2 = numberField(door.retY2);
      const arrivalX = numberField(door.arrivalX);
      const arrivalY = numberField(door.arrivalY);
      const returnBox =
        door.twoWay &&
        retX1 !== undefined &&
        retY1 !== undefined &&
        retX2 !== undefined &&
        retY2 !== undefined
          ? { x1: retX1, y1: retY1, x2: retX2, y2: retY2 }
          : undefined;
      return {
        room: door.from,
        destination: Number(door.to),
        box: {
          x1: numberField(door.x1) ?? NaN,
          y1: numberField(door.y1) ?? NaN,
          x2: numberField(door.x2) ?? NaN,
          y2: numberField(door.y2) ?? NaN,
        },
        ...(word(door.label) !== undefined ? { label: door.label.trim() } : {}),
        ...(word(door.id) !== undefined ? { id: door.id.trim() } : {}),
        ...(arrivalX !== undefined && arrivalY !== undefined
          ? { arrival: { x: arrivalX, y: arrivalY } }
          : {}),
        ...(returnBox !== undefined ? { returnDoor: { box: returnBox } } : {}),
      } satisfies GuidedInputs["connect-door"];
    }
    case "play-sound": {
      return {
        room: cue.room,
        sound: Number(cue.sound),
        on:
          cue.on === "region"
            ? { type: "region" as const, rule: cue.rule }
            : { type: "command" as const, command: cue.command },
        ...(word(cue.message) !== undefined ? { completionMessage: cue.message.trim() } : {}),
        ...(word(cue.flag) !== undefined ? { flag: cue.flag.trim() } : {}),
        ...(word(cue.startFlag) !== undefined ? { startFlag: cue.startFlag.trim() } : {}),
      } satisfies GuidedInputs["play-sound"];
    }
  }
}

/** The plain reason the submit button is disabled, per open form. */
const formReason = computed(() => {
  switch (open.value) {
    case "add-room":
      return "Name the room first";
    case "place-hero":
      return "Give a position or a view";
    case "respond-to-command":
      return "Fill in the command and the answer";
    case "connect-door":
      return "Pick the destination room";
    case "play-sound":
      return "Pick a sound and when it starts";
    default:
      return "";
  }
});

/** Only the visible required fields; every other constraint is prepare's own. */
const formReady = computed(() => {
  switch (open.value) {
    case "add-room":
      return addRoom.title.trim() !== "";
    case "place-hero":
      return (
        (numberField(placeHero.x) !== undefined && numberField(placeHero.y) !== undefined) ||
        placeHero.view !== ""
      );
    case "respond-to-command":
      return respond.command.trim() !== "" && respond.response.trim() !== "";
    case "connect-door":
      return door.to !== "";
    case "play-sound":
      return (
        cue.sound !== "" && (cue.on === "region" ? cue.rule !== "" : cue.command.trim() !== "")
      );
    default:
      return false;
  }
});

function submit(kind: GuidedOperationKind): void {
  if (!formReady.value) return;
  guided.prepare(kind, buildInput(kind));
}

function applyPreview(): void {
  if (!guided.apply()) return;
  open.value = undefined;
  void nextTick(() => appliedCard.value?.focus({ preventScroll: true }));
}

/**
 * The review dialog's Apply is the card's own apply — the same gate and the
 * same transaction. The dialog closes first: a modal's inertness swallows a
 * programmatic focus sent before it, so the transaction runs on `closed`,
 * leaving the applied card's focus free to land — and a refusal or stale
 * notice discoverable outside it either way.
 */
let applyAfterClose = false;
function applyFromCode(): void {
  applyAfterClose = true;
  codeOpen.value = false;
}
function onCodeClosed(): void {
  if (!applyAfterClose) return;
  applyAfterClose = false;
  applyPreview();
}

function cancelPreview(): void {
  const kind = guided.pending.value?.kind ?? open.value;
  guided.cancel();
  if (kind !== undefined) focusAction(kind);
}

function dismissApplied(): void {
  guided.close();
}

/** Refusal locations jump into the real source the message is about. */
function goToRefusal(): void {
  const refusal = guided.refusal.value;
  if (!refusal?.key) return;
  props.navigate({ key: refusal.key, line: refusal.lines?.start ?? 1 });
}

function showAppliedCode(key: string): void {
  const entry = guided.applied.value?.showCode.find((item) => item.key === key);
  props.navigate({ key, line: entry?.lines[0]?.start ?? 1 });
}

/** The picture/view edit affordance — only where the host can open one. */
function editResource(key: string): void {
  if (props.openResource !== undefined && /^(?:picture|view):\d+$/.test(key))
    props.openResource(key);
}
function canEdit(key: string): boolean {
  return props.openResource !== undefined && /^(?:picture|view):\d+$/.test(key);
}

/* --- The room previews ----------------------------------------------------- */

const profile = computed(() =>
  props.project ? (PROFILES[props.project.profileId] ?? null) : null,
);

/** The active form's room picture, compiled to a surface for the previews. */
const previewSurface = computed(() => {
  void props.revision;
  const ws = props.project;
  const prof = profile.value;
  const roomNum = open.value === "place-hero" ? placeHero.room : door.from;
  const source = docText(`logic:${roomNum}`);
  if (!ws || !prof || source === undefined) return null;
  const picNum = roomPictureNumber(source, bindingsText.value);
  if (picNum === null) return null;
  try {
    const content = documents.value[`picture:${picNum}`];
    let payload: Uint8Array | undefined;
    if (typeof content === "string")
      payload = compilePictureSource(content, { profile: prof }).bytes;
    else if (content instanceof Uint8Array) payload = content;
    else
      payload =
        openContainer(new Map(Object.entries(ws.storedData().files)), {
          profile: prof,
        }).getResource("picture", picNum) ?? undefined;
    if (payload === undefined) return null;
    const surface = createPictureSurface();
    renderPicture(payload, surface, { profile: prof });
    return surface;
  } catch {
    return null;
  }
});

const previewHeroView = computed<AgiView | null>(() => {
  const prof = profile.value;
  const num = placeHero.view === "" ? null : Number(placeHero.view);
  if (!prof || num === null) return null;
  const content = documents.value[`view:${num}`];
  try {
    if (typeof content === "string")
      return parseView(buildView(JSON.parse(content) as BuildViewInput, prof), prof);
    if (content instanceof Uint8Array) return parseView(content, prof);
  } catch {
    return null;
  }
  return null;
});

/** The cel drawn in the placement preview: the facing loop, or the first. */
const heroCel = computed(() => {
  const view = previewHeroView.value;
  if (!view) return null;
  return selectViewCel(view, view.loops.length > 2 ? 2 : 0, 0) ?? null;
});

const heroCanvas = useTemplateRef("heroCanvas");
const doorCanvas = useTemplateRef("doorCanvas");

function paintBase(canvas: HTMLCanvasElement | null): CanvasRenderingContext2D | null {
  const surface = previewSurface.value;
  if (!canvas || !surface) return null;
  canvas.width = SCREEN_WIDTH * 2;
  canvas.height = SCREEN_HEIGHT;
  const ctx = canvas.getContext("2d")!;
  const image = ctx.createImageData(SCREEN_WIDTH * 2, SCREEN_HEIGHT);
  for (let cell = 0; cell < surface.visual.length; cell++) {
    const [r, g, b] = EGA_PALETTE[surface.visual[cell]! & 0x0f]!;
    for (const half of [0, 1]) {
      const o = (cell * 2 + half) * 4;
      image.data[o] = r;
      image.data[o + 1] = g;
      image.data[o + 2] = b;
      image.data[o + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return ctx;
}

function heroPoint(): { x: number; y: number } | null {
  const x = numberField(placeHero.x);
  const y = numberField(placeHero.y);
  if (x === undefined || Number.isNaN(x) || y === undefined || Number.isNaN(y)) return null;
  return { x, y };
}

watchEffect(
  () => {
    const ctx = paintBase(heroCanvas.value);
    if (!ctx) return;
    const cel = heroCel.value;
    const point = heroPoint();
    if (!cel || !point) return;
    const image = ctx.getImageData(0, 0, SCREEN_WIDTH * 2, SCREEN_HEIGHT);
    const baseline = Math.min(point.y, SCREEN_HEIGHT - 1);
    for (let row = 0; row < cel.height; row++) {
      const cy = baseline - cel.height + 1 + row;
      if (cy < 0 || cy >= SCREEN_HEIGHT) continue;
      for (let col = 0; col < cel.width; col++) {
        const color = cel.pixels[row * cel.width + col]!;
        if (color === cel.transparentColor) continue;
        const cx = point.x + col;
        if (cx < 0 || cx >= SCREEN_WIDTH) continue;
        const [r, g, b] = EGA_PALETTE[color & 0x0f]!;
        for (const half of [0, 1]) {
          const o = (cy * SCREEN_WIDTH * 2 + cx * 2 + half) * 4;
          image.data[o] = r;
          image.data[o + 1] = g;
          image.data[o + 2] = b;
        }
      }
    }
    ctx.putImageData(image, 0, 0);
  },
  { flush: "post" },
);

function doorBox(): { x1: number; y1: number; x2: number; y2: number } | null {
  const [x1, y1, x2, y2] = [door.x1, door.y1, door.x2, door.y2].map(numberField);
  if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) return null;
  if (Number.isNaN(x1) || Number.isNaN(y1) || Number.isNaN(x2) || Number.isNaN(y2)) return null;
  return { x1, y1, x2, y2 };
}

watchEffect(
  () => {
    const ctx = paintBase(doorCanvas.value);
    if (!ctx) return;
    const box = doorBox();
    if (!box) return;
    const x1 = Math.max(0, Math.min(box.x1, box.x2));
    const x2 = Math.min(SCREEN_WIDTH - 1, Math.max(box.x1, box.x2));
    const y1 = Math.max(0, Math.min(box.y1, box.y2));
    const y2 = Math.min(SCREEN_HEIGHT - 1, Math.max(box.y1, box.y2));
    const image = ctx.getImageData(0, 0, SCREEN_WIDTH * 2, SCREEN_HEIGHT);
    const [r, g, b] = EGA_PALETTE[14]!;
    for (let cy = y1; cy <= y2; cy++) {
      for (let cx = x1; cx <= x2; cx++) {
        const edge = cy === y1 || cy === y2 || cx === x1 || cx === x2;
        for (const half of [0, 1]) {
          const o = (cy * SCREEN_WIDTH * 2 + cx * 2 + half) * 4;
          if (edge) {
            image.data[o] = r;
            image.data[o + 1] = g;
            image.data[o + 2] = b;
          } else {
            image.data[o] = image.data[o]! * 0.55 + r * 0.45;
            image.data[o + 1] = image.data[o + 1]! * 0.55 + g * 0.45;
            image.data[o + 2] = image.data[o + 2]! * 0.55 + b * 0.45;
          }
        }
      }
    }
    ctx.putImageData(image, 0, 0);
  },
  { flush: "post" },
);

/** Native 160×168 cell under a pointer on a preview canvas. */
function cellOf(event: PointerEvent): { x: number; y: number } {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  return {
    x: Math.floor(((event.clientX - rect.left) / rect.width) * SCREEN_WIDTH),
    y: Math.floor(((event.clientY - rect.top) / rect.height) * SCREEN_HEIGHT),
  };
}

function heroPlace(event: PointerEvent): void {
  const cel = heroCel.value;
  const { x, y } = cellOf(event);
  placeHero.x = String(
    Math.min(Math.max(x - Math.floor((cel?.width ?? 1) / 2), 0), SCREEN_WIDTH - 1),
  );
  placeHero.y = String(Math.min(Math.max(y, 0), SCREEN_HEIGHT - 1));
}
function heroDown(event: PointerEvent): void {
  if (event.button !== 0) return;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  heroPlace(event);
}
function heroMove(event: PointerEvent): void {
  if ((event.currentTarget as HTMLElement).hasPointerCapture(event.pointerId)) heroPlace(event);
}
function heroKey(event: KeyboardEvent): void {
  const step: Record<string, readonly [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };
  const move = step[event.key];
  if (!move) return;
  event.preventDefault();
  const far = event.shiftKey ? 8 : 1;
  const x = numberField(placeHero.x) ?? 80;
  const y = numberField(placeHero.y) ?? 120;
  placeHero.x = String(Math.min(Math.max(x + move[0] * far, 0), SCREEN_WIDTH - 1));
  placeHero.y = String(Math.min(Math.max(y + move[1] * far, 0), SCREEN_HEIGHT - 1));
}

let doorAnchor: { x: number; y: number } | null = null;
function doorDraw(event: PointerEvent): void {
  const cell = cellOf(event);
  const anchor = doorAnchor ?? cell;
  door.x1 = String(Math.min(anchor.x, cell.x));
  door.x2 = String(Math.max(anchor.x, cell.x));
  door.y1 = String(Math.min(anchor.y, cell.y));
  door.y2 = String(Math.max(anchor.y, cell.y));
}
function doorDown(event: PointerEvent): void {
  if (event.button !== 0) return;
  doorAnchor = cellOf(event);
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  doorDraw(event);
}
function doorMove(event: PointerEvent): void {
  if (doorAnchor === null) return;
  if (!(event.currentTarget as HTMLElement).hasPointerCapture(event.pointerId)) return;
  doorDraw(event);
}
function doorUp(): void {
  doorAnchor = null;
}
function doorKey(event: KeyboardEvent): void {
  const step: Record<string, readonly [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };
  const move = step[event.key];
  if (!move) return;
  event.preventDefault();
  const box = doorBox() ?? { x1: 0, y1: 0, x2: 10, y2: 10 };
  const shift = (n: number, dx: number, max: number) => String(Math.min(Math.max(n + dx, 0), max));
  door.x1 = shift(box.x1, move[0], SCREEN_WIDTH - 1);
  door.x2 = shift(box.x2, move[0], SCREEN_WIDTH - 1);
  door.y1 = shift(box.y1, move[1], SCREEN_HEIGHT - 1);
  door.y2 = shift(box.y2, move[1], SCREEN_HEIGHT - 1);
}

/* --- The preview's proposed-source listing --------------------------------- */

interface CodeEntry {
  readonly key: string;
  readonly rows: readonly GuidedDiffLine[];
  readonly binary: boolean;
}

/** The detached proposal as an honest per-document diff against its snapshot. */
const codeEntries = computed<CodeEntry[]>(() => {
  const pending = guided.pending.value;
  if (pending === null) return [];
  return pending.changes.map((change) => {
    const before = pending.snapshot.read(change.key)?.content;
    return {
      key: change.key,
      binary: typeof change.content !== "string",
      rows: compactDiff(
        diffLines(
          typeof before === "string" ? before : null,
          typeof change.content === "string" ? change.content : null,
        ),
      ),
    };
  });
});

/* --- What the live region announces ---------------------------------------- */

const spoken = computed(() => {
  if (guided.notice.value !== "") return guided.notice.value;
  const refusal = guided.refusal.value;
  if (refusal) return `${refusal.label}: ${refusal.message}`;
  const applied = guided.applied.value;
  if (applied)
    return `${applied.transaction.label} applied; ${applied.transaction.keys
      .map(documentLabel)
      .join(", ")} changed.`;
  const pending = guided.pending.value;
  if (pending) return `${pending.label} is ready to review.`;
  return "";
});
</script>

<template>
  <section class="guided" :aria-labelledby="headingId" data-testid="guided-actions">
    <h2 :id="headingId" class="guided__title">Guided actions</h2>
    <p class="guided__note">Build your game step by step. Review the code each action writes.</p>

    <div class="guided__bar" role="group" aria-label="Actions">
      <UiButton
        v-for="action in ACTIONS"
        :key="action.kind"
        :ref="setActionButton(action.kind)"
        size="sm"
        :aria-expanded="open === action.kind"
        :aria-controls="open === action.kind ? `guided-form-${action.kind}` : undefined"
        :title="action.teaches"
        :data-testid="`guided-${action.kind}`"
        @click="openForm(action.kind)"
      >
        {{ action.label }}
      </UiButton>
    </div>

    <!-- Add room ---------------------------------------------------------- -->
    <form
      v-if="open === 'add-room'"
      id="guided-form-add-room"
      ref="formHost"
      class="guided__form"
      data-testid="guided-form-add-room"
      @submit.prevent="submit('add-room')"
    >
      <UiField
        v-slot="{ id, describedBy }"
        label="Room title"
        hint="What the world map calls it. The source gets a plain name."
      >
        <input
          :id
          v-model="addRoom.title"
          :aria-describedby="describedBy"
          placeholder="Moonlit grove"
          data-testid="guided-add-room-title"
        />
      </UiField>
      <UiSwitch v-model="addRoom.hero" size="sm" data-testid="guided-add-room-hero-toggle">
        <span>Start the hero here<small>Choose where your hero enters the new room.</small></span>
      </UiSwitch>
      <template v-if="addRoom.hero">
        <UiField v-slot="{ id }" label="Hero view" dense>
          <UiSelect :id v-model="addRoom.view" size="sm" block data-testid="guided-add-room-view">
            <option value="">Pick a VIEW…</option>
            <option v-for="option in views" :key="option.value" :value="String(option.value)">
              {{ option.label }}
            </option>
          </UiSelect>
        </UiField>
        <div class="guided__grid">
          <UiField v-slot="{ id }" label="Spawn x" dense>
            <input :id v-model="addRoom.x" inputmode="numeric" data-testid="guided-add-room-x" />
          </UiField>
          <UiField v-slot="{ id }" label="Spawn y" dense>
            <input :id v-model="addRoom.y" inputmode="numeric" data-testid="guided-add-room-y" />
          </UiField>
          <UiField v-slot="{ id }" label="Horizon" dense>
            <input
              :id
              v-model="addRoom.horizon"
              inputmode="numeric"
              placeholder="36"
              data-testid="guided-add-room-horizon"
            />
          </UiField>
        </div>
      </template>
      <UiDisclosure id="guided-add-room-advanced" label="Advanced" hint="Ids · bindings">
        <div class="guided__grid">
          <UiField v-slot="{ id }" label="LOGIC id" dense>
            <input
              :id
              v-model="addRoom.logicId"
              inputmode="numeric"
              placeholder="next free"
              data-testid="guided-add-room-logic-id"
            />
          </UiField>
          <UiField v-slot="{ id }" label="PIC id" dense>
            <input
              :id
              v-model="addRoom.pictureId"
              inputmode="numeric"
              placeholder="next free"
              data-testid="guided-add-room-picture-id"
            />
          </UiField>
          <UiField v-slot="{ id }" label="Room name" dense>
            <input
              :id
              v-model="addRoom.roomName"
              placeholder="grove_room"
              data-testid="guided-add-room-room-name"
            />
          </UiField>
          <UiField v-slot="{ id }" label="Picture name" dense>
            <input
              :id
              v-model="addRoom.pictureName"
              placeholder="grove_pic"
              data-testid="guided-add-room-picture-name"
            />
          </UiField>
        </div>
      </UiDisclosure>
      <div class="guided__actions">
        <UiButton
          type="submit"
          size="sm"
          :disabled="!formReady"
          :title="formReady ? undefined : formReason"
          data-testid="guided-prepare"
        >
          Preview the code
        </UiButton>
      </div>
    </form>

    <!-- Place hero --------------------------------------------------------- -->
    <form
      v-else-if="open === 'place-hero'"
      id="guided-form-place-hero"
      ref="formHost"
      class="guided__form"
      data-testid="guided-form-place-hero"
      @submit.prevent="submit('place-hero')"
    >
      <UiField v-slot="{ id }" label="Room" dense>
        <UiSelect :id v-model="placeHero.room" size="sm" block data-testid="guided-hero-room">
          <option v-for="option in rooms" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </UiSelect>
      </UiField>
      <UiField v-slot="{ id }" label="View" dense>
        <UiSelect :id v-model="placeHero.view" size="sm" block data-testid="guided-hero-view">
          <option value="">Keep the current view</option>
          <option v-for="option in views" :key="option.value" :value="String(option.value)">
            {{ option.label }}
          </option>
        </UiSelect>
      </UiField>
      <div class="guided__grid">
        <UiField v-slot="{ id }" label="x" dense>
          <input
            :id
            v-model="placeHero.x"
            inputmode="numeric"
            placeholder="80"
            data-testid="guided-hero-x"
          />
        </UiField>
        <UiField v-slot="{ id }" label="y" dense>
          <input
            :id
            v-model="placeHero.y"
            inputmode="numeric"
            placeholder="140"
            data-testid="guided-hero-y"
          />
        </UiField>
      </div>
      <canvas
        v-if="previewSurface"
        ref="heroCanvas"
        class="guided__canvas"
        tabindex="0"
        role="img"
        aria-label="The room's picture; click or use the arrow keys to place the hero."
        data-testid="guided-hero-canvas"
        @pointerdown="heroDown"
        @pointermove="heroMove"
        @keydown="heroKey"
      ></canvas>
      <div class="guided__actions">
        <UiButton
          type="submit"
          size="sm"
          :disabled="!formReady"
          :title="formReady ? undefined : formReason"
          data-testid="guided-prepare"
        >
          Preview the code
        </UiButton>
      </div>
    </form>

    <!-- Respond ------------------------------------------------------------ -->
    <form
      v-else-if="open === 'respond-to-command'"
      id="guided-form-respond-to-command"
      ref="formHost"
      class="guided__form"
      data-testid="guided-form-respond-to-command"
      @submit.prevent="submit('respond-to-command')"
    >
      <UiField v-slot="{ id }" label="Room" dense>
        <UiSelect :id v-model="respond.room" size="sm" block data-testid="guided-respond-room">
          <option v-for="option in rooms" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </UiSelect>
      </UiField>
      <UiField
        v-slot="{ id, describedBy }"
        label="The player types"
        hint="A short verb phrase; synonyms join the dictionary."
      >
        <input
          :id
          v-model="respond.command"
          :aria-describedby="describedBy"
          placeholder="sing"
          data-testid="guided-respond-command"
        />
      </UiField>
      <UiField v-slot="{ id }" label="The game answers">
        <textarea
          :id
          v-model="respond.response"
          rows="3"
          placeholder="The clearing hums back."
          data-testid="guided-respond-response"
        ></textarea>
      </UiField>
      <UiSwitch v-model="respond.replace" size="sm" data-testid="guided-respond-replace">
        <span
          >Replace the existing answer<small
            >Only when that command already prints a plain reply.</small
          ></span
        >
      </UiSwitch>
      <div class="guided__actions">
        <UiButton
          type="submit"
          size="sm"
          :disabled="!formReady"
          :title="formReady ? undefined : formReason"
          data-testid="guided-prepare"
        >
          Preview the code
        </UiButton>
      </div>
    </form>

    <!-- Connect door -------------------------------------------------------- -->
    <form
      v-else-if="open === 'connect-door'"
      id="guided-form-connect-door"
      ref="formHost"
      class="guided__form"
      data-testid="guided-form-connect-door"
      @submit.prevent="submit('connect-door')"
    >
      <div class="guided__grid">
        <UiField v-slot="{ id }" label="From" dense>
          <UiSelect :id v-model="door.from" size="sm" block data-testid="guided-door-from">
            <option v-for="option in rooms" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </UiSelect>
        </UiField>
        <UiField v-slot="{ id }" label="To" dense>
          <UiSelect :id v-model="door.to" size="sm" block data-testid="guided-door-to">
            <option value="">Pick a room…</option>
            <option
              v-for="option in rooms"
              :key="option.value"
              :value="String(option.value)"
              :disabled="option.value === door.from"
            >
              {{ option.label }}
            </option>
          </UiSelect>
        </UiField>
      </div>
      <canvas
        v-if="previewSurface"
        ref="doorCanvas"
        class="guided__canvas"
        tabindex="0"
        role="img"
        aria-label="The room's picture; drag to mark the doorway, or use the arrow keys."
        data-testid="guided-door-canvas"
        @pointerdown="doorDown"
        @pointermove="doorMove"
        @pointerup="doorUp"
        @keydown="doorKey"
      ></canvas>
      <div class="guided__grid guided__grid--four">
        <UiField v-slot="{ id }" label="Door x1" dense>
          <input :id v-model="door.x1" inputmode="numeric" data-testid="guided-door-x1" />
        </UiField>
        <UiField v-slot="{ id }" label="y1" dense>
          <input :id v-model="door.y1" inputmode="numeric" data-testid="guided-door-y1" />
        </UiField>
        <UiField v-slot="{ id }" label="x2" dense>
          <input :id v-model="door.x2" inputmode="numeric" data-testid="guided-door-x2" />
        </UiField>
        <UiField v-slot="{ id }" label="y2" dense>
          <input :id v-model="door.y2" inputmode="numeric" data-testid="guided-door-y2" />
        </UiField>
      </div>
      <UiSwitch v-model="door.twoWay" size="sm" data-testid="guided-door-return">
        <span>A doorway back<small>A matching exit in the other room.</small></span>
      </UiSwitch>
      <div v-if="door.twoWay" class="guided__grid guided__grid--four">
        <UiField v-slot="{ id }" label="Return x1" dense>
          <input :id v-model="door.retX1" inputmode="numeric" data-testid="guided-door-rx1" />
        </UiField>
        <UiField v-slot="{ id }" label="y1" dense>
          <input :id v-model="door.retY1" inputmode="numeric" data-testid="guided-door-ry1" />
        </UiField>
        <UiField v-slot="{ id }" label="x2" dense>
          <input :id v-model="door.retX2" inputmode="numeric" data-testid="guided-door-rx2" />
        </UiField>
        <UiField v-slot="{ id }" label="y2" dense>
          <input :id v-model="door.retY2" inputmode="numeric" data-testid="guided-door-ry2" />
        </UiField>
      </div>
      <UiDisclosure id="guided-door-advanced" label="Advanced" hint="Landing · names">
        <div class="guided__grid">
          <UiField v-slot="{ id }" label="Arrival x" dense>
            <input :id v-model="door.arrivalX" inputmode="numeric" data-testid="guided-door-ax" />
          </UiField>
          <UiField v-slot="{ id }" label="Arrival y" dense>
            <input :id v-model="door.arrivalY" inputmode="numeric" data-testid="guided-door-ay" />
          </UiField>
          <UiField v-slot="{ id }" label="Label" dense>
            <input
              :id
              v-model="door.label"
              placeholder="north edge"
              data-testid="guided-door-label"
            />
          </UiField>
          <UiField v-slot="{ id }" label="Rule id" dense>
            <input :id v-model="door.id" placeholder="door-2" data-testid="guided-door-id" />
          </UiField>
        </div>
      </UiDisclosure>
      <div class="guided__actions">
        <UiButton
          type="submit"
          size="sm"
          :disabled="!formReady"
          :title="formReady ? undefined : formReason"
          data-testid="guided-prepare"
        >
          Preview the code
        </UiButton>
      </div>
    </form>

    <!-- Play sound ---------------------------------------------------------- -->
    <form
      v-else-if="open === 'play-sound'"
      id="guided-form-play-sound"
      ref="formHost"
      class="guided__form"
      data-testid="guided-form-play-sound"
      @submit.prevent="submit('play-sound')"
    >
      <UiField v-slot="{ id }" label="Room" dense>
        <UiSelect :id v-model="cue.room" size="sm" block data-testid="guided-cue-room">
          <option v-for="option in rooms" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </UiSelect>
      </UiField>
      <UiField v-slot="{ id }" label="Sound" dense>
        <UiSelect :id v-model="cue.sound" size="sm" block data-testid="guided-cue-sound">
          <option value="">Pick a SOUND…</option>
          <option v-for="option in sounds" :key="option.value" :value="String(option.value)">
            {{ option.label }}
          </option>
        </UiSelect>
      </UiField>
      <UiField v-slot="{ id }" label="Starts when" dense>
        <UiSelect :id v-model="cue.on" size="sm" block data-testid="guided-cue-on">
          <option value="command">A command is answered</option>
          <option value="region" :disabled="cueRegions.length === 0">
            Ego enters a marked place
          </option>
        </UiSelect>
      </UiField>
      <UiField v-if="cue.on === 'command'" v-slot="{ id }" label="The command" dense>
        <input
          :id
          v-model="cue.command"
          list="guided-cue-commands"
          placeholder="look"
          data-testid="guided-cue-command"
        />
        <datalist id="guided-cue-commands">
          <option v-for="command in cueCommands" :key="command" :value="command" />
        </datalist>
      </UiField>
      <UiField v-else v-slot="{ id }" label="The place" dense>
        <UiSelect :id v-model="cue.rule" size="sm" block data-testid="guided-cue-rule">
          <option value="">Pick a marked place…</option>
          <option v-for="rule in cueRegions" :key="rule.id" :value="rule.id">
            {{ rule.label }}
          </option>
        </UiSelect>
      </UiField>
      <UiField
        v-slot="{ id, describedBy }"
        label="When it finishes"
        hint="Optional; printed once the cue completes."
      >
        <input
          :id
          v-model="cue.message"
          :aria-describedby="describedBy"
          placeholder="The last note fades."
          data-testid="guided-cue-message"
        />
      </UiField>
      <UiDisclosure id="guided-cue-advanced" label="Advanced" hint="Flag names">
        <div class="guided__grid">
          <UiField v-slot="{ id }" label="Completion flag" dense>
            <input :id v-model="cue.flag" placeholder="cue_done" data-testid="guided-cue-flag" />
          </UiField>
          <UiField v-slot="{ id }" label="Started guard" dense>
            <input
              :id
              v-model="cue.startFlag"
              placeholder="cue_started"
              data-testid="guided-cue-start-flag"
            />
          </UiField>
        </div>
      </UiDisclosure>
      <div class="guided__actions">
        <UiButton
          type="submit"
          size="sm"
          :disabled="!formReady"
          :title="formReady ? undefined : formReason"
          data-testid="guided-prepare"
        >
          Preview the code
        </UiButton>
      </div>
    </form>

    <!-- The detached preview, then the applied transaction ------------------- -->
    <div v-if="guided.pending.value" class="guided__review" data-testid="guided-preview">
      <p class="guided__review-label" data-testid="guided-preview-label">
        {{ guided.pending.value.label }}: ready to apply.
      </p>
      <p class="guided__keys" data-testid="guided-preview-keys">
        {{ guided.pending.value.affectedKeys.map(documentLabel).join(", ") }}
      </p>
      <p
        v-if="guided.pendingStale.value"
        class="guided__warn"
        role="alert"
        data-testid="guided-preview-stale"
      >
        The draft changed. Preview the code again before applying.
      </p>
      <div class="guided__actions">
        <UiButton size="sm" data-testid="guided-show-code" @click="codeOpen = true">
          Review code
        </UiButton>
        <UiButton
          size="sm"
          variant="primary"
          :disabled="guided.pendingStale.value"
          :title="
            guided.pendingStale.value
              ? 'The draft changed since this preview; prepare again'
              : undefined
          "
          data-testid="guided-apply"
          @click="applyPreview"
        >
          Apply
        </UiButton>
        <UiButton size="sm" variant="ghost" data-testid="guided-cancel" @click="cancelPreview">
          Cancel
        </UiButton>
      </div>
    </div>

    <div
      v-else-if="guided.applied.value"
      ref="appliedCard"
      class="guided__review"
      tabindex="-1"
      data-testid="guided-applied"
    >
      <p class="guided__review-label" data-testid="guided-applied-label">
        {{ guided.applied.value.transaction.label }}
        {{ guided.applied.value.undone ? "undone." : "applied to the draft. Keep saves it." }}
      </p>
      <div class="guided__actions">
        <UiButton
          v-for="entry in guided.applied.value.showCode"
          :key="entry.key"
          size="sm"
          variant="ghost"
          :data-testid="`guided-open-${entry.key}`"
          @click="showAppliedCode(entry.key)"
        >
          {{ documentLabel(entry.key) }}
        </UiButton>
        <UiButton
          v-if="!guided.applied.value.undone"
          size="sm"
          icon="undo"
          data-testid="guided-undo"
          @click="guided.undo()"
        >
          Undo
        </UiButton>
        <UiButton v-else size="sm" icon="redo" data-testid="guided-redo" @click="guided.redo()">
          Redo
        </UiButton>
        <UiButton size="sm" variant="ghost" data-testid="guided-dismiss" @click="dismissApplied">
          Done
        </UiButton>
      </div>
    </div>

    <p v-if="guided.refusal.value" class="guided__warn" role="alert" data-testid="guided-refusal">
      <code class="guided__code" data-testid="guided-refusal-code">{{
        guided.refusal.value.code
      }}</code>
      {{ guided.refusal.value.label }}: {{ guided.refusal.value.message }}
      <button
        v-if="guided.refusal.value.key"
        type="button"
        class="guided__link"
        data-testid="guided-refusal-go"
        @click="goToRefusal"
      >
        Go to the code
      </button>
    </p>
    <p v-if="guided.notice.value" class="guided__warn" role="alert" data-testid="guided-notice">
      {{ guided.notice.value }}
    </p>

    <UiDialog
      v-model:open="codeOpen"
      title="Proposed source"
      description="Review the changes Apply will make to your draft."
      size="lg"
      close-testid="guided-code-close"
      @closed="onCodeClosed"
    >
      <section
        v-for="entry in codeEntries"
        :key="entry.key"
        class="guided__code-doc"
        :data-testid="`guided-code-${entry.key}`"
      >
        <header class="guided__code-head">
          <h3>{{ documentLabel(entry.key) }}</h3>
          <UiButton
            v-if="canEdit(entry.key)"
            size="sm"
            variant="ghost"
            icon="pencil"
            :data-testid="`guided-edit-${entry.key}`"
            @click="editResource(entry.key)"
          >
            Edit visually
          </UiButton>
        </header>
        <p v-if="entry.binary" class="guided__code-note">Resource bytes</p>
        <div v-else class="guided__diff">
          <template v-for="(row, index) in entry.rows" :key="index">
            <div v-if="row.kind === 'gap'" class="guided__row guided__row--gap">
              ⋯ {{ row.count }} unchanged
            </div>
            <div v-else :class="`guided__row guided__row--${row.kind}`">
              <span class="guided__row-sign" aria-hidden="true">{{
                row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "
              }}</span>
              {{ row.text }}
            </div>
          </template>
        </div>
      </section>
      <template #footer>
        <UiButton
          size="sm"
          variant="ghost"
          data-testid="guided-code-back"
          @click="codeOpen = false"
        >
          Back
        </UiButton>
        <UiButton
          size="sm"
          variant="primary"
          :disabled="guided.pending.value === null || guided.pendingStale.value"
          :title="
            guided.pendingStale.value
              ? 'The draft changed since this preview; prepare again'
              : undefined
          "
          data-testid="guided-code-apply"
          @click="applyFromCode"
        >
          Apply
        </UiButton>
      </template>
    </UiDialog>
    <p class="guided__sr" aria-live="polite" data-testid="guided-live">{{ spoken }}</p>
  </section>
</template>

<style scoped>
.guided {
  display: grid;
  align-content: start;
  gap: var(--space-3);
  font: var(--text-xs) / var(--leading) var(--font-sans);
}
.guided__title {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--text-2xs);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}
.guided__note {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--text-2xs);
}
.guided__bar {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.guided__form {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-3);
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  background: var(--surface-2);
}
.guided__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-2);
}
.guided__grid--four {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}
.guided__canvas {
  width: 100%;
  aspect-ratio: 320 / 168;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  cursor: crosshair;
  image-rendering: pixelated;
  touch-action: none;
}
.guided__canvas:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}
.guided__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.guided__review {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--action-line);
  border-radius: var(--radius);
  background: var(--action-soft);
}
.guided__review:focus-visible {
  outline: 2px solid var(--focus);
}
.guided__review-label {
  margin: 0;
  color: var(--ink);
  font-size: var(--text-xs);
}
.guided__keys {
  margin: 0;
  color: var(--ink-3);
  font: var(--text-2xs) var(--font-mono);
}
.guided__warn {
  margin: 0;
  color: var(--warn);
  font-size: var(--text-xs);
}
.guided__code {
  margin-right: var(--space-1);
  padding: 0 var(--space-1);
  border: 1px solid var(--warn-line);
  border-radius: var(--radius-sm);
  font: var(--text-2xs) var(--font-mono);
}
.guided__link {
  margin-left: var(--space-2);
  padding: 0;
  border: 0;
  color: var(--action);
  background: transparent;
  font-size: var(--text-xs);
  text-decoration: underline;
  cursor: pointer;
}
.guided__link:focus-visible {
  outline: 2px solid var(--focus);
}
.guided__code-note {
  margin: 0 0 var(--space-3);
  color: var(--ink-3);
  font-size: var(--text-sm);
}
.guided__code-doc {
  margin: 0 0 var(--space-4);
}
.guided__code-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin-bottom: var(--space-1);
}
.guided__code-head h3 {
  margin: 0;
  font: var(--weight-semibold) var(--text-sm) var(--font-sans);
}
.guided__diff {
  max-height: 320px;
  padding: var(--space-2) var(--space-3);
  overflow: auto;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  color: var(--ink-2);
  background: var(--surface-sunken);
  font: var(--text-2xs) / 1.5 var(--font-mono);
}
.guided__row {
  white-space: pre-wrap;
  word-break: break-word;
}
.guided__row-sign {
  display: inline-block;
  width: 1.2ch;
  color: var(--ink-3);
}
.guided__row--add {
  color: var(--ok);
}
.guided__row--del {
  color: var(--danger);
}
.guided__row--gap {
  color: var(--ink-3);
  font-size: var(--text-2xs);
}
.guided__sr {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
@media (max-width: 480px) {
  .guided__grid--four {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
