# Verification record — 2026-11-06, fourth milestone

All executed application checks used synthetic local data. No remote Cloudflare database, R2 bucket or production deployment was created. No live church import, payment, notification, advertising or sermon ingestion was performed.

## Executed checks

| Check | Result | Meaning and limits |
| --- | --- | --- |
| Fresh local D1 setup | PASS | All 24 versioned migration files applied, followed by five synthetic seed files through Wrangler `--local`. Browser batches use fresh temporary storage, separate from the persistent preview. The existing synthetic preview was also migrated without deleting its state or rotating local keys. |
| Worker TypeScript | PASS | `npm run typecheck --prefix cloudflare`, strict TypeScript for every Worker module. |
| Full frontend TypeScript | PASS | `yarn typecheck` checks both application and Node/tooling projects. The 53 inherited diagnostics reported at an earlier milestone are resolved without weakening compiler settings. |
| Changed frontend ESLint | PASS | 35 changed/new frontend and browser-test files; zero errors and two long-line style warnings. |
| Worker/D1/R2/DO tests | **264 / 264 PASS** | `npm test --prefix cloudflare`; isolated Miniflare/workerd with actual local bindings and SQL constraints. No mocked SQL adapter. Final run: 46.71 seconds; no skips. |
| Frontend production build | PASS | `vite build --mode cloudflare`; final build 14.59 seconds, 13,784 modules. Large-chunk, stale Browserslist-data and plugin/bundler timing warnings remain. |
| Worker bundle | PASS | `wrangler deploy --dry-run`, including 499 static assets and D1, R2 and Durable Object bindings; Worker upload 492.36 KiB (109.11 KiB gzip). This is a bundle check, not a remote deploy. |
| Original selected UI and mobile browser | **29 / 29 PASS** | All 19 spec files in seven fresh-state batches against the final patched app and Worker at `127.0.0.1:8790`, headless Chrome. Batch results: 4, 11, 4, 3, 3, 3 and 1 passing cases; 141.5 seconds of Playwright execution, excluding setup. No skips. |
| Persistent preview smoke | PASS | Applied migrations 0023–0025 without resetting existing synthetic data or keys. Health, instance version 0.4.0, admin/member sign-in and read APIs, logout, administration and portal pages verified at localhost:8787. |
| Empty-installation bootstrap | Previously verified | Local-only bootstrap script created an administrator setup link against a disposable fresh D1 installation; a second attempt correctly refused the nonempty installation. No link or private bootstrap state is committed. |
| Dependency advisory checks | Residual findings | Worker npm audit: zero findings. Frontend Yarn audit after compatible updates: three distinct security advisories (one high, two moderate), plus three deprecation notices. No critical findings remain. Exact affected paths and limits are in [SECURITY-REVIEW-M4.md](SECURITY-REVIEW-M4.md). This is not a clean frontend audit. |
| Whitespace and private-material check | PASS | `git diff --check`; changed/untracked deliverables inspected for private state paths, private keys and common credential patterns. Ignored local secrets, state and test output are excluded. This is not a comprehensive secret-scanner certification. |

The final frontend build's `dist/index.html` SHA-256 is `91136b5b9533d14f8fe0d6b270fcacb6827417fb93cf796d1e1a31af4141210c`. A final whitespace-only source correction was rebuilt; all 499 compiled files were byte-identical to the tested artifact. Compiled assets are ignored and reproducible from the source and lockfiles. CI runs full typechecks, backend tests, builds and the isolated browser suite without deployment credentials. Local results are distinct from the remote Actions result on the draft PR. Local tests ran on macOS with Node 22.22.0 and installed Chrome; the inherited `isomorphic-dompurify` dependency declares Node 22.22.2 or newer in the 22 line. Prerequisites and package engines now reflect that minimum. CI uses the current Node 22 release; successful local checks alone do not validate the older local runtime for that dependency.

## Backend evidence

The 264 tests cover the implemented contracts, including:

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

New milestone-4 cases also cover:

- Structured own-profile/new-family review, existing-relative proposals, protected My Work tasks, cancellation/decline/idempotent approval and atomic person/request/task/audit effects. Approval configuration preserves unrelated settings, validates active tenant groups, rechecks Settings Edit/session authority, and fails closed for malformed stored policy values.
- Calendar, sermon and playlist read/edit scopes, inherited child authorization, source/destination moves, minimal delegation metadata and live authorization/resource snapshots inside mutation batches.
- Permission changes during real R2 writes, lost responses after a ready commit, and both winner orders of upload finalization racing with cleanup. Persisted state drives reconciliation; D1 and R2 are not one transaction.
- Consent/publication/group filters before member paging, bounded offset/query validation, queries longer than D1's LIKE pattern limit, multibyte Unicode and literal wildcard characters.
- Per-file media grants, session context replacement, ordinary API cookie rejection, same-origin checks, live access before conditional/range/HEAD responses, revocation and grant-issuance races.

The independent security exercise passed 23/23 cases, plus a focused malformed-policy regression. [SECURITY-REVIEW-M4.md](SECURITY-REVIEW-M4.md) records findings and limitations; [WORKFLOW-PARITY.md](WORKFLOW-PARITY.md) compares the original profile/task behavior against pinned upstream sources.

