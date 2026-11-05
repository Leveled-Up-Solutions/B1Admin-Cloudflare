import { expect, test } from "@playwright/test";
import { createHmac } from "node:crypto";
function otp(secret: string) {
  let buffer = 0, bits = 0; const bytes: number[] = [];
  for (const char of secret) { buffer = (buffer << 5) | "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(char); bits += 5; if (bits >= 8) { bits -= 8; bytes.push((buffer >>> bits) & 255); } }
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(counter).digest(), offset = digest[19] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, "0");
}
test("authenticator enrollment, private backup acknowledgement and both sign-in surfaces require MFA", async ({ page, request, baseURL }) => {
  const suffix = crypto.randomUUID(), email = `browser-mfa-${suffix}@example.test`, password = "Synthetic MFA browser phrase 2026!";
  const admin = await request.post("/api/membership/users/login", { data: { email: "admin@example.test", password: "LocalDemo2026!" } });
  expect(admin.ok()).toBeTruthy();
  const headers = { Authorization: `Bearer ${(await admin.json()).userChurches[0].jwt}` };
  let roleId = "", backups: string[] = [], secret = "";
  const errors: string[] = [], external: string[] = [], urls: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", outgoing => { urls.push(outgoing.url()); const url = new URL(outgoing.url()); if (url.origin !== new URL(baseURL!).origin && !["data:", "blob:"].includes(url.protocol)) external.push(url.origin); });
  try {
    const people = await request.post("/api/membership/people", { headers, data: [{ name: { first: "Synthetic", last: `MFA ${suffix}` }, contactInfo: { email } }] }); expect(people.ok()).toBeTruthy();
    const roles = await request.post("/api/membership/roles", { headers, data: [{ name: `MFA browser ${suffix}` }] }); expect(roles.ok()).toBeTruthy(); roleId = (await roles.json())[0].id;
    expect((await request.post("/api/membership/rolepermissions", { headers, data: [{ roleId, apiName: "MembershipApi", contentType: "People", action: "View" }] })).ok()).toBeTruthy();
    const invite = await request.post("/api/membership/users/invitations", { headers, data: { personId: (await people.json())[0].id, roleId } }); expect(invite.status()).toBe(201);
    const authGuid = new URL((await invite.json()).invitationUrl, baseURL).searchParams.get("auth");
    expect((await request.post("/api/membership/users/setPasswordGuid", { data: { authGuid, newPassword: password } })).ok()).toBeTruthy();
    await page.goto("/login"); await page.getByLabel(/^Email/).fill(email); await page.getByLabel(/^Password/).fill(password); await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Church administration", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "My account", exact: true }).click(); await page.getByRole("button", { name: "Set up authenticator", exact: true }).click();
    await page.getByLabel("Password for authenticator settings", { exact: true }).fill(password);
    const setupResult = page.waitForResponse(response => response.url().endsWith("/users/mfa/setup") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Create authenticator setup", exact: true }).click(); const setup = await (await setupResult).json(); secret = setup.secret;
    await expect(page.getByLabel("Authenticator setup key", { exact: true })).toHaveText(secret);
    await page.getByLabel("Six-digit authenticator code", { exact: true }).fill(otp(secret));
    const enabledResult = page.waitForResponse(response => response.url().endsWith("/users/mfa/enable") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Enable authenticator", exact: true }).click(); const enabled = await enabledResult; expect(enabled.status()).toBe(200); backups = (await enabled.json()).backupCodes;
    const dialog = page.getByRole("dialog", { name: "Save your backup codes", exact: true }); await expect(dialog).toBeVisible();
    expect(backups).toHaveLength(10); await expect(page.getByLabel("Backup codes", { exact: true })).toContainText(backups[0]);
    await page.keyboard.press("Escape"); await expect(dialog).toBeVisible();
    expect(await page.evaluate(values => [...Object.values(localStorage), ...Object.values(sessionStorage)].some(stored => values.some(value => stored.includes(value))), [secret, setup.setupToken, ...backups])).toBeFalsy();
    await page.getByRole("button", { name: "I saved my backup codes. Sign in again", exact: true }).click();
    await expect(page).toHaveURL(/\/login$/); await page.getByLabel(/^Email/).fill(email); await page.getByLabel(/^Password/).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click(); await expect(page.getByLabel(/^Authenticator or backup code/)).toBeVisible();
    await expect(page.getByLabel(/^Password/)).toHaveCount(0);
    await page.getByLabel(/^Authenticator or backup code/).fill("invalid-code"); await page.getByRole("button", { name: "Verify and sign in", exact: true }).click(); await expect(page.getByRole("alert").filter({ hasText: "unused authenticator" })).not.toHaveCount(0);
    await page.getByLabel(/^Authenticator or backup code/).fill(backups[0]); await page.getByRole("button", { name: "Verify and sign in", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Church administration", exact: true })).toBeVisible(); await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.goto("/portal"); await page.getByLabel(/^Email/).fill(email); await page.getByLabel(/^Password/).fill(password); await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByLabel(/^Authenticator or (?:backup|recovery) code/i)).toBeVisible(); await page.getByLabel(/^Authenticator or (?:backup|recovery) code/i).fill(backups[1]); await page.getByRole("button", { name: /^Verify (?:and sign in|sign-in)$/i }).click();
    await expect(page.getByRole("heading", { name: /Hello, Synthetic/ })).toBeVisible();
    expect(urls.some(url => [secret, setup.setupToken, ...backups].some(value => url.includes(value)))).toBeFalsy(); expect(errors).toEqual([]); expect(external).toEqual([]);
  } finally {
    if (backups.length) {
      const challenge = await request.post("/api/membership/users/login", { data: { email, password } });
      if (challenge.ok()) { const pending = await challenge.json(); if (pending.mfaToken) { const signed = await request.post("/api/membership/users/login", { data: { mfaToken: pending.mfaToken, mfaCode: backups[8] } }); if (signed.ok()) await request.post("/api/membership/users/mfa/disable", { headers: { Authorization: `Bearer ${(await signed.json()).userChurches[0].jwt}` }, data: { currentPassword: password, code: backups[9] } }); } }
    }
    if (roleId) await request.delete("/api/membership/roles/" + roleId, { headers }).catch(() => undefined);
  }
});
