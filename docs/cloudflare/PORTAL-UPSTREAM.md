# Member portal, sermon archive and mobile source audit

The selected member-facing scope is members, groups, calendar, sermon archives, serving responses/availability and an actual PWA/mobile web application. The user explicitly accepted PWA/mobile web; a native app-store release is not required. Check-in and giving are excluded. This document records upstream source contracts to guide the implementation; it does not claim that the current port supports every route listed here. See [MEMBER-PORTAL.md](MEMBER-PORTAL.md) for the implemented custom portal and its tested boundary.

## Pinned sources and license

* [ChurchApps/B1App](https://github.com/ChurchApps/B1App/tree/85c9e7d96b2f1659fd897191fb719095a176fa0f), commit `85c9e7d96b2f1659fd897191fb719095a176fa0f`: MIT, copyright 2022 Live Church Solutions.
* [ChurchApps/B1Mobile](https://github.com/ChurchApps/B1Mobile/tree/b86c4c4ab4ec3cb3c554b226109380a26834ad75), commit `b86c4c4ab4ec3cb3c554b226109380a26834ad75`: MIT, copyright 2022 Live Church Solutions.
* Shared API and package source versions/notices are pinned in [UPSTREAM.md](UPSTREAM.md).

Preserve the applicable MIT copyright/permission notice when copying substantial source. No `AGENTS.md` or `.agents/skills/**/SKILL.md` was found in either portal/mobile checkout. This audit made no changes to either upstream checkout and did not deploy or run their hosted integrations.

## B1App is the web/PWA application

B1App's package uses Next.js `^16.4.2`, React `^19.2.6`, AppHelper `^1.10.11`, Helpers `^2.15.0`, TanStack Query, MUI, Serwist, and Yarn 4.15.0; Node >=22 is declared. Its README's older npm instructions do not match those current scripts. It is not an Expo or React Native application.

Next's App Router organizes church-specific content under `src/app/[sdSlug]`. Host rewrites hide the church slug on church domains. Public website routes and `/mobile/...` member routes share backend/configuration helpers. The mobile UI uses a persistent client layout, `ScreenRouter`, and `DetailRouter`; examples include `/mobile/login`, `/mobile/me`, `/mobile/profileEdit`, `/mobile/groups`, `/mobile/groups/:id`, `/mobile/community`, `/mobile/sermons`, `/mobile/sermons/:id`, and `/mobile/playlist/:id`.

The upstream PWA is substantive: a church-specific manifest starts at `/mobile/dashboard?source=pwa`, scopes installation to `/mobile/`, uses standalone display and 192/512px icons; Serwist caches the shell and handles offline fallback, push notifications and app badging. It also uses persisted browser query data. Porting it requires deliberate cache rules for public versus authenticated data and clearing private client state on logout/account switching. A manifest alone would not reproduce those behaviors. Existing service-worker API hostname matching includes hosted ChurchApps/B1 domains and must be adapted for a new origin.

The Next app has server-rendered routes, dynamic metadata/manifests, cached server fetches/tag revalidation, middleware with per-request CSP nonces, image routes, and a podcast download route. It cannot be treated as an ordinary Vite static export without changes. For the selected scope, a separate responsive member interface using the Worker APIs is a valid divergence; it should be described as such rather than claiming a complete Next application port. The public `pottershandsministries.org` website remains a separate project.

## Member and sermon API contracts

Paths below include the module prefix; an installation may add `/api`. These are observed B1App requests, not the new port's supported-endpoint list.

| Flow | Upstream request/response contract | Important boundary |
| --- | --- | --- |
| Church bootstrap | `GET /membership/churches/lookup/?subDomain=...`; public membership/content settings; content links, page tree and global styles | `ConfigHelper.load` also requests `/giving/gateways/configured/:churchId` to decide whether to show giving. Decouple this for the excluded giving scope. |
| Login and restore | `POST /membership/users/login` with `{email,password}`, `{jwt}`, or upstream auth-guid/MFA fields; returns `{user,userChurches}` | `hydrateUserSession` configures API JWTs/permissions, chooses matching church, and writes browser-readable `jwt`, name/email and last-church cookies. A safer or different session design must be explicit. |
| Church selection | `POST /membership/churches/select` with `{churchId}` or `{subDomain}`; returns one user church | Existing upstream allows a role-less church membership path. A local synthetic-member login need not imply public registration or membership claiming. |
| Own profile | `GET /membership/people/:personId`, fallback `GET /membership/people/claim/:churchId` | Bind the authenticated person on the server; a caller-supplied ID cannot grant access to another person's profile. |
| Profile edit | `POST /membership/people` with an array `[person]`, nested `name` and `contactInfo`; refreshes via `GET /people/:id` | Self-edit has a different authorization scope from staff editing. Whitelist permitted member fields. |
| Profile approval | Reads `directoryApprovalGroupId` from public settings. If configured, posts `[task]` to `/doing/tasks?type=directoryUpdate`; otherwise saves the person directly | The task's `data` contains proposed changes. This approval workflow is additional behavior, not implied by a working profile form. |
| Household/account | `GET /membership/people/household/:householdId`; `POST /people/familyMember`; account display name/email/password use `/users/setDisplayName`, `/users/updateEmail`, `/users/updatePassword` | Account identity and church contact details are separate. Password recovery/verification and family-member creation require independent acceptance. |
| Directory/privacy | `GET /membership/people`; details `/people/:id`; `/visibilityPreferences/my` and array POST `/visibilityPreferences` | UI gates on `directoryVisibility` and membership status; API must enforce contact visibility. Do not make the administrative people list public. |
| My groups | `GET /membership/groups/my`; detail tries `/groups/:id`, `/groups/public/:churchId/:id`, then `/groups/public/:churchId/slug/:slug` | Public group descriptions and private roster/member data are distinct. |
| Group roster/join | `GET /membership/groupmembers?groupId=...`; join request object POST `/groupjoinrequests`; GET `/groupjoinrequests/my`; cancellation DELETE `/groupjoinrequests/:id`; leaving DELETE `/groupmembers/:id` | Approvals, confidential groups, roster visibility and self-leave limits require server checks. Listing groups does not establish join/leave parity. |
| Calendar | `GET /content/events/timeline`; group calendar `GET /content/events/group/:groupId`; public event `GET /content/events/public/:churchId/:eventId` | Events include `start`, `end`, recurrence rules and exception dates. `EventOccurrences` expands recurring dates through Helpers. Recurrence/timezone parity is separate from a basic event list. |
| RSVP | `GET /content/events/rsvps/group/:groupId?from=...&to=...`; detail `/events/:eventId/rsvps?occurrenceStart=...` | Per-occurrence attendance intent is separate from excluded check-in. Do not claim RSVP support unless implemented and tested. |
| Sermon archive | `GET /content/sermons/public/:churchId` returns an array; client validates `id`/`title` and sorts by `publishDate` descending | Public results must exclude unpublished/restricted content even if a record ID is known. |
| Sermon detail | Uses the public church list to find the ID, then falls back to `GET /content/sermons/:id` | A port should avoid using this fallback to expose drafts or another tenant's content. |
| Series/playlists | `GET /content/playlists/public/:churchId`; series details select by ID and filter public sermons by `playlistId` | Playlist needs `id`, `title`, optional `description`, `thumbnail`, `publishDate`; series renders oldest first. |
| Playback | Sermon fields include `videoType`, `videoData`, `videoUrl`, `thumbnail`, `duration`, `description`, `publishDate`, `playlistId` | Upstream supports YouTube, YouTube channel, Vimeo, Facebook and generic HTTP URLs. R2-hosted media or explicitly safe URLs can be a smaller supported set. |

The upstream member sign-in screen additionally calls `checkEmail`, `register`, `forgot`, `verifyCode`, and `setPasswordGuid`. Those flows can send email or create real accounts and are outside synthetic development unless separately implemented. Group pages additionally request conversations, announcements, files, service plans, booking resources and attendance sessions; the selected member/groups implementation must not silently imply those larger features.

## Host and external-effect assumptions

B1App's `EnvironmentHelper` supports `NEXT_STAGE`/`NEXT_PUBLIC_STAGE=selfhost`: browser API calls use the current origin's `/api`, while server requests use `B1_API_INTERNAL_URL` (default `http://api:8084`). Public URLs use `PUBLIC_URL`. Workers needs its own deployment/routing configuration rather than that Docker container address.

Even in selfhost mode, Lessons and Ask hosts remain ChurchApps-hosted. `Header.tsx` and `StreamingHeader.tsx` construct hardcoded `https://admin.b1.church/login?...#jwt=...` handoffs; these must not receive the fork's tokens. Additional hosted assumptions appear in `siteOrigin.ts` (Ironwood defaults), metadata image fallbacks, preconnect tags, podcast API fallback, content-security-policy allowlists, analytics settings, Sentry, and external video embeds. The new local/PWA path should request only intended local/synthetic resources unless an external provider is explicitly enabled.

Existing check-in, donate, giving statements, registration payment, and their navigation remain upstream baseline code. The user's selected scope excludes check-in and giving; they should not appear as working or planned features in the adaptation's member flow. Disabling only a tab is insufficient if an endpoint still exposes excluded actions.

## B1Mobile is a separate native application

B1Mobile 3.16.1 uses Expo `^55.0.15`, React Native `0.83.4`, Expo Router, native iOS/Android directories, native Firebase, Sentry, secure storage, notifications and Expo updates. Its Helpers dependency is `^1.5.0`, different from the contemporary web client's `^2.15.0`; compatible API names alone do not establish cross-version behavior.

`src/helpers/EnvironmentHelper.ts` reads `Constants.expoConfig.extra.STAGE` but immediately overwrites it with `stage = "prod"`, then applies hardcoded hosted API roots. Although `app.config.js` exposes API environment options, this helper does not consume those URL overrides. Configuration also references the ChurchApps Sentry project, Firebase setup and hosted Expo OTA project. An unchanged native build would continue using upstream services. None of these native build, submission, production update or store-publish scripts were run.

Because the user accepted PWA/mobile web, this native application is a compatibility reference, not a required deliverable. Supporting a native fork later would require endpoint/configuration fixes, separate app identities and notification/update infrastructure, and device tests. The current PWA must be validated in mobile viewport/browser behavior on its own merits.

## Audit verification

Verified by reading pinned source: license/package declarations, Next versus native architecture, route/router mappings, session and profile calls, sermon/playlist shapes, calendar/group requests, manifest/service-worker behavior, and the hardcoded hosts noted above. No B1App/B1Mobile dependency installation, native build, upstream login, live backend request, payment, check-in, external message or deployment was performed. Runtime results for the new Cloudflare implementation belong in its own test report.
