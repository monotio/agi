/** Offline: saved PNGs named after the stored prompts; no provider transport. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodePng } from "../scripts/png.ts";
import { imageStylePrompt, scoreImageStyle } from "../src/creative/imageStyle.ts";
const prompts = JSON.parse(
  readFileSync(new URL("./fixtures/image-style/prompts.json", import.meta.url), "utf8"),
) as { id: string; target: "picture" | "view"; intent: string }[];
const folder = process.argv[2];
for (const prompt of prompts) {
  const request = imageStylePrompt(prompt.target, prompt.intent);
  if (!folder) console.log(JSON.stringify({ ...prompt, prompt: request }));
  else {
    const decoded = decodePng(readFileSync(join(folder, `${prompt.id}.png`)));
    console.log(
      JSON.stringify({
        id: prompt.id,
        ...scoreImageStyle(decoded.width, decoded.height, decoded.rgba),
      }),
    );
  }
}
