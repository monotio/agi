/**
 * The project frame's document model, shared by the explorer, the tab strip
 * and the overview. Everything here is a pure read over the workspace's
 * document list (logicWorkspace.ts `workspaceDocuments`): it never touches
 * the draft, the session or a surface, so a host can recompute it on any
 * change tick and compare results directly.
 *
 * Two workspace metadata documents may attach human names and room mapping:
 *
 * - `world` (`AuthoringState["world"]` JSON): a `rooms` entry keyed by LOGIC
 *   number names a room. A `logic:N` document is grouped under Rooms only
 *   when this record maps its number; the rest list under Shared, and a
 *   project without a readable world mapping keeps one flat Logic list.
 * - `bindings` (`readBindingsDocument` JSON): a stable authored name, shown
 *   beside the canonical resource label.
 *
 * Neither is required: absent or unreadable metadata changes presentation
 * only, never document identity. Tabs keep naming their key even after the
 * document leaves the set — `missing` marks that state deliberately.
 */
import { validateAuthoringState } from "../../../../src/authoring/authoringState.ts";
import { readBindingsDocument } from "../../../../src/authoring/projectDocuments.ts";
import {
  projectStudioDestination,
  type ProjectStudioDestination,
  type StudioOpenTarget,
} from "../../shell/projectStudioNav.ts";
import {
  documentLabel,
  type LogicDocumentContent,
  type LogicWorkspaceDocument,
} from "../logic/logicWorkspace.ts";

const RESOURCE_KEY = /^(logic|picture|view|sound):(0|[1-9]\d{0,2})$/;
const RESOURCE_SECTION = /^logic:|^picture:|^view:|^sound:/;

/** One document row: canonical label, optional human name, draft state. */
export interface ProjectDocumentItem {
  readonly key: string;
  /** Canonical identity, e.g. `LOGIC 3`, `WORDS.TOK`, `PIC 2`. */
  readonly label: string;
  /** Authored name from the world plan or bindings, when one exists. */
  readonly name?: string;
  readonly kind: "text" | "bytes";
  readonly dirty: boolean;
}

/** A labeled subdivision inside a section (Rooms / Shared under Logic). */
interface ProjectExplorerGroup {
  readonly label?: string;
  readonly entries: readonly ProjectDocumentItem[];
}

/** One explorer section; the six canonical resource families plus Project. */
export interface ProjectExplorerSection {
  readonly id: "logic" | "pictures" | "views" | "sounds" | "words" | "inventory" | "project";
  readonly label: string;
  readonly groups: readonly ProjectExplorerGroup[];
}

/** One open tab: identity, resolved name, draft and availability state. */
export interface ProjectStudioTab {
  readonly key: string;
  readonly label: string;
  readonly name?: string;
  readonly dirty: boolean;
  /** The key no longer names a document in the current set — a shown state. */
  readonly missing: boolean;
}

/**
 * The frame's navigation state: the selected place plus the open document
 * keys in open order. Tab order is insertion order and survives reselects;
 * closing a tab only changes this list — backing controllers belong to the
 * host, so their retention is invisible here.
 */
export interface ProjectStudioNavigation {
  readonly destination: ProjectStudioDestination;
  readonly tabs: readonly string[];
}

/** One resource-family count the overview reports. */
export interface ProjectStudioResourceStat {
  readonly id: ProjectExplorerSection["id"];
  readonly label: string;
  readonly count: number;
  /** A qualifying note, e.g. `3 rooms` under the Logic count. */
  readonly detail?: string;
}

/** A concrete first step the overview can offer, derived from real documents. */
export interface ProjectStudioStart {
  readonly key: string;
  /** The display name of the suggested first document. */
  readonly label: string;
}

/**
 * A project-level action the overview offers, supplied by the host. These
 * are project-wide entries only — Playtest, Keep, Undo and the common close
 * belong to the host's persistent frame bar beside the tab strip, reachable
 * from every editor, not to this landing place. The component renders and
 * reports the click; the host owns what the action does.
 * @public
 */
export interface ProjectStudioAction {
  readonly id: string;
  readonly label: string;
  /** A short line under the action saying what it does. */
  readonly hint?: string;
  /** Why the action is unavailable; its presence disables the button. */
  readonly unavailableReason?: string;
}

interface DocumentNames {
  readonly rooms: Readonly<Record<string, { readonly title: string }>> | undefined;
  readonly bound: Readonly<Record<string, string>> | undefined;
}

/**
 * The world document's room map, or undefined when the project has no
 * readable one. Only a document that validates against the authoring-state
 * schema demonstrates a room mapping; anything else leaves Logic flat.
 */
