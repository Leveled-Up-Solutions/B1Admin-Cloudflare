# Run and review the Cloudflare adaptation

This is a runnable local development adaptation of selected ChurchApps workflows. It is **not a complete ChurchApps port or production-ready church installation**. Only synthetic fixtures are included. No production database, church records, payment account, email delivery, or live sermon source has been connected.

## Agreed scope

Port the existing selected workflows first: people and households, directory, groups and join-group flows, calendars, Serving/Plans, volunteer signup and assignment responses, My Work, sermon archives, roles/permissions, audit logs, member portal and mobile web/PWA. Milestone 4 adds resource permissions, profile/family review, paged member lists and native private media delivery. Workers handles requests, D1 owns relational data, and R2 owns archive files. A Durable Object handles authenticated tenant refresh events. The separate `pottershandsministries.org` website is not built here.

Giving/donations/payments, check-in, song/provider integrations, and outbound delivery are excluded. Automated fair rotation and an interface redesign are deferred. The Sound Ministry example uses existing ministry, team, plan and position records; it is not an automatic rotation engine.

## Prerequisites and first launch

Node.js 22.22.2 or newer in the Node 22 line, npm and Corepack. The frontend retains upstream Yarn 4.15.0; `cloudflare/` has a separate pinned npm lockfile. Current Wrangler uses a pinned Miniflare 5 beta local runtime; that dependency is explicit in the lockfile.

```sh
git clone --branch cloudflare-port https://github.com/Leveled-Up-Solutions/B1Admin-Cloudflare.git
cd B1Admin-Cloudflare
corepack yarn install --immutable
corepack yarn postinstall
npm ci --prefix cloudflare
corepack yarn build:cloudflare
corepack yarn setup:cloudflare
corepack yarn dev:cloudflare
```

Open **http://localhost:8787** for administration and **http://localhost:8787/portal** for members. The one Worker serves the built frontend and `/api/*`. Setup generates an ignored random `cloudflare/.dev.vars` session secret and independent MFA encryption key, applies D1 migrations with `--local`, and loads development fixtures. It does not contact a remote Cloudflare account or deploy resources. Local D1/R2/Durable Object state persists under ignored `cloudflare/.wrangler/state/`.

| Account | Password | Purpose |
| --- | --- | --- |
| `admin@example.test` | `LocalDemo2026!` | Built-in development administrator |
| `viewer@example.test` | `LocalDemo2026!` | Staff read access; no administrative mutations |
| `member@example.test` | `LocalDemo2026!` | Member portal, privacy, groups and own serving |
| `multi-member@example.test` | `LocalDemo2026!` | Member linked to both synthetic churches; context-switch review |
| `other@example.test` | `LocalDemo2026!` | Separate synthetic church for isolation tests |

These are deliberately public development credentials. Manual one-time invitations, existing-account linking, password changes, authenticator MFA with backup codes and offline local recovery are implemented; [ACCOUNTS.md](ACCOUNTS.md) explains a separate local-only empty-installation bootstrap. Production recovery identity-proofing, key custody/rotation, deployment configuration and load validation remain unfinished. The local recovery CLI never sends messages and cannot target a remote database. Admin sign-in currently stays in memory and requires sign-in after a reload; the portal uses sessionStorage for the browser tab. Logout revokes the server session. Roles are reloaded from D1 on each request, so permission revocation does not wait for token expiration.

For hot frontend development, leave the Worker running and use a second terminal:

```sh
corepack yarn dev:cloudflare:ui
```

Open **http://localhost:3101**. Vite proxies `/api` to the local Worker. Default `yarn start`, `yarn build` and `yarn test` now target this Cloudflare adaptation. The inherited demo-reset pretest and AWS deployment scripts are not active defaults; upstream workflow files are archived under `docs/cloudflare/upstream-workflows/`.

## Suggested review

