import { expect, test } from "./test.ts";
import { isolateStorage, waitForRoom, workspaceSaved } from "./engineProbe.ts";
import type { ProjectSession } from "../src/project/projectSession.ts";
import type { WorkerInbound } from "../src/worker/workerProtocol.ts";

for (const entry of ["Create", "conversation"] as const) {
  test(`a Play-booted game keeps its retained History when opening ${entry}`, async ({ page }) => {
    await isolateStorage(page);
    await page.goto("/#create-adventure");
    await page.getByTestId("local-create-kind-starter").click();
    await page.getByRole("button", { name: "Start building", exact: true }).click();
    await waitForRoom(page, 1, { coldBoot: true });
    await workspaceSaved(page);
    const retained = await page.evaluate(async () => {
      const session = (
        window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
      ).__AGI_PROJECT__.getSession();
      const source = String(session.model.capture().read("logic:1")!.content);
      await session.update([{ key: "logic:1", content: source + "\n// Retained version\n" }], true);
      await session.flush();
      return session.history.capture().commits.map((commit) => commit.id);
    });
    const projectId = decodeURIComponent(new URL(page.url()).hash.slice("#create/".length));
    await page.addInitScript(() => {
      const audit = { histories: [] as (string[] | null)[] };
      Reflect.set(window, "playHistoryAudit", audit);
      const post = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (message: WorkerInbound, options) {
        if (message.type === "projectCreate")
          audit.histories.push(message.history?.commits.map((commit) => commit.id) ?? null);
        post.call(this, message, Array.isArray(options) ? { transfer: options } : options);
      };
    });
    await page.goto(`/?play-history#play/${encodeURIComponent(projectId)}`);
    await waitForRoom(page, 1, { coldBoot: true });
    if (entry === "Create") await page.getByRole("radio", { name: "Create", exact: true }).click();
    else await page.getByTestId("menu-agent").click();
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, "playHistoryAudit").histories))
      .toEqual([retained]);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const session = (
            window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession | null } }
          ).__AGI_PROJECT__.getSession();
          return session?.history.capture().commits.map((commit) => commit.id);
        }),
      )
      .toEqual(retained);
    if (entry === "Create") {
      await expect(page.getByTestId("workspace-undo")).toBeEnabled();
      await page.getByTestId("workspace-undo").click();
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (
                window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
              ).__AGI_PROJECT__
                .getSession()
                .history.capture().cursor,
          ),
        )
        .toBe(retained.at(-2));
    }
  });
}
