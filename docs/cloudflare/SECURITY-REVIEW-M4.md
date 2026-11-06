# Milestone 4 focused security review

Reviewed the approval, resource permission, pagination and protected media changes against baseline `84ee98e`. This is a focused source review and local regression exercise, not an audit of the complete ChurchApps suite. All fixtures and files were synthetic. No cloud deployment, external messages or live records were involved.

## Executed verification

The independent suite passed **23/23** with real local workerd, D1 and R2 on 2026-11-06:

| Test file | Passed | Boundaries exercised |
| --- | ---: | --- |
| `cloudflare/test/member-approvals-security.test.mjs` | 7 | Seventeen competing transitions involving reviewer grants/group membership/session/identity, requester household/account state, target household/account linkage/private field changes, and church policy. Failed writes leave person, task, request and audit effects unchanged. Requester logout does not prevent later authorized asynchronous review. |
| `cloudflare/test/resource-permission-race.test.mjs` | 12 | Calendar/event and sermon/playlist source and destination authority, mixed-batch rollback, scoped delegation after deletion/revocation, permission changes during a real R2 put, an uncertain D1 response after the archive-ready transaction committed, and both winner orders of cleanup racing with upload finalization. |
| `cloudflare/test/media-security.test.mjs` | 4 | Account A to B browser context replacement, mismatched bearer/context rejection, missing/duplicate/cross-site cookies, ordinary API cookie rejection, grant-issuance races, and unpublish/church-switch checks before range, HEAD or conditional responses. |

Reproduce from the repository root:

```sh
node --test cloudflare/test/member-approvals-security.test.mjs cloudflare/test/resource-permission-race.test.mjs cloudflare/test/media-security.test.mjs
node cloudflare/node_modules/typescript/bin/tsc --noEmit -p cloudflare/tsconfig.json
```

The Worker typecheck also passed. Race tests insert a competing write after handler preflight and before the actual D1 mutation batch; they do not substitute a mock database. The later malformed-policy regression in `member-approvals.test.mjs` was run separately and passed, covering 18 invalid stored forms and four valid absent/empty forms. Browser behavior and the broader functional suite are recorded separately in [VERIFICATION.md](VERIFICATION.md).

## Findings resolved during review

Per-file media cookies needed a separate active browser context: otherwise a successful sign-in as another account could leave an earlier account's file cookie usable. Completed login now replaces an HttpOnly media session context. Native requests must match that context and the file grant, and an old bearer cannot replace a different current context through grant issuance.

A deterministic failure injection reproduced archive loss after an uncertain D1 response: the ready transaction committed, but unconditional compensation deleted its R2 object. Simple uploads now inspect persisted state before compensation. A confirmed ready archive retains its object; an unreadable outcome retains its private persisted state for reconciliation. The regression verifies bytes and the single upload audit entry survive.

Cleanup also needs a transaction boundary: selecting an old pending row does not authorize deleting an object after that row becomes ready. Cleanup now claims the still-eligible hidden row as deleting before touching R2, while upload finalization checks that its file is still pending. Two deterministic tests verify that a successful ready commit preserves its bytes and that a cleanup winner prevents a success response or publication audit.

The approval owner also removed a hidden-value equality oracle: submitting an unchanged relative's private value must not behave differently from proposing a different value. That fix and its functional regression are described in [MEMBER-APPROVALS.md](MEMBER-APPROVALS.md).

Configuration review found that stored `false`, `0` and `null` policy values were interpreted as disabled review. The parser now treats malformed values, duplicate malformed entries and invalid top-level settings shapes as requiring configuration repair. Only absence or an explicit empty string disables review. The configuration mutation requires current Settings Edit, an unchanged settings/name/timezone snapshot and a currently active group in the same church, all checked in its D1 batch.

## Dependency advisory review — 2026-11-06

Compared the initial and final `yarn npm audit --all --recursive --json` reports with installed package metadata and the primary advisories. The integration owner updated compatible versions with the existing seven-day release age gate and install scripts disabled; this review did not install packages or override parent dependency ranges.

| Measure | Before | After |
| --- | ---: | ---: |
| Yarn report records, including deprecations and repeated advisories for different versions | 125 | 6 |
| Records carrying a GHSA URL | 122 | 3 |
| Distinct GHSA URLs | 108 | 3 |
| Distinct GHSA severity | 2 critical, 45 high, 46 moderate, 15 low | 1 high, 2 moderate |
| Separate deprecation records | 3 | 3 |

