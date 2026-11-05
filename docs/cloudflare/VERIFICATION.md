# Verification record — 2026-11-05

All executed application checks used synthetic local data. No remote Cloudflare database, R2 bucket or production deployment was created. No live church import, payment, notification, advertising or sermon ingestion was performed.

## Executed checks

| Check | Result | Meaning and limits |
| --- | --- | --- |
| Fresh local D1 setup | PASS | All eight current migration files applied, then five synthetic seed files loaded through Wrangler `--local`. An earlier disposable development database was retained outside the repository, then replaced to verify the final baselines. |
| Worker TypeScript | PASS | `npm run typecheck --prefix cloudflare`, strict TypeScript for every Worker module. |
| Worker/D1/R2/DO tests | **62 / 62 PASS** | `npm test --prefix cloudflare`; isolated Miniflare/workerd with actual local bindings and SQL constraints. No mocked SQL adapter. |
| Frontend production build | PASS | `vite build --mode cloudflare`, 13,758 modules. Inherited large-chunk and stale Browserslist-data warnings remain. |
| Worker bundle | PASS | `wrangler deploy --dry-run`, including 428 static assets, D1, R2 and Durable Object bindings. This is a bundle check, not a remote deploy. |
| Original selected UI and mobile browser | **10 / 10 PASS** | Final compiled application and Worker at `127.0.0.1:8787`; 18.3 seconds, headless Chrome. Tests include original workflows and authenticated member/R2 playback. |
| Whitespace/integration diff | PASS | `git diff --check`; private local state and credentials are ignored. |
| Full upstream frontend TypeScript | **Not clean: 53 existing diagnostics** | The same dependency installation against pinned upstream source produced 54 diagnostics; the port produced no new diagnostic path/code combinations, and fixed one existing sermon ID assertion. Vite build passes, but that does not make the inherited full typecheck clean. |

The backend suite exercises calendar timezone/DST and date validation, tenant-qualified foreign keys, atomic bulk rollback, name-only permission projections, member directory consent, group joining, service-plan copy/tree identity, concurrent signup capacity, assignment ownership and draft visibility, associated-group time filtering, custom-role grant/revocation and delegation boundaries, private availability after unrelated role grants, manual task access, publication rules, R2 bytes and cleanup recovery, session revocation, bounded WebSocket history/tenant routing, scheduled maintenance and service-worker privacy rules.

Independent review found and fixed a real authorization regression: granting an unrelated staff permission could previously broaden a member's blockout-date read. The regression tests now assert that unrelated role grants preserve ownership restrictions. Review also tightened exact self-service method/path routing and name-only directory projections. Passing tests are evidence for these cases, not a claim of a complete security audit.

## Browser evidence

The isolated Playwright configuration refuses non-loopback targets and does not call the upstream demo-reset pretest. Tests exercise original People/Groups creation, selected original Serving/Plans components, standalone My Work, Roles/Audit and Sermons editors, plus the mobile portal. The final test target is the compiled frontend and Worker at `http://127.0.0.1:8787`.

The final combined browser suite passed all ten tests. Its exercised flows, supplemented by focused real-browser checks, include:

- Original people create → edit → search → soft-delete, and group membership changes.
- Calendar/event create → edit → timezone persistence → delete; read-only staff cannot write.
- Original service-order/three-station plan display, position create/delete and print navigation; My Work close/reopen.
- Original role creation, permission toggling, deletion and audit navigation.
- Original playlist/sermon create, R2 upload and byte-matched authenticated download, explicit publication, member access, unpublication denial and cleanup.
- At 390×844: member login, consent-respecting directory, open-group join/leave, assignment acceptance, self-signup, unavailable dates, profile save/restore, session reload and logout. A synthetic one-second WAV stored in local R2 decoded in Chrome via an authorized blob URL.

The instrumented browser journeys recorded no unexpected external requests, JavaScript errors or failed expected API requests after fixes. Direct configured media links may contact their provider on explicit playback; the tested/seeded files were local and synthetic. Physical-device installation and app-store delivery were not tested. The PWA's service worker never caches private APIs or media; its policy has three automated tests.

Screenshots captured during local verification:

- [Original Serving plan and sound stations](screenshots/serving-plan.png)
- [Mobile member sermon archive](screenshots/member-portal.png)

## Boundaries

The unit/integration and browser results cover the implemented selection, not the upstream inventory of 1,010 routes. Authentication interoperability with other installations, production scale/load, large-media multipart delivery, backup/restore, physical iOS/Android installation and the missing selected feature details in [RUNNING.md](RUNNING.md) remain unverified or unfinished. No real-data migration or external live integration was attempted.
