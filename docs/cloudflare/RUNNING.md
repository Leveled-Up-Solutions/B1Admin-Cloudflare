# Run and review the Cloudflare first cut

This is a runnable local development adaptation of selected ChurchApps workflows. It is **not a complete ChurchApps port or production-ready church installation**. Only synthetic fixtures are included. No production database, church records, payment account, email delivery, or live sermon source has been connected.

## Agreed scope

Port the existing selected workflows first: people and households, directory, groups and join-group flows, calendars, Serving/Plans, volunteer signup and assignment responses, My Work, sermon archives, roles/permissions, audit logs, member portal and mobile web/PWA. Workers handles requests, D1 owns relational data, and R2 owns archive files. A Durable Object handles authenticated tenant refresh events. The separate `pottershandsministries.org` website is not built here.

Giving/donations/payments, check-in, song/provider integrations, and outbound delivery are excluded. Automated fair rotation and an interface redesign are deferred. The Sound Ministry example uses existing ministry, team, plan and position records; it is not an automatic rotation engine.

## Prerequisites and first launch

Node.js 22.22 or newer in the Node 22 line, npm and Corepack. The frontend retains upstream Yarn 4.15.0; `cloudflare/` has a separate pinned npm lockfile. Current Wrangler uses a pinned Miniflare 5 beta local runtime; that dependency is explicit in the lockfile.

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

Open **http://localhost:8787** for administration and **http://localhost:8787/portal** for members. The one Worker serves the built frontend and `/api/*`. Setup generates an ignored random `cloudflare/.dev.vars` session secret, applies D1 migrations with `--local`, and loads development fixtures. It does not contact a remote Cloudflare account or deploy resources. Local D1/R2/Durable Object state persists under ignored `cloudflare/.wrangler/state/`.

| Account | Password | Purpose |
| --- | --- | --- |
| `admin@example.test` | `LocalDemo2026!` | Built-in development administrator |
| `viewer@example.test` | `LocalDemo2026!` | Staff read access; no administrative mutations |
| `member@example.test` | `LocalDemo2026!` | Member portal, privacy, groups and own serving |
| `other@example.test` | `LocalDemo2026!` | Separate synthetic church for isolation tests |

These are deliberately public development credentials. The bootstrap admin and account lifecycle are not a production onboarding solution. Admin sign-in currently stays in memory and requires sign-in after a reload; the portal uses sessionStorage for the browser tab. Logout revokes the server session. Roles are reloaded from D1 on each request, so permission revocation does not wait for token expiration.

For hot frontend development, leave the Worker running and use a second terminal:

```sh
corepack yarn dev:cloudflare:ui
```

Open **http://localhost:3101**. Vite proxies `/api` to the local Worker. Default `yarn start`, `yarn build` and `yarn test` now target this Cloudflare adaptation. The inherited demo-reset pretest and AWS deployment scripts are not active defaults; upstream workflow files are archived under `docs/cloudflare/upstream-workflows/`.

## Suggested review

1. Sign in as admin. Open People, create a synthetic person, edit their contact information, and inspect the group roster. The people/group lists and create controls reuse B1Admin; focused detail editors currently replace broader unported profile panes.
2. Open Serving. Choose Sound Ministry and Street Church Gathering, then open the upcoming plan. The original plan types, plans, positions, time editor and service-order components run against D1. Sound-board Engineer, Streaming Specialist and Media Operator illustrate the existing station model.
3. Open My Work. Create a task assigned to a person or group, close it, and reopen it. Original standalone task controls are retained. Workflow cards, reminders and conversation notes are unavailable.
4. Open Calendars. Create a calendar with an IANA timezone, then an event. Timed events use explicit offset instants; all-day events retain civil dates with an exclusive end date. The current calendar UI is a smaller adapter, not every upstream calendar feature.
5. Open Sermons. Use the original sermon/playlist editor, deliberately publish a synthetic sermon, and attach a small synthetic audio/document/image file to test R2. Default archive drafts are private; publication and future release dates are enforced by public/member APIs.
6. Open Roles and Audit Log. Create a role with supported permissions and assign an existing local account. Inspect recorded changes. Bootstrap administrators are protected. No invitations are sent and no new external accounts are created.
7. Sign into `/portal` as the member. Inspect the opt-in directory, join an open group, respond to an assignment, record unavailable dates, view calendar events and play a protected sermon attachment. Toggle your directory preferences and confirm that private contact data stays out of the directory.

## Verification commands