Independent focused reviews found and fixed substantive issues, including stale invitation-issuer authority, scope changes between authorization and writes, session expiry during a queued write, active-person realtime revocation, last-administrator counting, and upstream client helpers ignoring permission scope. The final suite also corrected a group-request fixture that attempted to remove the now-protected last administrator. These cases have regression coverage. Passing tests are evidence for those cases, not a claim of a complete security audit.

## Browser evidence

The isolated Playwright configuration refuses non-loopback targets and does not call the upstream demo-reset pretest. `yarn test:cloudflare:browser` creates fresh temporary local D1/R2/Durable Object state for each batch of at most three spec files, runs against the compiled single-Worker app on port 8790, and stops that server. The persistent preview is untouched. Batching preserves the real login throttle instead of weakening it. Recovery tests issue links through the actual local CLI against that temporary state; no messages are sent.

The previous published milestone passed 24 browser cases locally and in Linux CI. The fourth milestone passed all 29 cases after compatible dependency updates, including scoped calendars/content, approval/family proposals, paged collections and native media access. The expanded suite uses accessible combobox selectors for church and family-role choices. Its corrected scoped Serving negative fixture distinguishes a private unscoped plan from a published plan legitimately visible to the member; both authorization outcomes are now asserted. MFA/recovery and member-profile checks also passed after correcting test labels, without behavior changes. Exercised flows include:

- Original people create/edit/search/soft-delete, household member moves and roles, and supported original advanced search filters.
- Group roster changes, manual request-to-join approval and decline, member/leader request views, exact-group role assignment and restricted group administration.
- Manual setup invitation issuance through the original role member picker, single-use acceptance, password change and old-session rejection; ordinary member sign-in opens the member portal.
- Calendar/event create/edit/delete and timezone persistence, monthly recurrence selection, occurrence changes and future-series editing; read-only staff cannot write.
- Original service-order/three-station plan display, position create/delete and print navigation; My Work close/reopen.
- Original role creation, global/scoped permission toggling, deletion, audit navigation and church timezone settings.
- Original playlist/sermon create, R2 upload and byte-matched authenticated download, explicit publication, member access, unpublication denial and cleanup.
- At 390×844: member login, consent-respecting directory, group join/leave, assignment acceptance, self-signup, unavailable dates, profile save/restore, session reload and logout. A synthetic one-second WAV stored in local R2 decoded in Chrome through the protected native media route.
- MFA enrollment with one-time backup-code acknowledgement, both admin/member challenges, local recovery token URL scrubbing, single-use reset and old credential/session rejection.
- Own contact/name/birth-date edits, household privacy and private family addition, explicit church selection/switching/reload, and reopening the currently selected church.
- Ministry-scoped Serving plan edits/assignments and group-scoped My Work close/reopen/reassignment without directory access, rejection of private plans outside the grant, and read-only controls despite ministry membership.
- Multipart pause/reload/resume, rejection of a different file, abort/restart with the same selected file, byte-matched download, and an actual 25 MiB+1 upload split into four parts. A separate native-media check decodes a synthetic 28 MiB WAV, seeks beyond 25 MiB with a real 206 response and verifies the downloaded 29,360,172 bytes by SHA-256. Native requests carry scoped HttpOnly/Secure/SameSite=Strict cookies, not bearer tokens in URLs. Account replacement rejects the old media context; logout clears grants and rejects later access. A full 1 GiB upload, other browser engines and video codecs are not claimed.

Additional fourth-milestone journeys verify:

- Church Settings approval policy; deferred own-profile writes; review through the original My Work assigned-group tab; family-add approval in the portal; existing-relative decline and cancellation without loading private baseline fields.
- Two-page group discovery/membership and published-sermon collections; bounded calendar recurrence across a DST window; privacy-safe directory search; page reset when switching A → B → A searches; and rejection of delayed results after a church switch.
- Exact calendar edits/recurrence without directory grants; no ungranted calendar choices; scoped role selectors; playlist edit/create inheritance; exact-sermon read/edit controls and native download without broad playlist or upload-session access.

The calendar test exposed a cache-clear/logout race that briefly retried queries with revoked credentials. Authenticated screens now unmount before clearing query state; the final browser run covers the corrected order. Test-only corrections included required synthetic sermon dates, updated permission option labels, native Secure-cookie inspection on loopback, and preserving in-memory administration navigation during review. No assertions were skipped to obtain the final result.

The instrumented browser journeys asserted no unexpected external requests, JavaScript errors or failed expected API requests. Direct configured media links can contact their provider on explicit playback; tested/seeded files were local and synthetic. Physical-device installation was not tested. Native store builds are outside scope. The service worker never caches private APIs or media; its policy has three automated tests.

Screenshots captured from synthetic local fixtures:

- [Original Serving plan and sound stations](screenshots/serving-plan.png)
- [Mobile member sermon archive](screenshots/member-portal.png)
- [Original household widget with family roles](screenshots/household.png)

## Boundaries

These results cover the implemented selection, not the upstream inventory of 1,010 routes. External ChurchApps authentication/client interoperability, remote Cloudflare behavior, production scale/load, scrypt CPU budgets, full-size 1 GiB transfer, physical-device/video-codec playback, key rotation/re-encryption, production recovery identity-proofing, backup/restore and physical iOS/Android installation remain unverified. Selected workflows still have narrower coverage than upstream; [RUNNING.md](RUNNING.md) lists the remaining feature and production gaps, including Everyone permissions, broad upstream member fields and legacy task-wire adapters, group-request paging controls, administrative large-directory paging and broader Serving automation. No real-data migration or external live integration was attempted.
