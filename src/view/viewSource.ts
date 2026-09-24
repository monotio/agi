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

import type { BuildCelInput, BuildLoopInput, BuildViewInput } from "./view.ts";

export const VIEW_SOURCE_DOC = `View source: one command per line, between \`view\` and \`endview\`.
- \`cel NAME WIDTH HEIGHT T\` then exactly HEIGHT rows of exactly WIDTH symbols, then \`endcel\`. Symbols \`0\`-\`F\` are EGA colours; \`.\` is the cel's transparent colour T (one hex digit). WIDTH 1-160, HEIGHT 1-168 logical pixels.
- \`cel NAME copy EARLIER\` copies an earlier cel (size and transparency included); \`row Y SYMBOLS\` lines replace whole rows (Y counts from 0), then \`endcel\`. Draw a frame once and copy it for the next.
- \`loop N NAME NAME...\` lists a loop's cels in order; loops are numbered from 0 without gaps, and a cel may appear more than once. \`loop N mirror M\` shows loop M flipped left to right.
- Optional \`description "TEXT"\` (a JSON string).
For a walking actor, loops are 0 right, 1 left, 2 front, 3 back: draw right as a profile facing right and mirror left from it unless the design is asymmetric; draw front and back as their own cels; give each walk frame changed leg rows.
Example, a flag waving in two frames that also faces left:
view
cel flag0 4 3 0
CC..
CCCC
.44.
endcel
cel flag1 copy flag0
row 0 .CC.
endcel
loop 0 flag0 flag1
loop 1 mirror 0
endview`;

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
  // "view" may carry a name, which has no meaning in the resource.
  if (!first || !/^view(?:\s+\S+)?$/.test(first.text))
    fail(first?.line ?? 1, 'source must start with "view".');
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
          if (parts[0] === "row" && parts.length > 3) {
            const symbols = parts.slice(2).join(" ");
            fail(
              edit.line,
              `cel ${celName} row ${parts[1]} "${symbols}" has a space; send its ${base.width} symbols as one run.`,
            );
          }
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
      if (words.length === 3 && cels.has(words[2]!))
        fail(line, `to copy ${words[2]}, write "cel ${celName} copy ${words[2]}".`);
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
        if (!raster)
          fail(
            lines.length,
            `the source ends inside cel ${celName} after ${y} of ${height} rows: send all ${height} rows, then endcel, the loops and endview in one source.`,
          );
        if (raster.text === "endcel")
          fail(
            raster.line,
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

/** Share of a cel's opaque pixels that match their left-right mirror, 0..1. */
function symmetry(cel: BuildCelInput): number {
  const t = cel.transparentColor ?? 0;
  let same = 0;
  let opaque = 0;
  for (let y = 0; y < cel.height; y++)
    for (let x = 0; x < cel.width; x++) {
      const a = cel.pixels[y * cel.width + x]!;
      const b = cel.pixels[y * cel.width + cel.width - 1 - x]!;
      if (a === t && b === t) continue;
      opaque++;
      if (a === b) same++;
    }
  return opaque ? same / opaque : 1;
}

/**
 * Advice for a compiled view, never a refusal: repeated frames and symmetric
 * designs can be deliberate. In the 1.0.0 Genesis benchmark, right-facing
 * profiles were 28-83% symmetric and front views 84-100%; the two side loops
 * drawn as front views were 100%, so 95% separates them.
 */
export function viewSourceWarnings(input: BuildViewInput): string[] {
  const warnings: string[] = [];
  // A repeated cel inside a changing loop holds a pose, as AGI has no
  // per-cel timing; only a loop whose cels are all the same never moves.
  input.loops.forEach((loop, index) => {
    const cels = loop.cels ?? [];
    const first = cels[0]?.pixels;
    if (
      first &&
      cels.length > 1 &&
      cels.every(
        (cel) =>
          cel.pixels.length === first.length &&
          Array.prototype.every.call(cel.pixels, (value, i) => value === first[i]),
      )
    )
      warnings.push(
        `Loop ${index}: all ${cels.length} cels are identical, so it shows no motion; change the rows that move (for a walk, the legs).`,
      );
  });
  // Facing advice is for a walker: four loops with an animated right loop.
  const walker = input.loops.length === 4 && (input.loops[0]?.cels?.length ?? 0) > 1;
  const right = input.loops[0]?.cels?.[0];
  if (walker && right && symmetry(right) >= 0.95)
    warnings.push(
      "Loop 0 faces right but its first cel is symmetric like a front view; draw the figure in profile, facing right (loop 2 is the front).",
    );
  return warnings;
}