```sh
corepack yarn check:cloudflare
corepack yarn test:cloudflare
corepack yarn build:cloudflare
npm run build --prefix cloudflare
```

`npm run build --prefix cloudflare` runs **`wrangler deploy --dry-run`**, which bundles without deploying. Backend tests instantiate isolated local workerd/Miniflare runtimes with actual D1, R2 and Durable Object bindings, not an in-memory JavaScript imitation of SQL. They do not access the persistent demo database.

With the local Worker and Vite server running, use:

```sh
corepack yarn playwright install chromium
corepack yarn test:cloudflare:ui
```

Alternatively set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to an installed Chromium/Chrome binary. The isolated browser configuration refuses non-loopback URLs and does not run the inherited upstream demo-reset setup. `B1_TEST_BASE_URL=http://127.0.0.1:8787` tests the built single-Worker application instead of Vite. Browser tests create synthetic records; people deletion is soft deletion and may leave synthetic household fixtures. Re-run setup only against local development state, not real records.

See [VERIFICATION.md](VERIFICATION.md) for the final executed checks, evidence and remaining failures. The full upstream frontend TypeScript project has pre-existing diagnostics; the Worker typecheck and production Vite build are separate checks.

## Module and interoperability boundaries

The Worker uses one D1 binding with module-owned table names and shared composite tenant foreign keys. This permits atomic cross-module database batches in this small installation. It is not a MySQL proxy, Hyperdrive experiment, historical MySQL migration replay, or claim of cross-database atomicity. Fresh SQLite migrations are versioned separately from seed data. No live-data migration converter has been built.

Supported suite routes retain their `/membership`, `/doing` and `/content` names under `/api`, array-save conventions and important nested DTOs. Authentication returns the ChurchApps-shaped user/church/API response, but uses this installation's secret, revocable sessions, and synthetic PBKDF2 credentials. Existing upstream users, OAuth tokens, MFA, SSO and API keys are not automatically portable.

`GET /api/instance` describes the local roots and capability boundaries. Unported routes return an explicit error. All active Cloudflare frontend roots point to this instance, including unsupported services; there is no fallback to a ChurchApps production API. Compatibility with unmodified B1App, B1Mobile, B1Checkin or other third-party clients has **not** been certified. See [UPSTREAM.md](UPSTREAM.md), [PORTAL-UPSTREAM.md](PORTAL-UPSTREAM.md), and [MODULES.md](MODULES.md).

A separate future website can use `GET /api/public/v1/churches/{slug}` and published sermon list/detail endpoints under `/sermons`. These return an explicit public projection and never member records. Cross-origin consumers must be added to `ALLOWED_ORIGINS` deliberately. Public calendar feeds, custom pages, and website composition are future work. Authenticated member APIs live under `/api/member/v1`.

## Remaining work before real use

- Reconcile the selected upstream route inventory against this port, including advanced directory search, merge/import/custom fields and fuller household editing. Original source remains available, but hidden or failing routes are not implemented features.
- Complete request-to-join approval workflows (open joins work), group hierarchy propagation, more granular resource-scoped/Everyone permissions, server/bootstrap admin management, and supported user registration/invitation/password-recovery/MFA/SSO flows.
- Audit entries currently identify actor, entity, action and time with upstream list filtering; old MySQL audit history, full before/after snapshots, IP/device enrichment and historical reconstruction are not ported.
- Finish full B1App member/mobile parity. The delivered PWA is a focused local member client, not a wholesale copy of the Next.js application. It supports home-screen installation where the browser permits it; iOS uses the browser Share/Add to Home Screen flow. Native App Store/Play Store builds are outside scope. Actual phone installation has not been verified.
- Complete calendar recurrence/resources/import/ICS behavior and timezone parity for copied service plans. Existing blockouts/preferences are stored; they do not add a new automatic fairness policy. Parent-group plan visibility inheritance, workflow cards, confirmation automation, notifications and external providers remain disabled.
- R2 raw uploads are bounded to 25 MiB and legacy JSON base64 uploads to 5 MiB. Large sermon video needs multipart/direct-upload work, range delivery and an explicit publication/distribution policy. No streaming/transcoding pipeline is claimed.
- Complete production readiness work: account bootstrap, selected auth compatibility, operational permissions, monitoring, backup/restore rehearsals, data retention, rate limits under load, accessibility review, and a deployment configuration with real bindings. Local simulation is not a deployed Cloudflare integration test.

No remote database or bucket has been created. The checked-in Wrangler database ID is a local placeholder and `workers_dev`/preview URLs are disabled. Production deployment requires a separate reviewed configuration and authorization.
