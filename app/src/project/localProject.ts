import { createAuthoringState } from "../../../src/authoring/authoringState.ts";
import { compileProjectDocuments } from "../../../src/authoring/projectDocuments.ts";
import { writeProjectWorkspace } from "../../../src/authoring/projectWorkspace.ts";
import { createStarterProject, type StarterKind } from "../../../src/authoring/starterProject.ts";
import { requireProjectId, requireResourceRevision } from "../../../src/gameIdentity.ts";
import { commitProject, type ProjectCommitRequest } from "./gameStorage.ts";

/**
 * Prepare a local playable project without a worker or assistant. Preparation
 * owns the seed and validates its complete document image before any storage
 * write. Keep this handle if storage fails: data() remains an exportable copy,
 * and save() retries the same durable commit instead of creating another game.
 */
export function prepareLocalProject(input: { readonly title: string; readonly kind: StarterKind }) {
  const title = input.title.trim();
  if (!title || title.length > 160)
    throw new Error("Choose a project title between 1 and 160 characters.");
  const seed = createStarterProject(input.kind);
  const authoring = createAuthoringState();
  authoring.bindings = structuredClone(seed.bindings);
  const sources = {
    logics: [...seed.sources.logics],
    pictures: [...seed.sources.pictures],
    views: [...seed.sources.views],
    sounds: [...seed.sources.sounds],
  };
  const documents: Record<string, string> = {
    bindings: JSON.stringify(authoring.bindings),
    world: JSON.stringify(authoring.world),
    words: JSON.stringify([...seed.sources.words]),
    inventory: JSON.stringify(seed.sources.objects),
  };
  for (const [num, source] of sources.logics) documents[`logic:${num}`] = source;
  for (const [num, source] of sources.pictures) documents[`picture:${num}`] = source;
  for (const [num, view] of sources.views) documents[`view:${num}`] = JSON.stringify(view);
  for (const [num, tracks] of sources.sounds) documents[`sound:${num}`] = JSON.stringify(tracks);
  const compiled = compileProjectDocuments({
    files: Object.fromEntries(seed.files()),
    profileId: seed.profileId,
    documents,
  });
  if (compiled.build.identity.revision !== seed.seed.digest)
    throw new Error("The starter documents do not reproduce their playable resources.");
  const projectId = requireProjectId(`local-${crypto.randomUUID()}`);
  const request: ProjectCommitRequest = {
    projectId,
    commitId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    buildId: compiled.build.identity.buildId,
    expected: null,
    documents: Object.keys(documents)
      .sort()
      .map((key) => ({ key, version: 0 })),
    data: {
      title,
      templateId: seed.seed.templateId,
      roomGeneration: false,
      files: Object.fromEntries(compiled.files()),
      words: [...seed.sources.words],
      authoringState: { authoring, sources },
      workspace: writeProjectWorkspace(compiled.documents()),
      library: {
        version: 1,
        revision: requireResourceRevision(seed.seed.digest),
        source: "authored",
        profile: seed.profileId,
        validation: { status: "unverified", message: "Ready to check." },
      },
    },
  };
  return Object.freeze({
    projectId,
    workspaceId: request.workspaceId,
    data(): ProjectCommitRequest["data"] {
      return structuredClone(request.data);
    },
    async save() {
      return commitProject(request);
    },
  });
}
