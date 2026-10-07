import { clickContextAction } from "./workspaceShared.ts";
import { expect, reviewShot, test } from "./test.ts";
import { isolateStorage, textHook, savePlayProgress, workspaceUpdated } from "./engineProbe.ts";
import type { Page } from "@playwright/test";
import type { ProjectSession } from "../src/project/projectSession.ts";

async function starter(page: Page): Promise<void> {
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page
    .getByTestId("create-adventure-disclosure")
    .getByLabel("Name", { exact: true })
    .fill("Sound proof");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await expect(page.getByTestId("parts-list")).toBeVisible();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
}

test("SOUND drafts audition privately and play in MAIN after Update game @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await starter(page);
  await page.getByTestId("part-sound:1").click();
  const panel = page.getByTestId("workspace-sound");
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Tracker", exact: true }).click();
  await panel.locator("[data-note-id] input.note").first().focus();
  await panel.getByText("Details", { exact: true }).click();
  await panel.getByLabel("Note", { exact: true }).fill("A4");
  await panel.getByLabel("Note", { exact: true }).press("Tab");
  await panel.getByLabel("Length in beats").fill("4");
  await panel.getByLabel("Length in beats").press("Tab");
  await panel.getByLabel("Volume", { exact: true }).fill("12");
  await panel.getByLabel("Volume", { exact: true }).press("Tab");
  await expect(page.getByTestId("workspace-saved")).toBeVisible();
  await expect(page.getByTestId("workspace-saved")).toHaveText(/^(?:Saved|Draft saved)$/);
  await expect(panel.getByLabel("Note", { exact: true })).toHaveValue("A4");
  await expect(panel.getByLabel("Length in beats")).toHaveValue("4");

  // A4: round((3,579,545 / 32) / 440) = 254 = 0x0fe.
  await expect(panel.getByLabel("Divisor", { exact: true })).toBeVisible();
  await expect(panel.getByLabel("Divisor", { exact: true })).toHaveValue("254");
  await expect(panel.getByLabel("Attenuation", { exact: true })).toHaveValue("3");
  await expect(panel.getByLabel("Ticks", { exact: true })).toHaveValue("120");
  const stored = await page.evaluate(() => {
    const session = (
      window as unknown as {
        __AGI_PROJECT__: {
          getSession(): ProjectSession;
        };
      }
    ).__AGI_PROJECT__.getSession();
    return [...(session.workingSnapshot().read("sound:1")!.content as Uint8Array).slice(8, 13)];
  });
  expect(stored).toEqual([120, 0, 15, 142, 147]);
  await panel.getByLabel("Ticks", { exact: true }).scrollIntoViewIfNeeded();
  await reviewShot(page, "sound-details");
  await panel.getByText("Details", { exact: true }).click();
  const cycle = (await textHook(page)).cycle;
  await page.evaluate(async () => {
    const { AgiAudio } = await import("/src/audio/AgiAudio.ts");
    const original = AgiAudio.prototype.outputTick;
    const samples: { owner: string; outputs: unknown[] }[] = [];
    (window as unknown as { soundSamples: typeof samples }).soundSamples = samples;
    AgiAudio.prototype.outputTick = function (packet) {
      if (samples.length < 1000)
        samples.push({
          owner: this === window.__AGI_AUDIO__ ? "main" : "audition",
          outputs: [...packet.outputs],
        });
      return original.call(this, packet);
    };
  });
  await panel.getByTestId("sound-play").click();
  await expect(panel.getByTestId("sound-play")).toHaveAttribute("aria-label", "Stop");
  await expect.poll(async () => (await textHook(page)).cycle).toBeGreaterThan(cycle);
  await expect.poll(() => page.evaluate(() => window.__AGI_AUDIO__?.isPlaying)).toBe(false);
  await reviewShot(page, "sound-playing");
  await panel.getByTestId("sound-play").press("Space");
  await expect(panel.getByTestId("sound-play")).toHaveAttribute("aria-label", "Play");
  await workspaceUpdated(page);
  await page.keyboard.press("Control+`");
  await page.keyboard.type("listen");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await textHook(page)).rows.join("\n")).toContain("meadowlark");
  await expect.poll(() => page.evaluate(() => window.__AGI_AUDIO__?.isPlaying)).toBe(true);
  const samples = await page.evaluate(
    () =>
      (
        window as unknown as {
          soundSamples: {
            owner: string;
            outputs: { kind: string; divisor?: number; bytes?: number[] }[];
          }[];
        }
      ).soundSamples,
  );
  for (const owner of ["main", "audition"]) {
    const outputs = samples
      .filter((sample) => sample.owner === owner)
      .flatMap((sample) => sample.outputs);
    expect(
      outputs.some(
        (output) =>
          output.kind === "psg" && output.bytes?.[0] === 0x8e && output.bytes?.[1] === 0x0f,
      ),
    ).toBe(true);
  }
  await reviewShot(page, "sound-listen");
  await page.keyboard.press("Enter");
  await savePlayProgress(page);
  await page.reload();
  await expect(page.getByTestId("parts-list")).toBeVisible();
  await page.getByTestId("part-sound:1").click();
  await panel.getByRole("button", { name: "Tracker", exact: true }).click();
  await panel.locator("[data-note-id] input.note").first().focus();
  await panel.getByText("Details", { exact: true }).click();
  await expect(panel.getByLabel("Note", { exact: true })).toHaveValue("A4");
  await expect(panel.getByLabel("Volume", { exact: true })).toHaveValue("12");
});

