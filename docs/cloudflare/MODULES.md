# Module boundaries and port backlog

## Current product boundary

The initial Cloudflare adaptation targets **people/directory, groups, existing Serving/Plans and My Work, calendars, sermon archive, and a browser-based member portal/PWA**. The existing B1Admin repository contains many more modules; the presence of that upstream source does not mean those modules are available in this port. The separate future Potter's Hands Ministries website is a consumer of the supported APIs, not part of this implementation.

Attendance, child/self check-in, donations/manual gift entry, payment gateways, messaging delivery and automation workflows are outside the initial product scope. There are no active Cloudflare attendance or giving handlers, migrations or seed files. Native mobile applications and a new volunteer-rotation design are also outside this milestone.

## Responsibilities

| Module | Owns | Depends on | API boundary |
| --- | --- | --- | --- |
| Identity and tenant access | Users, sessions, church selection, authorization | D1 and secret configuration | Authenticate every private request; derive the church from trusted identity, never a body field |
| Membership | People, households, groups and group membership | Identity and tenant access | Retain supported ChurchApps membership request/response shapes |
| Serving/Plans | Plan types, plans, positions, times, service-order items, assignments, blockouts and scheduling preferences | Membership IDs and tenant access | Preserve selected existing `/doing` contracts; keep providers, autofill and confirmation workflows explicit as unsupported |
| My Work | Manual tasks, assignment and completion | Membership people/groups and tenant access | Preserve selected upstream task contracts without activating workflow execution or notification delivery |
| Calendars | Calendars, events and their visibility | Membership IDs and tenant access | Keep public, member and administrative projections separate |
| Member portal/PWA | Sign-in, own profile, privacy-respecting directory, groups and visible church content | Scoped member APIs and the shared backend | A browser/PWA client is sufficient; do not cache private API responses for offline use by default |
| Sermon archive | Sermon metadata, publication and playlists as implemented | Tenant access, D1 and optional R2 file metadata | Public readers receive published visible sermons; draft and private records require authorized access |
| Content and files | File metadata, object storage and published content | R2, D1 and tenant access | Keep private files authorization-bound; public website APIs return explicit published projections |
| Realtime coordination | Per-tenant event fan-out where used | Authenticated tenant routing | Use Durable Objects only for coordination that needs a single authority |
| Future attendance | Sessions, visits and headcounts | Membership people/groups and a canonical campus catalog | Requires a separate implementation and tests before exposing attendance routes |
| Future giving | Manual records, allocations, batches and, only if separately authorized, gateways | Membership donor identity and explicit permissions | Requires a separate implementation and financial integrity verification |
| Future workflows | Persisted steps, assignment coordination and retries | Membership, schedules and explicitly enabled delivery adapters | Do not model a distributed workflow as a long-running SQL transaction |

The supported-contract notes, `/api/instance` capability descriptor and integration tests describe what runs. `upstream-routes.json` is the upstream baseline inventory, not a list of implemented Cloudflare routes. A module should be advertised in navigation or capability discovery only after its required routes, authorization and persistence are implemented. Unsupported routes must fail explicitly rather than silently proxying to ChurchApps production or returning invented empty data.

## Selected existing Plans contracts

The Cloudflare `doing.ts` module keeps the upstream route names and array-save shapes for:

- `/doing/planTypes`: read/save/delete plan types and list by ministry.
- `/doing/plans`: read/save/delete, list by type/IDs, and `/copy/:id` with `copyMode` (`none`, `positions`, `all`) and optional `copyServiceOrder`. Copy remaps positions, times, items and exclusions in one D1 batch and resets copied assignments to `Unconfirmed`.
- `/doing/positions` and `/doing/times`: plan-scoped records, ID lists and CRUD.
- `/doing/planItems`: nested service-order trees, array saves, sorting and cascading deletion. Sorting normalizes both affected sibling lists in the same D1 batch as the move and its audit record. `/doing/planItemTimes` stores per-time exclusions and position overrides.
- `/doing/assignments`: staff-managed assignments, `/my`, `/my/upcoming`, own `/accept/:id` and `/decline/:id`, and self-signup when the existing position enables it.
- `/doing/blockoutDates` and `/doing/schedulingPreferences`: own records, with broader access only through actual Plans View/Edit grants. An unrelated custom role does not broaden this private information.

