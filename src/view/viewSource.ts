/**
 * VIEW source: the text form in which an agent writes a whole view.
 *
 * A cel is drawn once as rows of hex digits; a later cel copies it and
 * replaces only the rows that differ; a loop lists its cels or mirrors an
 * earlier loop. Everything resolves to plain cels for buildView, which
 * applies the profile's own limits and encodes authentic AGI bytes. Nothing
 * is padded, truncated or masked: a row of the wrong width, a missing row or
 * an unknown reference is an error naming the line and the fix.
 */

import type { BuildLoopInput, BuildViewInput } from "./view.ts";

export const VIEW_SOURCE_DOC = `View source: one command per line, between \`view\` and \`endview\`.
- \`cel NAME WIDTH HEIGHT T\` then exactly HEIGHT rows of exactly WIDTH symbols, then \`endcel\`. Symbols \`0\`-\`F\` are EGA colours; \`.\` is the cel's transparent colour T (one hex digit). WIDTH 1-160, HEIGHT 1-168 logical pixels.
- \`cel NAME copy EARLIER\` copies an earlier cel (size and transparency included); \`row Y SYMBOLS\` lines replace whole rows (Y counts from 0), then \`endcel\`. Draw a frame once and copy it for the next.
- \`loop N NAME NAME...\` lists a loop's cels in order; loops are numbered from 0 without gaps, and a cel may appear more than once. \`loop N mirror M\` shows loop M flipped left to right.
- Optional \`description "TEXT"\` (a JSON string).
For a walking actor, loops are 0 right, 1 left, 2 front, 3 back; mirror left from right unless the design is asymmetric, and draw front and back.`;

const KEYWORDS: Record<string, true> = {
  view: true,
  endview: true,
  cel: true,
  endcel: true,
  copy: true,
  row: true,
  loop: true,
  mirror: true,
  description: true,
};

interface SourceCel {
  readonly width: number;
  readonly height: number;
  readonly transparentColor: number;
  readonly pixels: number[];
}

function fail(line: number, message: string): never {
  throw new Error(`line ${line}: ${message}`);
}

/** A canonical decimal integer within bounds. */
function uint(text: string | undefined, line: number, what: string, min: number, max: number) {
  if (text === undefined || !/^(?:0|[1-9]\d{0,5})$/.test(text))
    fail(line, `${what} must be a whole number from ${min} to ${max}.`);
  const value = Number(text);
  if (value < min || value > max) fail(line, `${what} ${value} is outside ${min}-${max}.`);
  return value;
}

function name(text: string | undefined, line: number): string {
  if (text === undefined || !/^[A-Za-z_]\w*$/.test(text) || Object.hasOwn(KEYWORDS, text))
    fail(line, `"${text ?? ""}" is not a cel name: use letters, digits and _, not a keyword.`);
  return text;
}

/** Row symbols to colours; `.` is the cel's transparent colour. */
function row(symbols: string, cel: string, y: number, width: number, t: number, line: number) {
  if (!/^[0-9A-Fa-f.]+$/.test(symbols))
    fail(line, `cel ${cel} row ${y} "${symbols}" may use only 0-9, A-F and "." (transparent).`);
  if (symbols.length !== width)
    fail(
      line,
      `cel ${cel} row ${y} has ${symbols.length} symbols; its width is ${width}. Send exactly ${width}.`,
    );
  return [...symbols].map((symbol) => (symbol === "." ? t : Number.parseInt(symbol, 16)));
}

