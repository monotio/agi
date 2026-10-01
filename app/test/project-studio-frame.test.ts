import assert from "node:assert/strict";
import { test } from "node:test";
import {
  projectStudioDestination,
  projectStudioDestinationKey,
  sameProjectStudioDestination,
} from "../src/shell/projectStudioNav.ts";
import { openEditableProject, type EditableProject } from "../src/project/editableProject.ts";
import { prepareLocalProject } from "../src/project/localProject.ts";
import {
  closeProjectStudioTab,
  createProjectStudioNavigation,
  openProjectStudioDocument,
  projectDocumentEntry,
  projectExplorerSections,
  projectResourceSummary,
  projectStudioFirstStep,
  projectStudioTabs,
  selectProjectStudioDestination,
  type ProjectExplorerSection,
} from "../src/studio/host/projectStudioDocuments.ts";
import {
  workspaceDocuments,
  type LogicDocumentContent,
  type LogicWorkspaceDocument,
} from "../src/studio/logic/logicWorkspace.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";

installIndexedDbFixture();
const cache = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => cache.get(key) ?? null,
    setItem: (key: string, value: string) => {
      cache.set(key, value);
    },
    removeItem: (key: string) => cache.delete(key),
  },
});

/**
 * The unified frame's navigation and document model: destinations name the
 * overview or one document key, tab lists keep their identity and order, and
 * explorer sections come from the real workspace documents — rooms only when
 * the world document actually maps them, never by guessing.
 */

async function starterDocuments(kind: "starter" | "blank" = "starter"): Promise<{
  project: EditableProject;
  documents: readonly LogicWorkspaceDocument[];
}> {
  const prepared = prepareLocalProject({ title: "Frame model fixture", kind });
  await prepared.save();
  const project = await openEditableProject(prepared.projectId);
  assert.ok(project);
  return {
    project,
    documents: workspaceDocuments(project.inspection.documents, project.draft.dirtyKeys()),
  };
}

function docs(
  record: Readonly<Record<string, LogicDocumentContent>>,
  dirty: readonly string[] = [],
): readonly LogicWorkspaceDocument[] {
  return workspaceDocuments(record, dirty);
}

function section(
  sections: readonly ProjectExplorerSection[],
  id: ProjectExplorerSection["id"],
): ProjectExplorerSection {
  const found = sections.find((entry) => entry.id === id);
  assert.ok(found, `section ${id} exists`);
  return found;
}

function groupEntries(section: ProjectExplorerSection, label?: string) {
  const group = section.groups.find((entry) => entry.label === label);
  assert.ok(group, `group ${label ?? "(flat)"} exists`);
  return group.entries;
}

// ---------- destinations (shell/projectStudioNav.ts) ----------

test("a bare request resolves to the overview; a document target keeps its key", () => {
  assert.deepEqual(projectStudioDestination(), { kind: "overview" });
  assert.deepEqual(projectStudioDestination({}), { kind: "overview" });
  assert.deepEqual(projectStudioDestination({ document: "picture:2" }), {
    kind: "document",
    key: "picture:2",
  });
  assert.equal(projectStudioDestinationKey({ kind: "overview" }), null);
  assert.equal(projectStudioDestinationKey({ kind: "document", key: "view:1" }), "view:1");
  assert.ok(
    sameProjectStudioDestination(
      { kind: "document", key: "view:1" },
      {
        kind: "document",
        key: "view:1",
      },
    ),
  );
  assert.ok(
    !sameProjectStudioDestination({ kind: "document", key: "view:1" }, { kind: "overview" }),
  );
  assert.ok(
    !sameProjectStudioDestination(
      { kind: "document", key: "view:1" },
      {
        kind: "document",
        key: "view:2",
      },
    ),
  );
});

// ---------- navigation model ----------

test("an open request on a document starts the frame there with one tab", () => {
  const nav = createProjectStudioNavigation({ document: "logic:1" });
  assert.deepEqual(nav.destination, { kind: "document", key: "logic:1" });
  assert.deepEqual(nav.tabs, ["logic:1"]);
});

