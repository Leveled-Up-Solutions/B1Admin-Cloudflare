import { expect, test, type Page, type Route } from "@playwright/test";
import { createHash } from "node:crypto";

async function signIn(page: Page) {
  await page.goto("/login");
  await page.locator('input[type="email"]').fill("admin@example.test");
  await page.locator('input[type="password"]').fill("LocalDemo2026!");
  const response = page.waitForResponse(r => r.url().endsWith("/api/membership/users/login") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const result = await (await response).json();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  return result.userChurches[0].jwt as string;
}

test("archive multipart upload pauses, reloads, verifies the original file, resumes and aborts", async ({ page, request, baseURL }, testInfo) => {
  test.setTimeout(120000);
  const external: string[] = [], errors: string[] = [], tokenUrls: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", req => {
    const url = req.url();
    if (!url.startsWith(baseURL!) && !url.startsWith("data:") && !url.startsWith("blob:")) external.push(url);
    if (/https?:/.test(url) && [...new URL(url).searchParams.keys()].some(key => /jwt|token|authorization/i.test(key))) tokenUrls.push(url);
  });
  const token = await signIn(page);
  const headers = { Authorization: `Bearer ${token}` };
  const sermonResponse = await request.post("/api/content/sermons", { headers, data: [{ title: `Synthetic resumable archive ${Date.now()}`, publishDate: "2026-01-01", visibility: "private" }] });
  expect(sermonResponse.ok()).toBeTruthy();
  const sermonId = (await sermonResponse.json())[0].id;
  const filename = "synthetic-resumable-sermon.mp4";
  const bytes = Buffer.alloc(8 * 1024 * 1024 + 123, 65);
  bytes.fill(66, 8 * 1024 * 1024);
  const partTwoPattern = "**/api/content/files/uploads/*/parts/2";
  let heldRoute: Route | undefined;
  let fileId = "";
  try {
    await page.getByRole("link", { name: "Sermons", exact: true }).first().click();
    await page.getByTestId("edit-sermon-" + sermonId).click();
    const archive = page.getByTestId("sermon-archive-files");
    await archive.getByLabel("Sermon archive file", { exact: true }).setInputFiles({ name: filename, mimeType: "video/mp4", buffer: bytes });
    await archive.getByRole("checkbox", { name: "Use resumable upload for this file", exact: true }).check();
    await page.route(partTwoPattern, route => { heldRoute = route; });
    const created = page.waitForResponse(response => response.url().endsWith("/api/content/files/uploads") && response.request().method() === "POST");
    await archive.getByRole("button", { name: "Upload archive file", exact: true }).click();
    const createdResponse = await created;
    expect(createdResponse.status()).toBe(201);
    const sessionId = (await createdResponse.json()).id;
    await expect.poll(() => Boolean(heldRoute)).toBe(true);
    await archive.getByRole("button", { name: "Pause upload", exact: true }).click();
    await heldRoute!.abort().catch(() => undefined); heldRoute = undefined;
    await page.unroute(partTwoPattern);
    await expect(archive.getByText("Upload paused. Select the same file and resume when ready.", { exact: true })).toBeVisible();
    const paused = await request.get(`/api/content/files/uploads/${sessionId}`, { headers });
    expect((await paused.json()).parts.map((part: { partNumber: number }) => part.partNumber)).toEqual([1]);
    await page.screenshot({ path: testInfo.outputPath("paused-sermon-upload.png"), fullPage: true });

    await page.reload();
    // Administrator authentication intentionally stays in memory across page loads.
    await signIn(page);
    await page.getByRole("link", { name: "Sermons", exact: true }).first().click();
    await page.getByTestId("edit-sermon-" + sermonId).click();
    await expect(archive.getByTestId("archive-upload-" + sessionId)).toBeVisible();
    const wrongBytes = Buffer.from(bytes); wrongBytes[0] = 90;
    await archive.getByLabel("Sermon archive file", { exact: true }).setInputFiles({ name: filename, mimeType: "video/mp4", buffer: wrongBytes });
    await archive.getByRole("button", { name: "Resume " + filename, exact: true }).click();
    await expect(archive.getByText("This file does not match the uploaded parts. Select the original file, or abort this upload and start again.", { exact: true })).toBeVisible();
    const unchanged = await request.get(`/api/content/files/uploads/${sessionId}`, { headers });
    expect((await unchanged.json()).parts.map((part: { partNumber: number }) => part.partNumber)).toEqual([1]);
    await archive.getByLabel("Sermon archive file", { exact: true }).setInputFiles({ name: filename, mimeType: "video/mp4", buffer: bytes });
    await archive.getByRole("button", { name: "Resume " + filename, exact: true }).click();
    await expect(archive.getByText("Archive upload complete.", { exact: true })).toBeVisible();
    await expect(archive.getByTestId("archive-upload-" + sessionId)).toHaveCount(0);
    await expect(archive.getByRole("button", { name: "Download " + filename, exact: true })).toBeVisible();
    const finished = await request.get(`/api/content/files/uploads/${sessionId}`, { headers });
    const completed = await finished.json();
    expect(completed.state).toBe("complete"); fileId = completed.file.id;
    const downloaded = await request.get(`/api/content/files/download/${fileId}`, { headers });
    expect(downloaded.status()).toBe(200);
    const savedBytes = await downloaded.body();
    expect(savedBytes.length).toBe(bytes.length);
    expect(createHash("sha256").update(savedBytes).digest("hex")).toBe(createHash("sha256").update(bytes).digest("hex"));

    const abortFilename = "synthetic-aborted-sermon.mp4";
    await archive.getByLabel("Sermon archive file", { exact: true }).setInputFiles({ name: abortFilename, mimeType: "video/mp4", buffer: bytes });
    await archive.getByRole("checkbox", { name: "Use resumable upload for this file", exact: true }).check();
    await page.route(partTwoPattern, route => { heldRoute = route; });
    await archive.getByRole("button", { name: "Upload archive file", exact: true }).click();
    await expect.poll(() => Boolean(heldRoute)).toBe(true);
    await archive.getByRole("button", { name: "Pause upload", exact: true }).click();
    await heldRoute!.abort().catch(() => undefined); heldRoute = undefined;
    await page.unroute(partTwoPattern);
    const abortButton = archive.getByRole("button", { name: "Abort " + abortFilename, exact: true });
    await expect(abortButton).toBeEnabled();
    page.once("dialog", dialog => dialog.accept());
    await abortButton.click();
    await expect(archive.getByText("Upload aborted.", { exact: true })).toBeVisible();
    await expect(abortButton).toHaveCount(0);
    await expect(archive.getByRole("button", { name: "Download " + abortFilename, exact: true })).toHaveCount(0);
    await expect(archive.getByRole("button", { name: "Download " + filename, exact: true })).toBeVisible();

    // Aborting must discard the idempotency key without requiring a file-input change.
    await page.route(partTwoPattern, route => { heldRoute = route; });
    const restarted = page.waitForResponse(response => response.url().endsWith("/api/content/files/uploads") && response.request().method() === "POST");
    await archive.getByRole("button", { name: "Upload archive file", exact: true }).click();
    expect((await restarted).status()).toBe(201);
    await expect.poll(() => Boolean(heldRoute)).toBe(true);
    await archive.getByRole("button", { name: "Pause upload", exact: true }).click();
    await heldRoute!.abort().catch(() => undefined); heldRoute = undefined;
    await page.unroute(partTwoPattern);
    await expect(abortButton).toBeEnabled();
    page.once("dialog", dialog => dialog.accept());
    await abortButton.click();
    await expect(archive.getByText("Upload aborted.", { exact: true })).toBeVisible();
    await expect(abortButton).toHaveCount(0);
    expect(external).toEqual([]); expect(errors).toEqual([]); expect(tokenUrls).toEqual([]);
  } finally {
    if (heldRoute) await heldRoute.abort().catch(() => undefined);
    await page.unroute(partTwoPattern).catch(() => undefined);
    const sessions = await request.get("/api/content/files/uploads?contentId=" + sermonId, { headers });
    if (sessions.ok()) for (const session of await sessions.json()) await request.delete(`/api/content/files/uploads/${session.id}`, { headers });
    if (fileId) await request.delete(`/api/content/files/${fileId}`, { headers });
    const files = await request.get("/api/content/files/sermon/" + sermonId, { headers });
    if (files.ok()) for (const file of await files.json()) await request.delete(`/api/content/files/${file.id}`, { headers });
    await request.delete(`/api/content/sermons/${sermonId}`, { headers });
  }
});