Prepared plans stay hidden from ordinary members. Members can read published plans related to their own assignments or group membership through a plan-type association. Associations on an ancestor group also apply to descendant members; this is an intentional extension of the inspected upstream API's direct association query. Inheritance only shares published plans downward: it does not grant membership in the parent, access to sibling groups, task access, or a church-wide staff assignment list. Past/future filters include the current church-local day, matching the upstream inclusive date filters. Removing membership or an association takes effect on the next request. `/membership/groups/:id/plans` requires membership in the requested group or a relevant staff grant and applies the same ancestor and date rules.

Self-signup follows the upstream `allowSelfSignup`, capacity and deadline behavior; it does not introduce a new qualification policy. Signup capacity is checked inside D1 to prevent concurrent requests overfilling a position. The `plans/public/signup/:churchId` compatibility-shaped route currently requires this installation's authenticated church context despite the upstream route's `public` segment.

The Plans, My Work and associated-group suites have 31 passing tests in the local Miniflare/workerd runtime at this milestone. Those checks cover tenant isolation, permission changes, prepared-plan visibility, own assignment responses, concurrent signup capacity, hierarchical and daylight-saving plan copy, transactional sort/rollback, inherited association date filters, task relationships and bounded ID queries. They do not establish external ChurchApps client or production-deployment compatibility.

Date-only service dates and blockouts are stored as ISO calendar days; service times are UTC instants and writes require an explicit `Z` or numeric offset. Plan copies shift church-local calendar days while preserving wall-clock time, milliseconds, and any offset from the plan's service day (including overnight times). The church's IANA `timeZone` defaults to `UTC`; a copy request may explicitly supply `timeZone` without changing the church setting. A repeated daylight-saving hour prefers the source UTC offset when available, otherwise the earlier instant. A nonexistent local time rejects the entire copy with 409 so a skipped hour cannot silently move the schedule. This is finite plan copying, not a recurring volunteer scheduler. When a signup deadline has no explicit service time, this port still uses the service date at UTC midnight; church-local fallback timezone parity remains work.

The original UI can retain notifications, providers, templates and automation controls in upstream mode. Cloudflare mode must disable unsupported controls and must not fall back to hosted services. `/plans/autofill`, automatic replacement on decline, provider content, templates, confirmation-workflow issuance, email links and outbound notices are not part of the implemented Plans module. Scheduling preferences and blockouts are stored and shown to staff; this milestone does not automatically enforce a new fair-rotation policy.

## Selected existing My Work contracts

Standalone manual tasks retain the original array-save, own open/closed lists, group-task query, and detail shapes. Staff with Tasks Edit can create, reassign, associate, close/reopen, and set or clear a due date. Creation identity, task number, creation time and close time are server-owned. Saves reject duplicate IDs and invalid date values before executing the transactional write/audit batch. Group ID queries accept at most 100 IDs through one JSON SQL parameter instead of exceeding D1's parameter limit.

Task readers follow the upstream relationship rules: the creator, assigned person, associated person, direct members of the assigned group, or staff with Tasks View/Edit. Group ancestry does not grant task access. `/doing/tasks/timeline` returns open person-related tasks and explicitly requested IDs only when the caller may read them, with the original `postType`/`postId` fields. Merely receiving an unrelated custom permission does not broaden task visibility. Ordinary members can read their related tasks but still need Tasks Edit to mutate manual tasks. Notes/conversations, reminder delivery, account-deletion/directory-update task processing and workflow cards remain outside this module.

## Later volunteer scheduling design

A volunteer-run street church may need distinct qualified pools for stations such as sound-board engineer, streaming specialist and media operator. Existing ministry/team/position records provide a starting point, and the synthetic fixtures illustrate those station names. They do not establish a qualification engine or fair automatic rotation. Preserve the current Serving/Plans behavior first; design and validate rotation, recurring slots, availability conflicts, swaps and administrative override rules separately before enabling them.

## D1 implementation conventions

- Use prepared parameters for data and fixed application-owned identifiers for tables and columns.
- Include `churchId` in every private read/write predicate and in relational foreign keys. An ID belonging to another church must not satisfy a reference.
- Use D1 `batch()` for an operation whose database writes must commit or roll back together, including its audit entry. Do not perform network side effects inside a pretend transaction.
- Define date-only versus instant fields explicitly. SQLite date functions and JavaScript UTC defaults are not automatic replacements for MySQL church-local date behavior.
- Validate boolean, numeric and JSON codecs. SQLite column affinity alone does not enforce integer values; constrained integer fields need an appropriate check or strict-table design.
- Check uniqueness, affected-row semantics and error mappings against D1. Do not retain MySQL error-code branches as the only correctness mechanism.
- Keep schema migrations separate from synthetic development seed data. There is no authorized live-data migration in this task.