Thus 105 distinct reported advisories were removed; this is not a count of demonstrated exploits. The separate Worker `npm audit --prefix cloudflare --json` reported zero advisories across 95 dependency entries. Audit results are a dated database snapshot, not proof that the application has no vulnerabilities.

The final installed versions include Axios **1.21.0**, DOMPurify **3.4.17**, React Router/DOM **7.18.5**, Vite **8.3.5**, tar **7.5.22**, and esbuild **0.28.2**, plus compatible transitive refreshes. DOMPurify's critical report requires template-safe processing with DOM output and an attached shadow root; those settings were not found in the inspected sanitization calls, but the sanitizer was patched regardless. Axios 1.18 alone would not cover the later fetch-adapter report fixed in 1.20.0. tar also needed the later 7.5.21 fix, beyond its earlier critical fix. Sources: [DOMPurify advisory](https://github.com/advisories/GHSA-cg2g-xh64-v4q7), [Axios advisory](https://github.com/advisories/GHSA-vh66-26gq-q6x8), [tar advisory](https://github.com/advisories/GHSA-r292-9mhp-454m).

The remaining actual advisories are:

| Severity and installed package | Observed dependency path and applicability | Fix and remaining constraint |
| --- | --- | --- |
| High: compression 1.8.1 | `serve 14.2.6 → compression`. Prematurely closed compressed responses can leak memory. This affects the inherited `yarn serve` alternative server; the selected built-asset Worker preview does not use it. | Fixed in **1.8.2**; serve pins exactly 1.8.1. Requires a tested parent change or explicit override, neither applied here. [Advisory](https://github.com/advisories/GHSA-vc2v-76pw-4v95). |
| Moderate: glob 13.0.6 | `@sentry/vite-plugin → @sentry/bundler-plugin-core 5.3.0 → glob`. Aborted filesystem walks can continue consuming resources. This is a build-tool path, not a Worker request handler. | Fixed in **14.0.2**; the parent requires `^13.0.6`. Requires a parent update or major-version compatibility work. [Advisory](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4). |
| Moderate: minimatch 10.2.6 | `eslint 10.4.0 → minimatch`. Crafted patterns can amplify processing with `optimizationLevel >= 2`; exposure depends on tooling accepting those inputs/options. | Fixed in **11.0.1**; ESLint requires `^10.2.4`. Requires a parent update or major-version compatibility work. [Advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249). |

The three additional notices concern `copyfiles 2.4.1 → glob 7.2.3 → inflight 1.0.6` (unsupported packages; inflight warns of a memory leak) and `@churchapps/apphelper 1.10.11 → isomorphic-dompurify 3.22.0` (a breaking Node minimum introduced without a major bump). These notices have no GHSA URL in this report and are not counted as three extra vulnerabilities. The latter package's actual engine range is `^22.22.2 || ^24.15.0 || >=26.0.0`; the local verification host is Node **22.22.0**, below that requirement. Prerequisites now declare the required range; successful local checks do not establish compatibility on a supported Node patch. See [VERIFICATION.md](VERIFICATION.md) for final integration results and CI status.

These residuals do not prevent a meaningful synthetic, loopback-only preview served by the Worker, with the runtime updates above. They do leave developer/build inputs and the inherited alternative server requiring follow-up. Do not infer production readiness or expose `serve` to untrusted traffic from this review. Package absence from this final audit does not establish that every reachable use has been assessed.

## Deliberate boundaries and remaining limits

The upstream generic directory-task payload and separate People-save/Task-close flow are not copied into the new approval path. Server-validated fields, immutable account links, relevant-field snapshots and atomic person/request/task/audit updates are intentional safety differences. Review-group membership alone does not grant People Edit.

Resource mutations recheck current authority and source/destination snapshots in the mutation batch. D1 and R2 do not share a transaction; upload publication therefore needs persisted state and reconciliation. Production R2/D1 outage behavior, throughput and cleanup operations still need operational validation.

Media authorization is rechecked for each new native request. Revocation cannot retract bytes already delivered or buffered by a client. Church switching revokes existing media grants; previously issued bearer tokens retain their existing authorized church membership semantics and can explicitly request fresh grants. Browser and service-worker cache behavior must remain part of deployment verification.

Pagination applies tenant, consent, membership and publication filters before paging. It uses bounded offsets rather than a consistent multi-request snapshot, so concurrent legitimate edits can change page boundaries. Stored approval snapshots need an operational retention policy before real records are introduced.
