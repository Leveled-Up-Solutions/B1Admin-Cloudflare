# Verification record — 2026-11-05, third milestone

All executed application checks used synthetic local data. No remote Cloudflare database, R2 bucket or production deployment was created. No live church import, payment, notification, advertising or sermon ingestion was performed.

## Executed checks

| Check | Result | Meaning and limits |
| --- | --- | --- |
| Fresh local D1 setup | PASS | All 21 versioned migration files applied, followed by five synthetic seed files through Wrangler `--local`. Browser batches use fresh temporary storage, separate from the persistent preview. The existing synthetic preview was also migrated without deleting its state or rotating local keys. |
| Worker TypeScript | PASS | `npm run typecheck --prefix cloudflare`, strict TypeScript for every Worker module. |
| Full frontend TypeScript | PASS | `yarn typecheck` checks both application and Node/tooling projects. The 53 inherited diagnostics reported at the previous milestone are resolved without weakening compiler settings. |
| Changed frontend ESLint | PASS | 37 changed/new frontend files; zero errors and 11 style warnings (long lines and inherited print-view color literals). Seven formatting errors in the new account UI were corrected before the final check. |
| Worker/D1/R2/DO tests | **204 / 204 PASS** | `npm test --prefix cloudflare`; isolated Miniflare/workerd with actual local bindings and SQL constraints. No mocked SQL adapter. Final run: 26.57 seconds; no skips. |
| Frontend production build | PASS | `vite build --mode cloudflare`, 13,772 modules, final rebuild 14.47 seconds. Inherited large-chunk and stale Browserslist-data warnings remain. |
| Worker bundle | PASS | `wrangler deploy --dry-run`, including 411 static assets and D1, R2 and Durable Object bindings; Worker upload 435.48 KiB (96.27 KiB gzip). This is a bundle check, not a remote deploy. |
| Original selected UI and mobile browser | **24 / 24 PASS** | All 14 spec files in five fresh-state batches against the compiled app and Worker at `127.0.0.1:8790`, headless Chrome. Batch results: 4, 11, 4, 3 and 2 passing cases; 87.3 seconds of Playwright execution, excluding local setup. No skipped cases. |
| Empty-installation bootstrap | PASS | Local-only bootstrap script created an administrator setup link against a disposable fresh D1 installation; a second attempt correctly refused the nonempty installation. No link or private bootstrap state is committed. |
| Whitespace and private-material check | PASS | `git diff --check`; changed/untracked deliverables inspected for private state paths, private keys and common credential patterns. Ignored local secrets, state and test output are excluded. This is not a comprehensive secret-scanner certification. |

The tested frontend build's `dist/index.html` SHA-256 is `f8447a5d75fdf5765f4d0fa6fd7dfc890b038885fa519480e828c63fdee10649`. The final rebuild at 2026-11-05 07:16:59 UTC, after formatting-only lint corrections, produced byte-identical compiled files to the browser-tested build; every regular asset's SHA-256 was compared. Compiled assets are ignored and reproducible from the checked-in source and lockfiles. The CI workflow runs full typechecks, backend tests, builds and the isolated browser suite without deployment credentials. Local results above are distinct from the current remote Actions result on the draft PR.

## Backend evidence

The 204 tests cover the implemented contracts, including:

- Tenant-qualified foreign keys, atomic bulk rollback, ordered ID reads, household replacement/moves/removal, and directory search date, age, literal wildcard and church-local day boundaries.
- Name-only permission projections, directory consent, exact-group grants, metadata/roster redaction, protected hierarchy changes, group request approval/decline races and archived groups.
- Password derivation against an independent implementation, one-time invitation consumption, existing-account password proof, issuer revocation races, password-change session revocation, and manual setup/link boundaries.
- Group mutation guards that recheck permissions, resource snapshots and live session expiry inside the D1 batch; races roll back earlier writes and their audit records.
- Civil-time recurrence, DST boundaries, occurrence exceptions, future splits and bounded expansion; calendar privacy is applied before expansion.
- Plan copy identity and church-local wall-clock behavior, concurrent signup capacity, assignment ownership, draft visibility, ancestor association rules, transactional service-order sorting and My Work relationships.
- Explicit sermon publication, R2 bytes and recovery cleanup, session revocation, restricted administrative WebSocket history/delivery, scheduled maintenance and service-worker privacy rules.
- TOTP RFC vectors, authenticated secret encryption, account/factor binding, atomic code/challenge consumption, backup-code replay and rotation, shared throttles, and MFA-preserving or explicitly authorized offline local recovery. Existing-account invitation linking cannot bypass an enrolled factor.
- Exact ministry Plans and assigned-group Tasks grants; narrow selector projections without directory access; source/destination moves and copy races; role delegation races; active-person/session rechecks; last-administrator invariants including two accounts linked to one person; removed-person realtime revocation.
- Own-profile and household projection/validation, private family additions without accounts, both upstream approval-setting representations, multi-church separation, and natural session expiry while profile writes or household reads wait for D1 execution.
- Authenticated HEAD/byte ranges, multipart manifests and actual R2 parts, retry idempotency, pinned part hashes, upload ownership/limits, completion/abort races, expired upload cleanup, preserved pre-migration files, and resumption after a real local-runtime restart.

