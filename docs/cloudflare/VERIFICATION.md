# Verification record — 2026-11-05, second milestone

All executed application checks used synthetic local data. No remote Cloudflare database, R2 bucket or production deployment was created. No live church import, payment, notification, advertising or sermon ingestion was performed.

## Executed checks

| Check | Result | Meaning and limits |
| --- | --- | --- |
| Fresh local D1 setup | PASS | All 16 versioned migration files applied, followed by five synthetic seed files through Wrangler `--local`. The complete browser run used new temporary storage, separate from the persistent preview. |
| Worker TypeScript | PASS | `npm run typecheck --prefix cloudflare`, strict TypeScript for every Worker module. |
| Full frontend TypeScript | PASS | `yarn typecheck` checks both application and Node/tooling projects. The 53 inherited diagnostics reported at the previous milestone are resolved without weakening compiler settings. |
| Worker/D1/R2/DO tests | **137 / 137 PASS** | `npm test --prefix cloudflare`; isolated Miniflare/workerd with actual local bindings and SQL constraints. No mocked SQL adapter. Final run: 11.6 seconds. |
| Frontend production build | PASS | `vite build --mode cloudflare`, 13,766 modules, 20.88 seconds. Inherited large-chunk and stale Browserslist-data warnings remain. |
| Worker bundle | PASS | `wrangler deploy --dry-run`, including 412 static assets and D1, R2 and Durable Object bindings; Worker upload 360.95 KiB (79.56 KiB gzip). This is a bundle check, not a remote deploy. |
| Original selected UI and mobile browser | **18 / 18 PASS** | Complete compiled application and Worker at `127.0.0.1:8790`, fresh temporary state, headless Chrome, 46.1 seconds. Includes account setup, scoped administration, households, recurring calendars, original workflows and authenticated member/R2 playback. |
| Empty-installation bootstrap | PASS | Local-only bootstrap script created an administrator setup link against a disposable fresh D1 installation; a second attempt correctly refused the nonempty installation. No link or private bootstrap state is committed. |
| Whitespace and private-material check | PASS | `git diff --check`; changed/untracked deliverables inspected for private state paths, private keys and common credential patterns. Ignored local secrets, state and test output are excluded. This is not a comprehensive secret-scanner certification. |

The tested frontend build's `dist/index.html` SHA-256 is `57399d50456e7a21fdc1821b3c6b9919944bd0d3a167e177add25de2dfea9a4b` (built at 2026-11-05 05:56:29 UTC). Compiled assets are ignored and reproducible from the checked-in source and lockfiles. The CI workflow runs full typechecks, backend tests, builds and the isolated browser suite without deployment credentials. Local results above are distinct from the current remote Actions result on the draft PR.

## Backend evidence

The 137 tests cover the implemented contracts, including:

- Tenant-qualified foreign keys, atomic bulk rollback, ordered ID reads, household replacement/moves/removal, and directory search date, age, literal wildcard and church-local day boundaries.
- Name-only permission projections, directory consent, exact-group grants, metadata/roster redaction, protected hierarchy changes, group request approval/decline races and archived groups.
- Password derivation against an independent implementation, one-time invitation consumption, existing-account password proof, issuer revocation races, password-change session revocation, and manual setup/link boundaries.
- Group mutation guards that recheck permissions, resource snapshots and live session expiry inside the D1 batch; races roll back earlier writes and their audit records.
- Civil-time recurrence, DST boundaries, occurrence exceptions, future splits and bounded expansion; calendar privacy is applied before expansion.
- Plan copy identity and church-local wall-clock behavior, concurrent signup capacity, assignment ownership, draft visibility, ancestor association rules, transactional service-order sorting and My Work relationships.
- Explicit sermon publication, R2 bytes and recovery cleanup, session revocation, restricted administrative WebSocket history/delivery, scheduled maintenance and service-worker privacy rules.

Independent focused reviews found and fixed substantive issues, including stale invitation-issuer authority, scope changes between authorization and writes, session expiry during a queued write, church-wide realtime metadata visibility, and the upstream client helper ignoring permission scope. These cases have regression coverage. Passing tests are evidence for those cases, not a claim of a complete security audit.

## Browser evidence

The isolated Playwright configuration refuses non-loopback targets and does not call the upstream demo-reset pretest. `yarn test:cloudflare:browser` creates fresh temporary local D1/R2/Durable Object state, runs all tests against the compiled single-Worker app on port 8790, and stops that server. The persistent preview is untouched. Repeated tests against shared preview state can correctly reach the login throttle; the isolated runner avoids weakening that control.

The final combined suite passed all 18 tests. Exercised flows include:

- Original people create/edit/search/soft-delete, household member moves and roles, and supported original advanced search filters.
- Group roster changes, manual request-to-join approval and decline, member/leader request views, exact-group role assignment and restricted group administration.
- Manual setup invitation issuance through the original role member picker, single-use acceptance, password change and old-session rejection; ordinary member sign-in opens the member portal.
- Calendar/event create/edit/delete and timezone persistence, monthly recurrence selection, occurrence changes and future-series editing; read-only staff cannot write.
- Original service-order/three-station plan display, position create/delete and print navigation; My Work close/reopen.
- Original role creation, global/scoped permission toggling, deletion, audit navigation and church timezone settings.
- Original playlist/sermon create, R2 upload and byte-matched authenticated download, explicit publication, member access, unpublication denial and cleanup.
- At 390×844: member login, consent-respecting directory, group join/leave, assignment acceptance, self-signup, unavailable dates, profile save/restore, session reload and logout. A synthetic one-second WAV stored in local R2 decoded in Chrome through an authorized blob URL.

The instrumented browser journeys asserted no unexpected external requests, JavaScript errors or failed expected API requests. Direct configured media links can contact their provider on explicit playback; tested/seeded files were local and synthetic. Physical-device installation was not tested. Native store builds are outside scope. The service worker never caches private APIs or media; its policy has three automated tests.

Screenshots captured from synthetic local fixtures:

- [Original Serving plan and sound stations](screenshots/serving-plan.png)
- [Mobile member sermon archive](screenshots/member-portal.png)
- [Original household widget with family roles](screenshots/household.png)

## Boundaries

These results cover the implemented selection, not the upstream inventory of 1,010 routes. External ChurchApps authentication/client interoperability, remote Cloudflare behavior, production scale/load, scrypt CPU budgets, large-media multipart/range delivery, backup/restore and physical iOS/Android installation remain unverified. Several selected workflows still have narrower coverage than upstream; [RUNNING.md](RUNNING.md) lists the remaining feature and production gaps. No real-data migration or external live integration was attempted.
