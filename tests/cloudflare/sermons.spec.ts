import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

async function signIn(page: Page) {
  await page.goto("/login");
  await page.locator('input[type="email"]').fill("admin@example.test");
  await page.locator('input[type="password"]').fill("LocalDemo2026!");
  const response = page.waitForResponse(r => r.url().endsWith("/api/membership/users/login") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const result = await (await response).json();
  await expect(page.getByRole("heading", { name: "Church administration", exact: true })).toBeVisible();
  return result.userChurches[0].jwt as string;
}

const writeResponse = (page: Page, resource: string) => page.waitForResponse(r => r.url().endsWith("/api/content/" + resource) && r.request().method() === "POST");

test("original sermon and playlist UI persists R2 archives and explicit member publication", async ({ page, request, baseURL }, testInfo) => {
  test.setTimeout(90000);
  const external: string[] = [];
  const errors: string[] = [];
  const failedApi: string[] = [];
  page.on("request", r => { if (!r.url().startsWith(baseURL!) && !r.url().startsWith("data:") && !r.url().startsWith("blob:")) external.push(r.url()); });
  page.on("pageerror", e => errors.push(e.message));
  page.on("response", r => { if (r.url().includes("/api/") && r.status() >= 400) failedApi.push(`${r.status()} ${r.url()}`); });
  const adminJwt = await signIn(page);
  const headers = { Authorization: "Bearer " + adminJwt };
  const unique = Date.now().toString();
  const playlistTitle = "Synthetic playlist " + unique;
  const sermonTitle = "Synthetic sermon " + unique;
  const filename = "synthetic-sermon-notes.txt";
  const fileBytes = Buffer.from("Synthetic development sermon notes. No church records.\n", "utf8");
  let playlistId = ""; let sermonId = ""; let fileId = "";
  try {
    await page.getByRole("link", { name: "Sermons", exact: true }).first().click();
    await expect(page.getByRole("heading", { name: "Sermons", exact: true }).first()).toBeVisible();
    await page.getByTestId("add-playlist-button").click();
    const playlistEditor = page.getByTestId("edit-playlist-inputbox");
    await playlistEditor.getByTestId("playlist-title-input").locator("input").fill(playlistTitle);
    await playlistEditor.getByTestId("playlist-description-input").locator("textarea").first().fill("Synthetic archive workflow test");
    const playlistSave = writeResponse(page, "playlists");
    await playlistEditor.getByRole("button", { name: "Save", exact: true }).click();
    const playlistResponse = await playlistSave;
    expect(playlistResponse.ok()).toBeTruthy();
    playlistId = (await playlistResponse.json())[0].id;
    await expect(page.getByTestId("edit-playlist-" + playlistId)).toBeVisible();

    await page.getByTestId("add-sermon-button").click();
    await page.getByRole("menuitem", { name: /Add Sermon/i }).click();
    let editor = page.getByTestId("sermon-edit-box");
    await editor.getByTestId("sermon-title-input").locator("input").fill(sermonTitle);
    await editor.getByTestId("sermon-description-input").locator("textarea").first().fill("Synthetic saved sermon for member archive verification.");
    await editor.getByTestId("publish-date-input").locator("input").fill("2026-01-01");
    await editor.getByTestId("sermon-playlist-select").click();
    await page.getByRole("option", { name: playlistTitle, exact: true }).click();
    await editor.getByLabel("Speaker", { exact: true }).fill("Synthetic speaker");
    await editor.getByRole("combobox", { name: "Archive visibility" }).click();
    await page.getByRole("option", { name: "Member archive", exact: true }).click();
    const sermonSave = writeResponse(page, "sermons");
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    const sermonResponse = await sermonSave;
    expect(sermonResponse.ok()).toBeTruthy();
    sermonId = (await sermonResponse.json())[0].id;
    await page.getByTestId("edit-sermon-" + sermonId).click();
    editor = page.getByTestId("sermon-edit-box");
    await expect(editor.getByLabel("Speaker", { exact: true })).toHaveValue("Synthetic speaker");
    await expect(editor.getByText("Saved publication status: Unpublished")).toBeVisible();

    const archive = editor.getByTestId("sermon-archive-files");
    await archive.getByLabel("Sermon archive file", { exact: true }).setInputFiles({ name: filename, mimeType: "text/plain", buffer: fileBytes });
    const uploaded = page.waitForResponse(r => r.url().includes("/api/content/files/upload?") && r.request().method() === "POST");
    await archive.getByRole("button", { name: "Upload archive file", exact: true }).click();
    const uploadResponse = await uploaded;
    expect(uploadResponse.status()).toBe(201);
    await expect(archive.getByRole("button", { name: "Download " + filename, exact: true })).toBeVisible();
    const savedFiles = await request.get("/api/content/files/sermon/" + sermonId, { headers });
    fileId = (await savedFiles.json()).find((file: { fileName: string }) => file.fileName === filename).id;
    const downloading = page.waitForEvent("download");
    await archive.getByRole("button", { name: "Download " + filename, exact: true }).click();
    const download = await downloading;
    const destination = testInfo.outputPath(filename);
    await download.saveAs(destination);
    expect(await readFile(destination)).toEqual(fileBytes);
    await page.screenshot({ path: testInfo.outputPath("sermon-archive-editor.png"), fullPage: true });

    const memberLogin = await request.post("/api/membership/users/login", { data: { email: "member@example.test", password: "LocalDemo2026!" } });
    expect(memberLogin.ok()).toBeTruthy();
    const memberJwt = (await memberLogin.json()).userChurches[0].jwt;
    const memberHeaders = { Authorization: "Bearer " + memberJwt };
    const beforePublish = await request.get("/api/member/v1/sermons", { headers: memberHeaders });
    expect((await beforePublish.json()).some((s: { id: string }) => s.id === sermonId)).toBeFalsy();
    await editor.getByRole("button", { name: "Publish saved sermon", exact: true }).click();
    await expect(page.getByTestId("sermon-edit-box")).toHaveCount(0);
    const published = await request.get("/api/member/v1/sermons", { headers: memberHeaders });
    expect((await published.json()).some((s: { id: string }) => s.id === sermonId)).toBeTruthy();
    const memberFile = await request.get("/api/member/v1/files/" + fileId + "/download", { headers: memberHeaders });
    expect(memberFile.ok()).toBeTruthy();
    expect(await memberFile.body()).toEqual(fileBytes);

    await page.getByTestId("edit-sermon-" + sermonId).click();
    editor = page.getByTestId("sermon-edit-box");
    await expect(editor.getByText("Saved publication status: Published")).toBeVisible();
    await editor.getByRole("button", { name: "Unpublish sermon", exact: true }).click();
    await expect(page.getByTestId("sermon-edit-box")).toHaveCount(0);
    const unpublished = await request.get("/api/member/v1/sermons", { headers: memberHeaders });
    expect((await unpublished.json()).some((s: { id: string }) => s.id === sermonId)).toBeFalsy();
    expect((await request.get("/api/member/v1/files/" + fileId + "/download", { headers: memberHeaders })).status()).toBe(404);

    await page.getByTestId("edit-sermon-" + sermonId).click();
    editor = page.getByTestId("sermon-edit-box");
    page.once("dialog", dialog => dialog.accept());
    await editor.getByRole("button", { name: "Delete " + filename, exact: true }).click();
    await expect(editor.getByText("No files attached.", { exact: true })).toBeVisible();
    fileId = "";
    await editor.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByTestId("edit-sermon-" + sermonId)).toHaveCount(0);
    sermonId = "";

    await page.getByTestId("edit-playlist-" + playlistId).click();
    await page.getByTestId("edit-playlist-inputbox").getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByTestId("edit-playlist-" + playlistId)).toHaveCount(0);
    playlistId = "";
    expect(external).toEqual([]);
    expect(errors).toEqual([]);
    expect(failedApi).toEqual([]);
  } finally {
    if (fileId) await request.delete("/api/content/files/" + fileId, { headers });
    if (sermonId) {
      // If a hot reload interrupted the upload response, still clean this test's attachments.
      const remainingFiles = await request.get("/api/content/files/sermon/" + sermonId, { headers });
      if (remainingFiles.ok()) for (const file of await remainingFiles.json()) await request.delete("/api/content/files/" + file.id, { headers });
      await request.delete("/api/content/sermons/" + sermonId, { headers });
    }
    if (playlistId) await request.delete("/api/content/playlists/" + playlistId, { headers });
  }
});
