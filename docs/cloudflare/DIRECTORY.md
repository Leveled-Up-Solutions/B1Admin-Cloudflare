# Directory, households and group records

The Cloudflare directory keeps the upstream people list, household cards, create-person form, household editor and advanced-search controls. The person detail adapter now includes middle/preferred names, contact fields, civil birth/anniversary dates and household management. Custom fields/forms, person merge/import and saved-list execution remain unported.

## Household contract

`POST /api/membership/people/household/{id}` accepts the upstream array of existing people with household roles (`Head`, `Spouse`, `Child`, `Other`). It requires People Edit. The full membership replacement is atomic in D1: submitted people move to the target household, omitted people receive their own household with role Head, and unused source households are removed. No other submitted person fields are changed by this endpoint. Moving a person with an address uses the existing editor's separate address-copy choice.

All IDs and tenant relationships are validated before writes. The removal set is evaluated inside the same batch as moves. Empty arrays intentionally split every active person into separate households. Duplicate members and invalid roles fail without partial changes; arrays of up to 100 members fit D1 binding limits.

`DELETE /api/membership/households/{id}` only deletes an unused household. A household referenced by a person, including a soft-deleted person, returns 409. Deleting a person is still a soft delete; it does not erase historical records or the associated household.

## Advanced search

`POST /api/membership/people/advancedSearch` preserves the array of `{field, operator, value}` conditions. It requires full People View or Edit; View Names alone cannot query contact or demographic data. All conditions combine with AND.

Supported fields include names, email/phone/address/city/state/ZIP, gender, marital and membership status, household ID/role, stored grade/school/campus IDs, birth/anniversary dates and months, age/years married, date added and ID sets. Operators are explicit: equals/not-equal, ordered comparisons where appropriate, literal contains/prefix/suffix, ID IN/NOT IN and date `lastDays`. Wildcard characters in search text are escaped. Unknown fields/operators are rejected, never interpolated into SQL.

Birth and anniversary dates are civil dates. Date-added comparisons use the church's IANA time zone; a record created just across UTC midnight still belongs to the correct local day. Age is evaluated on the church's current civil day. Undated people do not satisfy date comparisons. Search is bounded to 40 conditions, 1,000 returned records, 1,000 IDs per set and D1's parameter budget. Large directory pagination, configurable collation and complete Unicode case-folding remain work: SQLite NOCASE/LIKE case behavior is not equivalent to every MySQL Unicode collation.

The original advanced-search panel exposes the supported fields; excluded giving, attendance, custom-form and campus-management filters are omitted. Existing group membership filters resolve current group members and use the local ID set operation.

## Groups and church time zone

Group name, category, tags, description, joining policy, parent, meeting time/location and archive status persist. Default group lists return active groups; `?archived=1` returns archived groups. Composite foreign keys enforce tenant relationships, and database triggers reject parent cycles, including cycles introduced by multiple edits in one batch. Existing historical membership in an archived group remains available to authorized readers; archiving removes it from member discovery and prevents new joins/approval.

`POST /api/membership/churches` accepts the current church's name and validated IANA time zone with Settings Edit permission. Operational host settings and arbitrary church settings cannot be changed through this narrow route. `/settings/church` exposes those fields. Calendars retain their own zones; service-plan copies use the church zone.

See the focused household, directory-search, group-details and church-settings integration tests under `cloudflare/test/`, plus `tests/cloudflare/directory-households.spec.ts` for browser evidence. Final executed totals live in [VERIFICATION.md](VERIFICATION.md).

Literal containment, prefix and suffix searches use SQLite string operations rather than SQL LIKE. This preserves literal wildcard characters and accepts long Unicode text without exceeding D1’s [50-byte LIKE-pattern limit](https://developers.cloudflare.com/d1/platform/limits/). Case folding still follows SQLite’s built-in ASCII-oriented behavior; complete MySQL Unicode collation equivalence remains unimplemented. Parameter counts include phone-field expansion and suffix comparisons and are checked against D1’s 100-parameter limit before execution.
