import { expect, test } from "@playwright/test";

function syntheticWave(): Buffer {
  const samples = 22050;
  const data = Buffer.alloc(44 + samples * 2);
  data.write("RIFF", 0); data.writeUInt32LE(data.length - 8, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(samples, 24); data.writeUInt32LE(samples * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write("data", 36); data.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(800 * Math.sin(i * 2 * Math.PI * 440 / samples)), 44 + i * 2);
  return data;
}

test("mobile member portal supports local group and serving actions with authenticated archive playback", async ({ page, request, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const stamp = String(Date.now());
  const signIn = await request.post("/api/membership/users/login", { data: { email: "admin@example.test", password: "LocalDemo2026!" } });
  expect(signIn.ok()).toBeTruthy();
  const admin = (await signIn.json()).userChurches[0].jwt;
  const headers = { Authorization: `Bearer ${admin}` };
  async function api(path: string, method: string, data?: unknown) {
    const response = await request.fetch(`/api${path}`, { method, headers, data });
    expect(response.ok(), `${method} ${path}`).toBeTruthy();
    return response.json();
  }
  const records: { group?: string; plan?: string; file?: string } = {};
  const errors: string[] = [], external: string[] = [], apiFailures: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("response", response => { if (response.url().includes("/api/") && response.status() >= 400) apiFailures.push(`${response.status()} ${new URL(response.url()).pathname}`); });
  await page.route("**/*", route => {
    if (new URL(route.request().url()).origin !== new URL(baseURL!).origin) { external.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  try {
    const [group] = await api("/membership/groups", "POST", [{ name: `Portal group ${stamp}`, categoryName: "Community", joinPolicy: "open", tags: "standard" }]); records.group = group.id;
    const serviceDate = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const [plan] = await api("/doing/plans", "POST", [{ ministryId: "group-sound", name: `Portal plan ${stamp}`, serviceDate, prepared: false }]); records.plan = plan.id;
    const positions = await api("/doing/positions", "POST", [
      { planId: plan.id, name: `Confirm ${stamp}`, count: 1, groupId: "group-sound-board", allowSelfSignup: false },
      { planId: plan.id, name: `Signup ${stamp}`, count: 1, groupId: "group-sound-board", allowSelfSignup: true }
    ]);
    await api("/doing/assignments", "POST", [{ positionId: positions[0].id, personId: "person-alex", status: "Unconfirmed" }]);
    const [file] = await api("/content/files", "POST", [{ contentType: "sermon", contentId: "sermon-demo", fileName: `synthetic-${stamp}.wav`, fileType: "audio/wav", fileContents: `data:audio/wav;base64,${syntheticWave().toString("base64")}` }]); records.file = file.id;

    await page.goto("/portal");
    await expect(page.getByRole("heading", { name: "Welcome back", exact: true })).toBeVisible();
    await page.getByLabel("Email", { exact: true }).fill("member@example.test");
    await page.getByLabel("Password", { exact: true }).fill("LocalDemo2026!");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("heading", { name: /Hello, Alex/ })).toBeVisible();
    await page.getByRole("button", { name: "Directory", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Member directory", exact: true })).toBeVisible();
    await page.getByLabel("Find a member", { exact: true }).fill("Alex");
    await expect(page.getByRole("heading", { name: "Alex Example", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "My groups", exact: true }).click();
    const groupCard = page.locator("article").filter({ has: page.getByRole("heading", { name: group.name, exact: true }) });
    await groupCard.getByRole("button", { name: "Join group", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "You have joined" })).toBeVisible();
    await groupCard.getByRole("button", { name: "Leave group", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "You have left" })).toBeVisible();

    await page.getByRole("button", { name: "Serving", exact: true }).click();
    const assignment = page.locator("article").filter({ hasText: positions[0].name });
    await assignment.getByRole("button", { name: "Accept", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Assignment accepted" })).toBeVisible();
    await page.locator(".mp-serving-position").filter({ hasText: positions[1].name }).getByRole("button", { name: "Sign up", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "You have signed up" })).toBeVisible();

    await page.getByRole("button", { name: "Sermons", exact: true }).click();
    const sermon = page.locator("article").filter({ has: page.getByRole("heading", { name: "A welcome message", exact: true }) });
    await sermon.getByRole("button", { name: "View archive files", exact: true }).click();
    await sermon.getByRole("button", { name: `Play synthetic-${stamp}.wav`, exact: true }).click();
    await expect.poll(() => sermon.locator("audio").evaluate((element: HTMLAudioElement) => element.readyState)).toBeGreaterThanOrEqual(2);
    expect(await sermon.locator("audio").evaluate((element: HTMLAudioElement) => new URL(element.src).pathname)).toBe(`/api/media/files/${file.id}/play`);
    expect(await sermon.locator("audio").evaluate((element: HTMLAudioElement) => element.duration)).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();

    await page.reload();
    await expect(page.getByRole("heading", { name: /Hello, Alex/ })).toBeVisible();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Welcome back", exact: true })).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem("b1-member-session-v1"))).toBeNull();
    expect(errors).toEqual([]); expect(external).toEqual([]); expect(apiFailures).toEqual([]);
  } finally {
    if (records.file) await api(`/content/files/${records.file}`, "DELETE");
    if (records.plan) await api(`/doing/plans/${records.plan}`, "DELETE");
    if (records.group) await api(`/membership/groups/${records.group}`, "DELETE");
    await api("/membership/users/logout", "POST", {});
  }
});
