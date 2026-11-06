import { expect, test, type Page } from "@playwright/test";

test("members submit profile and household proposals for authorized review", async ({ page, browser, request, baseURL }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const stamp = crypto.randomUUID().slice(0, 8), problems: string[] = [];
  const adminLogin = await request.post("/api/membership/users/login", { data: { email: "admin@example.test", password: "LocalDemo2026!" } });
  expect(adminLogin.ok()).toBeTruthy();
  const adminToken = (await adminLogin.json()).userChurches[0].jwt;
  async function api(path: string, method = "GET", data?: unknown, token = adminToken) {
    const response = await request.fetch(`/api${path}`, { method, headers: { Authorization: `Bearer ${token}` }, data });
    expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy(); return response.json();
  }
  const initialChurch = await api("/membership/churches/current");
  const initialPerson = await api("/membership/people/person-multi-demo");
  const adminContext = await browser.newContext({ baseURL });
  const adminPage = await adminContext.newPage();
  for (const current of [page, adminPage]) {
    current.on("pageerror", error => problems.push(error.message));
    current.on("response", response => { if (response.url().includes("/api/") && response.status() >= 400) problems.push(`${response.status()} ${new URL(response.url()).pathname}`); });
    current.on("request", call => { if (new URL(call.url()).origin !== new URL(baseURL!).origin) problems.push(`External request: ${call.url()}`); });
  }
  let groupId = "", familyId = "", cleanupError: unknown;
  const requests: string[] = [];
  async function submitted(button: string) {
    const pending = page.waitForResponse(response => response.url().endsWith("/api/member/v1/profile-requests") && response.request().method() === "POST");
    await page.getByRole("button", { name: button, exact: true }).click();
    const response = await pending; expect(response.status()).toBe(201);
    const proposal = await response.json(); requests.push(proposal.id);
    await expect(page.getByTestId(`profile-request-${proposal.id}`)).toContainText("pending");
    await expect(page.getByTestId(`profile-request-${proposal.id}`).getByRole("button", { name: "Approve changes", exact: true })).toHaveCount(0);
    return proposal;
  }
  async function portalLogin(current: Page, email: string) {
    await current.goto("/portal");
    await current.getByLabel("Email", { exact: true }).fill(email);
    await current.getByLabel("Password", { exact: true }).fill("LocalDemo2026!");
    await current.getByRole("button", { name: "Sign in", exact: true }).click();
  }
  try {
    const [group] = await api("/membership/groups", "POST", [{ name: `Directory reviewers ${stamp}`, joinPolicy: "closed" }]); groupId = group.id;
    await api("/membership/groupmembers", "POST", [{ groupId, personId: "person-admin", leader: true }]);
    await adminPage.goto("/login");
    await adminPage.locator('input[type="email"]').fill("admin@example.test");
    await adminPage.locator('input[type="password"]').fill("LocalDemo2026!");
    await adminPage.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(adminPage.getByRole("heading", { name: "Church administration", exact: true })).toBeVisible();
    await adminPage.getByRole("link", { name: "Church settings", exact: true }).first().click();
    await adminPage.getByRole("combobox", { name: "Directory approval group", exact: true }).click();
    await adminPage.getByRole("option", { name: group.name, exact: true }).click();
    await adminPage.getByRole("button", { name: "Save church settings", exact: true }).click();
    await expect(adminPage.getByText("Church settings saved.", { exact: true })).toBeVisible();
    expect((await api("/membership/churches/current")).directoryApprovalGroupId).toBe(groupId);

    await portalLogin(page, "multi-member@example.test");
    await page.getByRole("combobox", { name: "Church", exact: true }).selectOption("church-demo");
    await page.getByRole("button", { name: "Open church", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Hello, Morgan.", exact: true })).toBeVisible();
    const memberToken = await page.evaluate(() => sessionStorage.getItem("b1-member-session-v1") || "");
    await page.getByRole("button", { name: "My profile", exact: true }).click();
    await expect(page.getByText("Your church reviews profile changes before applying them.", { exact: false })).toBeVisible();
    await page.getByLabel("Mobile phone", { exact: true }).fill("+1 202 555 0186");
    const personal = await submitted("Submit profile changes");
    expect((await api("/member/v1/me", "GET", undefined, memberToken)).person.contactInfo.mobilePhone || "").toBe(initialPerson.contactInfo.mobilePhone || "");
    await adminPage.getByRole("link", { name: "My Work", exact: true }).first().click();
    await adminPage.getByTestId("tasklist-tab-groups").click();
    await adminPage.locator(`a[href="/serving/tasks/${personal.taskId}"]`).click();
    await expect(adminPage.getByTestId(`profile-request-${personal.id}`)).toContainText("+1 202 555 0186");
    await expect(adminPage.getByTestId("task-status-toggle")).toHaveCount(0);
    await adminPage.getByRole("button", { name: "Approve changes", exact: true }).click();
    await expect(adminPage.getByTestId(`profile-request-${personal.id}`)).toContainText("approved");
    await page.getByRole("button", { name: "Refresh profile requests", exact: true }).click();
    await expect(page.getByTestId(`profile-request-${personal.id}`)).toContainText("approved");
    await expect(page.getByLabel("Mobile phone", { exact: true })).toHaveValue("+1 202 555 0186");

    const household = page.getByRole("region", { name: "My household", exact: true });
    const familyName = `Review child ${stamp}`;
    await household.getByRole("button", { name: "Add family member", exact: true }).click();
    await household.getByLabel("Family member first name", { exact: true }).fill(familyName);
    await household.getByLabel("Family member last name", { exact: true }).fill("Demo");
    await household.getByRole("combobox", { name: "Household role", exact: true }).selectOption("Child");
    const addition = await submitted("Submit family addition");
    await expect(household.getByText(`${familyName} Demo`, { exact: true })).toHaveCount(0);
    await portalLogin(adminPage, "admin@example.test");
    await expect(adminPage.getByRole("heading", { name: "Hello, Demo.", exact: true })).toBeVisible();
    await adminPage.getByRole("button", { name: "My profile", exact: true }).click();
    const review = adminPage.getByTestId(`profile-request-${addition.id}`);
    await expect(review).toContainText("Child");
    const applied = adminPage.waitForResponse(response => response.url().endsWith(`/profile-requests/${addition.id}/approve`) && response.request().method() === "POST");
    await review.getByRole("button", { name: "Approve changes", exact: true }).click();
    expect((await applied).ok()).toBeTruthy();
    const approved = await api(`/member/v1/profile-requests/${addition.id}`); familyId = approved.target.id;
    expect(approved.status).toBe("approved");
    await page.getByRole("button", { name: "Refresh profile requests", exact: true }).click();
    await expect(household.getByText(`${familyName} Demo`, { exact: true })).toBeVisible();
    const family = await api("/member/v1/household", "GET", undefined, memberToken);
    expect(family.members.every((person: Record<string, unknown>) => !("contactInfo" in person) && !("birthDate" in person))).toBeTruthy();

    await household.getByRole("button", { name: "Propose changes for Casey Demo", exact: true }).click();
    const form = household.getByRole("form", { name: "Propose changes for Casey Demo", exact: true });
    await form.getByRole("combobox", { name: "Field 1", exact: true }).selectOption("mobilePhone");
    await expect(form.getByLabel("Proposed mobile phone", { exact: true })).toHaveValue("");
    await form.getByLabel("Proposed mobile phone", { exact: true }).fill("+1 202 555 0187");
    const familyEdit = await submitted("Submit family changes");
    expect((await api("/membership/people/person-family-demo")).contactInfo.mobilePhone || "").toBe("");
    await adminPage.getByRole("button", { name: "Refresh profile requests", exact: true }).click();
    const familyReview = adminPage.getByTestId(`profile-request-${familyEdit.id}`);
    await familyReview.getByRole("button", { name: "Decline changes", exact: true }).click();
    await familyReview.getByLabel("Reason shown to requester", { exact: true }).fill("Please confirm this number with the family.");
    const declined = adminPage.waitForResponse(response => response.url().endsWith(`/profile-requests/${familyEdit.id}/decline`) && response.request().method() === "POST");
    await familyReview.getByRole("button", { name: "Confirm decline", exact: true }).click();
    expect((await declined).ok()).toBeTruthy();
    await page.getByRole("button", { name: "Refresh profile requests", exact: true }).click();
    await expect(page.getByTestId(`profile-request-${familyEdit.id}`)).toContainText("Please confirm this number with the family.");
    expect((await api("/membership/people/person-family-demo")).contactInfo.mobilePhone || "").toBe("");

    await household.getByRole("button", { name: "Propose changes for Casey Demo", exact: true }).click();
    await household.getByLabel("Proposed first name", { exact: true }).fill("Casey Proposal");
    const cancelled = await submitted("Submit family changes");
    await page.getByTestId(`profile-request-${cancelled.id}`).getByRole("button", { name: "Cancel request", exact: true }).click();
    await expect(page.getByTestId(`profile-request-${cancelled.id}`)).toContainText("cancelled");
    expect((await api("/membership/people/person-family-demo")).name.first).toBe("Casey");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await adminPage.getByRole("button", { name: "Sign out", exact: true }).click();
    expect(problems).toEqual([]);
  } finally {
    try {
      for (const id of requests) { const row = await api(`/member/v1/profile-requests/${id}`); if (row.status === "pending") await api(`/member/v1/profile-requests/${id}/decline`, "POST", { reason: "Synthetic test cleanup" }); }
      await api("/membership/churches", "POST", [{ id: initialChurch.id, directoryApprovalGroupId: initialChurch.directoryApprovalGroupId || "" }]);
      await api("/membership/people", "POST", [{ id: initialPerson.id, contactInfo: { mobilePhone: initialPerson.contactInfo.mobilePhone || "" } }]);
      if (familyId) await api(`/membership/people/${familyId}`, "DELETE");
      // Protected historical tasks retain their review-group reference.
      if (groupId) await api("/membership/groups", "POST", [{ id: groupId, archived: true }]);
      await api("/membership/users/logout", "POST", {});
    } catch (error) { cleanupError = error; testInfo.annotations.push({ type: "cleanup", description: String(error) }); }
    await adminContext.close();
  }
  if (cleanupError) throw cleanupError;
});
