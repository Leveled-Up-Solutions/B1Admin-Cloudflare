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

The bootstrap command applies migrations and atomically creates one church, person, pending administrator, and setup invitation. It prints a single-use `http://localhost:8787/login?auth=...` link, valid for 24 hours, only after success. The login page consumes the invitation to set a password; then sign in normally. The command refuses an installation containing any users or churches. It hardcodes `--local` and cannot target a remote database. A missing local `.dev.vars` gets a random session secret with mode `0600`.

Treat the link as a credential: copy it privately and keep it out of issue comments, screenshots, source files, and shell history. SQL temporary files contain only the token hash, use mode `0600`, and are deleted. The raw token exists only in process memory and the deliberate terminal output. The command never accepts a password argument.

Expired bootstrap invitations require an offline recovery procedure; none is exposed over HTTP. An administrator in a running installation can reissue ordinary pending invitations. Production administrator recovery and deployment provisioning remain work, rather than silently turning this tool into a production reset mechanism.

## Invitation API

Paths below are relative to `/api/membership`. Every response is `Cache-Control: no-store`. Error bodies use `{ "errors": ["message"] }`.

| Method and route | Access and contract |
| --- | --- |
| `POST /users/invitations` | Bootstrap administrator only. Body `{personId, roleId?}`; role must be a custom role in the current church. Returns `201 {id,mode,expiresAt,invitationUrl,delivery:"manual"}`. |
| `GET /users/invitations?personId=...` | Bootstrap administrator only. At most 100 current-tenant metadata rows. Never returns token or token hash. |
| `DELETE /users/invitations/:id` | Bootstrap administrator only, current tenant. Revokes outstanding token. |
| `POST /users/invitations/preview` | Anonymous. Body `{authGuid}`. Returns only `{mode,expiresAt}`; mode is `setPassword` or `link`. |
| `POST /users/setPasswordGuid` | Anonymous single-use setup. Body `{authGuid,newPassword}`. Returns `{success:true,email}`. |
| `POST /users/acceptInvitation` | Anonymous single-use existing-account link. Body `{authGuid,currentPassword}`. Returns `{success:true,email}`. |
| `POST /users/updatePassword` | Authenticated. Body `{currentPassword,newPassword}`. Returns safe user fields, `success:true,sessionsRevoked:true`; sign in again. Wrong current password returns `400`, so the shared client does not treat a mistyped field as an already-invalid session. |

The original role member picker offers manual invitations for a selected person without a linked account. For an already-linked active account, issuance returns `200 {mode:"login",invitationUrl:"/login",alreadyLinked:true}`. That response does not assign a requested role; use the existing role-member endpoint. A new account gets base role `member`; an optional custom role is attached only after acceptance. The API does not create another bootstrap administrator.

An existing active account is never reset by an invitation. A pending account already linked to a church can only use its original setup invitation, preventing another church from activating a pending bootstrap administrator. If the same email belongs to an account in another church, acceptance requires that account's current password before adding the new church link. Email/account relinking, self-service signup, forgotten-password recovery, OAuth, MFA, outbound invitations, and account deletion are not implemented here.

## Security mechanics and password format

Invitations use 32 random bytes and store only a SHA-256 token hash. A conditional claim and all account/role effects execute in one D1 batch. Losing/replayed claims cannot create a partial account. Issuance rechecks the actual administrator session and target snapshot inside the batch; concurrent logout, password changes, demotion, or target identity changes cannot leave an orphan user or newly usable invitation. Tokens expire after 24 hours and are permanently revoked on reissue, relevant person changes, issuer demotion, or account/password changes.

New passwords are 12–128 Unicode code points, at most 512 UTF-8 bytes. Whitespace is preserved, and no composition rules are imposed. New hashes use `@noble/hashes` scrypt with `N=32768,r=8,p=3`, a random 16-byte salt, and a 32-byte output. This parameter set appears in the [OWASP password storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html); the dependency is [MIT licensed](https://github.com/paulmillr/noble-hashes). The older PBKDF2-100000 format remains read-compatible for synthetic seed fixtures. No upstream password-database conversion has been attempted.

The hash implementation uses roughly 32 MiB of working memory and executes synchronously to avoid concurrent memory-heavy allocations inside one isolate. Local workerd acceptance and comparison against Node's independent scrypt implementation are tested. Production CPU cost, load behavior, and an appropriate paid Workers CPU budget have **not** been measured or deployed; this is not a claim that the free Workers CPU allowance is sufficient.

A password version ties sessions to the current account credentials. Password updates compare-and-swap the prior hash/version and revoke every session, including user-JWT refresh. Login's session insert also checks the password snapshot. Active enabled last-administrator protection is enforced by D1 triggers for supported role demotion, membership deletion, and account disabling. The role API cannot edit the virtual Domain Admins role. Per-IP and per-subject account throttles are stored atomically in D1; production abuse protection remains a deployment concern.

## Verification

- `auth-lifecycle.test.mjs`: 8 local Worker integration tests covering tenant/admin issuance, token hashing, concurrent single-use acceptance, role assignment, scrypt reference verification, reissue/revoke/expiry, identity changes, cross-church linking, password/session revocation, empty bootstrap, and cross-tenant pending-bootstrap takeover prevention.
- `auth-race.test.mjs`: 6 tests inserting deterministic competing D1 writes immediately before issuance, plus last-administrator multi-statement/multi-row rollback. The test uses real authentication and lifecycle code, without production test hooks.
- The actual CLI was exercised against fresh temporary Wrangler local storage: first run succeeded and emitted one link; second run failed with the nonempty-installation guard and emitted no link. Temporary state was removed.
- Frontend acceptance/password flows are covered separately by `tests/cloudflare/accounts.spec.ts`; consult the current verification report for its executed result.