function worldRooms(
  content: LogicDocumentContent | undefined,
): Readonly<Record<string, { readonly title: string }>> | undefined {
  if (typeof content !== "string") return undefined;
  try {
    return validateAuthoringState({
      version: 1,
      bindings: {},
      world: JSON.parse(content),
    }).world.rooms;
  } catch {
    return undefined;
  }
}

/** Stable authored names per resource key (`picture:2` → `forest`), code-point first. */
function boundNames(
  content: LogicDocumentContent | undefined,
): Readonly<Record<string, string>> | undefined {
  if (typeof content !== "string") return undefined;
  try {
    const bindings = readBindingsDocument(content);
    const names: Record<string, string> = Object.create(null);
    for (const [name, binding] of Object.entries(bindings)) {
      if (binding.kind === "flag" || binding.kind === "variable") continue;
      const key = `${binding.kind}:${binding.num}`;
      const held = names[key];
      if (held === undefined || name < held) names[key] = name;
    }
    return names;
  } catch {
    return undefined;
  }
}

function documentNames(documents: readonly LogicWorkspaceDocument[]): DocumentNames {
  const world = documents.find((doc) => doc.key === "world")?.content;
  const bindings = documents.find((doc) => doc.key === "bindings")?.content;
  return { rooms: worldRooms(world), bound: boundNames(bindings) };
}

/** Resolve one document's display item: canonical label plus any authored name. */
function documentItem(doc: LogicWorkspaceDocument, names: DocumentNames): ProjectDocumentItem {
  const resource = RESOURCE_KEY.exec(doc.key);
  let name: string | undefined;
  const num = resource?.[2];
  if (resource !== null && num !== undefined) {
    const roomTitle = resource[1] === "logic" ? names.rooms?.[num]?.title : undefined;
    const bound = names.bound?.[resource[0]];
    name = roomTitle !== undefined && roomTitle !== "" ? roomTitle : bound;
  }
  return {
    key: doc.key,
    label: documentLabel(doc.key),
    ...(name !== undefined ? { name } : {}),
    kind: doc.kind,
    dirty: doc.dirty,
  };
}

function logicNumber(key: string): number {
  return Number(RESOURCE_KEY.exec(key)?.[2]);
}

/**
 * The explorer's sections. The six resource families always appear in
 * canonical order — an empty family keeps its heading so the destination
 * set does not change shape — and every other document (bindings, world,
 * tests, references, music, and any key this model does not know) lands in
 * Project, retained and reachable.
 *
 * Logic splits into Rooms and Shared only when the world document maps at
 * least one of the present logic documents to a room; a project without
 * that mapping keeps one unlabeled list rather than guessing membership.
 */
export function projectExplorerSections(
  documents: readonly LogicWorkspaceDocument[],
): readonly ProjectExplorerSection[] {
  const names = documentNames(documents);
  const items = documents.map((doc) => documentItem(doc, names));
  const byKind = (prefix: string) => items.filter((item) => item.key.startsWith(prefix));

  const logics = byKind("logic:");
  let logicGroups: ProjectExplorerGroup[];
  const rooms = names.rooms;
  if (rooms !== undefined) {
    const roomItems = logics
      .filter((item) => rooms[item.key.slice(6)] !== undefined)
      .sort((a, b) => logicNumber(a.key) - logicNumber(b.key));
    const shared = logics.filter((item) => rooms[item.key.slice(6)] === undefined);
    if (roomItems.length > 0) {
      logicGroups = [
        { label: "Rooms", entries: roomItems },
        ...(shared.length > 0 ? [{ label: "Shared", entries: shared }] : []),
      ];
    } else {
      logicGroups = [{ entries: logics }];
    }
  } else {
    logicGroups = [{ entries: logics }];
  }

  const flat = (entries: ProjectDocumentItem[]): readonly ProjectExplorerGroup[] => [{ entries }];
  const sections: ProjectExplorerSection[] = [
    { id: "logic", label: "Logic", groups: logicGroups },
    { id: "pictures", label: "Pictures", groups: flat(byKind("picture:")) },
    { id: "views", label: "Views", groups: flat(byKind("view:")) },
    { id: "sounds", label: "Sounds", groups: flat(byKind("sound:")) },
    { id: "words", label: "Words", groups: flat(items.filter((item) => item.key === "words")) },
    {
      id: "inventory",
      label: "Inventory",
      groups: flat(items.filter((item) => item.key === "inventory")),
    },
  ];
  const project = items.filter(
    (item) => !RESOURCE_SECTION.test(item.key) && item.key !== "words" && item.key !== "inventory",
  );
  if (project.length > 0) sections.push({ id: "project", label: "Project", groups: flat(project) });
  return sections;
}

/** The display item for one key, or undefined when no document carries it. */
export function projectDocumentEntry(
  documents: readonly LogicWorkspaceDocument[],
  key: string,
): ProjectDocumentItem | undefined {
  const doc = documents.find((entry) => entry.key === key);
  if (doc === undefined) return undefined;
  return documentItem(doc, documentNames(documents));
}