1. Sign in as admin. Open People, create a synthetic person, edit their contact information, and inspect the group roster. The people/group lists, create controls, original household editor and supported advanced filters reuse B1Admin. Move household members and assign family roles; focused detail editors still replace broader unported profile panes.
2. Open Serving. Choose Sound Ministry and Street Church Gathering, then open the upcoming plan. The original plan types, plans, positions, time editor and service-order components run against D1. Sound-board Engineer, Streaming Specialist and Media Operator illustrate the existing station model.
3. Open My Work. Create a task assigned to a person or group, close it, and reopen it. Original standalone task controls are retained. Protected profile-review tasks instead show their dedicated decision controls to authorized reviewers; ordinary task edits cannot apply or bypass a request. Workflow cards, reminders and conversation notes are unavailable.
4. Open Calendars. Create a calendar with an IANA timezone, then an event. Timed events use explicit offset instants; all-day events retain civil dates with an exclusive end date. Test daily/weekly/monthly/yearly recurrence, individual exceptions, restoration, future-series edits and DST behavior. The calendar UI remains an adapter rather than every upstream calendar feature.
5. Open Sermons. Use the original sermon/playlist editor, deliberately publish a synthetic sermon, and attach a synthetic audio/document/image file to test R2. Test Play, seeking and Download through the native media controls. Default drafts are private; publication and future release dates are enforced by public/member APIs. Multipart upload offers pause/resume for larger files.
6. Open Roles and Audit Log. Create whole-church, exact-group, ministry Plans, assigned-group Tasks, calendar, sermon or playlist permissions and assign an existing account. Check that scoped editors see their resources without directory access or unrelated resources. For a person without an account, issue a manual one-time setup link using the original role member picker. Inspect recorded changes. Bootstrap administrators are protected; no invitation is sent automatically.
7. Sign into `/portal` as the member. Search and page through the opt-in directory, groups and published sermons; use calendar date controls. Join an open group or request approval, review group requests as a group leader, respond to an assignment, and record unavailable dates. Toggle directory preferences and confirm that private contact data stays out of the directory. Edit your own profile, inspect the household and add a private family record where direct changes are permitted. The multi-church fixture offers an explicit chooser and clears the previous church data when switching. Under My profile, test password changes or optional MFA and verify that old sessions are revoked.
8. As an administrator, set **Church settings → Directory approval group** to an active synthetic group. Submit a member's own profile change or new family addition, then review it through the original My Work task or the portal review queue. Also propose an existing relative's change: this always requires review, even without a configured group. Try approval, decline, cancellation and a stale-record conflict using synthetic records. Group membership alone does not authorize profile review; see the permission rules below.

## Milestone 4 behavior and limits

**Resource permissions.** Exact Calendars View/Edit covers a calendar and its events/recurrence. Exact Sermons View/Edit covers one sermon and its files; Playlists View/Edit covers that playlist and its current sermons/files. Lists filter scope before limits, moves require source and destination permission, and writes recheck authority in the same D1 batch as data and audit. Root calendar/playlist creation needs global editing authority; scoped playlist editors can create sermons inside their playlist. Existing global grants remain effective. Resource scope selectors show only delegatable actions and minimal labels, without adding directory rights. These are explicit fork semantics; [RESOURCE-PERMISSIONS.md](RESOURCE-PERMISSIONS.md) explains upstream differences, publishing, creation/move rules and strict delegation.

**Profile and family review.** Church Settings Edit controls the named approval-group setting. With no group, allowed own-profile edits and new private family additions save directly. With a valid group, both become proposals; malformed, unavailable or foreign group settings fail closed. Existing relatives always use proposals, and forms never fetch their hidden baseline contact details or birth dates. Directory/email visibility consent remains an independent direct choice. Every reviewer needs current global People Edit; when a group is configured, the reviewer additionally needs current membership in it, global Tasks Edit, or bootstrap administrator status. Approval atomically applies the validated changes, records the decision, closes its protected task and audits. Changed policy, household, account link or proposed fields require a refresh and usually cancellation/decline followed by resubmission. No notifications or automatic reviewer reassignment occur. See [MEMBER-APPROVALS.md](MEMBER-APPROVALS.md) and [the upstream workflow comparison](WORKFLOW-PARITY.md).

**Member pagination.** Directory, own/available groups, sermons and calendar occurrences have previous/next controls; search/date changes reset the page and hide stale results. The portal requests 20 rows. API callers retain array responses by default; `paged=1` returns items and bounded continuation metadata, not a total private-record count. API maximum/default page sizes are 100, or 200 for calendars, with offsets through 10,000. Reaching that cap asks the member to narrow their query. Search is limited to 100 characters and uses SQLite case folding, without full Unicode collation parity. Calendar windows are bounded to 366 days; visibility, recurrence and exception handling precede occurrence paging. Archive attachment lists remain capped at 100 per sermon. Portal group-join request lists still show only the first 100 without paging controls, although their API supports limit/offset. Details are in [MEMBER-PORTAL.md](MEMBER-PORTAL.md).

