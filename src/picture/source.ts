/**
 * Picture source: a line-oriented text format for AGI picture resources.
 *
 * One command per line, decimal operands, `#` comments. Compiles
 * deterministically to the authentic command byte stream (agi-re spec,
 * "Picture Resources and Rendering") and disassembles any byte stream back to
 * source such that `compile(disassemble(bytes)) === bytes` byte for byte.
 *
 * Grammar (tokens separated by whitespace; `x,y` is a coordinate pair):
 *
 *   vis <0..15>              0xf0 c   select visual colour, enable visual writes
 *   vis off                  0xf1     disable visual writes
 *   pri <0..15>              0xf2 p   select priority/control value, enable
 *   pri off                  0xf3     disable priority writes
 *   ycorner x,y y x y ...    0xf4     plot start, then alternate vertical/horizontal
 *   xcorner x,y x y x ...    0xf5     plot start, then alternate horizontal/vertical
 *   line x,y x,y ...         0xf6     absolute polyline (start point alone plots a dot)
 *   rel x,y dx,dy ...        0xf7     relative polyline, deltas in -7..7
 *   fill x,y x,y ...         0xf8     seed fills (visual target 15 / priority target 4)
 *   pen <r> [stipple] [bypass]  0xf9  brush radius 0..7, optional stipple / mask bypass
 *   plot x,y ...             0xfa     brush plots; in stipple mode: plot <seed> x,y ...
 *   end                      0xff     end of picture (implied if missing)
 *
 * Sugar (compiles to 0xf6 primitives):
 *
 *   polyline x,y x,y ...     same as `line`
 *   polygon x,y x,y x,y ...  closed: last point connects back to the first
 *   rect x1,y1 x2,y2         axis-aligned rectangle outline
 *   copy a-b dx,dy           re-emit source lines a..b shifted by dx,dy (absolute
 *                            coordinates, corner steps, fill seeds and plot points
 *                            move; rel deltas and state lines copy verbatim)
 *
 * Escape hatch (used by the disassembler for malformed originals):
 *
 *   raw <byte> ...           emit bytes verbatim
 *
 * Zero dependencies; runs in browser, worker and Node.
 */

import { type GameContainer } from "../types.ts";
import { DEFAULT_V2_PROFILE, type AgiProfile } from "../runtime/profile.ts";

export interface PictureSourceError {
  line: number;
  message: string;
}

export class PictureSourceSyntaxError extends Error {
  errors: readonly PictureSourceError[];
  constructor(errors: readonly PictureSourceError[]) {
    super(errors.map((e) => `line ${e.line}: ${e.message}`).join("\n"));
    this.name = "PictureSourceSyntaxError";
    this.errors = errors;
  }
}

export interface PictureSourceOptions {
  /** Command vocabulary and pattern behavior; defaults to AGI 2.936. */
  profile?: AgiProfile;
}

export interface CompilePictureOptions extends PictureSourceOptions {
  /**
   * Accept coordinates beyond the surface (x 160..239, y 168..239) and raw
   * colour operands 16..255. Off by default so authored pictures get precise
   * errors; the disassembler round-trip enables it.
   */
  lenient?: boolean;
}

export interface CompilePictureResult {
  bytes: Uint8Array;
  /** Number of source commands (comments and blank lines excluded). */
  commandCount: number;
  /** Non-fatal observations (e.g. missing `end`). */
  warnings: readonly string[];
  /**
   * Source map: one span per source line that emits bytes, in byte order.
   * A `copy` line owns everything it expands to; an implied terminator has
   * no span.
   */
  spans: readonly PictureSourceSpan[];
}

/** Bytes [start, end) of `bytes` compiled from 1-based source line `line`. */
export interface PictureSourceSpan {
  line: number;
  start: number;
  end: number;
}

/**
 * The trust rule for authored picture text: `source` stands for `payload` only
 * while it compiles (strictly) to exactly those bytes. Otherwise callers fall
 * back to `disassemblePicture(payload)`.
 */
