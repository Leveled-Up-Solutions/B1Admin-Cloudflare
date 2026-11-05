# Sermon administration in the Cloudflare milestone

The Cloudflare build reuses B1Admin's sermon list, search, playlists, sermon editor and duration controls. The API preserves the corresponding sermon and playlist fields. The changes are conditional on `REACT_APP_STAGE=cloudflare`; the upstream hosted mode keeps its original controls.

## Supported user flow

1. Create or edit a playlist, then create a sermon with a title, date and optional speaker, description, duration and manual HTTPS media URLs.
2. Save the sermon. New sermons start private and unpublished.
3. Reopen the saved sermon to attach archive files. Uploads use authenticated raw requests to R2 through the Worker, with a 25 MiB per-file limit. The editor lists attachments and supports authenticated download and deletion. Tokens never appear in file URLs.
4. Choose **Member archive**, save, reopen and select **Publish saved sermon**. Member visibility requires the saved `visibility=public`, an explicit `publishedAt` value and a publish date that has arrived. **Unpublish sermon** removes it from the member archive.

A published sermon's saved edits appear immediately. The editor explicitly advises unpublishing before preparing private changes. Files remain attached to the sermon; they are not inserted into external media URL fields. A sermon with attached files cannot be deleted until those files are removed.

## Deliberate limits

Live streaming, permanent live URLs, bulk import, provider metadata lookup, podcast RSS and external thumbnail previews are disabled in the Cloudflare build. Manual HTTPS media and thumbnail URLs may be stored; the editor does not fetch them automatically. R2 is an attachment archive, not a transcoding or adaptive streaming service. This milestone does not claim support for large sermon videos beyond the configured 25 MiB upload limit.

The original **StreamingServices / Edit** UI permission controls sermon administration. The Worker additionally enforces the persisted tenant and server-side permissions. Members use the separate portal API and cannot write sermon or archive records.

## Verification

The modified sermon components and new archive-file component passed esbuild TypeScript/JSX syntax transpilation. Full application type checking still includes upstream diagnostics; none were reported in these sermon components.

`tests/cloudflare/sermons.spec.ts` passed against the compiled local Worker at `127.0.0.1:8787` using installed Chrome. It exercises the original playlist and sermon editors, saves and reopens metadata, uploads a synthetic text archive to local R2, downloads and compares its bytes, explicitly publishes and unpublishes the sermon, and deletes the attachment, sermon and playlist through the UI. Member API assertions verify that drafts are hidden, published files download through `/api/member/v1/files/:id/download`, and unpublished files return 404. The run observed no external requests, browser errors or failed administration API responses. All created synthetic records were removed.

The test also captures `sermon-archive-editor.png` in its Playwright output directory. This covers desktop Chrome and a small text attachment; it does not establish large-file, physical-device or production behavior. Separate member portal tests cover local WAV playback. The integration report records the final combined suite and build results.
