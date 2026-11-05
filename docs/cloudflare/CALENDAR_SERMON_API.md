# Calendar and sermon APIs

These APIs are part of the selected Cloudflare milestone. They do not create the separate Potter's Hands website. Seeds contain synthetic development calendars and sermon descriptions only.

## Calendars and events

`/api/content/calendars` accepts GET and POST arrays. `/calendars/:id` accepts GET and DELETE. The calendar representation is `{id,churchId,name,description,color,timeZone,groupId,updatedAt}`. `groupId` may be null, `color` is six-digit hexadecimal, and `timeZone` must be an IANA zone. New records omit id; supplied ids update existing tenant records. A calendar containing events cannot be deleted or moved to another group until its events are moved or deleted.

`/api/content/events` accepts GET and POST arrays. `/events/:id` accepts GET and DELETE. `/events/group/:groupId` provides the upstream group-event read shape. Event fields are `{id,churchId,calendarId,groupId,title,description,start,end,allDay,location,timeZone,updatedAt}`. Calendar is required; the event inherits its calendar's group and time zone unless supplied. A group calendar's event must use that same group. The calendar/group relationship is guarded in SQLite triggers as well as application validation so racing requests cannot bypass it.

List reads accept `calendarId`, `groupId`, `start`, and `end` filters, with a maximum of 500 rows. Results overlap the requested start-inclusive/end-exclusive window, rather than only matching event start times. Unfiltered results order by start time. Collections return arrays to retain the ChurchApps wire convention.

Timed events require an ISO timestamp with `Z` or an explicit numeric offset; they are normalized to UTC for storage. `timeZone` preserves the intended presentation zone. The offset determines the instant; the API does not infer DST offsets from a naive wall-clock string. All-day events instead require `YYYY-MM-DD` civil dates and retain them without converting to UTC. Their end date is exclusive: one all-day event on January 16 uses start `2027-01-16`, end `2027-01-17`. Empty, invalid, or reversed intervals are rejected. Date-only query windows are preferred when displaying a calendar that includes all-day events.

Staff viewers can read, administrators can modify, and members use the separate `/api/member/v1/calendar` filtered surface. Every relationship and query is scoped by church id. Batch writes and audit entries commit atomically. Overlapping events are permitted; these are calendars, not an exclusive room-booking system. Recurrence, registration, rooms/resources, booking approval, holiday expansion, and external calendar synchronization remain unimplemented and are not simulated.

Named `/content/calendars` is an adaptation-specific API. Upstream organizes events through groups and curated calendars; basic `/content/events` fields and array writes are preserved, but complete curated-calendar and recurrence interoperability is not claimed.

## Sermon archive

`/api/content/sermons` supports GET and POST arrays; `/:id` supports GET and DELETE. Preserved fields are `title`, `description`, `speaker`, `publishDate`, `videoType`, `videoData`, `videoUrl`, `audioUrl`, `thumbnail`, `playlistId`, and `duration`. `/api/content/playlists` and `/:id` provide the corresponding playlist CRUD (`title`, `description`, `publishDate`, `thumbnail`). Playlists referenced by sermons cannot be deleted until sermons are moved or removed. Media URLs must be HTTPS. There are no YouTube/Vimeo imports, provider lookups, live streaming, or network requests during saves.

New sermons are private and unpublished. Set `visibility: "public"`, then POST `/api/content/sermons/:id/publish` to expose a sermon. DELETE `/:id/published` unpublishes. Publishing requires an administrator. A published sermon whose publish date is in the future remains hidden. Edits to an already published public sermon become visible immediately; unpublish first when draft edits are needed.

The narrow future-website integration is GET/HEAD `/api/public/v1/churches/:subDomain/sermons` and `/sermons/:id`. Lists return `{data,pagination:{limit,offset,count}}` with default limit 50, maximum 100, and offset maximum 10,000. Responses project explicit public sermon fields and exclude church settings, drafts, and member records. `hidePublicSite` disables the feed. Cross-origin access uses the Worker's allowlist; responses are not cached so unpublishing takes effect immediately. No website page-building routes are implemented.

## R2 archive files

Files belong to an existing sermon in the authenticated church. POST `/api/content/files/upload?fileName=example.mp3&contentType=sermon&contentId=<sermon-id>` sends raw bytes with the MIME `Content-Type` header, up to 25 MiB. The upstream one-item base64 POST `/api/content/files` shape is also accepted, up to 5 MiB decoded: `[{"contentType":"sermon","contentId":"sermon-demo","fileName":"transcript.txt","fileType":"text/plain","fileContents":"data:text/plain;base64,SGVsbG8="}]`.

Uploads return an array with server-owned `id`, file metadata, `provider: "r2"`, and `contentPath`. GET `/files/sermon/:id` lists archive metadata; GET `/files/download/:id` downloads authenticated bytes; DELETE `/files/:id` removes the file. Filenames reject path separators and control characters. PNG, JPEG, WebP, GIF, PDF, plain text, MP3, WAV, MP4 audio/video, ZIP, and generic binary MIME types are accepted; SVG, HTML, and script MIME types are rejected. Files always download as attachments with `nosniff`, a sandbox CSP, and no shared caching.

File ids are immutable. Replacing an archive means uploading a new file and deleting the old file. Existing archive files must be removed before deleting their sermon. Uploads persist `pending` metadata before writing bytes, then mark `ready` and audit in a D1 batch. Immediate compensation attempts to remove failed writes. Deletes mark `deleting` before removing bytes, so failed operations stay hidden and recoverable. `cleanupFiles` retries pending/deleting operations older than one hour, at most 100 per scheduled execution. This does not pretend R2 and D1 share a distributed transaction.

Large full-length video and multipart/resumable uploads are outside this milestone. Existing HTTPS media URLs can be archived as sermon metadata; no live media is fetched or imported.

## Tests

`cd cloudflare && node --test test/calendar.test.mjs test/sermons.test.mjs` exercises the actual Worker with local D1/R2 bindings, covering CRUD, audit/atomicity, tenant isolation, viewer restrictions, civil dates, UTC offsets and DST, published-only sermon reads, base64 compatibility, R2 bytes, and file delete constraints. The local runtime needs permission to bind a loopback server in sandboxed environments.

## Plan-type/group associations

The original PlanTypeGroups panel uses GET `/api/membership/associatedGroups/content/planType/:id`, GET `/associatedGroups/group/:id?contentType=planType`, POST arrays to `/associatedGroups`, and DELETE `/associatedGroups/:id`. Records contain `id`, `churchId`, `contentType: "planType"`, `contentId`, `groupId`, and `settings: "past" | "future" | "both"`. Only this association kind is implemented. Writes require Plans Edit; reads require Plans View or Edit. D1 enforces both tenant-qualified foreign keys and unique plan-type/group pairs. Changes are audited atomically.

For published plans, an association grants direct group members access to the selected plan-date range: past is before today, future is today or later, and both permits either. Draft/prepared plans remain hidden; removing an association takes effect on the next read. Assignment-based access remains independent. Parent-group inheritance and timeline plan-card generation are not implemented.