## Future attendance checklist

These are design findings from the upstream inspection, not delivered attendance features.

1. Decide whether membership's campus catalog is the canonical source. Upstream marks attendance campuses deprecated; duplicating independent campus catalogs would create reconciliation problems.
2. Preserve supported `services`, `servicetimes`, `sessions`, `visits` and `visitsessions` contracts, including nested visit/session response objects expected by suite clients.
3. Enforce per-tenant unique session slots and visit/session associations. Concurrent retries of staff attendance logging must not duplicate people or attendance totals.
4. Keep a linked visit consistent with its session date, group and service. Updates must not silently move recorded attendance to an unrelated session or person.
5. Treat checkout as a separate authorized state transition with server-owned identity and timestamps.
6. Child/self check-in needs explicit parity work for household authorization, guardians, capacity, volunteer ratios, warning acknowledgements, church-local check-in windows and security codes. A staff attendance form is not sufficient evidence to enable the child check-in application.
7. Verify headcount reporting and recorded-person attendance are distinct measures.
8. Test two churches, duplicate/concurrent requests, unauthorized mutation, full-batch rollback and date/time-zone boundaries in the Workers/D1 runtime before enabling the module.

## Future giving checklist

These are design findings from the upstream inspection, not delivered giving features. The current scope does not include even manual gift entry.

1. Store money in integer minor units with explicit currency handling. Reject non-finite values, fractional minor units, negative amounts where unsupported and overflow. Do not sum JavaScript floating-point input directly as the accounting source of truth.
2. Preserve tenant-scoped donor, batch, fund and allocation relationships. Sum allocations per donation and reject over-allocation atomically, including concurrent requests.
3. Make closed-batch enforcement a database-safe invariant, not only a preflight read in a Worker. Closing should verify any required allocation completeness.
4. Preserve server-owned entry attribution on edits. Define authorized correction, deletion, reversal and refund semantics separately.
5. Upstream clients sometimes save a donation and its fund allocations through separate HTTP requests. Either provide an atomic composite API and adapt the client, or explicitly design incomplete-record recovery and reconciliation. A compensating delete is not equivalent to an atomic commit.
6. Fund-filtered summaries must total the selected fund's allocation amounts, not the entire donations containing that fund. Separate original-currency totals from any conversions.
7. The upstream gateway event repository relies on a unique church/provider-event key and MySQL `ER_DUP_ENTRY` handling. A future D1 adapter must retain idempotency through the unique constraint and a tested D1 error strategy; never process an event twice because its duplicate error has a different name.
8. Payment credentials, gateway transmission, refund/retry/replay routes and external webhooks require their own approved implementation scope. They must not be activated as a side effect of enabling manual recordkeeping.
9. Test split allocations, batch closing races, cross-tenant references, duplicate provider events, rollback and report reconciliation before considering the module usable.

## Future workflow coordination checklist

Upstream `TaskRepo.withAssignmentLock` uses MySQL `GET_LOCK` / `RELEASE_LOCK` across workflow steps and network I/O. A direct SQL syntax substitution cannot preserve its semantics on D1. Use a coordinator such as a Durable Object together with persisted workflow state, stable operation IDs, idempotent effect adapters and recovery after partial failure. Decide ownership and retry boundaries before implementing the coordinator. Existing Durable Object realtime infrastructure is not evidence that workflow execution has been ported.

## Suite interoperability checklist

Wire contracts and host routing are separate concerns. Configure supported clients to use this installation's API base and socket URL; inspect hardcoded API, transfer/SSO, content and stock-media URLs. Do not transmit this installation's tokens to upstream hosts. Keep unsupported integrations visibly unavailable. Future website APIs should expose a narrow published/read projection and use a versioned contract without depending on the full admin application's permissions or internal database schema.

Administrative realtime boundary: the church-wide refresh feed exposes only bounded resource/ID metadata and is restricted to bootstrap administrators or explicit global Settings Edit. Publishing remains bootstrap-admin-only. The Durable Object revalidates the current grant and session before history, connection, delivery, messages and alarms; group-scoped grants never subscribe to whole-church metadata.

The realtime feed is a backend administrative API at `/api/messaging/realtime`, tested with an authenticated WebSocket client. It is not connected to automatic browser UI synchronization. The inherited frontend socket setting still names an unsupported local `/api/messaging/socket` compatibility endpoint; browser token handoff and the broader ChurchApps socket protocol remain unported. No production socket fallback is used.
