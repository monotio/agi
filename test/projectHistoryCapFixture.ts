import { projectContentHash, type ProjectContent } from "../src/authoring/projectContent.ts";
import { projectCommitId, type ProjectHistoryState } from "../src/authoring/projectHistoryData.ts";
import { sha256Hex } from "../src/crypto.ts";

// Original synthetic documents with the same manifest size as a large imported game.
export function largeProjectHistory(count: number): ProjectHistoryState {
  const shared = projectContentHash("return;", sha256Hex);
  const picture = projectContentHash(Uint8Array.of(255), sha256Hex);
  const documents = Object.fromEntries(
    Array.from({ length: 315 }, (_, i) => [
      i < 256 ? `logic:${i}` : `picture:${i - 256}`,
      i < 256 ? shared : picture,
    ]),
  );
  const blobs: Record<string, ProjectContent> = {
    [shared]: "return;",
    [picture]: Uint8Array.of(255),
  };
  const commits: ProjectHistoryState["commits"][number][] = [];
  for (let i = 0; i < count; i++) {
    const content = `// Edit ${i}\nreturn;`;
    const hash = projectContentHash(content, sha256Hex);
    blobs[hash] = content;
    const body = {
      documents: { ...documents, "logic:0": hash },
      parent: commits.at(-1)?.id ?? null,
      changed: i === 0 ? Object.keys(documents).sort() : ["logic:0"],
      label: "Edit",
      origin: "logic" as const,
      author: "creator" as const,
      time: i,
    };
    commits.push({ ...body, id: projectCommitId(body, sha256Hex) });
  }
  return { blobs, commits, cursor: commits.at(-1)!.id, future: [], tags: {} };
}
