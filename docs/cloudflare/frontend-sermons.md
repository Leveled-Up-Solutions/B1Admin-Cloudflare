# Sermon administration in the Cloudflare milestone

The Cloudflare build reuses B1Admin's sermon list, search, playlists, sermon editor and duration controls for the implemented archive workflows. The API preserves the corresponding sermon and playlist fields. Cloudflare-specific controls are conditional on `REACT_APP_STAGE=cloudflare`; the upstream hosted mode keeps its original permission gate and provider controls. This is a selected workflow adaptation, not complete upstream Content API parity.

## Scoped viewing, editing and creation

The archive screen accepts applicable Content, Sermons or Playlists View/Edit permissions, plus the existing global StreamingServices Edit permission. The Worker filters lists by tenant and resource scope. Existing sermon and playlist records carry a server-computed `canEdit`; the UI uses it to offer **View** details or the editor.

View-only sermon details include the permitted metadata, current playlist label and archive files. They allow native playback and download, while hiding save, upload, multipart-session and file-delete controls. An exact sermon reader does not need access to the playlist catalog or people directory, and the read-only file component does not request upload sessions.

An exact Sermons Edit grant permits changes to that sermon and its files. Playlists Edit applies to the selected playlist and its current sermons/files, and permits creating sermons inside that playlist. The add-sermon flow preselects an editable playlist when the user lacks authority to create unassigned sermons. Playlist destinations are restricted to eligible choices; an exact sermon editor can retain its existing playlist label without loading unrelated playlists.

Creating a playlist requires global Playlists Edit or a relevant global compatibility grant. Creating an unassigned sermon requires global Sermons Edit, Content Edit or StreamingServices Edit. An exact sermon grant alone does not expose creation controls. Moving a sermon requires source authority and destination playlist authority; moving it out of a playlist requires global sermon editing authority. These resource scopes are explicit fork behavior. See [calendar and archive permissions](RESOURCE-PERMISSIONS.md) for server checks and upstream differences.

## Supported archive flow

1. Create or edit an authorized playlist or sermon. Sermon fields include title, date, speaker, description, duration and manual HTTPS media URLs.
2. Save the sermon. New sermons start private and unpublished.
3. Reopen the saved sermon to attach archive files. Raw uploads accept up to 25 MiB; larger files automatically use resumable multipart upload, up to 1 GiB. Smaller files may also use multipart. The editor supports progress, pause, resume, original-file verification, refresh and abort.
4. Choose **Member archive**, save, reopen and select **Publish saved sermon**. Publication requires editing authority for that sermon. Member visibility additionally requires saved `visibility=public`, an explicit publication timestamp and a publish date that has arrived. **Unpublish sermon** removes it from the member archive.

Saved edits to a published sermon appear immediately. The editor advises unpublishing before preparing private changes. Files remain attached to the sermon and are not inserted into external media URL fields. Attached files must be removed before deleting their sermon. Ordinary member access uses the separate published-content portal API and does not confer archive editing authority.

## Native private playback and downloads

The admin archive and member portal use native browser audio/video elements and downloads. They no longer buffer an entire file as a JavaScript Blob or impose the earlier 25 MiB playback/download cap. Selecting Play or Download exchanges the current bearer authentication for a short-lived, file-scoped HttpOnly/Secure/SameSite=Strict cookie. The returned URL contains only a file identifier, never a bearer token or media secret.

Each range, HEAD and download request rechecks the login session, church membership, file readiness and current sermon permission/publication. A separate browser-context cookie prevents media from a previous signed-in account being reused after account replacement. Logout and successful church switching revoke grants and clear cookies; the UI stops its player on token changes or unmount. Grants last at most two hours, bounded by login expiry, with at most twenty active file grants per session. Selecting Play or Download again refreshes access. Already received buffers or an already-authorized in-flight response cannot be retracted.

This cookie flow requires the app and media API to share an origin; production requires HTTPS. The existing bearer download APIs remain available to API clients. See [the media API contract](CALENDAR_SERMON_API.md) for range semantics, limits, cookies, cleanup and revocation behavior.

## Deliberate limits

Live streaming, permanent live URLs, bulk import, provider metadata lookup, podcast RSS and external thumbnail previews remain disabled in the Cloudflare build. Manual HTTPS media and thumbnail URLs may be stored; the editor does not fetch them automatically. R2 archives do not transcode or package adaptive streams. Native playback depends on the browser's supported codecs; unsupported files can be downloaded. No live sermon ingestion, production deployment or complete suite interoperability is implied by these workflows.

The configured archive limit is 1 GiB. The largest browser-tested archive is a generated 28 MiB PCM WAV plus its 44-byte header. Other browsers, video codecs, physical devices, long-duration streaming and full 1 GiB throughput remain unverified.

## Verification

Application/Worker typechecks and focused frontend lint passed before the coordinated browser run. Browser checks used installed Chrome with compiled local assets and isolated synthetic Worker/D1/R2 state on loopback port 8790.

- `tests/cloudflare/sermons.spec.ts` passed the original playlist/sermon editors, metadata persistence, a synthetic text upload, exact-byte download, publication/unpublication, member visibility checks and UI cleanup.
- The two `tests/cloudflare/media-uploads.spec.ts` checks passed pause, reauthentication, original-file checks, resume, abort and automatic multipart upload/download above 25 MiB.
- `tests/cloudflare/member-portal.spec.ts` passed native playback of a synthetic one-second WAV alongside the member workflow checks.
- `tests/cloudflare/media-playback.spec.ts` passed native decoding of 29,360,172 bytes, a real HTTP 206 seek beyond byte 25 MiB, and a download with matching SHA-256. It verified Secure/HttpOnly/Strict cookies on loopback, no Authorization header on native requests, account replacement rejecting the old media context, and logout clearing access. Its initial run reached successful seeking but failed Playwright's HTTP URL-filtered cookie inspection; a test-only correction to inspect the full cookie jar passed without an application change.

`tests/cloudflare/scoped-content.spec.ts` covers playlist-scoped editing and creation, exact-sermon View/Edit, read-only archive download, and omission of unrelated playlist/upload-session/directory requests. The coordinated integration report records its execution and the final combined suite results. These focused checks do not establish full upstream parity or production readiness.
