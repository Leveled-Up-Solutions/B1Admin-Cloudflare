# B1Admin on Cloudflare

A Cloudflare adaptation of [ChurchApps B1Admin](https://github.com/ChurchApps/B1Admin) for Leveled Up Solutions. It retains the existing React/Vite application and ports selected API behavior to **Cloudflare Workers, D1 and R2**, with a Durable Object for tenant-scoped realtime coordination.

This is a local development milestone using synthetic records. It is not a complete port of the ChurchApps suite, a production deployment, or a migration of real church data. The original MIT license and upstream attribution remain intact.

## Scope

- People, households, directory visibility, groups and member access.
- Existing Serving/Plans and My Work workflows: service plans, positions, assignments, service order, scheduling preferences, blockout dates and manual tasks.
- Calendars and events, sermon archive and R2 file storage.
- Administrative roles/permissions and audit records, using the existing screens.
- A browser-based member portal/PWA; native mobile applications are not required for this milestone.
- Explicit APIs for a separate future church website. This repository does **not** rebuild `pottershandsministries.org`.

The frontend's Cloudflare mode uses this installation's API. Supported request/response contracts retain ChurchApps shapes where practical. Other suite clients still need their API hosts and authentication behavior verified; matching endpoint names alone does not establish interoperability.

Giving, child check-in, outbound email/SMS/push, advertising, payment gateways, external content providers and workflow automation are excluded. Fair volunteer rotation and station-specific qualification policies are a later design task; this milestone first ports the existing Serving workflow.

## Run locally

Use Node.js 22 and Corepack/Yarn for the upstream frontend. The Worker package has its own npm lockfile.

```sh
corepack yarn install --immutable
corepack yarn postinstall
npm ci --prefix cloudflare
corepack yarn build:cloudflare
corepack yarn setup:cloudflare
corepack yarn dev:cloudflare
```

Open `http://localhost:8787`. The setup script creates a local session secret, applies local D1 migrations and loads synthetic examples. The documented development account is `admin@example.test` with password `LocalDemo2026!`; these are public fixtures, never production credentials.

Read [the running and verification guide](docs/cloudflare/RUNNING.md) for the current commands, additional demo accounts and limitations. Do not point the synthetic seed process at a live database.

## Verify

```sh
corepack yarn check:cloudflare
corepack yarn test:cloudflare
corepack yarn build:cloudflare
npm run build --prefix cloudflare
```

The last command builds a Worker deployment bundle with `wrangler deploy --dry-run`; it does not deploy. Tests use local Workers/D1/R2 simulation. Browser testing and any remaining failures are recorded separately in the running guide; this README does not claim every upstream screen or external integration has been tested.

## Architecture and attribution

- [Module boundaries, supported Plans contracts and backlog](docs/cloudflare/MODULES.md)
- [Pinned upstream architecture and license audit](docs/cloudflare/UPSTREAM.md)
- [Original upstream README](docs/upstream-README.md)
- [B1Admin MIT license](LICENSE), [API notice](docs/cloudflare/LICENSE-API), [Packages notice](docs/cloudflare/LICENSE-PACKAGES)

Keep credentials, real church records, private files and generated local runtime state out of the repository. Upstream deployment workflows are retained as reference documentation rather than active production deployment jobs.
