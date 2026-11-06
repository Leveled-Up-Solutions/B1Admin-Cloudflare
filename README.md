# B1Admin on Cloudflare

A Cloudflare adaptation of [ChurchApps B1Admin](https://github.com/ChurchApps/B1Admin) for Leveled Up Solutions. It retains the existing React/Vite application and ports selected API behavior to **Cloudflare Workers, D1 and R2**, with a Durable Object for tenant-scoped realtime coordination.

This is a local development milestone using synthetic records. It is not a complete port of the ChurchApps suite, a production deployment, or a migration of real church data. The original MIT license and upstream attribution remain intact.

## Scope

- People and original household editing, supported advanced directory search, group membership and join approvals.
- Existing Serving/Plans and My Work workflows: service plans, positions, assignments, service order, scheduling preferences, blockout dates and manual tasks.
- Calendars with bounded recurrence and occurrence editing, sermon archive, resumable R2 storage and native private range playback/downloads.
- Administrative roles, exact group/ministry/task/calendar/sermon/playlist permissions and audit records, using the existing screens. Manual account setup links, password changes, authenticator MFA and offline local recovery with session revocation.
- A member portal/PWA with paged directory, groups, calendar and sermon views; own-profile and family-change review; and explicit church selection. Native mobile applications are not required for this milestone.
- Explicit APIs for a separate future church website. This repository does **not** rebuild `pottershandsministries.org`.

The frontend's Cloudflare mode uses this installation's API. Supported request/response contracts retain ChurchApps shapes where practical. Other suite clients still need their API hosts and authentication behavior verified; matching endpoint names alone does not establish interoperability.

Giving, all check-in, outbound email/SMS/push, advertising, payment gateways, external content providers and workflow automation are excluded. Fair volunteer rotation and station-specific qualification policies are a later design task; this milestone first ports the existing Serving workflow.

Configured profile review creates protected My Work tasks with atomic approve/decline actions; it does not enable general workflow automation. Exact content scopes and existing-family proposals are documented fork behavior, not claims of full upstream parity. See [resource permissions](docs/cloudflare/RESOURCE-PERMISSIONS.md), [member review](docs/cloudflare/MEMBER-APPROVALS.md) and [upstream workflow comparison](docs/cloudflare/WORKFLOW-PARITY.md).

## Run locally

Use Node.js 22.22.2 or newer in the Node 22 line and Corepack/Yarn for the upstream frontend. The Worker package has its own npm lockfile.

```sh
corepack yarn install --immutable
corepack yarn postinstall
npm ci --prefix cloudflare
corepack yarn build:cloudflare
corepack yarn setup:cloudflare
corepack yarn dev:cloudflare
```

Open `http://localhost:8787` for administration or `/portal` for members. The setup script creates local session and MFA encryption keys, applies local D1 migrations and loads synthetic examples. The documented development account is `admin@example.test` with password `LocalDemo2026!`; these are public fixtures, never production credentials.

Read [the running and verification guide](docs/cloudflare/RUNNING.md) for the current commands, additional demo accounts and limitations. Do not point the synthetic seed process at a live database.

## Verify

```sh
corepack yarn typecheck
corepack yarn check:cloudflare
corepack yarn test:cloudflare
corepack yarn build:cloudflare
npm run build --prefix cloudflare
```

For the full compiled browser suite, install Chromium with `yarn playwright install chromium`, then run `yarn test:cloudflare:browser`. It creates fresh temporary local D1/R2/DO state and stops its own loopback server afterward.

The Worker build command builds a deployment bundle with `wrangler deploy --dry-run`; it does not deploy. Tests use local Workers/D1/R2 simulation. Executed browser checks and remaining limitations are recorded separately in the running guide; this README does not claim every upstream screen or external integration has been tested.

## Architecture and attribution

- [Module boundaries, supported Plans contracts and backlog](docs/cloudflare/MODULES.md)
- [Member portal, privacy and pagination](docs/cloudflare/MEMBER-PORTAL.md)
- [Calendar, archive and private media APIs](docs/cloudflare/CALENDAR_SERMON_API.md)
- [Pinned upstream architecture and license audit](docs/cloudflare/UPSTREAM.md)
- [Original upstream README](docs/upstream-README.md)
- [B1Admin MIT license](LICENSE), [API notice](docs/cloudflare/LICENSE-API), [Packages notice](docs/cloudflare/LICENSE-PACKAGES)

Keep credentials, real church records, private files and generated local runtime state out of the repository. Upstream deployment workflows are retained as reference documentation rather than active production deployment jobs.
