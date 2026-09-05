import { TEXT_COLS, TEXT_ROWS, TextSurface, attr } from "./textSurface.ts";

/** Engine-owned trace text, composited without changing the game's text cells. */
export class TraceWindow {
  active = false;
  logic: number | null = null;
  private top = 1;
  private height = 10;
  private readonly lines: string[] = [];
  readonly surface = new TextSurface();

  configure(logic: number, top: number, height: number): void {
    this.logic = logic;
    this.height = Math.min(TEXT_ROWS, Math.max(2, height));
    this.top = Math.min(TEXT_ROWS - this.height, Math.max(0, top));
    this.lines.length = 0;
    this.draw();
  }

  setActive(active: boolean): void {
    this.active = active;
    this.lines.length = 0;
    this.draw();
  }

  append(line: string): void {
    if (!this.active) return;
    this.lines.push(line);
    if (this.lines.length >= this.height) this.lines.shift();
    this.draw();
  }

  private draw(): void {
    this.surface.clear();
    if (!this.active) return;
    this.surface.fill(this.top, 0, this.top + this.height - 1, TEXT_COLS - 1, 32, attr(0, 15));
    this.surface.write(this.top, 0, "Trace                        Scroll Lock", attr(15, 0));
    this.lines.forEach((line, index) =>
      this.surface.write(this.top + index + 1, 0, line, attr(0, 15)),
    );
  }
}
