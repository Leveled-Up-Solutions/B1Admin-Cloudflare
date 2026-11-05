import { expect, test } from "@playwright/test";

test("member profile and household changes remain private across church selection", async ({ page, request, baseURL }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors: string[] = [], external: string[] = [], failures: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", call => {
    const url = new URL(call.url());
    if (url.origin !== new URL(baseURL!).origin && !["data:", "blob:"].includes(url.protocol)) external.push(call.url());
  });
  page.on("response", response => {
    if (response.url().includes("/api/") && response.status() >= 400) failures.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });
  const adminLogin = await request.post("/api/membership/users/login", { data: { email: "admin@example.test", password: "LocalDemo2026!" } });
  expect(adminLogin.status()).toBe(200);
  const adminToken = (await adminLogin.json()).userChurches[0].jwt;
  const adminHeaders = { Authorization: `Bearer ${adminToken}` };
  let memberToken = "", familyId = "";
  let original: Record<string, unknown> | undefined;
  let workflowError: unknown;
  try {
    await page.goto("/portal");
    await page.getByLabel("Email", { exact: true }).fill("multi-member@example.test");
    await page.getByLabel("Password", { exact: true }).fill("LocalDemo2026!");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Choose your church", exact: true })).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem("b1-member-session-v1"))).toBeNull();
    await expect(page.getByRole("heading", { name: /Hello,/ })).toHaveCount(0);
    await page.getByRole("combobox", { name: "Church", exact: true }).selectOption("church-demo");
    await page.getByRole("button", { name: "Open church", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Hello, Morgan.", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Change church", exact: true }).click();
    await page.getByRole("button", { name: "Open church", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Hello, Morgan.", exact: true })).toBeVisible();
    memberToken = await page.evaluate(() => sessionStorage.getItem("b1-member-session-v1") || "");
    const memberHeaders = { Authorization: `Bearer ${memberToken}` };
    const before = await (await request.get("/api/member/v1/me", { headers: memberHeaders })).json();
    original = {
      firstName: before.person.name.first, middleName: before.person.name.middle, lastName: before.person.name.last, nickName: before.person.name.nick,
      mobilePhone: before.person.contactInfo.mobilePhone, homePhone: before.person.contactInfo.homePhone,
      address1: before.person.contactInfo.address1, address2: before.person.contactInfo.address2, city: before.person.contactInfo.city,
      state: before.person.contactInfo.state, zip: before.person.contactInfo.zip, birthDate: before.person.birthDate,
      directoryVisible: before.person.directoryVisible, shareEmail: before.person.shareEmail
    };
    await page.getByRole("button", { name: "My profile", exact: true }).click();
    const household = page.getByRole("region", { name: "My household", exact: true });
    await expect(household.getByText("Casey Demo", { exact: true })).toBeVisible();
    await expect(household.getByText("Riley Other", { exact: true })).toHaveCount(0);
    await page.getByLabel("Preferred name", { exact: true }).fill("Morgan Browser");
    await page.getByLabel("Middle name", { exact: true }).fill("Synthetic");
    await page.getByLabel("Birth date", { exact: true }).fill("1990-02-03");
    await page.getByLabel("Mobile phone", { exact: true }).fill("+1 202 555 0144");
    await page.getByLabel("Home phone", { exact: true }).fill("+1 202 555 0145");
    await page.getByLabel("Address line 1", { exact: true }).fill("123 Synthetic Lane");
    await page.getByLabel("Address line 2", { exact: true }).fill("Unit Test");
    await page.getByLabel("City", { exact: true }).fill("Example City");
    await page.getByLabel("State or region", { exact: true }).fill("EX");
    await page.getByLabel("Postal code", { exact: true }).fill("00000");
    await page.getByRole("button", { name: "Save profile", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Your profile has been saved." })).toBeVisible();
    const saved = await (await request.get("/api/member/v1/me", { headers: memberHeaders })).json();
    expect(saved.person.name.nick).toBe("Morgan Browser");
    expect(saved.person.contactInfo.address1).toBe("123 Synthetic Lane");
    expect(saved.person.birthDate).toBe("1990-02-03");
    expect(saved.person.householdId).toBe("household-multi-demo");

    await page.getByLabel("Show my name in the member directory", { exact: true }).check();
    await page.getByLabel("Share my email with signed-in members", { exact: true }).check();
    await page.getByRole("button", { name: "Save preferences", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Your directory preferences have been saved." })).toBeVisible();
    await household.getByRole("button", { name: "Add family member", exact: true }).click();
    const first = `Synthetic family ${crypto.randomUUID().slice(0, 8)}`;
    await household.getByLabel("Family member first name", { exact: true }).fill(first);
    await household.getByLabel("Family member last name", { exact: true }).fill("Demo");
    await household.getByLabel("Family member mobile phone", { exact: true }).fill("+1 202 555 0146");
    await household.getByRole("combobox", { name: "Household role", exact: true }).selectOption("Child");
    const added = page.waitForResponse(response => response.url().endsWith("/api/member/v1/household/members") && response.request().method() === "POST");
    await household.getByRole("button", { name: "Save family member", exact: true }).click();
    const result = await added;
    expect(result.status()).toBe(201);
    familyId = (await result.json()).id;
    await expect(household.getByText(`${first} Demo`, { exact: true })).toBeVisible();
    const family = await (await request.get("/api/member/v1/household", { headers: memberHeaders })).json();
    expect(family.members.find((person: { id: string }) => person.id === familyId)).toEqual(expect.objectContaining({ householdRole: "Child", isSelf: false }));
    expect(family.members.every((person: Record<string, unknown>) => !("contactInfo" in person) && !("birthDate" in person))).toBeTruthy();

    await page.getByRole("button", { name: "Directory", exact: true }).click();
    await page.getByLabel("Find a member", { exact: true }).fill("Morgan Browser");
    await expect(page.getByRole("heading", { name: "Morgan Browser Demo", exact: true })).toBeVisible();
    await expect(page.getByText("123 Synthetic Lane", { exact: true })).toHaveCount(0);
    await page.getByLabel("Find a member", { exact: true }).fill(first);
    await expect(page.getByText("No matching members.", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Change church", exact: true }).click();
    await page.getByRole("combobox", { name: "Church", exact: true }).selectOption("church-other");
    await page.getByRole("button", { name: "Open church", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Hello, Morgan.", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "My profile", exact: true }).click();
    await expect(household.getByText("Riley Other", { exact: true })).toBeVisible();
    await expect(household.getByText("Casey Demo", { exact: true })).toHaveCount(0);
    await expect(household.getByText(`${first} Demo`, { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Address line 1", { exact: true })).toHaveValue("");
    await expect(page.getByLabel("Preferred name", { exact: true })).toHaveValue("");
    await page.reload();
    await expect(page.getByRole("heading", { name: "Hello, Morgan.", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "My profile", exact: true }).click();
    await expect(household.getByText("Riley Other", { exact: true })).toBeVisible();
    await expect(household.getByText("Casey Demo", { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    expect(errors).toEqual([]); expect(external).toEqual([]); expect(failures).toEqual([]);
  } catch (error) {
    workflowError = error;
    throw error;
  } finally {
    try {
      if (memberToken && original) expect((await request.post("/api/member/v1/me", { headers: { Authorization: `Bearer ${memberToken}` }, data: original })).ok()).toBeTruthy();
      if (familyId) expect((await request.delete(`/api/membership/people/${familyId}`, { headers: adminHeaders })).ok()).toBeTruthy();
      if (memberToken) await request.post("/api/membership/users/logout", { headers: { Authorization: `Bearer ${memberToken}` }, data: {} });
      await request.post("/api/membership/users/logout", { headers: adminHeaders, data: {} });
    } catch (error) {
      if (!workflowError) throw error;
      testInfo.annotations.push({ type: "cleanup", description: error instanceof Error ? error.message : "Cleanup failed after the workflow failure." });
    }
  }
});
