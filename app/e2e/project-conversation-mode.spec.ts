import type { WorkerInbound, WorkerQueryFn } from "../src/worker/workerProtocol.ts";
import { expect, test } from "./test.ts";
import {
  isolateStorage,
  observe,
  savePlayProgress,
  waitForCycles,
  waitForRoom,
  workspaceSaved,
  type TextHook,
} from "./engineProbe.ts";

test("saving Play progress waits for the actual Play and Create admissions @webkit-desktop", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await waitForRoom(page, 1, { coldBoot: true });
  await workspaceSaved(page);
  await waitForCycles(page, 30);
  await page.evaluate(() => {
    const probe = window as unknown as {
      __AGI_PROJECT__: { getWorker(): Worker };
      __AGI_TEXT__: TextHook;
      progressAdmission: {
        heldPlay: boolean;
        heldCreate: boolean;
        earlyReads: number;
        releasePlay(): void;
        releaseCreate(): void;
        releaseAll(): void;
      };
    };
    const worker = probe.__AGI_PROJECT__.getWorker();
    const post = worker.postMessage;
    let hold = true;
    let pendingPlay: (() => void) | undefined;
    let pendingCreate: (() => void) | undefined;
    const audit = {
      heldPlay: false,
      heldCreate: false,
      earlyReads: 0,
      releasePlay() {
        audit.heldPlay = false;
        pendingPlay?.();
        pendingPlay = undefined;
      },
      releaseCreate() {
        audit.heldCreate = false;
        pendingCreate?.();
        pendingCreate = undefined;
      },
      releaseAll() {
        hold = false;
        audit.releasePlay();
        audit.releaseCreate();
      },
    };
    worker.postMessage = function (message: WorkerInbound, transfer) {
      const send = () =>
        post.call(worker, message, Array.isArray(transfer) ? { transfer } : transfer);
      if (hold && message.type === "projectPlay") {
        audit.heldPlay = true;
        pendingPlay = send;
      } else if (hold && message.type === "projectCreate" && message.progressMode === "create") {
        audit.heldCreate = true;
        pendingCreate = send;
      } else send();
    };
    let hook = probe.__AGI_TEXT__;
    Object.defineProperty(window, "__AGI_TEXT__", {
      configurable: true,
      get() {
        if (audit.heldPlay) audit.earlyReads++;
        return hook;
      },
      set(value: TextHook) {
        hook = value;
      },
    });
    probe.progressAdmission = audit;
  });
  let finished = false;
  const saving = savePlayProgress(page).then(() => {
    finished = true;
  });
  const audit = () =>
    page.evaluate(
      () =>
        Reflect.get(window, "progressAdmission") as {
          heldPlay: boolean;
          heldCreate: boolean;
          earlyReads: number;
        },
    );
  try {
    await expect.poll(async () => (await audit()).heldPlay).toBe(true);
    await observe(page, 3);
    expect((await audit()).earlyReads).toBe(0);
    await page.evaluate(() => Reflect.get(window, "progressAdmission").releasePlay());
    // The helper first waits for a durable autosave with the shared 30-second budget.
    await expect.poll(async () => (await audit()).heldCreate, { timeout: 30_000 }).toBe(true);
    expect(finished).toBe(false);
    await page.evaluate(() => Reflect.get(window, "progressAdmission").releaseCreate());
    await saving;
    const returned = await page.evaluate(() =>
      (window as unknown as { __AGI_PROJECT__: { query: WorkerQueryFn } }).__AGI_PROJECT__.query(
        "playHere",
        { room: 1, x: 0, y: 0, visit: "back" },
      ),
    );
    expect(returned).toMatchObject({ ok: true });
  } finally {
    await page.evaluate(() => Reflect.get(window, "progressAdmission").releaseAll());
    await saving.catch(() => {});
  }
});