**Native media.** After bearer-authorized access issuance, audio/video and browser downloads use same-origin native URLs and byte ranges with file-scoped HttpOnly, Secure, SameSite=Strict cookies. URLs carry no bearer/media secret. Every request rechecks the live session and current publication/resource rights; logout, church selection and account replacement invalidate the prior media context. Grants last at most two hours, capped by login expiry, with twenty active file grants per session. Play/Download can request fresh access. Production requires HTTPS; local loopback development is supported. Already received bytes cannot be retracted. This removes the former 25 MiB browser Blob cap while retaining the upload limits below. Browser codec support, not server transcoding, determines playback. These cookies are not cross-origin website authentication; see [CALENDAR_SERMON_API.md](CALENDAR_SERMON_API.md).

## Verification commands

```sh
corepack yarn typecheck
corepack yarn check:cloudflare
corepack yarn test:cloudflare
corepack yarn build:cloudflare
npm run build --prefix cloudflare
```

`npm run build --prefix cloudflare` runs **`wrangler deploy --dry-run`**, which bundles without deploying. Backend tests instantiate isolated local workerd/Miniflare runtimes with actual D1, R2 and Durable Object bindings, not an in-memory JavaScript imitation of SQL. They do not access the persistent demo database.

For the complete compiled browser suite, use:

```sh
corepack yarn playwright install chromium
corepack yarn test:cloudflare:browser
```

Alternatively set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to an installed Chromium/Chrome binary. The default browser runner divides the suite into batches of at most three spec files. Each batch applies all migrations and seeds to fresh temporary local storage, serves the built app on port 8790, runs its tests and stops that server. This keeps the real login throttle enabled as the suite grows. Passing explicit spec paths or Playwright arguments runs one isolated selection. It leaves the usual preview database untouched and prints the temporary state directory. The isolated browser configuration refuses non-loopback URLs and does not run the inherited upstream demo-reset setup. For individual checks against an already running server, `yarn test:cloudflare:ui` defaults to Vite on 3101; `B1_TEST_BASE_URL=http://127.0.0.1:8787` selects the built single-Worker preview. Repeated manual browser runs may correctly reach the login throttle; use the isolated runner for reproducible complete checks. Browser tests create synthetic records; people deletion is soft deletion and may leave synthetic household fixtures. Re-run setup only against local development state, not real records.

See [VERIFICATION.md](VERIFICATION.md) for the final executed checks, evidence and limitations. Both full frontend TypeScript projects and the Worker are checked. The inherited frontend diagnostics were corrected without weakening compiler settings; builds and browser tests remain separate checks.

## Module and interoperability boundaries

The Worker uses one D1 binding with module-owned table names and shared composite tenant foreign keys. This permits atomic cross-module database batches in this small installation. It is not a MySQL proxy, Hyperdrive experiment, historical MySQL migration replay, or claim of cross-database atomicity. Fresh SQLite migrations are versioned separately from seed data. No live-data migration converter has been built.

Supported suite routes retain their `/membership`, `/doing` and `/content` names under `/api`, array-save conventions and important nested DTOs. Authentication returns the ChurchApps-shaped user/church/API response, but uses this installation's secret and revocable sessions. New credentials use scrypt; the public synthetic seed fixtures retain their legacy PBKDF2 hashes. Existing upstream users, OAuth tokens, MFA, SSO and API keys are not automatically portable.

`GET /api/instance` describes the local roots and capability boundaries. Unported routes return an explicit error. All active Cloudflare frontend roots point to this instance, including unsupported services; there is no fallback to a ChurchApps production API. Compatibility with unmodified B1App, B1Mobile, B1Checkin or other third-party clients has **not** been certified. See [UPSTREAM.md](UPSTREAM.md), [PORTAL-UPSTREAM.md](PORTAL-UPSTREAM.md), and [MODULES.md](MODULES.md).

