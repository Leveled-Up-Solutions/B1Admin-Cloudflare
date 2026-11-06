# Member profile and family review

Milestone 4 adds a local review queue for member directory changes and proposals to edit an existing family member. It creates ordinary My Work task records for discoverability, but only the dedicated review action can apply or decide a request. It does not run automation, publish workflow events, or send notifications.

The source comparison and pinned upstream links are in [WORKFLOW-PARITY.md](WORKFLOW-PARITY.md). Upstream B1App submits `directoryUpdate` tasks when `directoryApprovalGroupId` is configured; the original B1Admin reviewer saves people and closes the task in separate requests. This fork uses one D1 transaction for the person mutation, decision, task closure and audit entry. The dedicated API is an intentional compatibility boundary: the upstream generic `POST /doing/tasks?type=directoryUpdate` submission and client-side People-save/Task-close sequence are not enabled here.

## Member behavior

Without a configured directory approval group, members can still save their own allowed profile fields and add a new private family record directly. With a configured group, the profile reports `settings.profileEditMode: "review"`; members submit proposals for those changes. Direct personal-data writes still return 409, so a caller cannot bypass the policy by ignoring the portal UI. Their own `directoryVisible` and `shareEmail` consent remains independently editable and is never part of a review proposal.

Editing an existing relative is always a proposal, including in a church with no approval group. This extends the inspected B1App behavior, which displays relatives but offers editing only for the signed-in person's own record. Household membership, Head/Spouse status, group leadership and directory visibility do not grant direct authority to edit another person. The current household list continues to expose names and roles only. The proposal form does not fetch the relative's hidden phone, address or birth date; it submits just the fields the requester supplies. Both unchanged and different proposed values receive the same submission behavior, preventing a private-value guessing check.

The requester, church, original household, current target and reviewer routing are selected or validated by the server. Existing-family targets must be active people in the requester's current nonempty household. Proposals cannot reassign people or create, link, invite, enable or reset an account. New family records default to private `Visitor` records. A household can have at most 100 active members through these self-service paths.

## Configure review in Church Settings

In administration, open **Church settings → Directory approval group**, select an active group, and save. **No review group** clears the policy for own-profile edits and new family additions; changes to an existing relative still require review. The panel explains the additional People Edit requirement and the need to cancel/decline and resubmit pending requests after changing the review group.

| Method and path | Contract |
| --- | --- |
| `GET /api/membership/churches/current` | Adds the string `directoryApprovalGroupId` to the current church response; `""` means no review group. |
| `GET /api/membership/churches/directoryReviewGroups` | Requires global Settings Edit and returns only active same-church `{id,name}` records. Groups View is not required. The selector is bounded to 1,000 groups and returns 413 rather than silently truncating a larger result. |
| `POST /api/membership/churches` | Accepts one current-church record, for example `[{"id":"church-demo","directoryApprovalGroupId":"group-welcome"}]`. A trimmed empty string clears the policy. Name and time zone remain optional editable fields; arbitrary raw `settings` and public-host changes are rejected. |

Policy writes validate the selected group's tenant and active state and preserve unrelated JSON settings in either the stored array or object representation. Existing array-entry metadata is retained while duplicate entries for this setting are normalized. Omitting `directoryApprovalGroupId` leaves the stored settings unchanged. The same D1 batch rechecks current Settings Edit, active account/person identity, session expiry/password version, the previous settings/name/time zone and the selected group's active state before updating and auditing. A concurrent change returns 409 without a partial save or audit entry.

For stored policy data, only an absent setting or an explicit empty string disables review. Present non-string values—including `false`, `0` and `null`—and malformed duplicate entries fail closed. Invalid top-level settings shapes also fail closed and require staff repair before this panel can change the policy. A configured but missing, foreign or archived group never turns review into direct editing.

## API

All routes are authenticated and begin with `/api/member/v1/profile-requests`.

| Method and suffix | Contract |
| --- | --- |
| `POST /` | `{kind,changes,personId?}`. `kind` is `profile`, `family-add` or `family-edit`; `personId` is required only for `family-edit` and forbidden otherwise. Creates one proposal and one protected task atomically. |
| `GET /my` | Current account/person's requests in this church, newest first, including terminal decisions. |
| `GET /review` | Pending queue for the currently authorized reviewer, oldest first. Returns an empty collection when the caller lacks review authority. |
| `GET /:id` | Proposal details for its requester or a currently authorized reviewer. |
| `GET /task/:taskId` | Same protected detail lookup for the original My Work task screen. Task visibility alone does not grant this detail access. |
| `POST /:id/approve` | `{}`. Apply the complete proposal and close the task atomically. |
| `POST /:id/decline` | `{reason?}`; reason is at most 500 characters. Record the decision and close the task without changing the person. |
| `DELETE /:id` | The original account/person may cancel its own pending proposal. Cancellation closes the task without changing people. |