test("files above 25 MiB automatically use multipart and explain the browser download limit", async ({ page, request }) => {
  test.setTimeout(90000);
  const token = await signIn(page);
  const headers = { Authorization: `Bearer ${token}` };
  const saved = await request.post("/api/content/sermons", { headers, data: [{ title: `Synthetic large archive ${Date.now()}`, publishDate: "2026-01-01", visibility: "private" }] });
  expect(saved.ok()).toBeTruthy();
  const sermonId = (await saved.json())[0].id;
  const filename = "synthetic-large-sermon.mp4";
  let fileId = "";
  try {
    await page.getByRole("link", { name: "Sermons", exact: true }).first().click();
    await page.getByTestId("edit-sermon-" + sermonId).click();
    const archive = page.getByTestId("sermon-archive-files");
    await archive.getByLabel("Sermon archive file", { exact: true }).setInputFiles({ name: filename, mimeType: "video/mp4", buffer: Buffer.alloc(25 * 1024 * 1024 + 1, 65) });
    await expect(archive.getByRole("checkbox", { name: "Use resumable upload for this file", exact: true })).not.toBeChecked();
    const completed = page.waitForResponse(response => /\/api\/content\/files\/uploads\/[^/]+\/complete$/.test(response.url()) && response.request().method() === "POST");
    await archive.getByRole("button", { name: "Upload archive file", exact: true }).click();
    const response = await completed;
    expect(response.status()).toBe(200);
    const session = await response.json(); fileId = session.file.id;
    expect(session.totalParts).toBe(4);
    expect(session.file.size).toBe(25 * 1024 * 1024 + 1);
    const downloads: string[] = [];
    page.on("request", req => { if (req.url().includes("/files/download/")) downloads.push(req.url()); });
    await archive.getByRole("button", { name: "Download " + filename, exact: true }).click();
    await expect(archive.getByText("Browser downloads currently support files up to 25 MiB. This file is archived, but cannot be downloaded here yet.", { exact: true })).toBeVisible();
    expect(downloads).toEqual([]);
  } finally {
    if (fileId) await request.delete(`/api/content/files/${fileId}`, { headers });
    const sessions = await request.get("/api/content/files/uploads?contentId=" + sermonId, { headers });
    if (sessions.ok()) for (const session of await sessions.json()) await request.delete(`/api/content/files/uploads/${session.id}`, { headers });
    const files = await request.get("/api/content/files/sermon/" + sermonId, { headers });
    if (files.ok()) for (const file of await files.json()) await request.delete(`/api/content/files/${file.id}`, { headers });
    await request.delete(`/api/content/sermons/${sermonId}`, { headers });
  }
});
