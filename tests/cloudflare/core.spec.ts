import { expect, test, type Page } from "@playwright/test";

async function login(page: Page, email = "admin@example.test") {
  await page.goto("/login");
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill("LocalDemo2026!");
  const response = page.waitForResponse(response => response.url().endsWith("/api/membership/users/login") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const result = await (await response).json();
  await expect(page.getByRole("heading", { name: "Church administration", exact: true })).toBeVisible();
  return result.userChurches[0].jwt as string;
}

test("sign-in and core navigation stay on this installation", async ({ page, baseURL }) => {
  const unexpected: string[] = [];
  const errors: string[] = [];
  const failedApi: string[] = [];
  page.on("request", request => {
    const url = request.url();
    if (!url.startsWith(baseURL!) && !url.startsWith("data:")) unexpected.push(url);
  });
  page.on("pageerror", error => errors.push(error.message));
  page.on("response", response => { if (response.url().includes("/api/") && response.status() >= 400) failedApi.push(`${response.status()} ${response.url()}`); });
  await login(page);
  for (const name of ["People", "Groups", "Calendars & scheduling", "Serving / Plans", "My Work", "Sermons", "Roles", "Audit log", "My account"]) {
    await page.getByRole("link", { name, exact: true }).first().click();
    await expect(page.locator("h1").first()).toBeVisible();
    await page.waitForLoadState("networkidle");
  }
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
  expect(failedApi).toEqual([]);
});

test("person creation, update and deletion persist through the original directory workflow", async ({ page }) => {
  await login(page);
  await page.getByRole("link", { name: "People", exact: true }).first().click();
  const unique = `Browser${Date.now()}`;
  const form = page.locator("#createPersonForm");
  await form.locator('input[name="first"]').fill(unique);
  await form.locator('input[name="last"]').fill("Synthetic");
  await form.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("heading", { name: unique + " Synthetic", exact: true })).toBeVisible();
  await page.getByLabel("City", { exact: true }).fill("Test City");
  await page.getByRole("button", { name: "Save person", exact: true }).click();
  await expect(page.getByText("Person saved.", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "← People", exact: true }).click();
  await page.getByLabel("Search people", { exact: true }).fill(unique);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByText(unique + " Synthetic", { exact: true }).first().click();
  await expect(page.getByLabel("City", { exact: true })).toHaveValue("Test City");
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Delete person", exact: true }).click();
  await expect(page).toHaveURL(/\/people$/);
});

test("calendar events support explicit timezone scheduling and deletion", async ({ page }) => {
  await login(page);
  await page.getByRole("link", { name: "Calendars & scheduling", exact: true }).first().click();
  const unique = `Calendar ${Date.now()}`;
  await page.getByRole("button", { name: "New calendar", exact: true }).click();
  await page.getByLabel(/^Calendar name/).fill(unique);
  await page.getByLabel(/^Time zone/).fill("America/New_York");
  await page.getByRole("button", { name: "Save calendar", exact: true }).click();
  await expect(page.getByText("Calendar saved.", { exact: true })).toBeVisible();
  await page.getByLabel("View from", { exact: true }).fill("2027-01-01");
  await page.getByRole("button", { name: "New event", exact: true }).click();
  await page.getByLabel(/^Event title/).fill("Synthetic planning meeting");
  await page.getByLabel(/^Start/).fill("2027-01-10T09:00");
  await page.getByLabel(/^End/).fill("2027-01-10T10:00");
  await page.getByLabel("Location", { exact: true }).fill("Test room");
  await page.getByRole("button", { name: "Save event", exact: true }).click();
  await expect(page.getByText("Event saved.", { exact: true })).toBeVisible();
  await expect(page.getByText("Synthetic planning meeting", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit Synthetic planning meeting", exact: true }).click();
  await expect(page.getByLabel(/^Start/)).toHaveValue("2027-01-10T09:00");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Delete Synthetic planning meeting", exact: true }).click();
  await expect(page.getByText("Event deleted.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit calendar", exact: true }).click();
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Delete calendar", exact: true }).click();
  await expect(page.getByText("Calendar deleted.", { exact: true })).toBeVisible();
});

test("viewer directory and calendar screens do not offer writes", async ({ page }) => {
  await login(page, "viewer@example.test");
  await page.getByRole("link", { name: "People", exact: true }).first().click();
  await expect(page.locator("#createPersonForm")).toHaveCount(0);
  await page.getByRole("link", { name: "Calendars & scheduling", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "New calendar", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New event", exact: true })).toHaveCount(0);
});

test("original plan displays service order and supports manual position changes", async ({ page }) => {
  const failed: string[] = [];
  const errors: string[] = [];
  page.on("response", response => { if (response.url().includes("/api/") && response.status() >= 400) failed.push(`${response.status()} ${response.url()}`); });
  page.on("pageerror", error => errors.push(error.message));
  await login(page);
  await page.getByRole("link", { name: "Serving / Plans", exact: true }).first().click();
  await page.getByRole("link", { name: "Street Church Gathering", exact: true }).click();
  await page.getByRole("link", { name: "Sunday Street Church", exact: true }).click();
  await expect(page.getByTestId("plan-serving")).toBeVisible();
  await expect(page.getByRole("button", { name: /Sound-board Engineer/ })).toBeVisible();
  await expect(page.getByText("Welcome and introductions", { exact: true })).toBeVisible();
  await expect(page.getByTestId("auto-assign-button")).toHaveCount(0);
  const name = `Synthetic position ${Date.now()}`;
  await page.getByTestId("add-position-button").click();
  await page.locator("input#name").fill(name);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name, exact: true }).click();
  await expect(page.locator("input#name")).toHaveValue(name);
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Sound-board Engineer.*Sound Board Team/ })).toBeVisible();
  await page.getByTestId("print-plan-link").click();
  await expect(page).toHaveURL(/\/serving\/plans\/print\/plan-demo$/);
  // Wait for the print view itself; the previous route can remain visible while its lazy module loads.
  await expect(page.locator(".printOrderColumn").getByText("Welcome and introductions:", { exact: true })).toBeVisible();
  expect(failed).toEqual([]);
  expect(errors).toEqual([]);
});

