import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/** Generated PCM only; no real church recording or external media source. */
function syntheticLongWave(): Buffer {
  const sampleRate = 48000, dataBytes = 28 * 1024 * 1024;
  const data = Buffer.alloc(44 + dataBytes), period = Buffer.alloc(sampleRate * 4);
  for (let i = 0; i < sampleRate; i++) {
    const sample = Math.round(600 * Math.sin(i * 2 * Math.PI * 440 / sampleRate));
    period.writeInt16LE(sample, i * 4); period.writeInt16LE(sample, i * 4 + 2);
  }
  data.fill(period, 44);
  data.write("RIFF", 0); data.writeUInt32LE(data.length - 8, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(2, 22);
  data.writeUInt32LE(sampleRate, 24); data.writeUInt32LE(sampleRate * 4, 28); data.writeUInt16LE(4, 32); data.writeUInt16LE(16, 34);
  data.write("data", 36); data.writeUInt32LE(dataBytes, 40);
  return data;
}

test("native private audio seeks above 25 MiB, downloads exact bytes and loses access on logout", async ({ page, request, context }, testInfo) => {
  test.setTimeout(150000);
  const bytes = syntheticLongWave(), filename = `synthetic-native-${Date.now()}.wav`;
  const login = await request.post("/api/membership/users/login", { data: { email: "admin@example.test", password: "LocalDemo2026!" } });
  expect(login.status()).toBe(200);
  const token = (await login.json()).userChurches[0].jwt, headers = { Authorization: `Bearer ${token}` };
  const saved = await request.post("/api/content/sermons", { headers, data: [{ title: `Synthetic native playback ${Date.now()}`, publishDate: "2026-01-01", visibility: "public" }] });
  expect(saved.status()).toBe(200);
  const sermon = (await saved.json())[0]; let fileId = "", uploadId = "";
  const network: { range: string; status: number; path: string; authorization: string | undefined }[] = [], errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("response", response => {
    const url = new URL(response.url());
    if (url.pathname.startsWith("/api/media/files/")) network.push({ range: response.request().headers().range || "", status: response.status(), path: url.pathname, authorization: response.request().headers().authorization });
  });
  const cdp = await context.newCDPSession(page);
  try {
    const created = await request.post("/api/content/files/uploads", { headers, data: { contentId: sermon.id, fileName: filename, fileType: "audio/wav", size: bytes.length, idempotencyKey: crypto.randomUUID() } });
    expect(created.status()).toBe(201); const upload = await created.json(); uploadId = upload.id;
    for (let n = 1; n <= upload.totalParts; n++) {
      const result = await request.put(`/api/content/files/uploads/${upload.id}/parts/${n}`, { headers: { ...headers, "Content-Type": "application/octet-stream" }, data: bytes.subarray((n - 1) * upload.partSize, n * upload.partSize) });
      expect(result.status()).toBe(200);
    }
    const complete = await request.post(`/api/content/files/uploads/${upload.id}/complete`, { headers, data: {} });
    expect(complete.status()).toBe(200); fileId = (await complete.json()).file.id;
    expect((await request.post(`/api/content/sermons/${sermon.id}/publish`, { headers, data: {} })).status()).toBe(200);

    await page.goto("/portal");
    await page.getByLabel("Email", { exact: true }).fill("member@example.test");
    await page.getByLabel("Password", { exact: true }).fill("LocalDemo2026!");
    const memberSignedIn = page.waitForResponse(response => response.url().endsWith("/api/membership/users/login") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    const memberToken = (await (await memberSignedIn).json()).userChurches[0].jwt as string;
    await expect(page.getByRole("heading", { name: /Hello, Alex/ })).toBeVisible();
    await page.getByRole("button", { name: "Sermons", exact: true }).click();
    const card = page.locator("article").filter({ has: page.getByRole("heading", { name: sermon.title, exact: true }) });
    await card.getByRole("button", { name: "View archive files", exact: true }).click();
    await cdp.send("Network.enable");
    // Keep the initial range from buffering the whole file before the user seeks.
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: 256 * 1024, uploadThroughput: -1 });
    await card.getByRole("button", { name: `Play ${filename}`, exact: true }).click();
    const audio = card.getByLabel(filename, { exact: true });
    await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.readyState), { timeout: 30000 }).toBeGreaterThanOrEqual(1);
    const duration = await audio.evaluate((el: HTMLAudioElement) => el.duration);
    expect(duration).toBeGreaterThan(150);
    const seekTo = duration * 0.96;
    await audio.evaluate((el: HTMLAudioElement, value) => { el.currentTime = value; void el.play(); }, seekTo);
    await expect.poll(() => network.some(item => item.status === 206 && Number(/^bytes=(\d+)-/.exec(item.range)?.[1]) > 25 * 1024 * 1024), { timeout: 30000 }).toBe(true);
    await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.readyState), { timeout: 30000 }).toBeGreaterThanOrEqual(2);
    await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime), { timeout: 10000 }).toBeGreaterThan(seekTo);
    expect(await audio.evaluate((el: HTMLAudioElement) => new URL(el.src).pathname)).toBe(`/api/media/files/${fileId}/play`);
    expect(await audio.evaluate((el: HTMLAudioElement) => new URL(el.src).search)).toBe("");
    // Playwright filters Secure cookies out for HTTP URL queries, even though
    // Chromium accepts/sends them on trustworthy loopback. Inspect the full jar.
    const stored = await context.cookies();
    const mediaCookie = stored.find(cookie => cookie.name === "__Secure-b1-media" && cookie.path === `/api/media/files/${fileId}/`);
    expect(mediaCookie?.httpOnly).toBe(true); expect(mediaCookie?.secure).toBe(true); expect(mediaCookie?.sameSite).toBe("Strict");
    expect(await page.evaluate(() => document.cookie)).not.toContain("b1-media");
    await audio.evaluate((el: HTMLAudioElement) => el.pause());
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await page.screenshot({ path: testInfo.outputPath("native-private-audio-seek.png"), fullPage: true });

    const downloading = page.waitForEvent("download");
    await card.getByRole("button", { name: `Download ${filename}`, exact: true }).click();
    const download = await downloading, actual = await readFile((await download.path())!);
    expect(actual.length).toBe(bytes.length);
    expect(createHash("sha256").update(actual).digest("hex")).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(network.every(item => item.authorization === undefined)).toBe(true);
    expect(errors).toEqual([]);
    // A new completed login must supersede the old file cookie, even before the old
    // account's still-live server session is logged out by its existing UI tab.
    expect(await page.evaluate(async () => (await fetch("/api/membership/users/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "viewer@example.test", password: "LocalDemo2026!" })
    })).status)).toBe(200);
    expect(await page.evaluate(async id => (await fetch(`/api/media/files/${id}/play`, { headers: { Range: "bytes=0-1" }, cache: "no-store" })).status, fileId)).toBe(401);
    expect(await page.evaluate(async ({ id, token }) => (await fetch("/api/media/access", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ fileId: id, audience: "member" }) })).status, { id: fileId, token: memberToken })).toBe(409);
    expect(await page.evaluate(async token => (await fetch("/api/member/v1/me", { headers: { Authorization: `Bearer ${token}` } })).status, memberToken)).toBe(200);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Welcome back", exact: true })).toBeVisible();
    expect(await page.evaluate(async id => (await fetch(`/api/media/files/${id}/play`, { headers: { Range: "bytes=0-1" }, cache: "no-store" })).status, fileId)).toBe(401);
    expect((await context.cookies()).filter(cookie => cookie.name.startsWith("__Secure-b1-media"))).toEqual([]);
  } finally {
    await cdp.detach();
    if (fileId) await request.delete(`/api/content/files/${fileId}`, { headers });
    else if (uploadId) await request.delete(`/api/content/files/uploads/${uploadId}`, { headers });
    await request.delete(`/api/content/sermons/${sermon.id}`, { headers });
  }
});
