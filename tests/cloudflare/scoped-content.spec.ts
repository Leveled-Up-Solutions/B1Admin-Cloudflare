import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("original archive screens respect playlist editing and exact sermon read/edit permissions", async ({ page, request, baseURL }, testInfo) => {
  test.setTimeout(90000);
  const login = await request.post("/api/membership/users/login", { data: { email: "admin@example.test", password: "LocalDemo2026!" } });
  expect(login.ok()).toBeTruthy();
  const headers = { Authorization: "Bearer " + (await login.json()).userChurches[0].jwt };
  async function api(path: string, method = "GET", data?: unknown) {
    const response = await request.fetch("/api" + path, { method, headers, data });
    expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy();
    return response.json();
  }
  const stamp = Date.now();
  const problems: string[] = [], calls: string[] = [];
  page.on("pageerror", error => problems.push(error.message));
  page.on("request", req => {
    const url = new URL(req.url());
    if (url.origin !== new URL(baseURL!).origin && !["blob:", "data:"].includes(url.protocol)) problems.push("External request");
    if (url.pathname.startsWith("/api/")) calls.push(url.pathname);
  });
  page.on("response", response => { if (response.url().includes("/api/") && response.status() >= 400) problems.push(`${response.status()} ${new URL(response.url()).pathname}`); });
  let roleId = "", playlistId = "", otherPlaylistId = "", sermonId = "", otherSermonId = "", fileId = "", addedId = "";
  let grants: { id: string }[] = [];
  async function setGrant(contentType: string, contentId: string, action: string) {
    for (const grant of grants) await api("/membership/rolepermissions/" + grant.id, "DELETE");
    grants = await api("/membership/rolepermissions", "POST", [{ roleId, apiName: "ContentApi", contentType, contentId, action }]);
  }
  async function signIn() {
    await page.goto("/login");
    await page.locator('input[type="email"]').fill("member@example.test");
    await page.locator('input[type="password"]').fill("LocalDemo2026!");
    const signedIn = page.waitForResponse(response => response.url().endsWith("/api/membership/users/login") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    const token = (await (await signedIn).json()).userChurches[0].jwt;
    await page.getByRole("link", { name: "Sermons", exact: true }).first().click();
    await expect(page.getByTestId("edit-sermon-" + sermonId)).toBeVisible();
    return token as string;
  }
  try {
    [playlistId, otherPlaylistId] = (await api("/content/playlists", "POST", [{ title: `Scoped playlist ${stamp}` }, { title: `Hidden playlist ${stamp}` }])).map((item: { id: string }) => item.id);
    [sermonId, otherSermonId] = (await api("/content/sermons", "POST", [{ title: `Scoped sermon ${stamp}`, playlistId, publishDate: "2026-01-01", visibility: "private" }, { title: `Hidden sermon ${stamp}`, playlistId: otherPlaylistId, publishDate: "2026-01-01", visibility: "private" }])).map((item: { id: string }) => item.id);
    const bytes = Buffer.from("Synthetic scoped archive notes. No church records.\n");
    const uploaded = await request.post(`/api/content/files/upload?contentId=${sermonId}&fileName=scoped-notes.txt`, { headers: { ...headers, "Content-Type": "text/plain" }, data: bytes });
    expect(uploaded.status()).toBe(201); fileId = (await uploaded.json())[0].id;
    roleId = (await api("/membership/roles", "POST", [{ name: `Scoped archive ${stamp}` }]))[0].id;
    await api("/membership/rolemembers", "POST", [{ roleId, personId: "person-alex" }]);
    await setGrant("Playlists", playlistId, "Edit");
    const scopedToken = await signIn();
    await expect(page.getByTestId("edit-sermon-" + otherSermonId)).toHaveCount(0);
    await expect(page.getByTestId("add-playlist-button")).toHaveCount(0);
    await page.getByTestId("edit-playlist-" + playlistId).click();
    await page.getByTestId("playlist-title-input").locator("input").fill(`Scoped playlist revised ${stamp}`);
    await page.getByTestId("edit-playlist-inputbox").getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByTestId("edit-playlist-inputbox")).toHaveCount(0);
    await page.getByTestId("add-sermon-button").click();
    await page.getByRole("menuitem", { name: /Add Sermon/i }).click();
    const editor = page.getByTestId("sermon-edit-box");
    await expect(editor.getByTestId("sermon-playlist-select")).toContainText(`Scoped playlist revised ${stamp}`);
    await editor.getByTestId("sermon-title-input").locator("input").fill(`Scoped new sermon ${stamp}`);
    const saved = page.waitForResponse(response => response.url().endsWith("/api/content/sermons") && response.request().method() === "POST");
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    const created = await saved; expect(created.ok()).toBeTruthy(); addedId = (await created.json())[0].id;
    expect((await api("/content/sermons/" + addedId)).playlistId).toBe(playlistId);
    expect((await request.get("/api/content/sermons/" + otherSermonId, { headers: { Authorization: "Bearer " + scopedToken } })).status()).toBe(403);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();

    await setGrant("Sermons", sermonId, "View");
    calls.length = 0;
    await signIn();
    await expect(page.getByTestId("add-sermon-button")).toHaveCount(0);
    await expect(page.getByTestId("edit-sermon-" + sermonId)).toHaveText("View");
    await page.getByTestId("edit-sermon-" + sermonId).click();
    const details = page.getByTestId("sermon-readonly-details");
    await expect(details).toContainText(`Scoped playlist revised ${stamp}`);
    await expect(details.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
    await expect(details.getByLabel("Sermon archive file", { exact: true })).toHaveCount(0);
    await expect(details.getByRole("button", { name: "Delete scoped-notes.txt", exact: true })).toHaveCount(0);
    const downloading = page.waitForEvent("download");
    await details.getByRole("button", { name: "Download scoped-notes.txt", exact: true }).click();
    const download = await downloading, destination = testInfo.outputPath("scoped-notes.txt");
    await download.saveAs(destination); expect(await readFile(destination)).toEqual(bytes);
    expect(calls.some(path => path === "/api/content/playlists" || path === "/api/content/files/uploads" || path.startsWith("/api/membership/people"))).toBe(false);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();

    await setGrant("Sermons", sermonId, "Edit");
    await signIn();
    await page.getByTestId("edit-sermon-" + sermonId).click();
    await expect(editor.getByTestId("sermon-playlist-select")).toContainText(`Scoped playlist revised ${stamp}`);
    await editor.getByTestId("sermon-title-input").locator("input").fill(`Exact sermon edit ${stamp}`);
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor).toHaveCount(0);
    expect((await api("/content/sermons/" + sermonId)).title).toBe(`Exact sermon edit ${stamp}`);
    expect(problems).toEqual([]);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
  } finally {
    await page.goto("about:blank").catch(() => undefined);
    if (roleId) await api("/membership/roles/" + roleId, "DELETE");
    if (fileId) await api("/content/files/" + fileId, "DELETE");
    for (const id of [addedId, sermonId, otherSermonId].filter(Boolean)) await api("/content/sermons/" + id, "DELETE");
    for (const id of [playlistId, otherPlaylistId].filter(Boolean)) await api("/content/playlists/" + id, "DELETE");
    await api("/membership/users/logout", "POST", {});
  }
});