export function sourceCompilesTo(
  source: string,
  payload: Uint8Array,
  profile: AgiProfile = DEFAULT_V2_PROFILE,
): boolean {
  try {
    const compiled = compilePictureSource(source, { profile }).bytes;
    return compiled.length === payload.length && compiled.every((b, i) => b === payload[i]);
  } catch {
    return false;
  }
}

/** The span containing byte `offset`, or undefined (binary search over ordered spans). */
export function pictureSpanAt(
  spans: readonly PictureSourceSpan[],
  offset: number,
): PictureSourceSpan | undefined {
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const span = spans[mid]!;
    if (offset < span.start) hi = mid - 1;
    else if (offset >= span.end) lo = mid + 1;
    else return span;
  }
  return undefined;
}

const MAX_X = 159;
const MAX_Y = 167;
const MAX_GUARDED = 0xef;

interface Token {
  text: string;
  /** Parsed `a,b` pair, or a single number. */
  pair?: [number, number];
  single?: number;
}

function tokenize(text: string, line: number, errors: PictureSourceError[]): Token[] {
  const out: Token[] = [];
  for (const text_ of text.split(/\s+/).filter((t) => t.length > 0)) {
    const tok: Token = { text: text_ };
    const pairMatch = /^(-?\d+),(-?\d+)$/.exec(text_);
    if (pairMatch) {
      tok.pair = [Number(pairMatch[1]), Number(pairMatch[2])];
    } else if (/^-?\d+$/.test(text_)) {
      tok.single = Number(text_);
    }
    out.push(tok);
  }
  if (out.length === 0) errors.push({ line, message: "empty command" });
  return out;
}

