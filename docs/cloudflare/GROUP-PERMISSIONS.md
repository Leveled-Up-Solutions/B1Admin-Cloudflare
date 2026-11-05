# Resource permission scopes

The custom role API preserves upstream permission keys and supports whole-tenant grants plus exact scopes for `MembershipApi / Groups` and `MembershipApi / Group Members`, each with `View` or `Edit` action. A scoped permission has `contentId` equal to an existing group in the same church; `contentId:""` means the whole church. Doing Plans scopes use a ministry group ID; Doing Tasks scopes use the assigned group ID. Other resource scopes and Everyone grants return an explicit unsupported response.

For example, an administrator can grant editing for one group with:

```json
[{"roleId":"existing-role-id","apiName":"MembershipApi","contentType":"Group Members","contentId":"existing-group-id","action":"Edit"}]
```

Send the array to `POST /api/membership/rolepermissions`. Role members use the existing `/rolemembers` array contract. Grants are loaded from D1 on each authenticated request, so revocation takes effect without token refresh. The original permissions editor has a separate scope selector; a checked group permission does not imply a checked whole-church permission.

| Grant | Behavior |
| --- | --- |
| Groups View | Group metadata for the exact group. List, ID, tag, category, and own-group results are filtered. |
| Groups Edit | Read/edit/delete the exact existing group, and manage its memberships. Creating groups or changing their parent hierarchy requires whole-church Groups Edit. Deleting a parent with children also requires the whole-church grant. |
| Group Members View | Membership records and group metadata for the exact group. |
| Group Members Edit | Read/add/edit/remove memberships and review join requests for the exact group. Does not grant group editing. |

There is no permission inheritance through group parents. Existing broad People View/Edit grants continue allowing group metadata for directory workflows, while member records still require their own grant. Membership person DTOs contain only names/photo unless the caller also has People View/Edit; group-scoped access alone does not expose contact details, birth dates, or households. Individual member ownership endpoints remain separate.

Group routes authorize each resource themselves. A scoped grant never sets broad `writeAuthorized` for a bulk request. Moving a membership requires access to both its original and destination group. Every bulk item is validated before the D1 batch. Inside that same batch, CHECK-backed guards revalidate the live session, role permissions, source membership group, and group-parent snapshot. A concurrent move, hierarchy edit, logout, or permission revocation aborts the whole batch, including earlier writes and audit entries, with HTTP 409. Transient guard rows are removed inside the batch. Deleting a group removes its scoped role grants, so reusing the ID cannot revive stale privileges.

A delegated role editor may delegate only the exact grant already held or a narrower group scope covered by a whole-church grant. They cannot assign themselves, edit a role assigned to themselves, delegate role-administration permissions, or broaden a group scope to the whole church. Bootstrap administrators remain the separate protected authority.

`group-permissions.test.mjs` verifies scope validation, metadata filtering and contact redaction, bulk rollback, source/destination checks, hierarchy limits, delegation limits, live revocation, and deletion/ID reuse. These tests run against local workerd/D1; they do not certify every possible upstream suite permission combination.

`group-scope-race.test.mjs` deterministically inserts competing D1 writes between handler preflight and mutation. Six tests cover membership save/delete moves, concurrent parent changes, child creation, grant revocation, logout and session expiry at transaction time; bulk rollback preserves the administrator’s competing update and leaves no guard rows.

## Plans, tasks and live delegation

`DoingApi / Plans / View|Edit` accepts `contentId` equal to an existing ministry group. It covers that ministry’s plan types, plans and their child records. `DoingApi / Tasks / View|Edit` accepts an existing group and covers manual tasks assigned to it. These are explicit fork contracts: upstream mostly uses global permissions and direct ministry membership, while this instance never turns membership alone into administrative editing authority. See [MODULES.md](MODULES.md) for copy/move rules, volunteer-pool boundaries and private availability limits.

The central dispatcher still requires a matching global or scoped permission for the implemented Doing resource family. Scoped admission does not set broad `writeAuthorized`; resource handlers check each concrete ministry/group and enforce the same authority inside atomic mutation batches. Scope grants do not authorize unknown Doing routes, directory contact reads or church-wide availability.

`GET /api/membership/permissionScopes` requires Roles View and returns at most 1,000 group/ministry names with only permission kinds the caller can delegate. It drives the original role editor’s scope selector; it is not a directory permission. Existing unavailable scopes can still be displayed from role grant records.

Every role/grant/member mutation now rechecks the actor’s live session, active linked person and current Roles Edit inside its D1 batch. A delegated editor cannot race a stronger role into an assignment, retain a revoked grant, change their own role, or delete a grant moved to another role after preflight. Database guards compare the prior resource tuple; failure rolls back earlier writes and audit rows. `role-race.test.mjs` covers six deterministic race scenarios, and `permission-scopes.test.mjs` checks the central gate and metadata projections.
