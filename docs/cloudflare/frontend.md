# Cloudflare frontend integration

Build with `yarn build:cloudflare` or `yarn vite build --mode cloudflare`. During development, `yarn vite --mode cloudflare` runs Vite on `127.0.0.1:3101`, proxying `/api` and WebSockets to the local Worker at `127.0.0.1:8787`. The built app and Worker API can also share the Wrangler origin.

The Cloudflare stage rewrites every ChurchApps API configuration to the installation's `/api/<module>` path, including unported Lessons, Ask and Commons services. Unavailable routes never fall back to the hosted ChurchApps deployment. It skips Sentry initialization, disables analytics, removes external Google Fonts links, and uses Stripe's side-effect-free module entry because the shared apphelper package imports donation components even on non-giving pages. Payment features are not reachable in this stage. A browser check verifies that supported navigation makes no external requests.

The admin sign-in keeps the upstream `LoginResponse` structure and `UserHelper` permission mapping. The development session remains in memory: reloading requires sign-in. Sign-out revokes the server session, clears the query cache and removes client API permissions. API 401 responses return the user to sign-in. The separate `/portal` member app has its own session and offline shell; see the member portal documentation.

## UI reuse and deliberate divergence

- Original people and groups list/create components are retained. People columns/export and household grouping remain available. Advanced/AI searches, saved lists, bulk operations and unported reports are hidden. Simple search uses the real D1 search endpoint.
- Person and group detail editors expose the implemented fields and group membership operations. The original detail pages eagerly load many unported forms, reports, messaging and check-in services, so this milestone uses smaller adapters instead of pretending those features work.
- Calendars use a scoped adapter over normalized D1 calendars/events. Calendar and event CRUD, group associations, explicit time zones, list/week views and all-day exclusive end dates are implemented. The original curated calendars, resource booking, recurrence and approval workflows are not yet ported. Timed events are converted from the displayed IANA time zone to UTC; nonexistent daylight-saving local times are rejected. Repeated fall-back hours use the timezone library's offset selection.
- Original Serving, plan types, plans, positions, service order, print preview and manual My Work task pages are mounted. The print preview stays in the same tab to preserve the development session; website-logo settings are not loaded. Templates, content-provider authentication, automatic fill, digital signage, notification delivery, confirmation workflows, task notes/reminders and workflow automation controls are hidden where those services are unavailable. Publishing a plan does not send messages. Fair automatic rotation remains backlog.
- Original sermon, playlist, roles and audit pages are retained with Cloudflare adapters. See `frontend-sermons.md` for publication and R2 archive behavior.
- The shell lists only the selected modules and displays an explicit unavailable notice for unported routes. This is an administration port, not a rebuild of pottershandsministries.org.

## Browser verification

With local synthetic D1 seeded and the Worker/Vite servers running:

```sh
# Install a Playwright browser once if needed.
yarn playwright install chromium
yarn playwright test --config cloudflare.playwright.config.ts
```

The isolated config refuses non-loopback base URLs, so these tests cannot target a hosted production deployment. `B1_TEST_BASE_URL` can select a different loopback port; `PLAYWRIGHT_CHROMIUM_EXECUTABLE` can select an existing Chrome executable. Tests remove their synthetic groups, events, roles, plans and files. Person deletion is a soft delete, and the person's newly created household remains because household deletion is not exposed; reset the disposable development database when a pristine demonstration state is needed. The config does not use the upstream pretest/login setup.

The browser checks exercise directory create/edit/search/delete, group creation and member/leader editing, explicit-time-zone calendar CRUD, viewer restrictions, original plan position editing and print preview, original My Work close/reopen, custom-role lifecycle, and module navigation including the audit log. Separate specs cover the sermon/R2 lifecycle and the member portal at a mobile viewport. They assert behavior against the local Worker and D1 rather than mocked API responses. The network-isolation check records external requests and API/JavaScript failures.

The final combined run passed **10/10 tests in 18.3 seconds** against the compiled Cloudflare app served by Wrangler at `http://127.0.0.1:8787`, after a fresh local migration and synthetic seed. `vite build --mode cloudflare` passed in 13.95 seconds; it reports a large-bundle warning and an outdated Browserslist-data warning. No production service was used.

The exact upstream source (`558c5ac74f2db7e7dab8d85e3c47dfee96446170`) and the same installed dependencies produced 54 TypeScript diagnostics in the frontend. The completed integration produces 53: comparison by source file and diagnostic code shows no additions, and one pre-existing sermon editor diagnostic was fixed. `tsc -p tsconfig.app.json --noEmit` therefore still fails on inherited diagnostics. This is a pre-existing frontend typecheck limitation, not evidence that the entire upstream UI has been validated. The production Vite build is a separate check.