test("opening documents preserves tab identity and order across reselects", () => {
  let nav = createProjectStudioNavigation();
  nav = openProjectStudioDocument(nav, "logic:1");
  nav = openProjectStudioDocument(nav, "picture:1");
  nav = selectProjectStudioDestination(nav, { kind: "overview" });
  assert.deepEqual(nav.tabs, ["logic:1", "picture:1"], "overview keeps the tab list");
  nav = selectProjectStudioDestination(nav, { kind: "document", key: "sound:2" });
  assert.deepEqual(nav.tabs, ["logic:1", "picture:1", "sound:2"]);
  nav = openProjectStudioDocument(nav, "logic:1");
  assert.deepEqual(nav.tabs, ["logic:1", "picture:1", "sound:2"], "reopen moves nothing");
  assert.deepEqual(nav.destination, { kind: "document", key: "logic:1" });
});

test("closing the selected tab moves selection to the tab that took its slot", () => {
  let nav = createProjectStudioNavigation();
  for (const key of ["logic:0", "view:1", "sound:1"]) nav = openProjectStudioDocument(nav, key);
  nav = selectProjectStudioDestination(nav, { kind: "document", key: "view:1" });
  nav = closeProjectStudioTab(nav, "view:1");
  assert.deepEqual(nav.tabs, ["logic:0", "sound:1"]);
  assert.deepEqual(nav.destination, { kind: "document", key: "sound:1" });
  nav = closeProjectStudioTab(nav, "sound:1");
  assert.deepEqual(nav.destination, { kind: "document", key: "logic:0" });
  nav = closeProjectStudioTab(nav, "logic:0");
  assert.deepEqual(nav.destination, { kind: "overview" });
  assert.deepEqual(nav.tabs, []);
});

test("closing a background tab keeps the selection; an unopened key is a no-op", () => {
  let nav = createProjectStudioNavigation({ document: "logic:1" });
  nav = openProjectStudioDocument(nav, "picture:2");
  const before = nav;
  nav = closeProjectStudioTab(nav, "logic:1");
  assert.deepEqual(nav.destination, { kind: "document", key: "picture:2" });
  assert.deepEqual(nav.tabs, ["picture:2"]);
  assert.equal(closeProjectStudioTab(nav, "words"), nav);
  assert.equal(before.tabs.length, 2, "the earlier state object is not mutated");
});

// ---------- explorer model ----------

test("a real starter project lists the six canonical sections in order", async () => {
  const { documents } = await starterDocuments();
  const sections = projectExplorerSections(documents);
  assert.deepEqual(
    sections.map((entry) => entry.label),
    ["Logic", "Pictures", "Views", "Sounds", "Words", "Inventory", "Project"],
  );
  assert.deepEqual(
    groupEntries(section(sections, "logic")).map((item) => item.key),
    ["logic:0", "logic:1", "logic:255"],
  );
  assert.deepEqual(
    groupEntries(section(sections, "pictures")).map((item) => item.key),
    ["picture:1"],
  );
  assert.deepEqual(
    groupEntries(section(sections, "views")).map((item) => item.key),
    ["view:1"],
  );
  assert.equal(groupEntries(section(sections, "sounds")).length, 2);
  assert.deepEqual(
    groupEntries(section(sections, "words")).map((item) => item.key),
    ["words"],
  );
  assert.deepEqual(
    groupEntries(section(sections, "inventory")).map((item) => item.key),
    ["inventory"],
  );
  const project = groupEntries(section(sections, "project")).map((item) => item.key);
  assert.ok(project.includes("bindings") && project.includes("world"));
});

test("a starter project's empty room plan keeps one flat Logic list", async () => {
  const { documents } = await starterDocuments();
  const logic = section(projectExplorerSections(documents), "logic");
  assert.equal(logic.groups.length, 1);
  assert.equal(logic.groups[0]!.label, undefined, "no Rooms/Shared claim without a mapping");
});

