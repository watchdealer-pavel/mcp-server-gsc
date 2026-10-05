# Maintenance Notes

Maintainer-facing rationale for non-obvious dependency and API decisions.

## Dependency overhaul (2026-07-04)

Bumped the stack to supported, LTS-appropriate versions and cleared all 30
OSV-Scanner findings. Every one was a stale transitive dependency, not a direct one.

| Package | Version | Note |
|---------|---------|------|
| `@modelcontextprotocol/sdk` | `^1.29.0` | v1 line (v2 is a separate beta for the 2026-07-28 spec). |
| `google-auth-library` | `^10.9.0` | See the override note below. |
| `googleapis` | `^173.0.0` | Discovery-doc regeneration; the `searchconsole_v1`/`webmasters_v3` surfaces are unchanged. |
| `zod` | `^4.4.3` | |
| `typescript` | `^6.0.3` | GA bridge release before the Go-based TS 7.0. Needs `types: ["node"]` in tsconfig (6.0 defaults `types` to `[]`). |
| `@types/node` | `^22` | Pinned to the minimum supported runtime (Node 22), not the latest, to avoid typing against APIs missing on Node 22. Do not bump it to match the dev machine's Node 24/26. |
| `engines.node` | `>=22` | Node 20 went EOL 2026-04-30. Node 22 is Maintenance LTS, Node 24 is Active LTS. |

## Why the `overrides` block exists

`package.json` has two overrides. Both are load-bearing; don't remove either
without understanding the consequence.

### `buffer-equal-constant-time` (local fork in `patches/`)

The upstream package (last published 2013, v1.0.1) references `SlowBuffer` from
the `buffer` module at require-time. `SlowBuffer` is removed in Node 25/26 and
only deprecated in Node 24, so on those newer runtimes the original crashes at
import before any function runs. It reaches us transitively through
`google-auth-library` → `jws` → `jwa` → `buffer-equal-constant-time` (JWT signing
for service-account auth). The fork uses `crypto.timingSafeEqual` and works on
every Node version.

- Not strictly required on Node 22/24 LTS, where `SlowBuffer` is still present,
  but a harmless forward-compatibility guard for the Node 26 LTS line.
- Can be dropped once `jwa` stops depending on the unmaintained package. Check
  `npm ls buffer-equal-constant-time` after future `google-auth-library` bumps.

### `google-auth-library` (pinned to `$google-auth-library`)

`googleapis-common@8.x` (pulled in by `googleapis@173`) pins `google-auth-library`
to an exact version (`10.5.0`) that differs from our direct `^10.9.0`. Without the
override, npm installs two copies, and their `GoogleAuth`/`AuthClient` classes
become nominally different types, so `tsc` fails with a `#private` mismatch in
`src/search-console.ts`. The override forces the whole tree onto our direct
version (a compatible same-major bump), collapsing it to a single copy.

- Re-check after any `googleapis` bump: if a future `googleapis-common` needs a
  `google-auth-library` newer than our direct dep, raise the direct dep to match.

## Removed dependency

`@google-cloud/local-auth` was declared but never imported. The server
authenticates only via service account (`GoogleAuth` plus a key file from
`GOOGLE_APPLICATION_CREDENTIALS`), and the package also pulled in a conflicting
`google-auth-library@^9` subtree. Re-add it only if an interactive OAuth flow is
ever implemented.

## GSC API audit (2026-07-04)

Audited the server against the current Search Console API, using the v1 discovery
doc and the official usage-limits page as the source of truth. Result: v0.5.0.

**Corrected bugs**

- The quota model was wrong. Search Analytics is 1,200 QPM per site (per minute),
  not 1,200 per day as the old tracker assumed. URL Inspection is 600 QPM plus
  2,000 QPD per site, and the daily cap was never tracked. `quota-tracker.ts` and
  the 429 guidance in `validators.ts` now use the real numbers.
- Hourly data was unreachable. The `hour` dimension was in the schema, but
  `dataState` lacked the `hourly_all` value it has to pair with. Added, with the
  range validated to 10 days or less (`validateHourlyRange`), and
  `metadata.firstIncompleteHour` surfaced in the enhanced response.

**Added capabilities**

