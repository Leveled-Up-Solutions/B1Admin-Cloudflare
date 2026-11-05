import { expect, test } from "@playwright/test";

test("scoped Serving and My Work work without directory grants and ministry membership does not grant edit", async ({ page, request, baseURL }, testInfo) => {
  const login = await request.post("/api/membership/users/login", { data: { email: "admin@example.test", password: "LocalDemo2026!" } });
  expect(login.ok()).toBeTruthy();
  const headers = { Authorization: `Bearer ${(await login.json()).userChurches[0].jwt}` };
  async function api(path: string, method = "GET", data?: unknown) {
    const response = await request.fetch("/api" + path, { method, headers, data });
    expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy();
    return response.json();
  }
  const stamp = String(Date.now());
  let roleId = "", ministryId = "", teamId = "", planId = "", privatePlanId = "", planTypeId = "", viewerMembershipId = "";
  let workflowFailed = false;
  const task = await api("/doing/tasks/task-demo");
  const seedPlan = await api("/doing/plans/plan-demo");
  const problems: string[] = [], directoryCalls: string[] = [];
  page.on("pageerror", error => problems.push(error.message));
  page.on("request", req => { if (/\/api\/membership\/(people|groupmembers)/i.test(new URL(req.url()).pathname)) directoryCalls.push(req.url()); });
  page.on("response", res => { if (res.url().includes("/api/") && res.status() >= 400) problems.push(`${res.status()} ${new URL(res.url()).pathname}`); });
  await page.route("**/*", route => {
    if (new URL(route.request().url()).origin !== new URL(baseURL!).origin) { problems.push("External request"); return route.abort(); }
    return route.continue();
  });
  async function signIn(email: string) {
    await page.goto("/login");
    await page.locator('input[type="email"]').fill(email);
    await page.locator('input[name="password"]').fill("LocalDemo2026!");
    const response = page.waitForResponse(res => res.url().endsWith("/api/membership/users/login") && res.request().method() === "POST");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    const jwt = (await (await response).json()).userChurches[0].jwt;
    await expect(page.getByRole("heading", { name: "Church administration", exact: true })).toBeVisible();
    return jwt;
  }
  try {
    const [ministry] = await api("/membership/groups", "POST", [{ name: `Scoped ministry ${stamp}`, tags: "ministry" }]); ministryId = ministry.id;
    const [team] = await api("/membership/groups", "POST", [{ name: `Scoped team ${stamp}`, tags: "team", categoryName: ministryId }]); teamId = team.id;
    await api("/membership/groupmembers", "POST", [{ groupId: teamId, personId: "person-jordan" }]);
    const [viewerMembership] = await api("/membership/groupmembers", "POST", [{ groupId: ministryId, personId: "person-jordan" }]); viewerMembershipId = viewerMembership.id;
    const [planType] = await api("/doing/planTypes", "POST", [{ ministryId, name: `Scoped plan type ${stamp}` }]); planTypeId = planType.id;
    const [plan] = await api("/doing/plans", "POST", [{ ministryId, planTypeId, name: `Scoped service ${stamp}`, serviceDate: "2027-12-12", serviceOrder: false, prepared: false }]); planId = plan.id;
    expect(seedPlan.ministryId).not.toBe(ministryId);
    const [privatePlan] = await api("/doing/plans", "POST", [{ ministryId: seedPlan.ministryId, planTypeId: seedPlan.planTypeId, name: `Unscoped private service ${stamp}`, serviceDate: "2027-12-12", serviceOrder: false, prepared: true }]); privatePlanId = privatePlan.id;
    await api("/doing/positions", "POST", [{ planId, groupId: teamId, categoryName: "Volunteers", name: "Scoped welcome position", count: 1 }]);
    await api("/doing/tasks", "POST", [{ ...task, assignedToType: "group", assignedToId: ministryId, title: `Scoped work ${stamp}`, status: "Open" }]);
    const [role] = await api("/membership/roles", "POST", [{ name: `Scoped Doing ${stamp}` }]); roleId = role.id;
    await api("/membership/rolepermissions", "POST", ["Plans", "Tasks"].flatMap(contentType => ["View", "Edit"].map(action => ({ roleId, apiName: "DoingApi", contentType, contentId: ministryId, action }))));
    await api("/membership/rolemembers", "POST", [{ roleId, personId: "person-alex" }]);

    const token = await signIn("member@example.test");
    await page.getByRole("link", { name: "Serving / Plans", exact: true }).first().click();
    await expect(page.getByTestId("add-ministry-button")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Street Church Gathering", exact: true })).toHaveCount(0);
    await page.getByRole("link", { name: planType.name, exact: true }).click();
    await expect(page.getByTestId("add-plan-button")).toBeVisible();
    await page.getByRole("link", { name: plan.name, exact: true }).click();
    await page.getByTestId("edit-plan-button").click();
    await page.getByTestId("plan-name-input").locator("input").fill(`${plan.name} revised`);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("heading", { name: `${plan.name} revised`, exact: true })).toBeVisible();
    await page.getByRole("row").filter({ hasText: "Scoped welcome position" }).getByRole("button", { name: /person needed/i }).click();
    await expect(page.getByTestId("preferences-button-person-jordan")).toHaveCount(0);
    await page.getByRole("button", { name: "Jordan Sample", exact: true }).click();
    await expect(page.getByRole("row").filter({ hasText: "Scoped welcome position" }).getByRole("button", { name: "Jordan Sample", exact: true })).toBeVisible();

    await page.getByRole("link", { name: "My Work", exact: true }).first().click();
    await page.getByTestId("tasklist-tab-groups").click();
    await page.getByRole("link", { name: `Scoped work ${stamp}`, exact: true }).click();
    await page.getByTestId("task-status-toggle").click();
    await expect(page.getByTestId("task-status")).toHaveText("Closed");
    await page.getByTestId("task-status-toggle").click();
    await expect(page.getByTestId("task-status")).toHaveText("Open");
    await page.getByTestId("task-assign").click();
    await expect(page.getByRole("dialog").getByRole("tab", { name: /person/i })).toHaveCount(0);
    await page.getByRole("dialog").getByRole("row").filter({ hasText: ministry.name }).click();
    await expect(page.getByTestId("task-assigned-label")).toHaveText(ministry.name);
    // Existing member relationships still expose the published seed plan. A private
    // plan outside the granted ministry isolates the staff-scope rejection instead.
    expect((await request.get("/api/doing/plans/plan-demo", { headers: { Authorization: `Bearer ${token}` } })).status()).toBe(200);
    expect((await request.get("/api/doing/plans/" + privatePlanId, { headers: { Authorization: `Bearer ${token}` } })).status()).toBe(403);
    expect((await request.get("/api/membership/people", { headers: { Authorization: `Bearer ${token}` } })).status()).toBe(403);
    expect(directoryCalls).toEqual([]);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();

    await signIn("viewer@example.test");
    await page.getByRole("link", { name: "Serving / Plans", exact: true }).first().click();
    await page.getByRole("tab", { name: ministry.name, exact: true }).click();
    await page.getByRole("link", { name: planType.name, exact: true }).click();
    await expect(page.getByTestId("add-plan-button")).toHaveCount(0);
    await page.getByRole("link", { name: `${plan.name} revised`, exact: true }).click();
    await expect(page.getByTestId("plan-serving")).toBeVisible();
    await expect(page.getByTestId("edit-plan-button")).toHaveCount(0);
    await expect(page.getByTestId("add-position-button")).toHaveCount(0);
    await page.getByRole("link", { name: "My Work", exact: true }).first().click();
    await expect(page.getByTestId("add-task-button")).toHaveCount(0);
    expect(problems).toEqual([]);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
  } catch (error) {
    workflowFailed = true;
    throw error;
  } finally {
    const cleanupErrors: string[] = [];
    // Unmount the app before deleting fixtures so outstanding UI queries cannot
    // race cleanup and appear to be authorization failures in the workflow.
    await page.goto("about:blank").catch(error => cleanupErrors.push(String(error)));
    const cleanup = [
      () => api("/doing/tasks", "POST", [task]),
      ...(roleId ? [() => api("/membership/roles/" + roleId, "DELETE")] : []),
      ...(planId ? [() => api("/doing/plans/" + planId, "DELETE")] : []),
      ...(privatePlanId ? [() => api("/doing/plans/" + privatePlanId, "DELETE")] : []),
      ...(planTypeId ? [() => api("/doing/planTypes/" + planTypeId, "DELETE")] : []),
      ...(viewerMembershipId ? [() => api("/membership/groupmembers/" + viewerMembershipId, "DELETE")] : []),
      ...(teamId ? [() => api("/membership/groups/" + teamId, "DELETE")] : []),
      ...(ministryId ? [() => api("/membership/groups/" + ministryId, "DELETE")] : []),
      () => api("/membership/users/logout", "POST", {})
    ];
    for (const operation of cleanup) {
      try { await operation(); } catch (error) { cleanupErrors.push(String(error)); }
    }
    if (cleanupErrors.length) {
      await testInfo.attach("fixture-cleanup-errors", { body: cleanupErrors.join("\n"), contentType: "text/plain" });
      if (!workflowFailed) expect(cleanupErrors, "Fixture cleanup must succeed").toEqual([]);
    }
  }
});