/**
 * The tab strip's rows: the supplied open keys, in order, resolved against
 * the current documents. A tab whose document left the set stays listed and
 * marked missing — the frame shows an explicit unavailable state instead of
 * redirecting the selection to another resource.
 */
export function projectStudioTabs(
  tabs: readonly string[],
  documents: readonly LogicWorkspaceDocument[],
): readonly ProjectStudioTab[] {
  const names = documentNames(documents);
  const byKey = new Map(documents.map((doc) => [doc.key, doc] as const));
  return tabs.map((key) => {
    const doc = byKey.get(key);
    if (doc === undefined) return { key, label: documentLabel(key), dirty: false, missing: true };
    const item = documentItem(doc, names);
    return {
      key: item.key,
      label: item.label,
      ...(item.name !== undefined ? { name: item.name } : {}),
      dirty: item.dirty,
      missing: false,
    };
  });
}

/**
 * The frame's starting state for one open request: an explicit document
 * target lands selected with its tab open; anything else starts on the
 * overview. No first-resource substitution happens here — an unavailable
 * key stays the destination so the frame can report it.
 */
export function createProjectStudioNavigation(target?: StudioOpenTarget): ProjectStudioNavigation {
  const destination = projectStudioDestination(target);
  return {
    destination,
    tabs: destination.kind === "document" ? [destination.key] : [],
  };
}

/** Move selection. A document selection also opens its tab. */
export function selectProjectStudioDestination(
  nav: ProjectStudioNavigation,
  destination: ProjectStudioDestination,
): ProjectStudioNavigation {
  if (destination.kind === "document") return openProjectStudioDocument(nav, destination.key);
  return { destination, tabs: nav.tabs };
}

/** Open a document: appended once, selected, existing order kept. */
export function openProjectStudioDocument(
  nav: ProjectStudioNavigation,
  key: string,
): ProjectStudioNavigation {
  return {
    destination: { kind: "document", key },
    tabs: nav.tabs.includes(key) ? nav.tabs : [...nav.tabs, key],
  };
}

/**
 * Close one tab. The removed key's selection moves to the tab that takes
 * its slot, else the overview — closing never selects a different document
 * it did not own, and a close on an unopened key is a no-op returning the
 * same state object.
 */
export function closeProjectStudioTab(
  nav: ProjectStudioNavigation,
  key: string,
): ProjectStudioNavigation {
  const index = nav.tabs.indexOf(key);
  if (index < 0) return nav;
  const tabs = nav.tabs.filter((open) => open !== key);
  if (nav.destination.kind !== "document" || nav.destination.key !== key)
    return { destination: nav.destination, tabs };
  const next = tabs[Math.min(index, tabs.length - 1)];
  return {
    destination: next === undefined ? { kind: "overview" } : { kind: "document", key: next },
    tabs,
  };
}

/** The overview's per-family resource counts, in the explorer's order. */
export function projectResourceSummary(
  documents: readonly LogicWorkspaceDocument[],
): readonly ProjectStudioResourceStat[] {
  return projectExplorerSections(documents)
    .filter((section) => section.id !== "project")
    .map((section) => {
      const count = section.groups.reduce((total, group) => total + group.entries.length, 0);
      const rooms = section.groups.find((group) => group.label === "Rooms");
      const detail =
        section.id === "logic" && rooms !== undefined
          ? `${rooms.entries.length} ${rooms.entries.length === 1 ? "room" : "rooms"}`
          : undefined;
      return {
        id: section.id,
        label: section.label,
        count,
        ...(detail !== undefined ? { detail } : {}),
      };
    });
}

/** True for a real LOGIC resource other than the per-cycle entry, logic 0. */
function isEditableLogic(key: string): boolean {
  const resource = RESOURCE_KEY.exec(key);
  return resource?.[1] === "logic" && resource[2] !== "0";
}

/**
 * One concrete first step for the overview: the first room's logic when the
 * world plan names rooms, else the first logic document past logic 0 — the
 * interpreter's per-cycle entry, real but rarely the place a first edit
 * belongs — else the first document in explorer order. Undefined only when
 * the project has no documents at all.
 */
export function projectStudioFirstStep(
  documents: readonly LogicWorkspaceDocument[],
): ProjectStudioStart | undefined {
  const sections = projectExplorerSections(documents);
  const rooms = sections
    .find((section) => section.id === "logic")
    ?.groups.find((group) => group.label === "Rooms")?.entries;
  const flat = sections.flatMap((section) => section.groups).flatMap((group) => group.entries);
  const first = rooms?.[0] ?? flat.find((item) => isEditableLogic(item.key)) ?? flat[0];
  if (first === undefined) return undefined;
  return { key: first.key, label: first.name ?? first.label };
}
