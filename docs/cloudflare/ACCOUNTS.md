# Local accounts and manual invitations

This implementation supports a local first-administrator bootstrap, administrator-issued account invitations, existing-account linking, and authenticated password changes. It sends no email and exposes no open registration or password-reset issuance endpoint. Only synthetic accounts have been tested; no live directory records or credentials were migrated.

## Fresh local bootstrap

The existing `yarn setup:cloudflare` command creates the synthetic demo installation. To exercise an empty installation separately, build the frontend, then use a separate local persistence directory:

```sh
yarn build:cloudflare
node scripts/cloudflare-bootstrap.mjs --church "Synthetic Church" --slug synthetic --email admin@example.test --first Admin --last Example --persist-to /tmp/b1-fresh-local
cd cloudflare
node node_modules/wrangler/bin/wrangler.js dev --local --persist-to /tmp/b1-fresh-local
```

The bootstrap command applies migrations and atomically creates one church, person, pending administrator, and setup invitation. It prints a single-use `http://localhost:8787/login?auth=...` link, valid for 24 hours, only after success. The login page consumes the invitation to set a password; then sign in normally. The command refuses an installation containing any users or churches. It hardcodes `--local` and cannot target a remote database. Setup adds missing session and independent MFA encryption keys to ignored local `.dev.vars` with mode `0600`; repeated runs preserve existing keys.

Treat the link as a credential: copy it privately and keep it out of issue comments, screenshots, source files, and shell history. SQL temporary files contain only the token hash, use mode `0600`, and are deleted. The raw token exists only in process memory and the deliberate terminal output. The command never accepts a password argument.

Expired bootstrap invitations require the offline recovery procedure below; none is exposed over HTTP. An administrator in a running installation can reissue ordinary pending invitations. The offline operator recovery procedure below can recover an expired local bootstrap; production provisioning and recovery identity-proofing remain work.

## Invitation API

Paths below are relative to `/api/membership`. Every response is `Cache-Control: no-store`. Error bodies use `{ "errors": ["message"] }`.

| Method and route | Access and contract |
| --- | --- |
| `POST /users/invitations` | Bootstrap administrator only. Body `{personId, roleId?}`; role must be a custom role in the current church. Returns `201 {id,mode,expiresAt,invitationUrl,delivery:"manual"}`. |
| `GET /users/invitations?personId=...` | Bootstrap administrator only. At most 100 current-tenant metadata rows. Never returns token or token hash. |
| `DELETE /users/invitations/:id` | Bootstrap administrator only, current tenant. Revokes outstanding token. |
| `POST /users/invitations/preview` | Anonymous. Body `{authGuid}`. Returns `{mode,expiresAt}` and, for `link`, `requiresMfa`; mode is `setPassword` or `link`. |
| `POST /users/setPasswordGuid` | Anonymous single-use setup. Body `{authGuid,newPassword}`. Returns `{success:true,email}`. |
| `POST /users/acceptInvitation` | Anonymous single-use existing-account link. Body `{authGuid,currentPassword,mfaCode?}`; an unused factor is required when MFA is enabled. Returns `{success:true,email}`. |
| `POST /users/updatePassword` | Authenticated. Body `{currentPassword,newPassword}`. Returns safe user fields, `success:true,sessionsRevoked:true`; sign in again. Wrong current password returns `400`, so the shared client does not treat a mistyped field as an already-invalid session. |

The original role member picker offers manual invitations for a selected person without a linked account. For an already-linked active account, issuance returns `200 {mode:"login",invitationUrl:"/login",alreadyLinked:true}`. That response does not assign a requested role; use the existing role-member endpoint. A new account gets base role `member`; an optional custom role is attached only after acceptance. The API does not create another bootstrap administrator.

An existing active account is never reset by an invitation. A pending account already linked to a church can only use its original setup invitation, preventing another church from activating a pending bootstrap administrator. If the same email belongs to an account in another church, acceptance requires that account's current password before adding the new church link. Email/account relinking, self-service signup, OAuth, outbound invitations, and account deletion are not implemented here. Optional MFA and offline local recovery are described below.

## Security mechanics and password format

