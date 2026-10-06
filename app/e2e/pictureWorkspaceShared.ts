import type { Page } from "@playwright/test";
import type { ProjectSession } from "../src/project/projectSession.ts";
import { isolateStorage, waitForRoom, workspaceUpdated } from "./engineProbe.ts";

export async function start(page: Page) {
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await waitForRoom(page, 1);
  await workspaceUpdated(page);
  await page.evaluate(async () => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    const capture = session.model.capture();
    const result = await session.submit({
      proposal: session.model.propose(capture, "More rooms and art", [
        { key: "picture:8", content: "vis 3\nfill 0,0\nend\n" },
        { key: "picture:9", content: "vis 5\nfill 0,0\nend\n" },
        { key: "view:8", content: capture.read("view:0")!.content },
        { key: "view:9", content: capture.read("view:0")!.content },
        {
          key: "logic:8",
          content:
            'if(isset(f5)){assignn(v100,8);load.pic(v100);draw.pic(v100);show.pic();animate.obj(o0);load.view(8);set.view(o0,8);position(o0,60,140);draw(o0);accept.input();}if(said("look")){new.room(1);}return;',
        },
        {
          key: "world",
          content: JSON.stringify({
            ...JSON.parse(capture.read("world")!.content as string),
            rooms: {
              "1": { title: "Home", description: "", exits: {} },
              "8": { title: "Garden", description: "", exits: {} },
            },
          }),
        },
      ]),
      label: "More rooms and art",
      origin: "logic",
      author: "creator",
    });
    if (result.status !== "committed") throw new Error(result.status);
  });
}
export async function open(page: Page, id: string) {
  if (page.viewportSize()!.width <= 600) await page.getByTestId("workspace-parts").click();
  await page.getByTestId(id).click();
}