Independent focused reviews found and fixed substantive issues, including stale invitation-issuer authority, scope changes between authorization and writes, session expiry during a queued write, active-person realtime revocation, last-administrator counting, and upstream client helpers ignoring permission scope. The final suite also corrected a group-request fixture that attempted to remove the now-protected last administrator. These cases have regression coverage. Passing tests are evidence for those cases, not a claim of a complete security audit.

## Browser evidence

The isolated Playwright configuration refuses non-loopback targets and does not call the upstream demo-reset pretest. `yarn test:cloudflare:browser` creates fresh temporary local D1/R2/Durable Object state for each batch of at most three spec files, runs against the compiled single-Worker app on port 8790, and stops that server. The persistent preview is untouched. Batching preserves the real login throttle instead of weakening it. Recovery tests issue links through the actual local CLI against that temporary state; no messages are sent.

The prior milestone passed 18 cases locally and in Linux CI; this milestone passed all 24 cases locally. The expanded suite uses accessible combobox selectors for church and family-role choices. Its corrected scoped Serving negative fixture distinguishes a private unscoped plan from a published plan legitimately visible to the member; both authorization outcomes are now asserted. MFA/recovery and member-profile checks also passed after correcting test labels, without behavior changes. Exercised flows include:

- Original people create/edit/search/soft-delete, household member moves and roles, and supported original advanced search filters.
- Group roster changes, manual request-to-join approval and decline, member/leader request views, exact-group role assignment and restricted group administration.
- Manual setup invitation issuance through the original role member picker, single-use acceptance, password change and old-session rejection; ordinary member sign-in opens the member portal.
- Calendar/event create/edit/delete and timezone persistence, monthly recurrence selection, occurrence changes and future-series editing; read-only staff cannot write.
- Original service-order/three-station plan display, position create/delete and print navigation; My Work close/reopen.
- Original role creation, global/scoped permission toggling, deletion, audit navigation and church timezone settings.
- Original playlist/sermon create, R2 upload and byte-matched authenticated download, explicit publication, member access, unpublication denial and cleanup.
- At 390×844: member login, consent-respecting directory, group join/leave, assignment acceptance, self-signup, unavailable dates, profile save/restore, session reload and logout. A synthetic one-second WAV stored in local R2 decoded in Chrome through an authorized blob URL.
- MFA enrollment with one-time backup-code acknowledgement, both admin/member challenges, local recovery token URL scrubbing, single-use reset and old credential/session rejection.
- Own contact/name/birth-date edits, household privacy and private family addition, explicit church selection/switching/reload, and reopening the currently selected church.
- Ministry-scoped Serving plan edits/assignments and group-scoped My Work close/reopen/reassignment without directory access, rejection of private plans outside the grant, and read-only controls despite ministry membership.
- Multipart pause/reload/resume, rejection of a different file, abort/restart with the same selected file, byte-matched download, and an actual 25 MiB+1 upload split into four parts. Browser playback/download deliberately stops above 25 MiB; a full 1 GiB upload and large native playback are not claimed.

The instrumented browser journeys asserted no unexpected external requests, JavaScript errors or failed expected API requests. Direct configured media links can contact their provider on explicit playback; tested/seeded files were local and synthetic. Physical-device installation was not tested. Native store builds are outside scope. The service worker never caches private APIs or media; its policy has three automated tests.

Screenshots captured from synthetic local fixtures:

- [Original Serving plan and sound stations](screenshots/serving-plan.png)
- [Mobile member sermon archive](screenshots/member-portal.png)
- [Original household widget with family roles](screenshots/household.png)

## Boundaries

These results cover the implemented selection, not the upstream inventory of 1,010 routes. External ChurchApps authentication/client interoperability, remote Cloudflare behavior, production scale/load, scrypt CPU budgets, full-size 1 GiB transfer, large native browser playback, key rotation/re-encryption, production recovery identity-proofing, backup/restore and physical iOS/Android installation remain unverified. Selected workflows still have narrower coverage than upstream; [RUNNING.md](RUNNING.md) lists the remaining feature and production gaps, including content/calendar scopes, Everyone permissions, member approval tasks, existing-family-member editing, list pagination and broader Serving automation. No real-data migration or external live integration was attempted.