Invitations use 32 random bytes and store only a SHA-256 token hash. A conditional claim and all account/role effects execute in one D1 batch. Losing/replayed claims cannot create a partial account. Issuance rechecks the actual administrator session and target snapshot inside the batch; concurrent logout, password changes, demotion, or target identity changes cannot leave an orphan user or newly usable invitation. Tokens expire after 24 hours and are permanently revoked on reissue, relevant person changes, issuer demotion, or account/password changes.

New passwords are 12–128 Unicode code points, at most 512 UTF-8 bytes. Whitespace is preserved, and no composition rules are imposed. New hashes use `@noble/hashes` scrypt with `N=32768,r=8,p=3`, a random 16-byte salt, and a 32-byte output. This parameter set appears in the [OWASP password storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html); the dependency is [MIT licensed](https://github.com/paulmillr/noble-hashes). The older PBKDF2-100000 format remains read-compatible for synthetic seed fixtures. No upstream password-database conversion has been attempted.

The hash implementation uses roughly 32 MiB of working memory and executes synchronously to avoid concurrent memory-heavy allocations inside one isolate. Local workerd acceptance and comparison against Node's independent scrypt implementation are tested. Production CPU cost, load behavior, and an appropriate paid Workers CPU budget have **not** been measured or deployed; this is not a claim that the free Workers CPU allowance is sufficient.

A password version ties sessions to the current account credentials. Password updates compare-and-swap the prior hash/version and revoke every session, including user-JWT refresh. Login's session insert also checks the password snapshot. D1 triggers protect the last enabled administrator with an active password and nonremoved person link, including role/link changes, disabling, pending-state changes and person removal. HTTP authentication and realtime validation both reject removed-person links; existing sockets are checked again during realtime activity and maintenance. The role API cannot edit the virtual Domain Admins role. Per-IP and per-subject account throttles are stored atomically in D1; production abuse protection remains a deployment concern.

## Verification

- `auth-lifecycle.test.mjs`: 8 local Worker integration tests covering tenant/admin issuance, token hashing, concurrent single-use acceptance, role assignment, scrypt reference verification, reissue/revoke/expiry, identity changes, cross-church linking, password/session revocation, empty bootstrap, and cross-tenant pending-bootstrap takeover prevention.
- `auth-race.test.mjs`: 6 tests inserting deterministic competing D1 writes immediately before issuance, plus last-administrator multi-statement/multi-row rollback. The test uses real authentication and lifecycle code, without production test hooks.
- The actual CLI was exercised against fresh temporary Wrangler local storage: first run succeeded and emitted one link; second run failed with the nonempty-installation guard and emitted no link. Temporary state was removed.
- Frontend acceptance/password flows are covered separately by `tests/cloudflare/accounts.spec.ts`; consult the current verification report for its executed result.

## Optional authenticator MFA (milestone 3)

The account page now supports an authenticator app, using six-digit SHA-1 TOTP with 30-second steps and a ±1-step clock allowance. Accepted steps are atomically consumed and cannot be reused across challenges or settings changes. The implementation matches the SHA-1 test vectors in [RFC 6238](https://www.rfc-editor.org/rfc/rfc6238). This is TOTP, not phishing-resistant WebAuthn.

The first password login may return `{mfaRequired:true,mfaToken,expiresAt}`. Complete it using the same `POST /users/login` route with `{mfaToken,mfaCode}`; `mfaCode` accepts either an unused six-digit authenticator code or one backup code. Only successful completion creates a session and returns the existing suite `user`/`userChurches` response. Challenges expire after five minutes, have at most five attempts, and are tied to the account password version and active factor. Per-account/per-IP limits also span separate challenges and sensitive factor operations, following [RFC 4226](https://www.rfc-editor.org/rfc/rfc4226) throttling guidance. Both the administration login and member portal implement this flow.

| Route relative to `/api/membership` | Contract |
| --- | --- |
| `GET /users/mfa/status` | Authenticated account: `{enabled,backupCodesLeft}`. No secret retrieval. |
| `POST /users/mfa/setup` | `{currentPassword}`; returns `{secret,otpauthUrl,setupToken,expiresAt}` once. Pending enrollment lasts ten minutes and is tied to the initiating account/session/password version. |
| `POST /users/mfa/enable` | `{setupToken,code}`; confirms possession and returns ten `backupCodes` plus `sessionsRevoked:true`. |
| `POST /users/mfa/disable` | `{currentPassword,code}`; requires an unused authenticator or backup code and revokes all sessions. |
| `POST /users/mfa/backupCodes` | `{currentPassword,code}`; requires a fresh **TOTP** code, replaces every backup code, and revokes all sessions. |

Backup codes have 128 random bits each and are stored only as user-bound SHA-256 hashes. Enabling, disabling, or rotating backup codes increments the account security/password version, revoking existing sessions and pending challenges. The client displays newly issued backup codes in a modal that blocks navigation until acknowledgement; codes and setup credentials stay in component memory. A page reload intentionally loses them. Changing the password retains the authenticator; existing-account invitation acceptance also requires its factor, preventing a different church administrator from bypassing MFA through account linking.

Active and pending authenticator secrets are encrypted with AES-256-GCM, a fresh nonce, and authenticated data bound to both user ID and factor ID. `AUTH_ENCRYPTION_KEY` is a separate 32-byte base64url development secret, not derived from `SESSION_SECRET`. Setup/bootstrap add it to ignored `.dev.vars` only when missing and preserve both existing keys on repeated runs. Keep an independent protected backup of the encryption key: replacing it makes existing authenticator ciphertext unreadable. Automated key rotation/re-encryption is not implemented. Missing or incorrect keys prevent TOTP decryption without disabling MFA; valid backup codes remain usable. No secret is stored in SQL/audit plaintext or sent to an external QR-code service; the QR is generated locally.

The changes require the existing password and enrolled-factor proof where applicable, consistent with [OWASP MFA guidance](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html). There are no factor-change notification messages in this no-transmission development instance. Production abuse controls, incident response, key custody/rotation, and phishing-resistant authenticators remain deployment work.

## Offline operator recovery

There is still no HTTP recovery issuance or tenant-administrator account reset. A local operator with filesystem/D1 access can issue a 30-minute, single-use recovery link for an **exact user ID and email pair**:

```sh
node scripts/cloudflare-recover.mjs --user-id user-member --email member@example.test
# For isolated local state, add: --persist-to /tmp/b1-fresh-local
```

The CLI hardcodes `--local`, stores only the token hash, uses a mode-0600 temporary SQL file and deletes it, and prints the raw link only after a successful write. A mismatched identity produces no link. Normal recovery changes the password, preserves MFA, and requires the user's existing factor or a backup code. For an independently verified offline loss of both factors, the operator may explicitly add `--reset-mfa`; that fact appears in the confirmation UI and audit action. A church administrator cannot perform this global-account operation through the API.

The recovery page captures `?recovery=...` into memory and removes it from the URL. `POST /users/recovery/preview {recoveryToken}` returns only expiry/factor requirements. `POST /users/recovery/complete {recoveryToken,newPassword,mfaCode?}` atomically consumes the token, applies the authorized change, and revokes every session. Reissue, password/security-version changes, account email changes, and disabling invalidate outstanding recovery grants. The user must sign in normally afterward, consistent with [OWASP recovery guidance](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html).

Recovery does not create church memberships, alter roles, reactivate disabled users, or restore a removed person record. An expired first-administrator bootstrap can be recovered through the same privileged local CLI; recovering credentials never repairs unrelated tenant-access changes. No production recovery identity-proofing process is claimed by this local development tool.

Verification additions: RFC vector/ciphertext binding tests; enrollment/password/session ownership; concurrent TOTP and challenge consumption; backup-code replay/rotation; challenge expiry/attempt limits; shared factor throttles; MFA-preserving reset and explicit offline factor removal; recovery identity/single-use/expiry/reissue/disabled-account boundaries; cross-church MFA invitation linking; and removed-link access denial. The actual CLI was exercised against isolated temporary Wrangler D1: matching identity succeeded, mismatch failed without a link, explicit factor-reset mode was disclosed, and repeated secret setup preserved existing keys with mode 0600.

Focused browser verification: **4/4 cases passed** across accounts (2), MFA enrollment/backup acknowledgement plus administration/member sign-in (1), and real local-CLI recovery through the browser (1). The checks confirmed no secrets in browser storage/API URLs and no external requests in the MFA flow. Initial selector failures were corrected without changing product behavior.