test("the world document's room map splits Logic into Rooms and Shared", () => {
  const documents = docs({
    "logic:0": "// boot",
    "logic:1": "// hall",
    "logic:2": "// cellar",
    world: JSON.stringify({
      rooms: {
        "2": { title: "Cellar", description: "", exits: {} },
        "1": { title: "Hall", description: "", exits: {} },
      },
      facts: {},
      quests: {},
    }),
  });
  const logic = section(projectExplorerSections(documents), "logic");
  const rooms = groupEntries(logic, "Rooms");
  assert.deepEqual(
    rooms.map((item) => item.key),
    ["logic:1", "logic:2"],
    "rooms order by number",
  );
  assert.equal(rooms[0]!.name, "Hall");
  assert.equal(rooms[0]!.label, "LOGIC 1", "canonical identity stays beside the room name");
  assert.deepEqual(
    groupEntries(logic, "Shared").map((item) => item.key),
    ["logic:0"],
  );
});

test("an unreadable world document leaves Logic flat rather than guessing", () => {
  for (const world of [
    "not json",
    JSON.stringify({ rooms: [] }),
    JSON.stringify({ rooms: { "1": { title: 7 } } }),
  ]) {
    const documents = docs({ "logic:1": "// a", world });
    const logic = section(projectExplorerSections(documents), "logic");
    assert.equal(logic.groups.length, 1, `world ${world}`);
    assert.equal(logic.groups[0]!.label, undefined);
  }
  const byteWorld = docs({ "logic:1": "// a", world: new Uint8Array([1, 2]) });
  assert.equal(section(projectExplorerSections(byteWorld), "logic").groups[0]!.label, undefined);
});

test("a world mapping for absent logic does not fabricate a Rooms group", () => {
  const documents = docs({
    "logic:0": "// boot",
    world: JSON.stringify({
      rooms: { "9": { title: "Nowhere", description: "", exits: {} } },
      facts: {},
      quests: {},
    }),
  });
  const logic = section(projectExplorerSections(documents), "logic");
  assert.equal(logic.groups.length, 1);
  assert.equal(logic.groups[0]!.label, undefined);
});

test("bindings give resources their authored names beside the canonical label", async () => {
  const { documents } = await starterDocuments();
  const sections = projectExplorerSections(documents);
  const picture = groupEntries(section(sections, "pictures"))[0]!;
  assert.equal(picture.label, "PIC 1");
  assert.equal(picture.name, "clearing_pic");
  const view = groupEntries(section(sections, "views"))[0]!;
  assert.equal(view.name, "ego_view");
});

test("dirty marks come only from the supplied draft state", async () => {
  const { project, documents } = await starterDocuments();
  const clean = projectExplorerSections(documents);
  assert.ok(groupEntries(section(clean, "pictures")).every((item) => !item.dirty));
  const snapshot = project.draft.capture();
  project.draft.edit("picture:1", "# edited\nend\n", snapshot.version("picture:1"));
  const edited = projectExplorerSections(
    workspaceDocuments(project.inspection.documents, project.draft.dirtyKeys()),
  );
  assert.equal(groupEntries(section(edited, "pictures"))[0]!.dirty, true);
  assert.equal(groupEntries(section(edited, "views"))[0]!.dirty, false);
});

// ---------- tabs and availability ----------

test("a tab for a deleted or absent key stays listed and marked missing", async () => {
  const { documents } = await starterDocuments();
  const tabs = projectStudioTabs(["view:1", "picture:9"], documents);
  assert.equal(tabs.length, 2);
  assert.equal(tabs[0]!.key, "view:1");
  assert.equal(tabs[0]!.missing, false);
  assert.equal(tabs[1]!.key, "picture:9");
  assert.equal(tabs[1]!.missing, true);
  assert.equal(tabs[1]!.dirty, false);
  assert.equal(projectDocumentEntry(documents, "picture:9"), undefined);
  const found = projectDocumentEntry(documents, "view:1");
  assert.equal(found?.label, "VIEW 1");
});

