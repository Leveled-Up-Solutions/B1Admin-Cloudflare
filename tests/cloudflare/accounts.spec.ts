import { expect, test } from "@playwright/test";

test("ordinary members signing in at the administration entry land in their portal", async ({ page }) => {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill("member@example.test");
  await page.locator('input[name="password"]').fill("LocalDemo2026!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/portal$/);
  await expect(page.getByRole("heading", { name: /Hello, Alex/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "People", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem("b1-member-session-v1"))).toBeTruthy();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Welcome back", exact: true })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("b1-member-session-v1"))).toBeNull();
});

// Accepted accounts deliberately have no destructive delete API. These uniquely named
// synthetic accounts are retained until the disposable development database is reset.
test("manual invitation setup and password changes revoke old sessions", async ({ page, request, baseURL }) => {
  const errors: string[] = [], external: string[] = [], apiUrls: string[] = [];
  let setupRequests = 0;
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.origin !== new URL(baseURL!).origin && !["data:", "blob:"].includes(url.protocol)) external.push(url.origin);
    if (url.pathname.startsWith("/api/")) apiUrls.push(request.url());
    if (url.pathname.endsWith("/users/setPasswordGuid") && request.method() === "POST") setupRequests++;
  });
  const adminLogin = await request.post("/api/membership/users/login", { data: { email: "admin@example.test", password: "LocalDemo2026!" } });
  expect(adminLogin.status()).toBe(200);
  const headers = { Authorization: "Bearer " + (await adminLogin.json()).userChurches[0].jwt };
  const suffix = crypto.randomUUID();
  const email = `browser-account-${suffix}@example.test`;
  const firstPassword = "Synthetic initial phrase 2026!";
  const nextPassword = "Synthetic replacement phrase 2026!";
  const portalPassword = "Synthetic member portal phrase 2026!";
  let roleId = "";
  try {
    const personResponse = await request.post("/api/membership/people", { headers, data: [{ name: { first: "Synthetic", last: `Account ${suffix}` }, contactInfo: { email }, membershipStatus: "Member" }] });
    expect(personResponse.ok()).toBeTruthy();
    const personId = (await personResponse.json())[0].id;
    const roleResponse = await request.post("/api/membership/roles", { headers, data: [{ name: `Account browser role ${suffix}` }] });
    expect(roleResponse.ok()).toBeTruthy();
    roleId = (await roleResponse.json())[0].id;
    expect((await request.post("/api/membership/rolepermissions", { headers, data: [{ roleId, apiName: "MembershipApi", contentType: "People", action: "View" }] })).ok()).toBeTruthy();
    const invitationResponse = await request.post("/api/membership/users/invitations", { headers, data: { personId, roleId } });
    expect(invitationResponse.status()).toBe(201);
    const invitation = await invitationResponse.json();
    expect(invitation.mode).toBe("setPassword");
    const token = new URL(invitation.invitationUrl, baseURL).searchParams.get("auth")!;

    await page.goto(invitation.invitationUrl);
    await expect(page.getByRole("form", { name: "Accept invitation", exact: true })).toBeVisible();
    await expect(page).not.toHaveURL(/auth=/);
    expect(apiUrls.some(url => url.includes(token))).toBeFalsy();
    expect(await page.evaluate(value => [...Object.values(localStorage), ...Object.values(sessionStorage)].some(stored => stored.includes(value)), token)).toBeFalsy();
    await page.getByLabel(/^New password/).fill("😀".repeat(6));
    await page.getByLabel(/^Confirm new password/).fill("😀".repeat(6));
    await page.getByRole("button", { name: "Set password and accept", exact: true }).click();
    await expect(page.getByText("Use a password or passphrase with 12–128 characters.", { exact: true })).toBeVisible();
    expect(setupRequests).toBe(0);
    await page.getByLabel(/^New password/).fill(firstPassword);
    await page.getByLabel(/^Confirm new password/).fill("A mismatching synthetic password");
    await page.getByRole("button", { name: "Set password and accept", exact: true }).click();
    await expect(page.getByText("The new passwords do not match.", { exact: true })).toBeVisible();
    expect(setupRequests).toBe(0);
    await page.getByLabel(/^Confirm new password/).fill(firstPassword);
    await page.getByRole("button", { name: "Set password and accept", exact: true }).click();
    await expect(page.getByText("Invitation accepted. Sign in with your email and password.", { exact: true })).toBeVisible();
    await expect(page.locator('input[type="email"]')).toHaveValue(email);
    await page.locator('input[name="password"]').fill(firstPassword);
    const signedIn = page.waitForResponse(response => response.url().endsWith("/api/membership/users/login") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    const oldSession = (await (await signedIn).json()).userChurches[0].jwt;
    await expect(page.getByRole("heading", { name: "Church administration", exact: true })).toBeVisible();

    await page.getByRole("link", { name: "My account", exact: true }).click();
    await page.getByLabel(/^Current password/).fill("Incorrect synthetic current password");
    await page.getByLabel(/^New password/).fill(nextPassword);
    await page.getByLabel(/^Confirm new password/).fill(nextPassword);
    const wrongPassword = page.waitForResponse(response => response.url().endsWith("/api/membership/users/updatePassword") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Change password", exact: true }).click();
    expect((await wrongPassword).status()).toBe(400);
    await expect(page).toHaveURL(/\/account$/);
    await page.getByLabel(/^Current password/).fill(firstPassword);
    await page.getByRole("button", { name: "Change password", exact: true }).click();
    await expect(page.getByText("Your password has changed. Sign in with your new password.", { exact: true })).toBeVisible();
    expect((await request.get("/api/member/v1/me", { headers: { Authorization: `Bearer ${oldSession}` } })).status()).toBe(401);

    await page.locator('input[type="email"]').fill(email);
    await page.locator('input[name="password"]').fill(nextPassword);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Church administration", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();

    await page.goto("/portal");
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill(nextPassword);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("heading", { name: /Hello, Synthetic/ })).toBeVisible();
    const memberSession = await page.evaluate(() => sessionStorage.getItem("b1-member-session-v1"));
    await page.getByRole("button", { name: "My profile", exact: true }).click();
    await page.getByLabel(/^Current password/).fill(nextPassword);
    await page.getByLabel(/^New password/).fill(portalPassword);
    await page.getByLabel(/^Confirm new password/).fill(portalPassword);
    await page.getByRole("button", { name: "Change password", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Welcome back", exact: true })).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem("b1-member-session-v1"))).toBeNull();
    expect((await request.get("/api/member/v1/me", { headers: { Authorization: `Bearer ${memberSession}` } })).status()).toBe(401);
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill(portalPassword);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("button", { name: "Home", exact: true }).click();
    await expect(page.getByRole("heading", { name: /Hello, Synthetic/ })).toBeVisible();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Welcome back", exact: true })).toBeVisible();
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  } finally {
    if (roleId) await request.delete(`/api/membership/roles/${roleId}`, { headers });
    await request.post("/api/membership/users/logout", { headers, data: {} });
  }
});