/** Compile view source to buildView input; throws with the line and the fix. */
export function compileViewSource(source: string): BuildViewInput {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const cels = new Map<string, SourceCel>();
  const loops: BuildLoopInput[] = [];
  const mirrors = new Set<number>();
  let description: string | undefined;
  let index = 0;
  const next = (): { text: string; line: number } | null => {
    while (index < lines.length) {
      const text = lines[index]!.trim();
      index++;
      if (text) return { text, line: index };
    }
    return null;
  };

  const readDescription = (text: string, line: number) => {
    if (description !== undefined) fail(line, "a view has one description.");
    let value: unknown;
    try {
      value = JSON.parse(text.slice("description".length).trim());
    } catch {
      // Reported below with the expected form.
    }
    if (typeof value !== "string")
      fail(line, 'description must be a JSON string, as in description "A small boat".');
    description = value;
  };

  let first = next();
  // The description may also come before "view".
  if (first?.text.split(/\s+/)[0] === "description") {
    readDescription(first.text, first.line);
    first = next();
  }
  if (first?.text !== "view") fail(first?.line ?? 1, 'source must start with "view".');
  for (;;) {
    const current = next();
    if (!current) fail(lines.length, 'source must end with "endview".');
    const { text, line } = current;
    const words = text.split(/\s+/);
    const command = words[0];
    if (command === "endview") {
      const trailing = next();
      if (trailing) fail(trailing.line, 'nothing may follow "endview".');
      break;
    }
    if (command === "description") {
      readDescription(text, line);
      continue;
    }
    if (command === "cel") {
      const celName = name(words[1], line);
      if (cels.has(celName)) fail(line, `cel ${celName} is already defined.`);
      if (words[2] === "copy") {
        if (words.length !== 4) fail(line, "write cel NAME copy EARLIER.");
        const base = cels.get(words[3]!);
        if (!base)
          fail(line, `cel ${celName} copies ${words[3]}, which is not defined above this line.`);
        const pixels = base.pixels.slice();
        const edited = new Set<number>();
        for (;;) {
          const edit = next();
          if (!edit) fail(lines.length, `cel ${celName} is missing "endcel".`);
          if (edit.text === "endcel") break;
          const parts = edit.text.split(/\s+/);
          if (parts[0] !== "row" || parts.length !== 3)
            fail(edit.line, `inside a copied cel, write "row Y SYMBOLS" or "endcel".`);
          const y = uint(parts[1], edit.line, `cel ${celName} row`, 0, base.height - 1);
          if (edited.has(y)) fail(edit.line, `cel ${celName} replaces row ${y} twice.`);
          edited.add(y);
          const colours = row(parts[2]!, celName, y, base.width, base.transparentColor, edit.line);
          pixels.splice(y * base.width, base.width, ...colours);
        }
        cels.set(celName, { ...base, pixels });
        continue;
      }
      if (words.length !== 5)
        fail(line, "write cel NAME WIDTH HEIGHT T, or cel NAME copy EARLIER.");
      const width = uint(words[2], line, `cel ${celName} width`, 1, 160);
      const height = uint(words[3], line, `cel ${celName} height`, 1, 168);
      if (!/^[0-9A-Fa-f]$/.test(words[4]!))
        fail(line, `cel ${celName} transparent colour must be one hex digit 0-F.`);
      const transparentColor = Number.parseInt(words[4]!, 16);
      const pixels: number[] = [];
      for (let y = 0; y < height; y++) {
        const raster = next();
        if (!raster || raster.text === "endcel")
          fail(
            raster?.line ?? lines.length,
            `cel ${celName} has ${y} rows; its height is ${height}. Send exactly ${height}.`,
          );
        pixels.push(...row(raster.text, celName, y, width, transparentColor, raster.line));
      }
      const end = next();
      if (end?.text !== "endcel")
        fail(
          end?.line ?? lines.length,
          `cel ${celName} has more than ${height} rows, or is missing "endcel".`,
        );
      cels.set(celName, { width, height, transparentColor, pixels });
      continue;
    }
    if (command === "loop") {
      const number = uint(words[1], line, "loop number", 0, 254);
      if (number !== loops.length)
        fail(line, `loops are numbered from 0 without gaps: expected loop ${loops.length}.`);
      if (words[2] === "mirror") {
        if (words.length !== 4) fail(line, "write loop N mirror M.");
        const target = uint(words[3], line, "mirrored loop", 0, 254);
        if (target >= number) fail(line, `loop ${number} can mirror only an earlier loop.`);
        if (mirrors.has(target))
          fail(line, `loop ${target} is itself a mirror; mirror the loop it shows instead.`);
        mirrors.add(number);
        loops.push({ mirrorLoop: target });
        continue;
      }
      const names = words.slice(2);
      if (!names.length) fail(line, `loop ${number} lists no cels.`);
      loops.push({
        cels: names.map((celName) => {
          const cel = cels.get(celName);
          if (!cel) fail(line, `loop ${number} uses cel ${celName}, which is not defined above.`);
          return { ...cel, pixels: cel.pixels.slice(), mirror: false };
        }),
      });
      continue;
    }
    fail(line, `unknown command "${command}": use cel, loop, description or endview.`);
  }
  if (!loops.length) fail(lines.length, "a view needs at least one loop.");
  return { loops, ...(description === undefined ? {} : { description }) };
}
