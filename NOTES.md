# Maintenance Notes

Maintainer-facing rationale for non-obvious dependency and API decisions.

## Dependency stack (2026-10-23, v0.8.0)

The second overhaul cleared all 41 OSV-Scanner findings (9 transitive packages,
1 critical), cutting the install from 222 packages to 71 and `node_modules` from
284 MB to 62 MB. Most findings came from the HTTP/OAuth stack of
`@modelcontextprotocol/sdk` v1 (express, hono, proxy-addr, qs, ip-address,
fast-uri), which a stdio server never uses. The rest came from a stale
`gaxios` → `rimraf` → `brace-expansion` chain and `shx`'s `braces`.

| Package | Version | Note |
|---------|---------|------|
| `@modelcontextprotocol/server` | `^2.3.1` | SDK v2, the current stable line, which supports the 2026-07-28 spec. Depends only on `zod` and `@modelcontextprotocol/core`. v1 (`@modelcontextprotocol/sdk`) is maintenance-only: fixes until at least 2027-01-27, no 2026-07-28 spec. |
| `@googleapis/searchconsole` | `^11.0.1` | The per-API client: same generated `searchconsole_v1` surface as `googleapis`, 259 KB instead of 246 MB. Brings `googleapis-common@9` → `google-auth-library@11` (range deps, a single copy). |
| `zod` | `^4.6.7` | v2 SDK requires `^4.2.0`. |
| `re2js` | `^2.8.6` | Validates regex filters as RE2, the dialect Search Console uses (see the live test section below). A pure-JS port of RE2: no dependencies, MIT. Pinned to 2.8.6, the newest release at least two weeks old on 2026-10-23. ncu offering 2.9.0 is expected until it ages. |
| `typescript` | `^7.0.2` | The native (Go) compiler, GA 2026-07-08. No tsconfig changes were needed. `tsc --watch` works. |
| `@types/node` | `^24.19.2` | Kept on the minimum supported runtime (Node 24), not the latest, so we don't type against APIs that Node 24 lacks. Bump it together with `engines.node`. |
| `engines.node` | `>=24` | The server runs locally under fnm's pinned Node 24 (the only Node installed; Claude Code and Codex launch it as a bare `node`), so Node 22 support bought nothing. Node 24 is Maintenance LTS until 2028-04-30, and Node 26 becomes Active LTS on 2026-10-28. Tests and an end-to-end client run pass on 24.22.1 and 26.12.1. |

Removed in this pass:

| Removed | Why |
|---------|-----|
| `googleapis` | Replaced by `@googleapis/searchconsole` (only Search Console is used). |
| `google-auth-library` (direct) | Only two types came from it. `GoogleAuth` now comes from `@googleapis/searchconsole`'s `auth`, and passing it straight to the client lets it lazily load and cache the credential, so the hand-rolled `AuthClient` cache went too. |
| `@modelcontextprotocol/sdk` | Replaced by `@modelcontextprotocol/server` (v2). |
| `tsx` | Never referenced by any script or doc. |
| `shx` | Only ran `chmod +x`, now a `node -e` one-liner in `build`. |
| `google-auth-library` override (`$google-auth-library`) | Existed only because `googleapis-common@8` pinned an exact auth version. v9 uses a `^11` range, so the tree dedupes on its own. |

## MCP SDK v2 migration (2026-10-23)

The server moved from the low-level `Server` (deprecated in v2 for anything but
advanced use) to `McpServer.registerTool`. Behavior differences, checked
end to end with both a v1 and a v2 client:

- Tool errors now come back as `isError: true` results the model can read, per the
  MCP spec. Before, they were JSON-RPC `-32603` errors. An unknown tool name is
  `-32602`.
- Schemas are `z.strictObject`, so the server rejects unknown arguments itself.
  Before, `z.object` silently stripped them: a misspelled `pageFiltr` ran the
  query unfiltered. Only clients that validated against the advertised schema
  caught it. The migration itself left the `tools/list` output byte-identical to v0.7.0 (checked before the later additions).
- Errors are logged to stderr. MCP logging notifications (`sendLoggingMessage`
  and the `logging` capability) are deprecated by the 2026-07-28 spec (SEP-2577),
  which prescribes stderr for stdio servers.