test("original My Work task closes and reopens without messaging", async ({ page }) => {
  const failed: string[] = [];
  page.on("response", response => { if (response.url().includes("/api/") && response.status() >= 400) failed.push(`${response.status()} ${response.url()}`); });
  await login(page);
  await page.getByRole("link", { name: "My Work", exact: true }).first().click();
  await page.getByRole("link", { name: "Prepare the service welcome table", exact: true }).click();
  await expect(page.getByTestId("task-status")).toHaveText("Open");
  await page.getByTestId("task-status-toggle").click();
  await expect(page.getByTestId("task-status")).toHaveText("Closed");
  await page.getByTestId("task-status-toggle").click();
  await expect(page.getByTestId("task-status")).toHaveText("Open");
  await page.waitForLoadState("networkidle");
  expect(failed).toEqual([]);
});

test("original roles workflow creates, configures and deletes an unused role", async ({ page }) => {
  const failed: string[] = [];
  page.on("response", response => { if (response.url().includes("/api/") && response.status() >= 400) failed.push(`${response.status()} ${response.url()}`); });
  await login(page);
  await page.getByRole("link", { name: "Roles", exact: true }).first().click();
  await page.getByTestId("add-role-button").click();
  await page.getByTestId("add-custom-role-menu-item").click();
  const name = `Synthetic role ${Date.now()}`;
  await page.getByTestId("role-name-input").locator("input").fill(name);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("link", { name, exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await page.getByTestId("role-permission-filter").locator("input").fill("People");
  const checkbox = page.locator("#rolePermissionsBox").getByRole("checkbox").first();
  await Promise.all([
    page.waitForResponse(response => response.url().includes("/api/membership/rolepermissions") && response.request().method() === "POST" && response.ok()),
    checkbox.check()
  ]);
  await expect(checkbox).toBeChecked();
  await page.getByRole("link", { name: "Roles", exact: true }).first().click();
  await page.getByRole("row").filter({ has: page.getByRole("link", { name, exact: true }) }).getByTestId("edit-role-button").click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("link", { name, exact: true })).toHaveCount(0);
  expect(failed).toEqual([]);
});

test("original group creation and local membership editing persist", async ({ page, request }) => {
  const token = await login(page);
  let groupId = "";
  try {
    await page.getByRole("link", { name: "Groups", exact: true }).first().click();
    await page.getByTestId("add-group-button").click();
    const name = `Browser group ${Date.now()}`;
    await page.getByTestId("add-category-name-select").click();
    await page.getByTestId("add-new-option").click();
    await page.getByTestId("add-category-name-input").locator("input").fill("Community");
    await page.getByTestId("add-group-name-input").locator("input").fill(name);
    const created = page.waitForResponse(response => response.url().endsWith("/api/membership/groups") && response.request().method() === "POST" && response.ok());
    await page.getByRole("button", { name: "Add", exact: true }).click();
    groupId = (await (await created).json())[0].id;
    await page.getByRole("link", { name, exact: true }).click();
    await page.getByLabel("Meeting location", { exact: true }).fill("Synthetic meeting room");
    await page.getByRole("button", { name: "Save group", exact: true }).click();
    await expect(page.getByText("Group saved.", { exact: true })).toBeVisible();
    await page.getByLabel(/^Person to add/).click();
    await page.getByRole("option", { name: "Jordan Sample", exact: true }).click();
    await page.getByRole("button", { name: "Add member", exact: true }).click();
    await expect(page.getByText("Member added.", { exact: true })).toBeVisible();
    const row = page.getByRole("row").filter({ has: page.getByRole("link", { name: "Jordan Sample", exact: true }) });
    await row.getByRole("checkbox", { name: "Group leader", exact: true }).click();
    await expect(page.getByText("Member updated.", { exact: true })).toBeVisible();
    await expect(row.getByRole("checkbox", { name: "Group leader", exact: true })).toBeChecked();
    await row.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(page.getByText("Member removed.", { exact: true })).toBeVisible();
    await expect(row).toHaveCount(0);
  } finally {
    if (groupId) expect((await request.delete(`/api/membership/groups/${groupId}`, { headers: { Authorization: `Bearer ${token}` } })).ok()).toBeTruthy();
  }
});