for (const boundary of ["direct", "initial", "conversation"] as const)
  test(`a failed Create ${boundary} session keeps Play and reports how to recover @webkit-desktop`, async ({
    page,
  }) => {
    await isolateStorage(page);
    const requested = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await page.route("**/src/engine/mainProjectAdmission.ts", async (route) => {
      requested.resolve();
      if (boundary !== "direct") await release.promise;
      await route.abort("connectionreset");
    });
    await page.goto("/");
    if (boundary === "initial") {
      await page.getByTestId("create-adventure-toggle").click();
      await page.getByTestId("local-create-kind-starter").click();
      await page.getByRole("button", { name: "Start building", exact: true }).click();
    } else await page.getByTestId("catalog-play-adventure-department").click();
    await waitForRoom(page, 1, { coldBoot: true });
    const stored = () =>
      page.evaluate(async () => {
        const { loadAuthoredGame } = await import("/src/project/gameStorage.ts");
        const id = decodeURIComponent(location.hash.slice(location.hash.indexOf("/") + 1));
        return JSON.stringify(await loadAuthoredGame(id as Parameters<typeof loadAuthoredGame>[0]));
      });
    const before = await stored();
    const projectId = await page.evaluate(() =>
      decodeURIComponent(location.hash.slice(location.hash.indexOf("/") + 1)),
    );
    if (boundary === "conversation") {
      await page.getByTestId("menu-assistant").click();
      await requested.promise;
    }
    if (boundary === "conversation")
      await page.evaluate(() => {
        location.hash = location.hash.replace("#play/", "#create/");
      });
    else if (boundary !== "initial")
      await page.getByRole("radio", { name: "Create", exact: true }).click();
    else {
      await requested.promise;
      await expect(page.getByRole("radio", { name: "Create", exact: true })).toHaveAttribute(
        "aria-checked",
        "true",
      );
    }
    release.resolve();
    await expect(page.getByTestId("entry-notice")).toBeVisible();
    await expect(page.getByTestId("entry-notice")).toContainText("Reload");
    await expect(page.getByRole("radio", { name: "Play", exact: true })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(page).toHaveURL(/#play\//);
    const returned = await page.evaluate(() =>
      (window as unknown as { __AGI_PROJECT__: { query: WorkerQueryFn } }).__AGI_PROJECT__.query(
        "playHere",
        { room: 1, x: 0, y: 0, visit: "back" },
      ),
    );
    expect(returned).toMatchObject({ ok: false, reason: "Open Create to return to your game." });
    expect(await stored()).toBe(before);
    await page.unroute("**/src/engine/mainProjectAdmission.ts");
    await page.goto("/");
    const card = page.getByTestId("saved-game-gallery").locator(`[data-project-id="${projectId}"]`);
    await card.getByRole("button", { name: "Game actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Edit in Create", exact: true }).click();
    await waitForRoom(page, 1, { coldBoot: true });
    await expect(page.getByTestId("workspace-saved")).toBeVisible();
    await expect(page.getByTestId("entry-notice")).toHaveCount(0);
    await expect(page.getByRole("radio", { name: "Create", exact: true })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

for (const boundary of ["request", "session", "fork"] as const)
  test(`Create waits for the Play conversation ${boundary} and transitions the worker @webkit-desktop`, async ({
    page,
  }) => {
    await isolateStorage(page);
    await page.addInitScript(
      ({ holdRequest, holdReply }) => {
        const modes: string[] = [];
        Object.assign(window, { conversationProjectModes: modes });
        const post = Worker.prototype.postMessage;
        const creates = new Set<number>();
        let pendingReply: (() => void) | undefined;
        const receive = Object.getOwnPropertyDescriptor(Worker.prototype, "onmessage")!;
        Object.defineProperty(Worker.prototype, "onmessage", {
          ...receive,
          set(this: Worker, handler: Worker["onmessage"]) {
            receive.set!.call(this, (event: MessageEvent) => {
              const deliver = () => handler?.call(this, event);
              if (holdReply && event.data.type === "projectCreated" && creates.has(event.data.id))
                pendingReply = deliver;
              else deliver();
            });
          },
        });
        let pending: (() => void) | undefined;
        Object.assign(window, {
          releaseCreateReply() {
            pendingReply?.();
            pendingReply = undefined;
          },
          releaseConversationAdmission() {
            pending?.();
            pending = undefined;
          },
        });
        Worker.prototype.postMessage = function (message, transfer) {
          if (message.type === "projectCreate") {
            modes.push(message.progressMode);
            if (message.progressMode === "create") {
              creates.add(message.id);
              const received = (event: MessageEvent) => {
                if (event.data.type !== "projectCreated" || event.data.id !== message.id) return;
                Object.assign(window, { conversationCreateReply: event.data });
                this.removeEventListener("message", received);
              };
              this.addEventListener("message", received);
            }
          }
          const send = () =>
            post.call(this, message, Array.isArray(transfer) ? { transfer } : transfer);
          if (holdRequest && message.type === "projectCreate" && message.progressMode === "play")
            pending = send;
          else send();
        };
      },
      { holdRequest: boundary !== "session", holdReply: boundary === "fork" },
    );
    const opening = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await page.route("**/src/engine/mainProjectAdmission.ts", async (route) => {
      opening.resolve();
      if (boundary === "session") await release.promise;
      await route.continue();
    });
    await page.goto("/");
    await page.getByTestId("catalog-play-adventure-department").click();
    await waitForRoom(page, 1, { coldBoot: true });
    await page.getByTestId("menu-assistant").click();
    const modes = () =>
      page.evaluate(
        () =>
          (window as unknown as { conversationProjectModes: string[] }).conversationProjectModes,
      );
    await expect.poll(modes).toEqual(["play"]);
    if (boundary === "session") await opening.promise;
    await page.evaluate(() => {
      location.hash = location.hash.replace("#play/", "#create/");
    });
    await expect(page.getByRole("radio", { name: "Create", exact: true })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(await modes()).toEqual(["play"]);
    if (boundary !== "session")
      await page.evaluate(() =>
        (
          window as unknown as { releaseConversationAdmission(): void }
        ).releaseConversationAdmission(),
      );
    release.resolve();
    await expect.poll(modes).toEqual(["play", "create"]);
    await expect
      .poll(() =>
        page.evaluate(() => Reflect.get(window, "conversationCreateReply")?.grant !== undefined),
      )
      .toBe(true);
    if (boundary === "fork") {
      await expect(
        page.getByRole("heading", { name: "Adventure Department Remix", exact: true }),
      ).toBeVisible();
      await page.evaluate(() =>
        (window as unknown as { releaseCreateReply(): void }).releaseCreateReply(),
      );
    }
    // Attachment includes the first chat save and any catalog ownership transfer.
    await expect(page.getByTestId("agent-message")).toBeEnabled();
    const returned = await page.evaluate(() =>
      (
        window as unknown as {
          __AGI_PROJECT__: { query: WorkerQueryFn };
        }
      ).__AGI_PROJECT__.query("playHere", { room: 1, x: 0, y: 0, visit: "back" }),
    );
    expect(
      returned,
      `the worker must hold a Create return point: ${JSON.stringify(returned)}`,
    ).toMatchObject({ ok: true });
    await expect(page.getByRole("radio", { name: "Create", exact: true })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

test("lazy conversation acquisition reports a stale stored project @webkit-desktop", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.addInitScript(() => Reflect.deleteProperty(window, "BroadcastChannel"));
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await waitForRoom(page, 1, { coldBoot: true });
  const projectId = await page.evaluate(() =>
    decodeURIComponent(location.hash.slice("#play/".length)),
  );
  const other = await page.context().newPage();
  await other.goto("/");
  const saved = await other.evaluate(async (id) => {
    const { loadAuthoredGame, saveAuthoredGame } = await import("/src/project/gameStorage.ts");
    const project = id as Parameters<typeof loadAuthoredGame>[0];
    const data = (await loadAuthoredGame(project))!;
    data.authoringState = { ...data.authoringState, sources: { logics: [[1, "return;"]] } };
    if (!(await saveAuthoredGame(project, data))) throw new Error("The other tab could not save.");
    return JSON.stringify(await loadAuthoredGame(project));
  }, projectId);
  await page.getByTestId("menu-assistant").click();
  await expect
    .poll(() =>
      page.evaluate(() => ({
        stale: window.__AGI_STATE__?.staleTab,
        reload: window.__AGI_STATE__?.powerUp.offerReload,
        error: window.__AGI_STATE__?.powerUp.error,
      })),
    )
    .toEqual({
      stale: true,
      reload: true,
      error: "Changed in another tab. Editing is paused. Download your unsaved edits, then reload.",
    });
  expect(
    await other.evaluate(async (id) => {
      const { loadAuthoredGame } = await import("/src/project/gameStorage.ts");
      return JSON.stringify(await loadAuthoredGame(id as Parameters<typeof loadAuthoredGame>[0]));
    }, projectId),
  ).toBe(saved);
});
