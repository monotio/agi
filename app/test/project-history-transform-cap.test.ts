import { test } from "node:test";
import assert from "node:assert/strict";
import { installWebLocksFixture } from "./webLocksFixture.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { openProjectSession } from "../src/project/projectSession.ts";
import { compileProjectDocuments } from "../../src/authoring/projectDocuments.ts";
import { createContainer } from "../../src/container/container.ts";
import { writeProjectWorkspace } from "../../src/authoring/projectWorkspace.ts";
import {
  PROJECT_HISTORY_LIMITS,
  writeProjectHistory,
} from "../../src/authoring/projectHistoryCodec.ts";
import { projectContentHash, type ProjectContent } from "../../src/authoring/projectContent.ts";
import {
  projectCommitId,
  type ProjectHistoryState,
} from "../../src/authoring/projectHistoryData.ts";
import { sha256Hex } from "../../src/crypto.ts";
import { requireProjectId } from "../../src/gameIdentity.ts";

installWebLocksFixture();
installIndexedDbFixture();
const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  },
});
const frames = new Map<number, FrameRequestCallback>();
let frame = 0;
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: (callback: FrameRequestCallback) => {
    frames.set(++frame, callback);
    return frame;
  },
});
Object.defineProperty(globalThis, "cancelAnimationFrame", {
  configurable: true,
  value: (id: number) => frames.delete(id),
});

/**
 * A history sitting exactly at the blob cap whose every retained commit is
 * pinned: the next commit fits only while it adds no new blob.
 */
function cappedHistory(liveDocuments: Record<string, ProjectContent>): ProjectHistoryState {
  const blobs: Record<string, ProjectContent> = {};
  const commits: ProjectHistoryState["commits"][number][] = [];
  const liveKeys = Object.keys(liveDocuments).sort();
  // Enough valid document keys for one full manifest, the live ones included:
  // the four resource kinds at 0..255 each plus seven named documents.
  const keys = [
    ...["logic", "picture", "view", "sound"].flatMap((kind) =>
      Array.from({ length: 256 }, (_, n) => `${kind}:${n}`),
    ),
    ...["words", "inventory", "bindings", "world", "tests", "references", "music"],
  ].sort();
  const commitCount = Math.ceil(PROJECT_HISTORY_LIMITS.maxBlobs / keys.length);
  for (let i = 0; i < commitCount; i++) {
    const last = i === commitCount - 1;
    // The last commit also manifests the live documents, so their blobs are
    // already stored and an unchanged document adds no new blob.
    const fresh = Math.min(
      keys.length,
      PROJECT_HISTORY_LIMITS.maxBlobs - i * keys.length - (last ? liveKeys.length : 0),
    );
    const documents: Record<string, string> = {};
    let written = 0;
    for (const key of keys) {
      if (last && Object.hasOwn(liveDocuments, key)) {
        const hash = projectContentHash(liveDocuments[key]!, sha256Hex);
        blobs[hash] = liveDocuments[key]!;
        documents[key] = hash;
        continue;
      }
      if (written >= fresh) continue;
      const content = `edit ${i} of ${key}`;
      const hash = projectContentHash(content, sha256Hex);
      blobs[hash] = content;
      documents[key] = hash;
      written++;
    }
    const parent = commits.at(-1)?.id ?? null;
    const parentKeys = i === 0 ? [] : Object.keys(commits.at(-1)!.documents);
    const body = {
      documents,
      parent,
      changed: [...new Set([...Object.keys(documents), ...parentKeys])].sort(),
      label: "Edit",
      origin: "logic" as const,
      author: "creator" as const,
      time: i,
    };
    commits.push({ ...body, id: projectCommitId(body, sha256Hex) });
  }
  return {
    blobs,
    commits,
    cursor: commits.at(-1)!.id,
    future: [],
    tags: Object.fromEntries(commits.map((commit, i) => [`Pin ${i}`, commit.id])),
  };
}

test("a history-cap failure on a candidate transformed after preflight refuses before admission", async () => {
  // The player-visible rule: an edit that cannot enter History must not reach
  // the running game — the admission and the History commit are one
  // transaction, and preparation can still transform the candidate (here the
  // Launch pruning that follows a room's removal) after a preflight that
  // checked only the untransformed documents.
  const world = JSON.stringify({
    rooms: {},
    facts: {},
    quests: {},
    launches: { "2": { entries: [{ id: "cart", name: "At the cart" }] } },
  });
  const documents = {
    "logic:0": "return; // 0",
    "logic:1": "return; // 1",
    "logic:2": "return; // 2",
    world,
  };
  const compiled = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents,
    profileId: "2.936",
  });
  let admissions = 0;
  const session = openProjectSession({
    data: {
      projectId: requireProjectId("cap-transform-project"),
      title: "Pinned history",
      authoredAt: "",
      files: Object.fromEntries(compiled.files()),
      words: [],
      workspace: writeProjectWorkspace(documents),
      projectHistory: writeProjectHistory(cappedHistory(documents), sha256Hex),
    },
    lifetime: "initial",
    admission: {
      runToken: "cap-run",
      admit: async () => {
        admissions++;
        return { status: "committed" as const, expected: null, current: null, patchGeneration: 1 };
      },
    },
  });
  try {
    await session.drafts().ready;
    await assert.rejects(session.update([{ key: "logic:2", content: null }]), /retention limit/i);
    assert.equal(admissions, 0, "a candidate that cannot be recorded must not reach the worker");
  } finally {
    session.dispose();
  }
});