- `search_analytics_all` pages `startRow` past the 25k-per-request cap, up to ~50k per day per search type.
- `compare_periods` diffs two date ranges: totals, deltas, and per-key top movers.
- `get_quota_status` exposes the tracker's current usage.
- A `searchAppearance` filter in `buildFilterGroups`.

**Client consolidation**

Moved every call from the legacy `webmasters` v3 namespace to `searchconsole` v1,
which is a superset (searchanalytics, sitemaps, sites, urlinspection). One client,
the canonical namespace, and `searchType` exists in v1 so the request shape did
not change.

**Deliberately not added (deprecated or out of scope)**

- `urlTestingTools.mobileFriendlyTest`: the Mobile-Friendly Test was retired in December 2023 and the API now errors.
- `mobileUsabilityResult` parsing: the Mobile Usability report was retired in December 2023 and the field returns nothing.
- Sites `add`/`get`/`delete`: kept out of scope to avoid an agent mutating GSC property membership.

**Verified valid, left as-is**

- `aggregationType: byNewsShowcasePanel` is a real enum (`BY_NEWS_SHOWCASE_PANEL`) in the discovery doc.
- Search types `discover`/`googleNews` and the `searchAppearance` dimension were already present and correct.

## Live audit and bug fixes (2026-07-04)

Tested every tool against real Search Console data and fixed what the audit found.

**Bugs fixed**

- `sanitizeForLogging` only redacted `/home/` paths, so macOS `/Users/...` and
  `/root/...` credential paths leaked into error logs. Now redacts any absolute
  path to a `.json`/`.key`/`.pem`/`.p12` file.
- `withPermissionFallback` wrapped non-permission API errors in a new `Error`,
  dropping `.code`, so 500/503 lost their actionable guidance. It now retries,
  then routes every failure through `parseGoogleApiError`, so all tools get the
  same friendly messages.
- `compare_periods` totals were badly understated with dimensions set (summing
  grouped rows hits the rowLimit cap and misses anonymized queries). Live example:
  it reported 14,582 impressions for a period whose true total was 95,986. It now
  fetches a separate dimensionless total per period; the grouped query is used
  only for per-key movers.

**Improvements**

- `fetchSitemapUrls` discovers sitemaps from `robots.txt`, handles gzipped
  (`.xml.gz`) sitemaps, and follows a sitemap index by fetching children
  concurrently with a cap (`MAX_CHILD_SITEMAPS`, 50) instead of one slow
  sequential pass.
- `coverage_report` matches sitemap and analytics URLs on a normalized key
  (scheme, www, case, and trailing slash insensitive), so it stops reporting
  false orphaned/missing pages.
- `index_inspect` gained the sc-domain permission fallback that `search_analytics`
  already had.
- Dropped the ineffective ReDoS heuristic in `validateRegex` (the pattern is
  forwarded to Google and only compiled here, never executed against input).
- Silenced the false "Large rowLimit" warning that fired on every
  `detect_quick_wins` call. Made the 16-month date check UTC-safe and day-based.

Regression guards for all of the above live in `test/behavior.test.mjs`.

## compare_periods: truncated "final" periods (2026-10-05)

A weekly report compared 28 Sep–4 Oct against 21–27 Sep with `dataState: "final"`
and showed -40% clicks. Finalized data stopped at 2 Oct, so the primary period held
5 days against 7. Per day, impressions were flat. Google documents
`metadata.firstIncompleteDate` only for `dataState: "all"` grouped by date, so a
`final` request gets no signal that it was cut short.

Totals now come from a date-grouped query per period instead of a dimensionless
one. The sum is the same and position is impression-weighted, which matched the
API's own figure on live data (8.8 both ways). Each period reports `dataThrough`.
The response carries `warnings` when a period has no data after a date before its
`endDate`. The API call count is unchanged: 2 calls without dimensions, 4 with.

## Future work (deferred, not done in this pass)

- [ ] Fuller test coverage (validators, quota-tracker, quick-wins math). A boot plus `tools/list` smoke test already lives at `test/smoke.test.mjs` (`npm test`).
- [ ] `CHANGELOG.md` and semver discipline.
- [ ] CI (GitHub Actions: build, test, `osv-scanner`).
- [ ] Dependabot or renovate for ongoing vulnerability monitoring.
- [ ] Retry and backoff for transient API failures (503, network errors).
