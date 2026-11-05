import { expect, test } from "@playwright/test";

test("members request and cancel while leaders and original admin cards approve or decline", async ({ page, browser, request, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const stamp = String(Date.now());
  const login = await request.post("/api/membership/users/login", { data: { email: "admin@example.test", password: "LocalDemo2026!" } });
  expect(login.ok()).toBeTruthy();
  const adminToken = (await login.json()).userChurches[0].jwt;
  const headers = { Authorization: `Bearer ${adminToken}` };
  async function api(path: string, method = "GET", data?: unknown) {
    const response = await request.fetch(`/api${path}`, { method, headers, data });
    expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy(); return response.json();
  }
  const groups: string[] = [], problems: string[] = [];
  const adminContext = await browser.newContext({ baseURL });
  const adminPage = await adminContext.newPage();
  for (const current of [page, adminPage]) {
    current.on("pageerror", error => problems.push(error.message));
    current.on("response", response => { if (response.url().includes("/api/") && response.status() >= 400) problems.push(`${response.status()} ${response.url()}`); });
    await current.route("**/*", route => {
      if (new URL(route.request().url()).origin !== new URL(baseURL!).origin) { problems.push(`External: ${route.request().url()}`); return route.abort(); }
      return route.continue();
    });
  }
  try {
    const [group, led] = await api("/membership/groups", "POST", [
      { name: `Request group ${stamp}`, joinPolicy: "request", categoryName: "Community" },
      { name: `Led group ${stamp}`, joinPolicy: "request", categoryName: "Community" }
    ]); groups.push(group.id, led.id);
    await api("/membership/groupmembers", "POST", [{ groupId: led.id, personId: "person-alex", leader: true }]);
    const leaderRequest = await api("/membership/groupjoinrequests", "POST", { groupId: led.id, message: "Synthetic leader review" });

    await page.goto("/portal");
    await page.getByLabel("Email", { exact: true }).fill("member@example.test");
    await page.getByLabel("Password", { exact: true }).fill("LocalDemo2026!");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("heading", { name: /Hello, Alex/ })).toBeVisible();
    await page.getByRole("button", { name: "My groups", exact: true }).click();
    await page.getByTestId(`review-request-${leaderRequest.id}`).getByRole("button", { name: "Approve request", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Join request approved" })).toBeVisible();
    await expect(page.getByTestId(`review-request-${leaderRequest.id}`)).toHaveCount(0);

    const findGroup = () => page.locator("article").filter({ has: page.getByRole("heading", { name: group.name, exact: true }) }).filter({ has: page.getByRole("button", { name: "Request to join", exact: true }) });
    async function submitRequest(message: string) {
      await findGroup().getByRole("button", { name: "Request to join", exact: true }).click();
      await page.getByLabel("Message to group leaders (optional)", { exact: true }).fill(message);
      const created = page.waitForResponse(response => response.url().endsWith("/api/membership/groupjoinrequests") && response.request().method() === "POST");
      await page.getByRole("button", { name: "Send request", exact: true }).click();
      const row = await (await created).json();
      await expect(page.getByTestId(`member-request-${row.id}`)).toContainText("pending"); return row;
    }
    const first = await submitRequest("I would like to join this synthetic group.");
    await adminPage.goto("/login");
    await adminPage.locator('input[type="email"]').fill("admin@example.test");
    await adminPage.locator('input[type="password"]').fill("LocalDemo2026!");
    await adminPage.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(adminPage.getByRole("heading", { name: "Church administration", exact: true })).toBeVisible();
    await adminPage.getByRole("link", { name: "Groups", exact: true }).first().click();
    await adminPage.getByText(group.name, { exact: true }).click();
    await adminPage.getByTestId(`approve-${first.id}`).click();
    await expect(adminPage.getByTestId(`pending-request-${first.id}`)).toHaveCount(0);
    await page.getByRole("button", { name: "Home", exact: true }).click();
    await page.getByRole("button", { name: "My groups", exact: true }).click();
    await expect(page.getByTestId(`member-request-${first.id}`)).toContainText("approved");
    // Refreshing requests reloads status; reload the parent lists to observe the approved membership.
    await page.reload(); await page.getByRole("button", { name: "My groups", exact: true }).click();
    const own = page.locator("article").filter({ has: page.getByRole("heading", { name: group.name, exact: true }) }).filter({ has: page.getByRole("button", { name: "Leave group", exact: true }) });
    await own.getByRole("button", { name: "Leave group", exact: true }).click();
    const second = await submitRequest("A second synthetic request.");
    await adminPage.getByRole("button", { name: "Refresh requests", exact: true }).click();
    await adminPage.getByTestId(`decline-${second.id}`).click();
    await adminPage.getByLabel("Reason (optional)", { exact: true }).fill("Please speak to a group leader first.");
    await adminPage.getByTestId("decline-confirm").click();
    await expect(adminPage.getByTestId(`pending-request-${second.id}`)).toHaveCount(0);
    await page.getByRole("button", { name: "Refresh requests", exact: true }).click();
    await expect(page.getByTestId(`member-request-${second.id}`)).toContainText("Please speak to a group leader first.");
    const third = await submitRequest("A request to cancel.");
    await page.getByTestId(`member-request-${third.id}`).getByRole("button", { name: "Cancel request", exact: true }).click();
    await expect(page.getByTestId(`member-request-${third.id}`)).toContainText("cancelled");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await adminPage.getByRole("button", { name: "Sign out", exact: true }).click();
    expect(problems).toEqual([]);
  } finally {
    await adminContext.close();
    for (const groupId of groups) await api(`/membership/groups/${groupId}`, "DELETE");
    await api("/membership/users/logout", "POST", {});
  }
});