A separate future website can use `GET /api/public/v1/churches/{slug}/sermons` and `GET /api/public/v1/churches/{slug}/sermons/{id}` for published sermon lists and details. These return an explicit public projection and never member records. Cross-origin consumers must be added to `ALLOWED_ORIGINS` deliberately. Public calendar feeds, custom pages, and website composition are future work. Authenticated member APIs live under `/api/member/v1`.

## Remaining work before real use

- Reconcile the selected upstream route inventory against this port, including merge/import/custom fields, saved lists, large-directory pagination and complete Unicode collation parity. Supported advanced search and original household editing now work. Original source remains available, but hidden or failing routes are not implemented features.
- Complete unsupported content-kind scopes, Everyone permission semantics, administrator management, self-service registration/recovery, SSO and phishing-resistant authentication. Exact group scopes, ministry Plans, assigned-group Tasks and calendar/sermon/playlist scopes now work, as do manual setup/link invitations, authenticator MFA, backup codes and offline operator recovery. Scoped Content/StreamingServices umbrella grants remain unsupported, and scope-picker search/pagination beyond 1,000 eligible resources per kind is not implemented. Doing and resource scopes are documented fork semantics, not automatic membership/leadership editing authority.
- Audit entries currently identify actor, entity, action and time with upstream list filtering; old MySQL audit history, full before/after snapshots, IP/device enrichment and historical reconstruction are not ported.
- Finish full B1App member/mobile parity, including conversations, notification preferences, richer profile/photo fields and household reassignment. Own-profile/new-family review, existing-relative proposals and multi-church selection now work. Approval gaps include partial approval, edit/diff/merge tools, policy-change reassignment, reminders, retention procedures and the full upstream generic directory-task wire contract. Existing relatives still cannot be edited directly through member APIs. Member paging does not remove all collection/offset caps or implement large administrative-directory pagination. The PWA is a focused local client, not a wholesale copy of the Next.js application; native-store builds are outside scope and physical-phone installation remains unverified.
- Complete calendar resources/import/ICS and broader upstream calendar parity. Bounded recurrence, occurrence changes, future splits and church-local DST-safe plan copies now work. Existing blockouts/preferences are stored; they do not add a new automatic fairness policy. Parent-group plan visibility is implemented for the documented published-plan rules. Workflow cards, confirmation automation, notifications and external providers remain disabled; signup deadlines without explicit service times still use the documented UTC fallback.
- R2 resumable multipart uploads accept manifests up to 1 GiB in 8 MiB parts, with native authenticated range/HEAD delivery and recovery cleanup. Raw uploads remain bounded to 25 MiB and legacy JSON base64 to 5 MiB. Upload sessions last 24 hours, with three active sessions per user and twenty per church. Final verification records the executed upload/playback cases; a full 1 GiB throughput test and every browser/codec combination are not claimed. Direct-to-R2 transfer, transcoding, adaptive streaming and public media distribution remain work. Uncertain provider multipart creation still needs an operational incomplete-upload lifecycle policy.
- Resolve the remaining frontend dependency advisories before production: the legacy static `serve` tool retains a compression issue, and inherited tooling retains glob/minimatch issues. Compatible updates removed the other reported security advisories; [SECURITY-REVIEW-M4.md](SECURITY-REVIEW-M4.md) records the remaining paths and runtime limits. The Worker dependency audit reports zero findings.
- Complete production readiness work: production bootstrap/operational recovery, selected auth compatibility, key custody/rotation, operational permissions, monitoring, backup/restore rehearsals, data retention, rate limits under load, accessibility review, and a deployment configuration with real bindings. New password hashes also require production scrypt CPU/load validation. Local simulation is not a deployed Cloudflare integration test.

No remote database or bucket has been created. The checked-in Wrangler database ID is a local placeholder and `workers_dev`/preview URLs are disabled. Production deployment requires a separate reviewed configuration and authorization.

Focused implementation notes: [directory/households](DIRECTORY.md), [accounts](ACCOUNTS.md), [group/Doing scopes](GROUP-PERMISSIONS.md), [resource scopes](RESOURCE-PERMISSIONS.md), [calendar/sermon/media APIs](CALENDAR_SERMON_API.md), [member portal](MEMBER-PORTAL.md), [profile/family review](MEMBER-APPROVALS.md), and [upstream workflow comparison](WORKFLOW-PARITY.md).