Own-profile and existing-family `changes` accept the flat fields `firstName`, `lastName`, `middleName`, `nickName`, `mobilePhone`, `homePhone`, `address1`, `address2`, `city`, `state`, `zip`, and `birthDate`. Birth date is a real non-future `YYYY-MM-DD` or null. New-family changes accept `first`, optional `last`, optional `mobilePhone`, and `householdRole` (`Head`, `Spouse`, `Child`, `Other`, default `Other`). A missing new-family surname uses the requester's surname at submission time.

The response contains `id`, `taskId`, `kind`, `status`, `target`, `requester`, `changes`, `createdAt`, `decidedAt`, `reason`, and `canReview`. Names use `{name:{display}}`; new-family target ID is null until approval creates the record. Status is `pending`, `approved`, `declined`, or `cancelled`. The caller never receives the stored baseline fields, account-link snapshot, session details or reviewer-group internals. Audit records contain action and entity identifiers, not the proposed personal values.

`my` and `review` support bounded `limit`/`offset`. Defaults preserve array responses; `paged=1` returns `{items,pagination}` using the member API's shared paging contract. There is one pending proposal per requester/kind/target, with one new-family proposal at a time. An identical repeated submission returns the existing request; a different pending proposal returns 409 until cancelled or decided. A terminal request is immutable. Repeating the same decision returns its result without another person mutation or audit; a conflicting decision returns 409.

## Review authority and My Work

Every reviewer needs current global `MembershipApi / People / Edit`. When a review group is configured, the reviewer must also currently belong to that group, have global `DoingApi / Tasks / Edit`, or be a bootstrap administrator. Group membership or leadership alone never grants People Edit. With no configured group, current People Edit is sufficient for the review queue; the corresponding task is assigned to an active bootstrap administrator. An authorized staff member may review their own proposal because the existing People Edit permission already grants that record-editing authority.

Configured groups must be in the same church and active. A configured but missing, foreign or archived group, or malformed policy data, fails closed with a staff-facing configuration error rather than falling back to direct writes or creating an unassigned task. Task assignment is server-owned. A generic task carries only safe metadata and `taskType: "directoryUpdate"`, never private change payloads. Generic creation of that task type and mutation/deletion of its protected task are rejected. The original TaskPage hides close/reopen, reassignment and due-date edits for these records and mounts the authorized review component. Ordinary manual tasks retain their existing behavior.

The separate review queue remains available to currently authorized People Edit staff even when the originally assigned administrator changes. Changing the configured review group makes old proposals ineligible for approval; it does not discard them. A current reviewer can decline them, or their requester can cancel and resubmit under the current policy. Old tasks are not automatically reassigned, and no messages are sent to a new review group. The portal review queue is the authority-aware way to find these pending records when task assignment no longer matches the current policy.

## Atomicity and privacy boundary

Submission and decision batches recheck the acting user's live session, password version, account/person link, active person and current policy at D1 execution time. Approval additionally requires the original requester still to have the same active account/person/household relationship; the requester's original session may have ended because review is asynchronous. Target removal, household or household-role changes, account-link changes, and changes to any proposed field invalidate the stored snapshot. Unrelated field edits and independent privacy-consent updates are preserved.

Approval applies only server-validated fields after those checks, changes the pending request to its terminal outcome, closes its task and appends the audit record in one D1 batch. A failed check rolls back all effects and leaves the request pending. This prevents stale overwrites, applying a request to a person who moved households, duplicate family creation on replay, or a task marked closed after a failed person update. A 409 requires refreshing and normally cancelling/declining and resubmitting; there is no force-apply control.

## Verification and remaining scope

The latest focused local workerd/D1 run passed **30/30**: `member-approvals.test.mjs` (11), independent `member-approvals-security.test.mjs` (7), `church-settings.test.mjs` (4), and existing `member-profile.test.mjs` (8). These cover concurrent submissions and decisions, atomic task/person/audit effects, private account-free additions, tenant/household boundaries, reviewer grants, cancellation/decline, hidden-field guessing, strict malformed-policy handling, capacity limits, and changes injected immediately before the real D1 batch. Configuration tests cover array/object preservation, foreign/archived groups, Settings Edit without Groups View, and queued grant/session/identity/settings/group changes. The independent security cases also confirm that a requester's logout does not prevent later authorized review. Worker and frontend application typechecks and targeted TaskPage/Church Settings lint checks passed. Coordinated browser and full-suite results remain separate in [VERIFICATION.md](VERIFICATION.md); this focused result does not establish browser verification.

Remaining boundaries include photos, title/prefix/work-phone fields, contact email or account identity changes, rich visibility preferences, household reassignment or role changes for existing people, partial approval, an editable request/diff/merge interface, automatic reviewer reassignment, reminders and notifications, approval SLAs, and the full upstream directory task wire contract. Proposed values are reviewed as a complete request; the UI does not expose other relatives' private baseline values. Operational retention and access review for stored request snapshots remain production work. No live data or external delivery was used.
