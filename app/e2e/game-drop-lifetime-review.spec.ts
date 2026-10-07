import { expect, test } from "./test.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildZip } from "../src/archive/zip.ts";
import { isolateStorage, savedGameCard } from "./engineProbe.ts";

for (const kind of ["zip", "folder"] as const) {
  test(`@webkit-desktop a ${kind} drop captures its handles before the event expires`, async ({
    page,
  }) => {
    await page.route("**/api/**", (route) => route.abort());
    await isolateStorage(page);
    await page.goto("/");
    const game = createContainer();
    game.putResource(
      "logic",
      0,
      assembleLogic('display(5, 4, "Captured drop"); return;', {
        dictionary: new Map(),
      }).payload,
    );
    game.putFile("WORDS.TOK", new Uint8Array(52));
    const files = [...game.files].map(([name, data]) => ({ name, bytes: [...data] }));
    const zip = [
      ...buildZip(files.map(({ name, bytes }) => ({ name, data: Uint8Array.from(bytes) }))),
    ];
    const captures = await page.getByTestId("game-zip-drop").evaluate(
      (target, input) => {
        const file = new File([Uint8Array.from(input.zip)], "Captured drop.zip");
        const entries = input.files.map(({ name, bytes }) => ({
          isFile: true,
          isDirectory: false,
          name,
          file(success: (value: File) => void) {
            queueMicrotask(() => success(new File([Uint8Array.from(bytes)], name)));
          },
        }));
        const folder = {
          isFile: false,
          isDirectory: true,
          name: "Captured drop",
          createReader() {
            let read = false;
            return {
              readEntries(success: (value: typeof entries) => void) {
                const batch = read ? [] : entries;
                read = true;
                queueMicrotask(() => success(batch));
              },
            };
          },
        };
        let alive = true;
        let captured = 0;
        const item = {
          kind: "file",
          webkitGetAsEntry() {
            if (!alive || input.kind !== "folder") return null;
            captured++;
            return folder;
          },
          getAsFile() {
            if (!alive || input.kind !== "zip") return null;
            captured++;
            return file;
          },
        };
        const transfer = {
          get items() {
            return alive ? [item] : [];
          },
          get files() {
            return alive && input.kind === "zip" ? [file] : [];
          },
        };
        const event = new Event("drop", { bubbles: true, cancelable: true });
        Object.defineProperty(event, "dataTransfer", { value: transfer });
        target.dispatchEvent(event);
        // The browser's protected drop store ends with the event dispatch.
        alive = false;
        return captured;
      },
      { kind, files, zip },
    );
    expect(captures, "the real Home handler must capture before its first await").toBe(1);
    await expect(page.getByTestId("game-import-ready")).toContainText("added to your library");
    await expect(
      savedGameCard(page, "Captured drop").getByTestId("btn-resume-cached"),
    ).toBeEnabled();
  });
}