- Replaced zod 4 deprecations: `.merge()` → `.extend(x.shape)`, `z.string().url()` → `z.url()`.

## Why the `overrides` block exists

`package.json` has one override. It's load-bearing; don't remove it
without understanding the consequence.

### `buffer-equal-constant-time` (local fork in `patches/`)

The upstream package (last published 2013, v1.0.1) references `SlowBuffer` from
the `buffer` module at require-time. `SlowBuffer` is removed in Node 25/26 and
only deprecated in Node 24, so on those newer runtimes the original crashes at
import before any function runs. It reaches us transitively through
`google-auth-library` → `jws` → `jwa` → `buffer-equal-constant-time` (JWT signing
for service-account auth). The fork uses `crypto.timingSafeEqual` and works on
every Node version.

- Not strictly required on Node 22/24, where `SlowBuffer` is still present, but
  required on Node 26, which becomes Active LTS on 2026-10-28.
- Still needed as of 2026-10-23: `jwa@2.0.1`, the latest release, still depends on it
  (via `google-auth-library@11` → `jws@4`). It can be dropped once `jwa` stops depending
  on the unmaintained package. Check `npm ls buffer-equal-constant-time` after future
  `@googleapis/searchconsole` bumps.

## Removed dependency (2026-07-04)

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

Review follow-ups (same release): `dataState: "all"` includes partial recent days and
was never flagged, which an LLM could reach by "fixing" the final-lag warning; it now
warns when the totals query's `metadata.firstIncompleteDate` falls inside a period
(free, since that query is date-grouped). Warnings name the actual cause, give the
observed day count and say how far to shift both periods; an empty period is flagged.
Verified live: quiet days return zero-impression rows (no false positives), and totals
match the old dimensionless query to the decimal with page, country and query filters,
`byPage` and Discover. `hourly_all` failed on every call before (the API accepts only
hour grouping there); totals now group by hour for it.

## GSC API re-audit and additions (2026-10-23)

Re-checked the live discovery doc (revision 20261021) and Google's announcements
since January 2025. Hourly data (April 2025) is the only API addition, and it is
already supported. Branded/non-branded queries, AI Overviews / AI Mode data, query
groups and Search Console Insights exist only in the web interface; none has an
API field, dimension or endpoint. Every method and enum is either covered or left
out on purpose (sites add/delete, the retired mobile-friendly test).

**Fixes**

- Retries. The client library retries 408/429/5xx (3 tries) and network failures
  (2 tries) with exponential backoff, but only for GET/HEAD/PUT/OPTIONS/DELETE, so the two
  workhorse calls (`searchanalytics.query`, `urlInspection.index.inspect`, both
  POST) were never retried. `RETRY_CONFIG` adds POST; both calls only read.
  The test proves it against a local HTTP server returning one 503.
- `rich_results_check` swallowed every error (`catch { /* skip */ }`), so a quota
  or permission failure read as "no rich results". Failures now go to `errors`.
- `batch_inspect` and `rich_results_check` share one loop (`inspectEach`). A 429
  that survives the retries stops the run and reports `stoppedEarly` with the
  number of skipped URLs, instead of spending ~5 s of backoff on each remaining URL.
  `parseGoogleApiError` keeps the HTTP status as `code` so the loop can tell.
- `list_sites` failures now get the shared error guidance.

**Additions**

- MCP tool annotations: `readOnlyHint` on every read, `destructiveHint` on
  `delete_sitemap`, and `idempotentHint` on both sitemap writes.
- A `filters` array on the analytics tools (any number of AND-ed filters, each with
  its own operator). The API accepts every operator on every filterable dimension.
  The old code comment said country/device/searchAppearance were `equals`-only,
  which is not documented. Verified live: `page contains`/`notContains` and
  `country notEquals` filter correctly.
- `detect_cannibalization`: one query+page request (up to 25k rows). It returns
  queries where two or more pages each hold at least `minShare` of the impressions,
  with a warning when the row cap truncates the long tail.
- `batch_inspect` adds `inspectionResultLink` (a deep link to the URL's report in
  the Search Console UI) and `crawledAs`, plus `sitemap` and `referringUrls` for
  failing URLs. `rich_results_check` adds the link too.

