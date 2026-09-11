/**
 * Adventure template parser and vocabulary builder for AGI game templates (SKILL.md).
 *
 * Framework-free TypeScript, zero dependencies. Parses YAML frontmatter and
 * structured markdown sections (premise, tone, art direction, protagonist,
 * starting room, lexicon, point table, beats, NPC seeds, deaths) into typed
 * objects for the authoring agent and engine bootstrap.
 */

import type { WordEntry } from "../logic/words.ts";

export interface TemplatePoint {
  readonly points: number;
  readonly beat: string;
}

export interface TemplateNpc {
  readonly name: string;
  readonly description: string;
}

export interface SynonymGroup {
  readonly id: number;
  readonly words: readonly string[];
}

export interface TemplateLexicon {
  readonly verbs: readonly string[];
  readonly nouns: readonly string[];
  readonly allWords: readonly string[];
  readonly synonymGroups: readonly SynonymGroup[];
}

export interface AdventureTemplate {
  readonly id: string;
  readonly description: string;
  readonly title: string;
  readonly premise: string;
  readonly tone: string;
  readonly artDirection: string;
  readonly protagonist: string;
  readonly startingRoom: string;
  readonly lexicon: TemplateLexicon;
  readonly maxPoints: number;
  readonly pointTable: readonly TemplatePoint[];
  readonly beats: readonly string[];
  readonly npcSeeds: readonly TemplateNpc[];
  readonly deaths: readonly string[];
  readonly rawMarkdown: string;
}

const STANDARD_NAV_WORDS: readonly (readonly string[])[] = [
  ["look"],
  ["east", "e"],
  ["west", "w"],
  ["north", "n"],
  ["south", "s"],
  ["up", "u"],
  ["down", "d"],
];

function sanitizeWord(w: string): string {
  return w.replace(/[^a-z0-9']/gi, "").toLowerCase();
}

function parseLexicon(content: string): TemplateLexicon {
  const verbs: string[] = [];
  const nouns: string[] = [];
  const synonymGroups: SynonymGroup[] = [];
  let nextGroupId = 100;

  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const verbMatch = line.match(/^-\s*Verbs:\s*(.+)$/i);
    if (verbMatch && verbMatch[1]) {
      const tokens = verbMatch[1]
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      for (const token of tokens) {
        const words = token
          .split("/")
          .map(sanitizeWord)
          .filter((w) => w.length > 0);
        for (const w of words) verbs.push(w);
        if (words.length > 0) {
          synonymGroups.push({ id: nextGroupId++, words });
        }
      }
    }
    const nounMatch = line.match(/^-\s*Nouns:\s*(.+)$/i);
    if (nounMatch && nounMatch[1]) {
      const tokens = nounMatch[1]
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      for (const token of tokens) {
        const words = token
          .split("/")
          .map(sanitizeWord)
          .filter((w) => w.length > 0);
        for (const w of words) nouns.push(w);
        if (words.length > 0) {
          synonymGroups.push({ id: nextGroupId++, words });
        }
      }
    }
  }

  const allWords = Array.from(new Set([...verbs, ...nouns])).sort();
  return { verbs, nouns, allWords, synonymGroups };
}

function parsePointTable(content: string): TemplatePoint[] {
  const points: TemplatePoint[] = [];
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\|\s*(\d+)\s*\|\s*(.+?)\s*\|$/);
    if (m && m[1] && m[2]) {
      const pt = parseInt(m[1], 10);
      const beat = m[2].trim();
      points.push({ points: pt, beat });
    }
  }
  return points;
}

function parseBeats(content: string): string[] {
  const beats: string[] = [];
  const lines = content.split(/\r?\n/);
  let currentBeat = "";
  for (const line of lines) {
    const m = line.match(/^\s*\d+\.\s+(.+)$/);
    if (m && m[1]) {
      if (currentBeat.length > 0) beats.push(currentBeat);
      currentBeat = m[1].trim();
    } else if (currentBeat.length > 0 && line.trim().length > 0) {
      currentBeat += " " + line.trim();
    }
  }
  if (currentBeat.length > 0) beats.push(currentBeat);
  return beats;
}

function parseNpcSeeds(content: string): TemplateNpc[] {
  const npcs: TemplateNpc[] = [];
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*-\s+\*\*(.+?)\*\*\s*[—–-]\s*(.+)$/);
    if (m && m[1] && m[2]) {
      npcs.push({ name: m[1].trim(), description: m[2].trim() });
    }
  }
  return npcs;
}

function parseDeaths(content: string): string[] {
  const deaths: string[] = [];
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*-\s+(.+)$/);
    if (m && m[1]) {
      deaths.push(m[1].trim());
    }
  }
  return deaths;
}