test("a request for a missing document stays the destination, marked and not redirected", () => {
  const nav = createProjectStudioNavigation({ document: "sound:9" });
  assert.deepEqual(nav.destination, { kind: "document", key: "sound:9" });
  const documents = docs({ "sound:1": "[]", "logic:0": "// boot" });
  const tabs = projectStudioTabs(nav.tabs, documents);
  assert.deepEqual(
    tabs.map((tab) => [tab.key, tab.missing]),
    [["sound:9", true]],
    "the explicit target is the tab; no first resource is substituted",
  );
  assert.deepEqual(
    projectExplorerSections(documents)
      .flatMap((entry) => entry.groups)
      .flatMap((group) => group.entries)
      .map((item) => item.key),
    ["logic:0", "sound:1"],
    "and the explorer lists only real documents",
  );
});

test("closing a tab removes only that key; draft state is a prop the model never touches", async () => {
  const { project } = await starterDocuments();
  const snapshot = project.draft.capture();
  project.draft.edit("view:1", "{}", snapshot.version("view:1"));
  let nav = createProjectStudioNavigation();
  nav = openProjectStudioDocument(nav, "view:1");
  nav = openProjectStudioDocument(nav, "logic:0");
  nav = closeProjectStudioTab(nav, "view:1");
  assert.deepEqual(nav.tabs, ["logic:0"]);
  assert.deepEqual(nav.destination, { kind: "document", key: "logic:0" });
  assert.ok(
    project.draft.dirtyKeys().includes("view:1"),
    "closing a dirty tab leaves the draft untouched",
  );
  const remaining = projectStudioTabs(
    nav.tabs,
    workspaceDocuments(project.inspection.documents, project.draft.dirtyKeys()),
  );
  assert.equal(remaining[0]!.dirty, false);
});

// ---------- overview model ----------

test("the overview summary counts the real families", async () => {
  const { documents } = await starterDocuments();
  const stats = projectResourceSummary(documents);
  assert.deepEqual(
    stats.map((stat) => stat.id),
    ["logic", "pictures", "views", "sounds", "words", "inventory"],
  );
  const count = (id: string) => stats.find((stat) => stat.id === id)!.count;
  assert.equal(count("logic"), 3);
  assert.equal(count("pictures"), 1);
  assert.equal(count("views"), 1);
  assert.equal(count("sounds"), 2);
  assert.equal(count("words"), 1);
  assert.equal(count("inventory"), 1);
});

test("the first step prefers a named room and falls back to the first document", () => {
  const documents = docs({
    "logic:0": "// boot",
    "logic:3": "// tower",
    "picture:1": "# p\nend\n",
    world: JSON.stringify({
      rooms: { "3": { title: "Tower", description: "", exits: {} } },
      facts: {},
      quests: {},
    }),
  });
  assert.deepEqual(projectStudioFirstStep(documents), { key: "logic:3", label: "Tower" });
  const plain = docs({ "picture:2": "# p\nend\n" });
  assert.deepEqual(projectStudioFirstStep(plain), { key: "picture:2", label: "PIC 2" });
  assert.equal(projectStudioFirstStep([]), undefined);
});

test("a real starter or blank project lands on the first room's logic", async () => {
  for (const kind of ["starter", "blank"] as const) {
    const { documents } = await starterDocuments(kind);
    assert.deepEqual(
      projectStudioFirstStep(documents),
      { key: "logic:1", label: "first_room" },
      `${kind}: the first step is the editable room, not the per-cycle entry`,
    );
  }
});

test("the fallback prefers the first logic past logic 0, then the first document", () => {
  const documents = docs({
    "logic:0": "// boot",
    "logic:2": "// tower",
    "picture:1": "# p\nend\n",
  });
  assert.deepEqual(projectStudioFirstStep(documents), { key: "logic:2", label: "LOGIC 2" });
  const bootOnly = docs({ "logic:0": "// boot", "picture:1": "# p\nend\n" });
  assert.deepEqual(projectStudioFirstStep(bootOnly), { key: "logic:0", label: "LOGIC 0" });
});
