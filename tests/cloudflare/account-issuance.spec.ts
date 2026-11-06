import { expect, test } from "@playwright/test";

test("original roles keep group scopes separate and create a manual setup link without sending", async ({ page, request, baseURL }) => {
  const login = await request.post("/api/membership/users/login", { data: { email: "admin@example.test", password: "LocalDemo2026!" } });
  expect(login.ok()).toBeTruthy();
  const headers = { Authorization: `Bearer ${(await login.json()).userChurches[0].jwt}` };
  async function api(path: string, method: string, data?: unknown) {
    const response = await request.fetch(`/api/membership${path}`, { method, headers, data });
    expect(response.ok(), `${method} ${path}`).toBeTruthy(); return response.json();
  }
  const suffix = String(Date.now()), records: { person?: string; role?: string; invitation?: string } = {};
  const external: string[] = [], errors: string[] = [], paths: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { const path = new URL(request.url()).pathname; if (path.startsWith("/api/") && !["GET", "HEAD"].includes(request.method())) paths.push(path); });
  await page.route("**/*", route => {
    if (new URL(route.request().url()).origin !== new URL(baseURL!).origin) { external.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  try {
    const [person] = await api("/people", "POST", [{ name: { first: "Setup", last: suffix }, contactInfo: { email: `setup-${suffix}@example.test` }, membershipStatus: "Member" }]); records.person = person.id;
    const [role] = await api("/roles", "POST", [{ name: `Setup role ${suffix}` }]); records.role = role.id;
    await page.goto("/login");
    await page.locator('input[type="email"]').fill("admin@example.test");
    await page.locator('input[name="password"]').fill("LocalDemo2026!");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Church administration", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Roles", exact: true }).first().click();
    await page.getByRole("link", { name: role.name, exact: true }).click();
    await page.getByTestId("role-permission-filter").locator("input").fill("Group");
    const editMembers = () => page.getByTestId("role-permission-checkbox-Group Members-Edit").locator("input");
    await Promise.all([page.waitForResponse(response => response.url().includes("/rolepermissions") && response.request().method() === "POST" && response.ok()), editMembers().check()]);
    await page.getByTestId("role-permission-scope").getByRole("combobox").click();
    await page.getByRole("option", { name: "Welcome Team", exact: true }).click();
    await expect(editMembers()).not.toBeChecked();
    await Promise.all([page.waitForResponse(response => response.url().includes("/rolepermissions") && response.request().method() === "POST" && response.ok()), editMembers().check()]);
    await page.getByTestId("role-permission-scope").getByRole("combobox").click();
    await page.getByRole("option", { name: "All church resources", exact: true }).click();
    await page.getByTestId("role-permission-filter").locator("input").fill("Group");
    await expect(editMembers()).toBeChecked();
    await page.getByTestId("role-permission-scope").getByRole("combobox").click();
    await page.getByRole("option", { name: "Welcome Team", exact: true }).click();
    await expect(editMembers()).toBeChecked();
    await Promise.all([page.waitForResponse(response => response.url().includes("/rolepermissions") && response.request().method() === "DELETE" && response.ok()), editMembers().uncheck()]);
    const grants = await api(`/rolepermissions/roles/${role.id}`, "GET");
    expect(grants).toHaveLength(1); expect(grants[0].contentId).toBe("");
    await page.getByTestId("add-role-member-button").click();
    await page.getByTestId("person-search-input").locator("input").fill(suffix);
    await page.getByTestId("search-button").click();
    await page.getByTestId(`add-person-button-${person.id}`).click();
    await expect(page.getByRole("button", { name: "Create account setup link", exact: true })).toBeVisible();
    const issued = page.waitForResponse(response => response.url().endsWith("/api/membership/users/invitations") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Create account setup link", exact: true }).click();
    const invitation = await (await issued).json(); records.invitation = invitation.id;
    expect(invitation.mode).toBe("setPassword");
    const field = page.getByLabel("Account setup link", { exact: true });
    await expect(field).toBeVisible();
    const link = new URL(await field.inputValue());
    expect(link.origin).toBe(new URL(baseURL!).origin); expect(link.pathname).toBe("/login"); expect(link.searchParams.has("auth")).toBeTruthy();
    await expect(page.getByText(/Nothing has been emailed/)).toBeVisible();
    const pending = await api(`/users/invitations?personId=${person.id}`, "GET");
    expect(pending.some((item: { id: string }) => item.id === invitation.id)).toBeTruthy();
    const members = await api(`/rolemembers/roles/${role.id}`, "GET");
    expect(members).toEqual([]);
    expect(paths.some(path => /sendinvite|sendemail|notifications/i.test(path))).toBeFalsy();
    expect(external).toEqual([]); expect(errors).toEqual([]);
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
  } finally {
    if (records.invitation) await api(`/users/invitations/${records.invitation}`, "DELETE");
    if (records.role) await api(`/roles/${records.role}`, "DELETE");
    if (records.person) await api(`/people/${records.person}`, "DELETE");
    await api("/users/logout", "POST", {});
  }
});
