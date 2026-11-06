import { expect, test } from "@playwright/test";

test.use({ timezoneId: "America/New_York", viewport: { width: 390, height: 844 } });

test("members browse bounded pages, search authorized records and choose calendar dates", async ({ page, request, baseURL }, testInfo) => {
  const stamp = crypto.randomUUID().slice(0, 8), prefix = `Paging ${stamp}`;
  const problems: string[] = [];
  page.on("pageerror", error => problems.push(error.message));
  page.on("response", response => { if (response.url().includes("/api/") && response.status() >= 400) problems.push(`${response.status()} ${new URL(response.url()).pathname}`); });
  page.on("request", call => { if (new URL(call.url()).origin !== new URL(baseURL!).origin) problems.push(`External request: ${call.url()}`); });
  const login = await request.post("/api/membership/users/login", { data: { email: "admin@example.test", password: "LocalDemo2026!" } });
  expect(login.ok()).toBeTruthy();
  const headers = { Authorization: `Bearer ${(await login.json()).userChurches[0].jwt}` };
  async function api(path: string, method = "GET", data?: unknown) {
    const response = await request.fetch(`/api${path}`, { method, headers, data });
    expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy();
    return response.json();
  }
  const groups: string[] = [], sermons: string[] = [], events: string[] = [];
  let calendarId = "", cleanupError: unknown, releaseSlow: (() => void) | undefined;
  try {
    const createdGroups: Array<{ id: string; name: string }> = await api("/membership/groups", "POST", Array.from({ length: 42 }, (_, index) => ({ name: `${prefix} ${index < 21 ? "own" : "available"} ${String(index % 21).padStart(2, "0")}`, joinPolicy: "open" })));
    groups.push(...createdGroups.map(group => group.id));
    await api("/membership/groupmembers", "POST", createdGroups.slice(0, 21).map(group => ({ groupId: group.id, personId: "person-multi-demo" })));
    const createdSermons: Array<{ id: string; title: string }> = await api("/content/sermons", "POST", Array.from({ length: 22 }, (_, index) => ({ title: `${prefix} sermon ${String(index).padStart(2, "0")}`, speaker: `${prefix} speaker`, publishDate: `2020-01-${String(index + 1).padStart(2, "0")}T12:00:00Z`, visibility: "public" })));
    sermons.push(...createdSermons.map(sermon => sermon.id));
    for (const sermon of createdSermons.slice(0, 21)) await api(`/content/sermons/${sermon.id}/publish`, "POST", {});
    const [calendar] = await api("/content/calendars", "POST", [{ name: prefix, timeZone: "America/New_York" }]); calendarId = calendar.id;
    const createdEvents = await api("/content/events", "POST", [
      { calendarId, title: `${prefix} gathering`, start: "2027-03-01T09:00:00-05:00", end: "2027-03-01T10:00:00-05:00", timeZone: "America/New_York", recurrenceRule: "FREQ=DAILY;COUNT=21" },
      { calendarId, title: `${prefix} all day`, start: "2027-03-14", end: "2027-03-15", allDay: true, timeZone: "America/New_York" }
    ]); events.push(...createdEvents.map((event: { id: string }) => event.id));

    await page.goto("/portal");
    await page.getByLabel("Email", { exact: true }).fill("multi-member@example.test");
    await page.getByLabel("Password", { exact: true }).fill("LocalDemo2026!");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("combobox", { name: "Church", exact: true }).selectOption("church-demo");
    await page.getByRole("button", { name: "Open church", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Hello, Morgan.", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Directory", exact: true }).click();
    await page.getByLabel("Find a member", { exact: true }).fill("Alex Example");
    await expect(page.getByRole("heading", { name: "Alex Example", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "alex@example.test", exact: true })).toBeVisible();
    await page.getByLabel("Find a member", { exact: true }).fill("Jordan");
    await expect(page.getByText("No matching members.", { exact: true })).toBeVisible();
    await page.getByLabel("Find a member", { exact: true }).fill("admin@example.test");
    await expect(page.getByText("No matching members.", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "My groups", exact: true }).click();
    await page.getByLabel("Search my groups", { exact: true }).fill(`${prefix} own`);
    await expect(page.getByRole("heading", { name: new RegExp(`${prefix} own`) })).toHaveCount(20);
    await page.getByRole("button", { name: "Next my groups page", exact: true }).click();
    await expect(page.getByRole("heading", { name: `${prefix} own 20`, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Next my groups page", exact: true })).toBeDisabled();
    await page.getByLabel("Search my groups", { exact: true }).fill(`${prefix} own 00`);
    await expect(page.getByRole("heading", { name: `${prefix} own 00`, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Previous my groups page", exact: true })).toBeDisabled();
    await page.getByLabel("Search my groups", { exact: true }).fill(`${prefix} own`);
    await expect(page.getByRole("heading", { name: new RegExp(`${prefix} own`) })).toHaveCount(20);
    await expect(page.getByRole("button", { name: "Previous my groups page", exact: true })).toBeDisabled();
    await page.getByLabel("Search available groups", { exact: true }).fill(`${prefix} available`);
    await expect(page.getByRole("heading", { name: new RegExp(`${prefix} available`) })).toHaveCount(20);
    await page.getByRole("button", { name: "Next available groups page", exact: true }).click();
    await expect(page.getByRole("heading", { name: `${prefix} available 20`, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Next available groups page", exact: true })).toBeDisabled();

    await page.getByRole("button", { name: "Sermons", exact: true }).click();
    await page.getByLabel("Search sermons", { exact: true }).fill(`${prefix} speaker`);
    await expect(page.getByRole("heading", { name: new RegExp(`${prefix} sermon`) })).toHaveCount(20);
    await page.getByRole("button", { name: "Next sermons page", exact: true }).click();
    await expect(page.getByRole("heading", { name: `${prefix} sermon 00`, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Next sermons page", exact: true })).toBeDisabled();
    await page.getByLabel("Search sermons", { exact: true }).fill(`${prefix} sermon 20`);
    await expect(page.getByRole("heading", { name: `${prefix} sermon 20`, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Previous sermons page", exact: true })).toBeDisabled();
    await page.getByLabel("Search sermons", { exact: true }).fill(`${prefix} sermon 21`);
    await expect(page.getByText("No matching sermons.", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Calendar", exact: true }).click();
    await page.getByLabel("From date", { exact: true }).fill("2027-03-01");
    await page.getByLabel("Through date", { exact: true }).fill("2027-03-31");
    await page.getByRole("button", { name: "Show events", exact: true }).click();
    await expect(page.getByRole("heading", { name: new RegExp(`${prefix} (gathering|all day)`) })).toHaveCount(20);
    await page.getByRole("button", { name: "Next calendar page", exact: true }).click();
    await expect(page.getByRole("heading", { name: new RegExp(`${prefix} (gathering|all day)`) })).toHaveCount(2);
    await expect(page.getByRole("button", { name: "Next calendar page", exact: true })).toBeDisabled();
    await page.getByLabel("From date", { exact: true }).fill("2027-03-14");
    await page.getByLabel("Through date", { exact: true }).fill("2027-03-14");
    const dated = page.waitForResponse(response => { const url = new URL(response.url()); return url.pathname === "/api/member/v1/calendar" && url.searchParams.get("from") === "2027-03-14T05:00:00.000Z"; });
    await page.getByRole("button", { name: "Show events", exact: true }).click();
    const calendarResponse = await dated;
    expect(new URL(calendarResponse.url()).searchParams.get("to")).toBe("2027-03-15T04:00:00.000Z");
    await expect(page.getByRole("heading", { name: `${prefix} all day`, exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: `${prefix} gathering`, exact: true })).toHaveCount(1);
    const gathering = page.locator("article").filter({ has: page.getByRole("heading", { name: `${prefix} gathering`, exact: true }) });
    await expect(gathering).toContainText("9:00 AM");
    await expect(page.getByRole("button", { name: "Previous calendar page", exact: true })).toBeDisabled();
    await page.getByLabel("From date", { exact: true }).fill("2027-03-01");
    await page.getByLabel("Through date", { exact: true }).fill("2027-03-31");
    await page.getByRole("button", { name: "Show events", exact: true }).click();
    await expect(page.getByRole("heading", { name: new RegExp(`${prefix} (gathering|all day)`) })).toHaveCount(20);
    await expect(page.getByRole("button", { name: "Previous calendar page", exact: true })).toBeDisabled();

    // Hold a real response across a church change; the old query must never populate the new context.
    const slow = new Promise<void>(resolve => { releaseSlow = resolve; });
    let entered: (() => void) | undefined;
    const started = new Promise<void>(resolve => { entered = resolve; });
    await page.route("**/api/member/v1/directory?**", async route => {
      if (new URL(route.request().url()).searchParams.get("q") !== "Alex") return route.continue();
      const response = await route.fetch(); entered?.(); await slow;
      await route.fulfill({ response }).catch(() => { /* The old request is deliberately aborted on unmount. */ });
    });
    await page.getByRole("button", { name: "Directory", exact: true }).click();
    await page.getByLabel("Find a member", { exact: true }).fill("Alex"); await started;
    await page.getByRole("button", { name: "Change church", exact: true }).click();
    await page.getByRole("combobox", { name: "Church", exact: true }).selectOption("church-other");
    await page.getByRole("button", { name: "Open church", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Hello, Morgan.", exact: true })).toBeVisible();
    releaseSlow?.();
    await page.getByRole("button", { name: "Directory", exact: true }).click();
    await expect(page.getByLabel("Find a member", { exact: true })).toHaveValue("");
    await expect(page.getByText("No members have opted into the directory yet.", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Alex Example", exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    expect(problems).toEqual([]);
  } finally {
    releaseSlow?.();
    try {
      for (const id of events) await api(`/content/events/${id}`, "DELETE");
      if (calendarId) await api(`/content/calendars/${calendarId}`, "DELETE");
      for (const id of sermons) await api(`/content/sermons/${id}`, "DELETE");
      for (const id of groups) await api(`/membership/groups/${id}`, "DELETE");
      await api("/membership/users/logout", "POST", {});
    } catch (error) { cleanupError = error; testInfo.annotations.push({ type: "cleanup", description: String(error) }); }
  }
  if (cleanupError) throw cleanupError;
});
