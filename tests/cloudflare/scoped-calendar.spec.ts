import { expect, test } from "@playwright/test";

test("calendar scope controls role actions, event recurrence edits and read-only access without directory grants", async ({ page, request, baseURL }, testInfo) => {
  test.setTimeout(90000);
  const login = await request.post("/api/membership/users/login", { data: { email: "admin@example.test", password: "LocalDemo2026!" } });
  expect(login.ok()).toBeTruthy();
  const headers = { Authorization: `Bearer ${(await login.json()).userChurches[0].jwt}` };
  async function api(path: string, method = "GET", data?: unknown) {
    const response = await request.fetch("/api" + path, { method, headers, data });
    expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy();
    return response.json();
  }
  async function signIn(email: string) {
    await page.goto("/login");
    await page.locator('input[type="email"]').fill(email);
    await page.locator('input[type="password"]').fill("LocalDemo2026!");
    const signedIn = page.waitForResponse(response => response.url().endsWith("/api/membership/users/login") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    const token = (await (await signedIn).json()).userChurches[0].jwt;
    await expect(page.getByRole("heading", { name: "Church administration", exact: true })).toBeVisible();
    return token as string;
  }
  const stamp = Date.now();
  const calendars: { id: string; name: string }[] = [];
  let roleId = "", scopedSession = false, failed = false;
  const problems: string[] = [], directoryCalls: string[] = [];
  page.on("pageerror", error => problems.push(error.message));
  page.on("response", response => { if (response.url().includes("/api/") && response.status() >= 400) problems.push(`${response.status()} ${new URL(response.url()).pathname}`); });
  page.on("request", req => {
    const url = new URL(req.url());
    if (scopedSession && /^\/api\/membership\/(people|groups|groupmembers)(\/|$)/i.test(url.pathname)) directoryCalls.push(url.pathname);
  });
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(baseURL!).origin && !["data:", "blob:"].includes(url.protocol)) { problems.push("External request"); return route.abort(); }
    return route.continue();
  });
  try {
    calendars.push(...await api("/content/calendars", "POST", [{ name: `Scoped calendar ${stamp}`, groupId: "group-welcome" }, { name: `Hidden calendar ${stamp}` }]));
    const [own, other] = calendars;
    const [event, hiddenEvent] = await api("/content/events", "POST", calendars.map((calendar, index) => ({ calendarId: calendar.id, title: `${index ? "Hidden" : "Scoped"} weekly ${stamp}`, start: "2027-03-07T09:00:00Z", end: "2027-03-07T10:00:00Z", recurrenceRule: "FREQ=WEEKLY;COUNT=3" })));
    const roleName = `Scoped calendar role ${stamp}`;
    roleId = (await api("/membership/roles", "POST", [{ name: roleName }]))[0].id;
    const editId = (await api("/membership/rolepermissions", "POST", [{ roleId, apiName: "ContentApi", contentType: "Calendars", contentId: own.id, action: "Edit" }]))[0].id;
    await api("/membership/rolemembers", "POST", [{ roleId, personId: "person-alex" }]);

    await signIn("admin@example.test");
    await page.getByRole("link", { name: "Roles", exact: true }).first().click();
    await page.getByRole("link", { name: roleName, exact: true }).click();
    await page.getByRole("combobox", { name: "Permission scope", exact: true }).click();
    await page.getByRole("option", { name: `Calendar: ${own.name}`, exact: true }).click();
    const checks = page.locator("#rolePermissionsBox");
    await expect(checks.getByRole("checkbox")).toHaveCount(2);
    await expect(checks.getByTestId("role-permission-checkbox-Calendars-Edit").locator("input")).toBeChecked();
    await expect(checks.getByTestId("role-permission-checkbox-Calendars-Admin")).toHaveCount(0);
    await Promise.all([
      page.waitForResponse(response => /\/api\/membership\/rolepermissions\/?$/.test(response.url()) && response.request().method() === "POST" && response.ok()),
      checks.getByTestId("role-permission-checkbox-Calendars-View").locator("input").check()
    ]);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.locator('input[type="email"]')).toBeVisible();

    scopedSession = true;
    const token = await signIn("member@example.test");
    await page.getByRole("link", { name: "Calendars & scheduling", exact: true }).first().click();
    await expect(page.getByRole("button", { name: "New calendar", exact: true })).toHaveCount(0);
    await page.getByRole("combobox", { name: "Calendar", exact: true }).click();
    await expect(page.getByRole("option", { name: other.name, exact: true })).toHaveCount(0);
    await page.getByRole("option", { name: own.name, exact: true }).click();
    await page.getByRole("button", { name: "Edit calendar", exact: true }).click();
    await expect(page.getByRole("combobox", { name: /^Default group(?: |$)/ })).toBeDisabled();
    await page.getByLabel(/^Calendar name/).fill(`${own.name} revised`);
    await page.getByRole("button", { name: "Save calendar", exact: true }).click();
    await expect(page.getByText("Calendar saved.", { exact: true })).toBeVisible();
    await page.getByLabel("View from", { exact: true }).fill("2027-03-01");
    await expect(page.getByText(event.title, { exact: true })).toHaveCount(3);
    await expect(page.getByText(hiddenEvent.title, { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Edit " + event.title, exact: true }).first().click();
    await page.getByRole("button", { name: "This event only", exact: true }).click();
    await expect(page.getByRole("combobox", { name: /^Group(?: |$)/ })).toBeDisabled();
    await page.getByLabel(/^Event title/).fill(`Scoped occurrence ${stamp}`);
    await page.getByRole("button", { name: "Save event", exact: true }).click();
    await expect(page.getByText(`Scoped occurrence ${stamp}`, { exact: true })).toBeVisible();
    await expect(page.getByText(event.title, { exact: true })).toHaveCount(2);
    const scopedHeaders = { Authorization: `Bearer ${token}` };
    expect((await request.get(`/api/content/events/${hiddenEvent.id}`, { headers: scopedHeaders })).status()).toBe(403);
    expect((await request.post("/api/content/events", { headers: scopedHeaders, data: [{ id: event.id, calendarId: other.id }] })).status()).toBe(403);
    expect((await request.get("/api/membership/people", { headers: scopedHeaders })).status()).toBe(403);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await api("/membership/rolepermissions/" + editId, "DELETE");
    await signIn("member@example.test");
    await page.getByRole("link", { name: "Calendars & scheduling", exact: true }).first().click();
    await page.getByLabel("View from", { exact: true }).fill("2027-03-01");
    await expect(page.getByText(`Scoped occurrence ${stamp}`, { exact: true })).toBeVisible();
    for (const name of ["New calendar", "Edit calendar", "New event", "Edit " + event.title]) await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
    expect(directoryCalls).toEqual([]);
    expect(problems).toEqual([]);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.locator('input[type="email"]')).toBeVisible();
  } catch (error) { failed = true; throw error; } finally {
    const cleanupErrors: string[] = [];
    await page.goto("about:blank").catch(() => undefined);
    const cleanup = [
      async () => { if (roleId) await api("/membership/roles/" + roleId, "DELETE"); },
      ...calendars.map(calendar => async () => {
        const events = await api("/content/events?calendarId=" + calendar.id);
        for (const event of events) if (!event.recurrenceParentId) await api("/content/events/" + event.id, "DELETE");
        await api("/content/calendars/" + calendar.id, "DELETE");
      }),
      () => api("/membership/users/logout", "POST", {})
    ];
    for (const operation of cleanup) try { await operation(); } catch (error) { cleanupErrors.push(String(error)); }
    if (cleanupErrors.length) {
      await testInfo.attach("fixture-cleanup-errors", { body: cleanupErrors.join("\n"), contentType: "text/plain" });
      if (!failed) expect(cleanupErrors).toEqual([]);
    }
  }
});
