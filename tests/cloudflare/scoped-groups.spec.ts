import { expect, test } from "@playwright/test";

test("a scoped group editor can edit its group without global creation or people access", async ({ page, request, baseURL }) => {
  const adminLogin = await request.post("/api/membership/users/login", { data: { email: "admin@example.test", password: "LocalDemo2026!" } });
  expect(adminLogin.ok()).toBeTruthy();
  const headers = { Authorization: `Bearer ${(await adminLogin.json()).userChurches[0].jwt}` };
  async function api(path: string, method: string, data?: unknown) {
    const response = await request.fetch(`/api/membership${path}`, { method, headers, data });
    expect(response.ok(), `${method} ${path}`).toBeTruthy(); return response.json();
  }
  const stamp = String(Date.now()), groups: string[] = [];
  let roleId = "";
  const peopleRequests: string[] = [], problems: string[] = [];
  page.on("pageerror", error => problems.push(error.message));
  page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/membership/people")) peopleRequests.push(request.url()); });
  page.on("response", response => { if (response.url().includes("/api/") && response.status() >= 400) problems.push(`${response.status()} ${new URL(response.url()).pathname}`); });
  await page.route("**/*", route => {
    if (new URL(route.request().url()).origin !== new URL(baseURL!).origin) { problems.push(`External: ${route.request().url()}`); return route.abort(); }
    return route.continue();
  });
  try {
    const [own, other] = await api("/groups", "POST", [{ name: `Scoped group ${stamp}`, categoryName: "Community" }, { name: `Other group ${stamp}`, categoryName: "Community" }]);
    groups.push(own.id, other.id);
    await api("/groupmembers", "POST", [{ groupId: own.id, personId: "person-jordan", leader: false }]);
    const [role] = await api("/roles", "POST", [{ name: `Scoped editor ${stamp}` }]); roleId = role.id;
    await api("/rolepermissions", "POST", ["Groups", "Group Members"].flatMap(contentType => ["View", "Edit"].map(action => ({ roleId, apiName: "MembershipApi", contentType, contentId: own.id, action }))));
    await api("/rolemembers", "POST", [{ roleId, personId: "person-alex" }]);
    await page.goto("/login");
    await page.locator('input[type="email"]').fill("member@example.test");
    await page.locator('input[name="password"]').fill("LocalDemo2026!");
    const signedIn = page.waitForResponse(response => response.url().endsWith("/api/membership/users/login") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    const memberToken = (await (await signedIn).json()).userChurches[0].jwt;
    await expect(page.getByRole("heading", { name: "Church administration", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Groups", exact: true }).first().click();
    await expect(page.getByTestId("add-group-button")).toHaveCount(0);
    await expect(page.getByRole("link", { name: other.name, exact: true })).toHaveCount(0);
    await page.getByRole("link", { name: own.name, exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Group name", exact: true })).toBeEnabled();
    await expect(page.getByRole("combobox", { name: "Parent group", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Add member", exact: true })).toHaveCount(0);
    await page.getByLabel("Meeting location", { exact: true }).fill("Scoped synthetic room");
    await page.getByRole("button", { name: "Save group", exact: true }).click();
    await expect(page.getByText("Group saved.", { exact: true })).toBeVisible();
    const rosterRow = page.getByRole("row").filter({ hasText: "Jordan Sample" });
    await rosterRow.getByRole("checkbox", { name: "Group leader", exact: true }).click();
    await expect(page.getByText("Member updated.", { exact: true })).toBeVisible();
    await expect(rosterRow.getByRole("checkbox", { name: "Group leader", exact: true })).toBeChecked();
    const scopedHeaders = { Authorization: `Bearer ${memberToken}` };
    expect((await request.get(`/api/membership/groups/${other.id}`, { headers: scopedHeaders })).status()).toBe(403);
    expect((await request.post("/api/membership/groups", { headers: scopedHeaders, data: [{ ...other, name: "Forbidden change" }] })).status()).toBe(403);
    expect((await request.get("/api/membership/people", { headers: scopedHeaders })).status()).toBe(403);
    expect((await api(`/groups/${own.id}`, "GET")).meetingLocation).toBe("Scoped synthetic room");
    expect(peopleRequests).toEqual([]); expect(problems).toEqual([]);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
  } finally {
    if (roleId) await api(`/roles/${roleId}`, "DELETE");
    for (const groupId of groups) await api(`/groups/${groupId}`, "DELETE");
    await api("/users/logout", "POST", {});
  }
});