**Live test of every tool (same day).** A scripted suite of 99 checks ran against a real property through a v2 client, on Node 24 and 26. It covers every tool, dimension, search type, aggregation type, data state, filter operator, validation error and permission path, plus a throwaway sitemap submit and delete (the sitemap list was confirmed unchanged afterwards). It found four problems, now fixed with regression tests:

- Google treats an invalid RE2 pattern (lookarounds, backreferences, unbalanced
  brackets, possessive quantifiers) as "match nothing" and returns zero rows, not
  an error, so the tools reported zero traffic as fact. Every regex filter is now
  validated with `re2js` before the call. The old check used JS `RegExp`, which
  also wrongly rejected valid RE2: `(?i)` (case-insensitive, the common Search
  Console idiom) and `(?P<name>...)`.
- `enhanced_search_analytics` silently skipped `regexFilter` unless grouping by
  query, while reporting `regexFilterApplied: true`. The API filters on query
  regardless, so the filter now always applies.
- The sc-domain permission fallback re-sent the identical request when the siteUrl
  was already `sc-domain:` form. It now retries only when normalizing changes the URL.
- Aggregation errors got generic guidance. The 400 guidance and the
  `aggregationType` description now say that `byProperty` can't be used with page,
  and that `byNewsShowcasePanel` needs type `discover` or `googleNews` with a
  `NEWS_SHOWCASE` search-appearance filter (both verified live).

**PR review (same day).** An independent review of the release PR found these, all fixed with tests:

- The sc-domain fallback also ran for sitemap submit and delete. A 403 on
  `https://www.example.com/` re-sent the DELETE to `sc-domain:www.example.com`
  and reported success, so a write could change a property the caller never
  named. Writes no longer fall back. Reads fall back only from a root URL-prefix
  property, because `https://x.com/blog/` falling back to `sc-domain:x.com`
  silently widened the data to the whole domain. When the fallback fails too,
  the error for the URL the caller named is reported, not the fallback's.
- `QuotaTracker` was one process-wide counter labelled "per site". It is now keyed
  by siteUrl, so batches on different properties no longer share a budget or slow
  each other down. `get_quota_status` now returns `{ sites: { <siteUrl>: … } }`.
- `compare_periods` didn't flag a period whose data starts after its `startDate`
  (past the 16-month retention, or before the property had data). It now warns.
- An inverted quick-wins position range (min > max) passed validation and returned
  an empty "complete" result. It is now rejected.
- The quota-stop test now drives a gaxios-shaped 429 through the real client path.

Observed during that re-test: near the 16-month retention edge the API isn't
deterministic. The same date-grouped query for June 2025 returned 21 days
(from 2025-06-10) on every call in one server process, and 0 days on every call
in another, minutes apart. It looks like it depends on which backend the
connection lands on. Both outcomes are flagged by `compare_periods` (late-start
or no-data warning), so no code change; just don't treat retention-edge numbers
as stable.

**Considered and skipped**: `outputSchema`/`structuredContent` (LLM clients read
the text block anyway) and MCP prompts or resources (no workflow needs them yet).

## Future work (deferred, not done in this pass)

- [ ] Fuller test coverage (validators, quota-tracker, quick-wins math). A boot plus `tools/list` smoke test already lives at `test/smoke.test.mjs` (`npm test`).
- [ ] `CHANGELOG.md` and semver discipline.
- [ ] CI (GitHub Actions: build, test, `osv-scanner`).
- [ ] Dependabot or renovate for ongoing vulnerability monitoring.
- [ ] Sitemap fetching follows whatever URLs a site's `robots.txt` and sitemap index list, including private or internal hosts. That's low risk for a local tool pointed at your own properties, but if this server ever runs shared or remotely, restrict fetches to the property's host.
- [ ] Sitemap fetching (`fetchText`) sends a spoofed Googlebot `User-Agent`. Sites that verify Googlebot by reverse DNS may block it, and it misrepresents the client. Consider an honest UA such as `mcp-server-gsc/<version>`. Left as is because it changes which sitemaps some sites serve.