/** Compile picture source to the authentic byte stream. Throws PictureSourceSyntaxError. */
export function compilePictureSource(
  source: string,
  opts?: CompilePictureOptions,
): CompilePictureResult {
  const lenient = opts?.lenient === true;
  const profile = opts?.profile ?? DEFAULT_V2_PROFILE;
  const errors: PictureSourceError[] = [];
  const warnings: string[] = [];
  const bytes: number[] = [];
  const spans: PictureSourceSpan[] = [];
  let commandCount = 0;
  let ended = false;
  let stipple = false;
  const maxX = lenient ? MAX_GUARDED : MAX_X;
  const maxY = lenient ? MAX_GUARDED : MAX_Y;

  const lines = source.split(/\r?\n/);
  /** Strip the comment and whitespace of a raw source line. */
  const stripLine = (raw: string): string => {
    const hash = raw.indexOf("#");
    return (hash >= 0 ? raw.slice(0, hash) : raw).trim();
  };

  /**
   * Compile one command. `origin` names the copied line when the command
   * comes from a `copy` expansion, so errors point at the copy line but
   * still say which original line produced them.
   */
  const processLine = (text: string, lineNo: number, origin?: string): void => {
    if (ended) {
      errors.push({ line: lineNo, message: `command after 'end': '${text}'` });
      return;
    }
    const tokens = tokenize(text, lineNo, errors);
    const head = tokens[0]!;
    const args = tokens.slice(1);
    const err = (message: string): void => {
      errors.push({ line: lineNo, message: origin ? `${origin}: ${message}` : message });
    };
    commandCount++;

    /** Validate and append a coordinate pair. */
    const pushPair = (tok: Token, what: string): boolean => {
      if (!tok.pair) {
        err(`${what}: expected x,y pair, got '${tok.text}'`);
        return false;
      }
      const [x, y] = tok.pair;
      if (x < 0 || x > maxX || y < 0 || y > maxY) {
        err(`${what}: coordinate ${x},${y} out of range (x 0..${MAX_X}, y 0..${MAX_Y})`);
        return false;
      }
      bytes.push(x, y);
      return true;
    };
    const pushSingle = (tok: Token, what: string, max: number): boolean => {
      if (tok.single === undefined) {
        err(`${what}: expected a number, got '${tok.text}'`);
        return false;
      }
      if (tok.single < 0 || tok.single > max) {
        err(`${what}: value ${tok.single} out of range 0..${max}`);
        return false;
      }
      bytes.push(tok.single);
      return true;
    };
    const requirePairs = (min: number, what: string): boolean => {
      if (args.length < min) {
        err(`${what}: needs at least ${min} x,y pair${min === 1 ? "" : "s"}`);
        return false;
      }
      return true;
    };

    const name = head.text.toLowerCase();
    switch (name) {
      case "vis":
      case "visual":
      case "pri":
      case "priority": {
        const isVis = name.startsWith("v");
        const a = args[0];
        if (args.length !== 1 || !a) {
          err(`${name}: expected one operand (0..15 or 'off')`);
          break;
        }
        if (a.text.toLowerCase() === "off") {
          bytes.push(isVis ? 0xf1 : 0xf3);
          break;
        }
        if (a.single === undefined || a.single < 0 || a.single > (lenient ? 255 : 15)) {
          err(`${name}: expected colour 0..15 or 'off', got '${a.text}'`);
          break;
        }
        bytes.push(isVis ? 0xf0 : 0xf2, a.single);
        break;
      }
      case "ycorner":
      case "xcorner": {
        bytes.push(name === "ycorner" ? 0xf4 : 0xf5);
        if (!requirePairs(1, name)) break;
        if (!pushPair(args[0]!, name)) break;
        let expectY = name === "ycorner";
        for (let k = 1; k < args.length; k++) {
          if (!pushSingle(args[k]!, `${name} step ${k}`, expectY ? maxY : maxX)) break;
          expectY = !expectY;
        }
        break;
      }
      case "line":
      case "polyline": {
        bytes.push(0xf6);
        if (!requirePairs(1, name)) break;
        for (let k = 0; k < args.length; k++)
          if (!pushPair(args[k]!, `${name} point ${k + 1}`)) break;
        break;
      }
      case "polygon": {
        bytes.push(0xf6);
        if (!requirePairs(3, name)) break;
        let ok = true;
        for (let k = 0; k < args.length; k++) {
          if (!pushPair(args[k]!, `polygon point ${k + 1}`)) {
            ok = false;
            break;
          }
        }
        if (ok) pushPair(args[0]!, "polygon close");
        break;
      }
      case "rect": {
        bytes.push(0xf6);
        if (args.length !== 2 || !args[0]!.pair || !args[1]!.pair) {
          err("rect: expected two corners x1,y1 x2,y2");
          break;
        }
        const [x1, y1] = args[0]!.pair;
        const [x2, y2] = args[1]!.pair;
        const corners: Token[] = [
          { text: "", pair: [x1, y1] },
          { text: "", pair: [x2, y1] },
          { text: "", pair: [x2, y2] },
          { text: "", pair: [x1, y2] },
          { text: "", pair: [x1, y1] },
        ];
        for (const c of corners) if (!pushPair(c, "rect corner")) break;
        break;
      }
      case "rel": {
        bytes.push(0xf7);
        if (!requirePairs(1, "rel")) break;
        if (!pushPair(args[0]!, "rel start")) break;
        for (let k = 1; k < args.length; k++) {
          const t = args[k]!;
          if (!t.pair) {
            err(`rel delta ${k}: expected dx,dy, got '${t.text}'`);
            break;
          }
          const [dx, dy] = t.pair;
          if (dx < -7 || dx > 7 || dy < -7 || dy > 7) {
            err(`rel delta ${k}: ${dx},${dy} out of range -7..7`);
            break;
          }
          bytes.push(
            (dx < 0 ? 0x80 : 0) | (Math.abs(dx) << 4) | (dy < 0 ? 0x08 : 0) | Math.abs(dy),
          );
        }
        break;
      }
      case "fill": {
        bytes.push(0xf8);
        if (!requirePairs(1, "fill")) break;
        for (let k = 0; k < args.length; k++) if (!pushPair(args[k]!, `fill seed ${k + 1}`)) break;
        break;
      }
      case "pen": {
        if (profile.pictureMaxCommand < 0xf9) {
          err(`pen is not available in profile ${profile.id}; use lines and fills`);
          break;
        }
        const r = args[0];
        if (profile.patternProfile === "point-2.411" && r?.text.toLowerCase() !== "raw") {
          err(
            "profile 2.411 supports point plots, not brush modes; omit pen or use pen raw to preserve an ignored byte",
          );
          break;
        }
        let mode: number;
        if (r && r.text.toLowerCase() === "raw") {
          const m = args[1];
          if (args.length !== 2 || !m || m.single === undefined || m.single < 0 || m.single > 255) {
            err("pen raw: expected one mode byte 0..255");
            break;
          }
          mode = m.single;
        } else if (!r || r.single === undefined) {
          err("pen: expected radius 0..7 (optionally followed by 'stipple' and/or 'bypass')");
          break;
        } else {
          if (r.single < 0 || r.single > 7) {
            err(`pen: radius ${r.single} out of range 0..7`);
            break;
          }
          mode = r.single;
          let bad = false;
          for (const f of args.slice(1)) {
            const flag = f.text.toLowerCase();
            if (flag === "stipple") mode |= 0x20;
            else if (flag === "bypass") mode |= 0x10;
            else {
              err(`pen: unknown flag '${f.text}' (expected 'stipple' or 'bypass')`);
              bad = true;
            }
          }
          if (bad) break;
        }
        stipple = profile.patternProfile !== "point-2.411" && (mode & 0x20) !== 0;
        bytes.push(0xf9, mode & 0xff);
        break;
      }
      case "plot": {
        if (profile.pictureMaxCommand < 0xfa) {
          err(`plot is not available in profile ${profile.id}; use one-point lines`);
          break;
        }
        bytes.push(0xfa);
        if (args.length === 0) {
          err("plot: needs at least one x,y pair");
          break;
        }
        let k = 0;
        // Stipple sugar: a seed applies to every following pair until the
        // next seed, so `plot 17 1,2 3,4` emits the seed before both pairs.
        let seed = -1;
        while (k < args.length) {
          if (stipple) {
            const s = args[k]!;
            if (s.single !== undefined) {
              if (!pushSingle(s, "plot seed", MAX_GUARDED)) break;
              seed = s.single;
              k++;
              if (k >= args.length) {
                err("plot: seed without a following x,y pair");
                break;
              }
            } else if (seed < 0) {
              err(`plot: stipple pen is active, expected '<seed> x,y' but got '${s.text}'`);
              break;
            } else {
              bytes.push(seed);
            }
          }
          if (!pushPair(args[k]!, "plot")) break;
          k++;
        }
        break;
      }
      case "raw": {
        if (args.length === 0) {
          err("raw: expected one or more byte values");
          break;
        }
        for (const a of args) {
          if (!pushSingle(a, "raw", 255)) break;
          // A raw 0xff is the terminator: the decoder stops here.
          if (a.single === 0xff) ended = true;
        }
        break;
      }
      case "end":
        bytes.push(0xff);
        ended = true;
        break;
      case "copy": {
        // copy <from>-<to> dx,dy : re-emit already-compiled source lines with
        // absolute coordinates offset. Pure sugar; never produced by disassembly.
        commandCount--; // the expanded lines count themselves
        const range = args[0];
        const delta = args[1];
        const m = range ? /^(\d+)-(\d+)$/.exec(range.text) : null;
        if (origin) {
          err("copy: a copied range cannot itself contain a copy");
          break;
        }
        if (!m || args.length !== 2 || !delta?.pair) {
          err("copy: expected '<fromLine>-<toLine> dx,dy'");
          break;
        }
        const from = Number(m[1]);
        const to = Number(m[2]);
        if (from < 1 || to < from || to >= lineNo) {
          err(`copy: range ${from}-${to} must be earlier lines (1..${lineNo - 1}) with from <= to`);
          break;
        }
        const [dx, dy] = delta.pair;
        const shift = (tok: string, sx: number, sy: number): string => {
          const pm = /^(-?\d+),(-?\d+)$/.exec(tok);
          return pm ? `${Number(pm[1]) + sx},${Number(pm[2]) + sy}` : tok;
        };
        for (let k = from; k <= to; k++) {
          const src = stripLine(lines[k - 1] ?? "");
          if (src.length === 0) continue;
          const parts = src.split(/\s+/);
          const cmd = parts[0]!.toLowerCase();
          let out: string[];
          switch (cmd) {
            case "line":
            case "polyline":
            case "polygon":
            case "rect":
            case "fill":
            case "plot":
              out = [parts[0]!, ...parts.slice(1).map((t) => shift(t, dx, dy))];
              break;
            case "rel":
              out = [parts[0]!, shift(parts[1] ?? "", dx, dy), ...parts.slice(2)];
              break;
            case "xcorner":
            case "ycorner": {
              let expectX = cmd === "xcorner";
              out = [parts[0]!, shift(parts[1] ?? "", dx, dy)];
              for (const t of parts.slice(2)) {
                out.push(/^\d+$/.test(t) ? String(Number(t) + (expectX ? dx : dy)) : t);
                expectX = !expectX;
              }
              break;
            }
            case "end":
              err(`copy: line ${k} is 'end'; the range must not include it`);
              continue;
            default:
              out = parts; // vis / pri / pen / raw: state lines copy verbatim
          }
          processLine(out.join(" "), lineNo, `copy of line ${k}`);
        }
        break;
      }
      default:
        err(
          `unknown command '${head.text}' (expected vis, pri, line, polyline, polygon, rect, rel, xcorner, ycorner, fill, pen, plot, copy, end)`,
        );
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const text = stripLine(lines[i]!);
    if (text.length === 0) continue;
    const start = bytes.length;
    processLine(text, i + 1);
    if (bytes.length > start) spans.push({ line: i + 1, start, end: bytes.length });
  }

  if (errors.length > 0) throw new PictureSourceSyntaxError(errors);
  if (!ended) {
    bytes.push(0xff);
    warnings.push("missing 'end'; terminator appended");
  }
  return { bytes: new Uint8Array(bytes), commandCount, warnings, spans };
}

/**
 * Disassemble a byte stream to source. Uses only primitive commands; every
 * byte that does not fit a well-formed command is emitted through `raw`, so
 * recompiling reproduces the input exactly.
 */
export function disassemblePicture(payload: Uint8Array, opts?: PictureSourceOptions): string {
  const profile = opts?.profile ?? DEFAULT_V2_PROFILE;
  const lines: string[] = [];
  let pos = 0;
  let stipple = false;
  const n = payload.length;
  const guarded = (i: number): boolean => i < n && payload[i]! < 0xf0;

  const rawRun = (from: number, to: number): void => {
    if (to > from) lines.push("raw " + Array.from(payload.subarray(from, to)).join(" "));
  };

  /** Read as many complete pairs as possible; return the index after them. */
  const readPairs = (start: number, out: string[]): number => {
    let i = start;
    while (guarded(i) && guarded(i + 1)) {
      out.push(`${payload[i]},${payload[i + 1]}`);
      i += 2;
    }
    return i;
  };
  /** Bytes from `i` up to the next command byte become a raw line. */
  const flushGuarded = (i: number): number => {
    let j = i;
    while (guarded(j)) j++;
    rawRun(i, j);
    return j;
  };

  while (pos < n) {
    const cmd = payload[pos]!;
    if (cmd < 0xf0) {
      pos = flushGuarded(pos);
      continue;
    }
    pos++;
    if (cmd > profile.pictureMaxCommand && cmd !== 0xff) {
      lines.push(`raw ${cmd}`);
      continue;
    }
    switch (cmd) {
      case 0xf0:
      case 0xf2: {
        const isVis = cmd === 0xf0;
        if (pos >= n) {
          lines.push(`raw ${cmd}`);
          break;
        }
        lines.push(`${isVis ? "vis" : "pri"} ${payload[pos]}`);
        pos++;
        break;
      }
      case 0xf1:
        lines.push("vis off");
        break;
      case 0xf3:
        lines.push("pri off");
        break;
      case 0xf4:
      case 0xf5: {
        const name = cmd === 0xf4 ? "ycorner" : "xcorner";
        if (!(guarded(pos) && guarded(pos + 1))) {
          lines.push(`raw ${cmd}`);
          pos = flushGuarded(pos);
          break;
        }
        const parts = [`${payload[pos]},${payload[pos + 1]}`];
        pos += 2;
        while (guarded(pos)) {
          parts.push(String(payload[pos]));
          pos++;
        }
        lines.push(`${name} ${parts.join(" ")}`);
        break;
      }
      case 0xf6:
      case 0xf8: {
        const name = cmd === 0xf6 ? "line" : "fill";
        const parts: string[] = [];
        pos = readPairs(pos, parts);
        if (parts.length === 0) {
          lines.push(`raw ${cmd}`);
        } else {
          lines.push(`${name} ${parts.join(" ")}`);
        }
        pos = flushGuarded(pos);
        break;
      }
      case 0xf7: {
        if (!(guarded(pos) && guarded(pos + 1))) {
          lines.push("raw 247");
          pos = flushGuarded(pos);
          break;
        }
        const parts = [`${payload[pos]},${payload[pos + 1]}`];
        pos += 2;
        while (guarded(pos)) {
          const b = payload[pos]!;
          const dxMag = (b & 0x70) >> 4;
          const dyMag = b & 0x07;
          // A zero magnitude with its sign bit set is not expressible as a
          // signed delta; stop and let the remainder go through `raw`.
          if ((dxMag === 0 && (b & 0x80) !== 0) || (dyMag === 0 && (b & 0x08) !== 0)) break;
          const dx = (b & 0x80) !== 0 ? -dxMag : dxMag;
          const dy = (b & 0x08) !== 0 ? -dyMag : dyMag;
          parts.push(`${dx},${dy}`);
          pos++;
        }
        lines.push(`rel ${parts.join(" ")}`);
        pos = flushGuarded(pos);
        break;
      }
      case 0xf9: {
        if (pos >= n) {
          lines.push("raw 249");
          break;
        }
        const mode = payload[pos]!;
        pos++;
        stipple = profile.patternProfile !== "point-2.411" && (mode & 0x20) !== 0;
        if (profile.patternProfile === "point-2.411" || (mode & ~0x37) !== 0) {
          lines.push(`pen raw ${mode}`);
        } else {
          const flags = [
            (mode & 0x20) !== 0 ? " stipple" : "",
            (mode & 0x10) !== 0 ? " bypass" : "",
          ];
          lines.push(`pen ${mode & 0x07}${flags.join("")}`);
        }
        break;
      }
      case 0xfa: {
        const parts: string[] = [];
        if (stipple) {
          while (guarded(pos) && guarded(pos + 1) && guarded(pos + 2)) {
            parts.push(String(payload[pos]), `${payload[pos + 1]},${payload[pos + 2]}`);
            pos += 3;
          }
        } else {
          pos = readPairs(pos, parts);
        }
        if (parts.length === 0) lines.push("raw 250");
        else lines.push(`plot ${parts.join(" ")}`);
        pos = flushGuarded(pos);
        break;
      }
      case 0xff:
        lines.push("end");
        if (pos < n) {
          // Trailing bytes after the terminator: emit verbatim but keep the
          // source well-formed by ending after them.
          lines.pop();
          lines.push(`raw 255 ${Array.from(payload.subarray(pos)).join(" ")}`.trimEnd());
          pos = n;
        }
        break;
      default:
        lines.push(`raw ${cmd}`);
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * Reference documentation for the source format, suitable for verbatim use
 * in an authoring prompt or tool description.
 */
export const PICTURE_SOURCE_DOC = `Picture source format: one command per line, decimal numbers, \`x,y\` coordinate pairs, \`#\` comments.
Surface is 160 wide (x 0..159) by 168 tall (y 0..167); y grows downward. The surface starts all white (15) with priority 4.

  vis <0..15>              select visual colour and enable visual drawing
  vis off                  stop drawing on the visual surface
  pri <0..15>              select priority/control value and enable priority drawing
  pri off                  stop drawing on the priority surface
  line x,y x,y ...         absolute polyline through the points (one point = a dot)
  polygon x,y x,y x,y ...  closed outline (last point joins the first)
  rect x1,y1 x2,y2         rectangle outline
  copy a-b dx,dy           duplicate source lines a..b (line numbers of this file, 1-based, earlier lines only)
                           shifted by dx,dy: the cheapest way to add "another one of those" (a second tree, a
                           row of windows) in exactly the same style; colour/pen lines inside the range copy as-is
  rel x,y dx,dy ...        relative polyline; each delta in -7..7 (compact for small detail)
  xcorner x,y x y x ...    staircase: horizontal to x, vertical to y, alternating
  ycorner x,y y x y ...    staircase: vertical to y, horizontal to x, alternating
  fill x,y ...             seed fill: floods the 4-connected WHITE (15) region around the seed with the
                           visual colour (or, with visual off, the priority-4 region with the priority value).
                           The region must be enclosed by lines first; a seed on a non-white pixel does nothing.
  pen <r> [stipple] [bypass]   brush radius 0..7; 'stipple' makes plots speckled (texture: foliage, gravel)
  plot x,y ...             stamp the brush; with a stipple pen: plot <seed> x,y x,y ... (seed 0..239 picks the
                           pattern and applies to every following point until the next seed)
  end                      end of picture

Draw the visual pass far to near with enclosed outlines and fills. Then draw only intentional priority/control
shapes: pri 0/1 barriers, 2 triggers, 3 water, and 5..15 scenery that should occlude a sprite. Leave ordinary
walkable floor at pri 4; shape higher-priority regions to visible scenery instead of drawing floor stripes.
`;

// ---------------------------------------------------------------------------
// Reading originals and structural comparison

/**
 * Disassemble picture `num` of a loaded container into DSL source, or null
 * when the directory has no such entry. This is the read side of the agent's
 * picture tooling (`read_picture`): orientation in a running game before a
 * live patch, and the reference form for the picture eval.
 */
export function readPictureSource(
  container: Pick<GameContainer, "getResource">,
  num: number,
  opts?: PictureSourceOptions,
): string | null {
  const bytes = container.getResource("picture", num);
  return bytes ? disassemblePicture(bytes, opts) : null;
}

/** Structural summary of a picture command stream (vector-level, not pixels). */
export interface PictureStructure {
  commands: number;
  /** Count per command family. */
  lines: number;
  relLines: number;
  cornerLines: number;
  fills: number;
  /** Individual fill seeds (a `fill` command may carry many). */
  fillSeeds: number;
  plots: number;
  /** Line segments drawn (points minus one per polyline). */
  segments: number;
  visualColours: number[];
  priorityValues: number[];
  /** Fraction of drawing commands issued with both channels enabled. */
  bothChannelsFraction: number;
  /** Fraction of drawing commands issued with only the priority channel enabled. */
  priorityOnlyFraction: number;
  /** Channel-enable sequence, e.g. "vis pri vis vis pri" (first 40 entries). */
  passOrder: string;
  visualEnables: number;
  priorityEnables: number;
}

export function analyzePictureStructure(
  bytes: Uint8Array,
  opts?: PictureSourceOptions,
): PictureStructure {
  const profile = opts?.profile ?? DEFAULT_V2_PROFILE;
  const s: PictureStructure = {
    commands: 0,
    lines: 0,
    relLines: 0,
    cornerLines: 0,
    fills: 0,
    fillSeeds: 0,
    plots: 0,
    segments: 0,
    visualColours: [],
    priorityValues: [],
    bothChannelsFraction: 0,
    priorityOnlyFraction: 0,
    passOrder: "",
    visualEnables: 0,
    priorityEnables: 0,
  };
  const vis = new Set<number>();
  const pri = new Set<number>();
  const passes: string[] = [];
  let visOn = false;
  let priOn = false;
  let drawing = 0;
  let both = 0;
  let priOnly = 0;
  let stipple = false;
  let pos = 0;
  const n = bytes.length;
  const guarded = (i: number): boolean => i < n && bytes[i]! < 0xf0;
  const countDrawing = (): void => {
    drawing++;
    if (visOn && priOn) both++;
    else if (priOn) priOnly++;
  };
  while (pos < n) {
    const cmd = bytes[pos]!;
    pos++;
    if (cmd < 0xf0) continue;
    s.commands++; // `end` counts, matching compilePictureSource().commandCount
    if (cmd === 0xff) break;
    if (cmd > profile.pictureMaxCommand) continue;
    switch (cmd) {
      case 0xf0:
        if (pos < n) vis.add(bytes[pos]! & 0x0f);
        pos++;
        visOn = true;
        passes.push("vis");
        break;
      case 0xf1:
        visOn = false;
        break;
      case 0xf2:
        if (pos < n) pri.add(bytes[pos]! & 0x0f);
        pos++;
        priOn = true;
        passes.push("pri");
        break;
      case 0xf3:
        priOn = false;
        break;
      case 0xf4:
      case 0xf5: {
        s.cornerLines++;
        countDrawing();
        let k = 0;
        while (guarded(pos)) {
          pos++;
          k++;
        }
        s.segments += Math.max(0, k - 2);
        break;
      }
      case 0xf6: {
        s.lines++;
        countDrawing();
        let k = 0;
        while (guarded(pos)) {
          pos++;
          k++;
        }
        s.segments += Math.max(0, (k >> 1) - 1);
        break;
      }
      case 0xf7: {
        s.relLines++;
        countDrawing();
        let k = 0;
        while (guarded(pos)) {
          pos++;
          k++;
        }
        s.segments += Math.max(0, k - 2);
        break;
      }
      case 0xf8: {
        s.fills++;
        countDrawing();
        let k = 0;
        while (guarded(pos)) {
          pos++;
          k++;
        }
        s.fillSeeds += k >> 1;
        break;
      }
      case 0xf9:
        if (pos < n)
          stipple = profile.patternProfile !== "point-2.411" && (bytes[pos]! & 0x20) !== 0;
        pos++;
        break;
      case 0xfa: {
        countDrawing();
        let k = 0;
        while (guarded(pos)) {
          pos++;
          k++;
        }
        s.plots += stipple ? Math.floor(k / 3) : k >> 1;
        break;
      }
      default:
        break;
    }
  }
  s.visualColours = [...vis].sort((a, b) => a - b);
  s.priorityValues = [...pri].sort((a, b) => a - b);
  s.bothChannelsFraction = drawing === 0 ? 0 : both / drawing;
  s.priorityOnlyFraction = drawing === 0 ? 0 : priOnly / drawing;
  s.passOrder = passes.slice(0, 40).join(" ");
  s.visualEnables = passes.filter((p) => p === "vis").length;
  s.priorityEnables = passes.length - s.visualEnables;
  return s;
}

/** Vector-level comparison: candidate minus reference per count, plus set overlaps. */
export interface StructureComparison {
  deltas: Record<string, number>;
  /** Jaccard overlap of visual colour sets and priority value sets. */
  visualColourOverlap: number;
  priorityValueOverlap: number;
}

function jaccard(a: readonly number[], b: readonly number[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 1 : inter / union;
}

export function comparePictureStructure(
  reference: PictureStructure,
  candidate: PictureStructure,
): StructureComparison {
  const keys = [
    "commands",
    "lines",
    "relLines",
    "cornerLines",
    "fills",
    "fillSeeds",
    "plots",
    "segments",
    "bothChannelsFraction",
    "priorityOnlyFraction",
  ] as const;
  const deltas: Record<string, number> = {};
  for (const k of keys) deltas[k] = candidate[k] - reference[k];
  return {
    deltas,
    visualColourOverlap: jaccard(reference.visualColours, candidate.visualColours),
    priorityValueOverlap: jaccard(reference.priorityValues, candidate.priorityValues),
  };
}
