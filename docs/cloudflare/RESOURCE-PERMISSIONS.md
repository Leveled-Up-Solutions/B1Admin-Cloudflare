# Calendar and archive permissions

These are explicit Cloudflare fork permissions, using the ChurchApps `apiName`, `contentType`, `contentId`, and `action` wire fields. They do not claim identical upstream authorization semantics.

## Scope contract

| ContentApi permission | `contentId` | Effective resources |
| --- | --- | --- |
| Calendars View / Edit | Exact calendar id | That calendar, its events, recurring occurrences and exclusions |
| Sermons View / Edit | Exact sermon id | That sermon and its archive files |
| Playlists View / Edit | Exact playlist id | That playlist, its current sermons and their archive files |

An empty `contentId` grants the named permission across the church. Edit includes reading the same resources. Existing global Content View/Edit and StreamingServices Edit retain their existing access. Global Calendars Admin permits calendar reads and edits; it does not grant sermon access. Scoped Calendars Admin is rejected, and scoped Content/StreamingServices grants remain unsupported.

Calendar and playlist creation require the corresponding global Edit permission or an applicable global compatibility grant. A playlist editor may create sermons inside that playlist. Creating an unassigned sermon requires global Sermons Edit, Content Edit or StreamingServices Edit. Global Playlists Edit alone covers sermons attached to existing playlists, not unassigned sermons.

Moving an event or splitting its future series into another calendar requires both source and destination calendar access. Moving a sermon requires its current source access plus destination Playlists Edit. Moving it out of a playlist requires global sermon editing authority. An exact sermon grant does not authorize moving the sermon into an otherwise inaccessible playlist. Existing exact sermon grants continue to identify that sermon after an authorized move.

Published content visibility remains separate from staff editing rights. A permitted editor can publish/unpublish its sermon. Public/member readers still require public visibility, a publication timestamp, and a publish date that has arrived. Edits to a published sermon are immediately visible; unpublish it before making draft changes.

## Upstream comparison

The pinned upstream API's EventController permits global Content Edit or Calendars Admin, then falls back to direct group leadership for other event edits. Its CuratedCalendarController uses Content Edit. SermonController and PlaylistController use StreamingServices Edit. The reviewed controllers do not implement the exact calendar, sermon and playlist `contentId` rules above. Upstream's permission helper declares Calendars Admin, rather than Calendars View/Edit.

This fork's named calendars and exact resource scopes deliberately replace that implicit group-leader edit fallback. Membership, leadership and unrelated directory grants do not confer calendar or archive editing. No room approval, resource booking or full curated-calendar interoperability is implied by Calendars Admin.

## Delegation and controls

The original Roles screen offers calendar, sermon and playlist scopes alongside existing group/ministry scopes. `/membership/permissionScopes` requires Roles View and returns only minimal names/ids and delegatable actions. Eligibility is filtered before its per-resource 1,000-row limit. It does not grant access to the people directory or group catalog.

Non-administrators may delegate only the same held permission type and action, with existing global-to-specific narrowing. Effective aliases are not delegation authority: Content Edit does not permit granting a new Sermons Edit permission, nor does Edit's effective read access imply authority to delegate a separate View grant. The role guard rechecks the held grant and target resource in the write transaction. Deleting a resource removes its exact scoped role grants so reusing an id cannot revive them.

Calendar DTOs include `canEdit`, `canCreate`, and the current group label. Sermon/playlist DTOs include `canEdit`; a permitted sermon includes its current `playlistTitle` without exposing other playlist records. The calendar UI omits root creation for scoped editors and disables group pickers without global group access. The archive UI uses resource permissions and offers eligible playlist destinations. A global grant can intentionally expand these controls.

## Write and storage guarantees

Collection reads filter tenant and effective scopes before result limits. Each write checks source and destination authority, current tenant/person/session state, and relevant resource relationships in the same D1 batch as the changes and audit entries. Mixed authorized/unauthorized bulk writes roll back together. A stale read, revoked role, deleted resource, expired session or removed church person cannot pass the commit guard.

Simple and multipart uploads require current sermon editing authority both before accepting metadata and after R2 writes. Permission loss cannot publish pending bytes. R2 and D1 do not share a transaction: pending/deleting states and compensating cleanup make failures recoverable. A lost response after a committed ready batch is reconciled before any object deletion. Cleanup must atomically claim an old hidden file as deleting before removing bytes, while upload completion requires its pending snapshot to remain intact. Multipart manifests stay frozen during uncertain completion.

## Verification and remaining work

The local D1/R2 suites exercise scope-filtered lists, View-only denial, calendar/sermon moves, recurring edits, bulk rollback, scope deletion/delegation races, file reads and uploads, and revocation after R2 writes. `resource-permission-race.test.mjs` independently injects transitions after preflight, including a lost response from a committed ready transaction. `scoped-calendar.spec.ts` covers the role selector and calendar UI workflow; browser execution is recorded separately by the coordinated milestone verification.

This is focused regression coverage, not a complete security audit. Collection caps remain; administrative permission-scope search/pagination beyond 1,000 eligible resources per kind is not implemented. Production load, deployed R2/D1 behavior, notifications, provider integrations, live streaming and other upstream Content kinds remain outside this milestone.