/**
 * Parse an adventure template markdown string (SKILL.md) into a typed AdventureTemplate.
 */
export function parseAdventureTemplate(markdown: string): AdventureTemplate {
  const fmMatch = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!fmMatch || !fmMatch[1]) {
    throw new Error("template must begin with YAML frontmatter (---\\n...\\n---)");
  }
  const fm = fmMatch[1];
  const nameMatch = fm.match(/^name:\s*(.+)$/m);
  const descMatch = fm.match(/^description:\s*(.+)$/m);
  if (!nameMatch || !nameMatch[1]) {
    throw new Error("template frontmatter missing 'name'");
  }
  const id = nameMatch[1].trim();
  const description = descMatch && descMatch[1] ? descMatch[1].trim() : "";

  const body = markdown.slice(fmMatch[0].length);

  const titleMatch = body.match(/^#\s+(.+)$/m);
  if (!titleMatch || !titleMatch[1]) {
    throw new Error("template missing H1 '# Title'");
  }
  const title = titleMatch[1].trim();

  const sections = new Map<string, string>();
  const lines = body.split(/\r?\n/);
  let currentHeading = "";
  let currentLines: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+)$/);
    if (headingMatch && headingMatch[1]) {
      if (currentHeading.length > 0) {
        const key = currentHeading
          .toLowerCase()
          .replace(/\s*\(.*?\)/, "")
          .trim();
        sections.set(key, currentLines.join("\n").trim());
        if (key === "point table") {
          sections.set("__point_table_heading__", currentHeading);
        }
      }
      currentHeading = headingMatch[1].trim();
      currentLines = [];
    } else if (currentHeading.length > 0) {
      currentLines.push(line);
    }
  }
  if (currentHeading.length > 0) {
    const key = currentHeading
      .toLowerCase()
      .replace(/\s*\(.*?\)/, "")
      .trim();
    sections.set(key, currentLines.join("\n").trim());
    if (key === "point table") {
      sections.set("__point_table_heading__", currentHeading);
    }
  }

  const premise = sections.get("premise") ?? "";
  const tone = sections.get("tone") ?? "";
  const artDirection = sections.get("art direction") ?? "";
  const protagonist = sections.get("protagonist") ?? "";
  const startingRoom = sections.get("starting room") ?? "";

  const lexiconContent = sections.get("lexicon") ?? "";
  const lexicon = parseLexicon(lexiconContent);

  const ptHeading = sections.get("__point_table_heading__") ?? "";
  const maxPtsMatch = ptHeading.match(/max\s+(\d+)/i);
  const pointTableContent = sections.get("point table") ?? "";
  const pointTable = parsePointTable(pointTableContent);
  const maxPoints =
    maxPtsMatch && maxPtsMatch[1]
      ? parseInt(maxPtsMatch[1], 10)
      : pointTable.reduce((acc, p) => (p.points > 0 ? acc + p.points : acc), 0);

  const beatsContent = sections.get("beats") ?? "";
  const beats = parseBeats(beatsContent);

  const npcContent = sections.get("npc seeds") ?? "";
  const npcSeeds = parseNpcSeeds(npcContent);

  const deathsContent = sections.get("deaths") ?? "";
  const deaths = parseDeaths(deathsContent);

  return {
    id,
    description,
    title,
    premise,
    tone,
    artDirection,
    protagonist,
    startingRoom,
    lexicon,
    maxPoints,
    pointTable,
    beats,
    npcSeeds,
    deaths,
    rawMarkdown: markdown,
  };
}

/**
 * Build WordEntry items from a template for WORDS.TOK dictionary compilation.
 */
export function buildTemplateWordEntries(template: AdventureTemplate, baseId = 100): WordEntry[] {
  const wordToId = new Map<string, number>();
  let nextId = baseId;

  for (const group of template.lexicon.synonymGroups) {
    const id = nextId++;
    for (const word of group.words) {
      if (!wordToId.has(word)) {
        wordToId.set(word, id);
      }
    }
  }

  for (const group of STANDARD_NAV_WORDS) {
    let existingId: number | undefined;
    for (const w of group) {
      if (wordToId.has(w)) {
        existingId = wordToId.get(w);
        break;
      }
    }
    const id = existingId ?? nextId++;
    for (const w of group) {
      if (!wordToId.has(w)) {
        wordToId.set(w, id);
      }
    }
  }

  const entries: WordEntry[] = [];
  for (const [word, id] of wordToId) {
    entries.push({ word, id });
  }
  return entries;
}