test("sound presets, note keyboard edits and guided cue creation share the workspace @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await starter(page);
  await page
    .getByTestId("parts-list")
    .getByRole("button", { name: "Add a sound", exact: true })
    .click();
  const panel = page.getByTestId("workspace-sound").filter({ visible: true });
  await expect(panel.getByRole("heading", { name: "SOUND 2", exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Tracker", exact: true }).click();
  await expect(panel.locator("[data-note-id]")).toHaveCount(3);
  await panel.getByRole("button", { name: "Choose preset", exact: true }).click();
  const picker = panel.getByRole("group", { name: "New sound from a recipe", exact: true });
  await expect(picker).toBeVisible();
  await picker.getByRole("button", { name: "Play Danger", exact: true }).click();
  await picker.getByRole("button", { name: "Danger", exact: true }).click();
  await expect(panel.getByRole("heading", { name: "SOUND 3", exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Tracker", exact: true }).click();
  await expect(panel.locator("[data-note-id]")).toHaveCount(4);
  const note = panel.getByLabel("Voice 1, tick 34, note", { exact: true });
  await note.fill("A4");
  await note.press("Enter");
  await note.focus();
  await panel.getByText("Details", { exact: true }).click();
  await panel.getByLabel("Length in beats").fill("1");
  await panel.getByLabel("Length in beats").press("Tab");
  await expect(panel.getByLabel("Note", { exact: true })).toHaveValue("A4");
  await panel.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(note).toHaveValue("Rest");
  await note.fill("A4");
  await note.press("Enter");
  await expect(panel.locator("[data-note-id]")).toHaveCount(5);
  await expect(page.getByTestId("workspace-saved")).toBeVisible();
  await expect(page.getByTestId("workspace-saved")).toHaveText(/^(?:Saved|Draft saved)$/);
  await reviewShot(page, "sound-notes");
  await page.getByTestId("part-room:1:logic").click();
  await clickContextAction(page, "room-action-play-sound");
  const form = page.getByTestId("workspace-guided-form");
  await expect(form).toBeVisible();
  await form.getByLabel("When the player types…", { exact: true }).fill("help");
  await form.getByRole("button", { name: "Success", exact: true }).click();
  await form.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByTestId("part-sound:4")).toBeVisible();
  await expect(page.getByTestId("workspace-saved")).toBeVisible();
  await expect(page.getByTestId("workspace-saved")).toHaveText(/^(?:Saved|Draft saved)$/);
  await page.getByTestId("part-sound:4").click();
  const success = page.getByTestId("workspace-sound").filter({ visible: true });
  await success.getByRole("button", { name: "Tracker", exact: true }).click();
  await expect(success.locator("[data-note-id]")).toHaveCount(5);
  await reviewShot(page, "sound-preset-success");
  await page.getByTestId("part-sound:3").click();
  const retained = page.getByTestId("workspace-sound").filter({ visible: true });
  await expect(retained.getByLabel("Note", { exact: true })).toHaveValue("A4");
  await workspaceUpdated(page);
  await retained.getByLabel("Tempo", { exact: true }).fill("240");
  await retained.getByLabel("Tempo", { exact: true }).press("Tab");
  await expect(page.getByTestId("workspace-saved")).toBeVisible();
  await expect(page.getByTestId("workspace-saved")).toHaveText(/^(?:Saved|Draft saved)$/);
  await retained.locator("td.voice-0[data-note-id] input.note").last().focus();

  await expect(retained.getByLabel("Ticks", { exact: true })).toHaveValue("15");
  await workspaceUpdated(page);
  await page.getByTestId("workspace-undo").click();
  await expect(page.getByTestId("workspace-saved")).toBeVisible();
  await expect(page.getByTestId("workspace-saved")).toHaveText(/^(?:Saved|Draft saved)$/);
  await retained.locator("td.voice-0[data-note-id] input.note").last().focus();
  await expect(retained.getByLabel("Ticks", { exact: true })).toHaveValue("30");
  await expect(retained.getByLabel("Tempo", { exact: true })).toHaveValue("120");
  await page.getByTestId("workspace-redo").click();
  await expect(page.getByTestId("workspace-saved")).toBeVisible();
  await expect(page.getByTestId("workspace-saved")).toHaveText(/^(?:Saved|Draft saved)$/);
  await savePlayProgress(page);
  await page.reload();
  await expect(page.getByTestId("parts-list")).toBeVisible();
  await page.getByTestId("part-sound:3").click();
  const reopened = page.getByTestId("workspace-sound").filter({ visible: true });
  await expect(reopened.getByLabel("Tempo", { exact: true })).toHaveValue("240");
});

test("a SOUND edit survives an immediate reload before the project write @webkit-desktop", async ({
  page,
}) => {
  await starter(page);
  await page.getByTestId("part-sound:1").click();
  await expect(page.getByTestId("workspace-sound")).toBeVisible();
  await page.evaluate(async () => {
    const session = (
      window as unknown as {
        __AGI_PROJECT__: {
          getSession(): ProjectSession;
        };
      }
    ).__AGI_PROJECT__.getSession();
    const { soundProjectChanges } = await import("/src/studio/sound/soundEdits.ts");
    const content = session.model.capture().read("sound:1")!.content as Uint8Array;
    await session.submit({
      proposal: session.model.propose(
        session.model.capture(),
        "Tempo",
        soundProjectChanges("sound:1", content, 240),
      ),
      label: "Tempo",
      origin: "sound",
      author: "creator",
    });
    location.reload();
  });
  await expect(page.getByTestId("parts-list")).toBeVisible();
  await page.getByTestId("part-sound:1").click();
  await expect(
    page.getByTestId("workspace-sound").getByLabel("Tempo", { exact: true }),
  ).toHaveValue("240");
});
