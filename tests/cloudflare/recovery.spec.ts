import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { tmpdir } from "node:os";

test("offline operator recovery link is scrubbed and resets only the intended synthetic account", async ({ page, request, baseURL }) => {
  const state = process.env.B1_LOCAL_STATE_PATH;
  test.skip(!state, "Recovery browser acceptance requires the isolated local browser runner.");
  if (!state || !isAbsolute(state) || !resolve(state).startsWith(resolve(tmpdir()) + "/b1-browser-check-")) throw new Error("Recovery acceptance requires an explicit temporary browser state.");
  const suffix = crypto.randomUUID(), email = `browser-recovery-${suffix}@example.test`;
  const firstPassword = "Synthetic before recovery 2026!", nextPassword = "Synthetic after recovery 2026!";
  const admin = await request.post("/api/membership/users/login", { data: { email: "admin@example.test", password: "LocalDemo2026!" } }); expect(admin.ok()).toBeTruthy();
  const headers = { Authorization: `Bearer ${(await admin.json()).userChurches[0].jwt}` };
  const person = await request.post("/api/membership/people", { headers, data: [{ name: { first: "Recovered", last: suffix }, contactInfo: { email } }] }); expect(person.ok()).toBeTruthy();
  const invitation = await request.post("/api/membership/users/invitations", { headers, data: { personId: (await person.json())[0].id } }); expect(invitation.status()).toBe(201);
  const authGuid = new URL((await invitation.json()).invitationUrl, baseURL).searchParams.get("auth");
  expect((await request.post("/api/membership/users/setPasswordGuid", { data: { authGuid, newPassword: firstPassword } })).ok()).toBeTruthy();
  const before = await request.post("/api/membership/users/login", { data: { email, password: firstPassword } }); expect(before.ok()).toBeTruthy(); const old = await before.json();
  // The operator command receives identity arguments, never a password or recovery token.
  // Its raw token output is captured only in this test's memory and never logged.
  const output = execFileSync(process.execPath, ["scripts/cloudflare-recover.mjs", "--user-id", old.user.id, "--email", email, "--persist-to", state], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
  const matched = output.match(/http:\/\/localhost:8787\/login\?recovery=([A-Za-z0-9_-]{43})/); expect(!!matched).toBeTruthy(); const token = matched![1];
  const apiUrls: string[] = [];
  page.on("request", outgoing => { if (new URL(outgoing.url()).pathname.startsWith("/api/")) apiUrls.push(outgoing.url()); });
  await page.goto("/login?recovery=" + token);
  await expect(page.getByRole("form", { name: "Recover account", exact: true })).toBeVisible(); await expect(page).not.toHaveURL(/recovery=/);
  await page.getByLabel(/^Recovery new password/).fill(nextPassword); await page.getByLabel(/^Confirm recovery password/).fill(nextPassword);
  await page.getByRole("button", { name: "Set recovered password", exact: true }).click();
  await expect(page.getByText("Account recovered. Sign in with your new password.", { exact: true })).toBeVisible();
  expect((await request.get("/api/member/v1/me", { headers: { Authorization: `Bearer ${old.userChurches[0].jwt}` } })).status()).toBe(401);
  expect((await request.post("/api/membership/users/login", { data: { email, password: firstPassword } })).status()).toBe(401);
  expect((await request.post("/api/membership/users/recovery/complete", { data: { recoveryToken: token, newPassword: nextPassword } })).status()).toBe(400);
  expect(apiUrls.some(url => url.includes(token))).toBeFalsy();
  expect(await page.evaluate(value => [...Object.values(localStorage), ...Object.values(sessionStorage)].some(stored => stored.includes(value)), token)).toBeFalsy();
  await page.getByLabel(/^Password/).fill(nextPassword); await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Hello, Recovered/ })).toBeVisible();
});
