// Behavior + regression tests for the service logic and validators.
// Drives the real built code, stubbing only the network boundary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { SearchConsoleService, RETRY_CONFIG } from '../dist/search-console.js';
import {
  validateDateRange, validateHourlyRange, validateSiteUrl, validateRegex,
  sanitizeForLogging, parseGoogleApiError,
} from '../dist/validators.js';

test('validators: date, hourly, siteUrl', () => {
  validateDateRange('2026-01-01', '2026-03-01');
  assert.throws(() => validateDateRange('2026-03-01', '2026-01-01'));
  assert.throws(() => validateDateRange('2024-01-01', '2026-06-01')); // >16 months
  validateHourlyRange('2026-03-01', '2026-03-10');
  assert.throws(() => validateHourlyRange('2026-03-01', '2026-03-20')); // >10 days
  assert.equal(validateSiteUrl('sc-domain:example.com'), 'sc-domain:example.com');
  assert.throws(() => validateSiteUrl('not a url'));
});

test('sanitizeForLogging redacts secrets and credential paths on any OS', () => {
  assert.match(sanitizeForLogging('key=abc secret=xyz'), /key=\*\*\*/);
  // Regression: macOS/root paths were leaking (only /home was redacted before).
  assert.doesNotMatch(sanitizeForLogging('reading /Users/pavel/secret/credentials.json'), /pavel\/secret/);
  assert.doesNotMatch(sanitizeForLogging('reading /root/keys/sa.json'), /root\/keys/);
});

test('parseGoogleApiError maps status codes to guidance', () => {
  assert.match(parseGoogleApiError({ code: 403, message: 'denied' }).message, /Owner/);
  assert.match(parseGoogleApiError({ code: 503, message: 'down' }).message, /temporarily unavailable/);
});

test('withPermissionFallback preserves error code so 503 stays actionable', async () => {
  const svc = new SearchConsoleService('/tmp/dummy.json', true);
  svc.getClient = async () => ({
    searchanalytics: { query: async () => { const e = new Error('unavailable'); e.code = 503; throw e; } },
  });
  let msg = '';
  try { await svc.searchAnalytics('sc-domain:x', { startDate: '2026-01-01', endDate: '2026-01-10' }); }
  catch (e) { msg = e.message; }
  assert.match(msg, /temporarily unavailable/);
});

test('detectQuickWins picks qualifying rows and computes value', async () => {
  const svc = new SearchConsoleService('/tmp/dummy.json', true);
  svc.searchAnalytics = async () => ({ data: { rows: [
    { keys: ['good', '/p1'], clicks: 10, impressions: 1000, ctr: 0.01, position: 5 },  // qualifies
    { keys: ['hictr', '/p2'], clicks: 90, impressions: 1000, ctr: 0.09, position: 5 }, // ctr too high
    { keys: ['toppos', '/p4'], clicks: 5, impressions: 500, ctr: 0.01, position: 2 },  // position < 4
  ] } });
  const r = await svc.enhancedSearchAnalytics('sc-domain:x', { dimensions: ['query', 'page'], rowLimit: 25000 }, { enableQuickWins: true });
  assert.equal(r.data.quickWins.length, 1);
  assert.equal(r.data.quickWins[0].additionalClicks, 40);
  assert.equal(r.data.quickWins[0].estimatedValue, 41.2);
});

test('comparePeriods computes totals, deltas, and top movers', async () => {
  const svc = new SearchConsoleService('/tmp/dummy.json', true);
  // Key off the request's startDate so both the grouped and the date-grouped
  // totals query for a period return that period's data.
  svc.searchAnalytics = async (_s, body) => {
    const feb = body.startDate === '2026-02-01';
    if (body.dimensions[0] === 'date') {
      return feb
        ? { data: { rows: [{ keys: ['2026-02-01'], clicks: 10, impressions: 100, position: 5 }, { keys: ['2026-02-28'], clicks: 5, impressions: 200, position: 8 }] } }
        : { data: { rows: [{ keys: ['2026-01-01'], clicks: 20, impressions: 120, position: 4 }, { keys: ['2026-01-31'], clicks: 3, impressions: 50, position: 9 }] } };
    }
    return feb
      ? { data: { rows: [{ keys: ['a'], clicks: 10, impressions: 100, ctr: 0.1, position: 5 }, { keys: ['b'], clicks: 5, impressions: 200, ctr: 0.025, position: 8 }] } }
      : { data: { rows: [{ keys: ['a'], clicks: 20, impressions: 120, ctr: 0.167, position: 4 }, { keys: ['c'], clicks: 3, impressions: 50, ctr: 0.06, position: 9 }] } };
  };
  const c = await svc.comparePeriods('sc-domain:x',
    { startDate: '2026-02-01', endDate: '2026-02-28', dimensions: ['query'] },
    { startDate: '2026-01-01', endDate: '2026-01-31', dimensions: ['query'] }, 25);
  assert.equal(c.warnings, undefined); // both periods have data through their end dates
  assert.equal(c.periodA.dataThrough, '2026-02-28');
  assert.equal(c.periodA.totals.clicks, 15);
  assert.equal(c.periodA.totals.position, 7); // impression-weighted
  // Deltas are primary minus comparison: Feb (15) vs Jan (23) is a decline.
  assert.equal(c.delta.clicks.abs, -8);
  assert.equal(c.delta.clicks.pct, -34.8);
  assert.equal(c.delta.position.abs, 1.5); // 7 vs 5.5: numerically worse
  assert.equal(c.topChanges[0].key, 'a');
  assert.equal(c.topChanges[0].clicks.delta, -10);
  assert.equal(c.totalKeys, 3);
});

// Daily rows for [startDate, startDate + days), as the date-grouped totals query returns them.
// Quiet days come back as zero-impression rows (verified live), not as missing rows.
const dailyRows = (startDate, days, { quietLast = false } = {}) => {
  const day0 = new Date(startDate + 'T00:00:00Z');
  return Array.from({ length: days }, (_, i) => ({
    keys: [new Date(day0.getTime() + i * 864e5).toISOString().slice(0, 10)],
    clicks: quietLast && i === days - 1 ? 0 : 10,
    impressions: quietLast && i === days - 1 ? 0 : 100,
    position: 8,
  }));
};
const comparator = (rowsFor, metadataFor = () => undefined) => {
  const svc = new SearchConsoleService('/tmp/dummy.json', true);
  const calls = [];
  svc.searchAnalytics = async (_s, body) => { calls.push(body); return { data: { rows: rowsFor(body), metadata: metadataFor(body) } }; };
  return { svc, calls };
};
const week = (startDate, endDate, extra = {}) => ({ startDate, endDate, dataState: 'final', ...extra });

test('comparePeriods totals queries keep every filter and option, grouped only by date', async () => {
  const extra = { type: 'web', aggregationType: 'byPage', dimensionFilterGroups: [{ filters: [{ dimension: 'country', operator: 'equals', expression: 'deu' }] }] };
  const reqA = week('2026-09-21', '2026-09-27', { ...extra, dimensions: ['query'], rowLimit: 1000 });
  const reqB = week('2026-09-14', '2026-09-20', { ...extra, dimensions: ['query'], rowLimit: 1000 });
  const { svc, calls } = comparator(b => (b.dimensions[0] === 'date' ? dailyRows(b.startDate, 7) : []));
  await svc.comparePeriods('sc-domain:x', reqA, reqB, 25);
  assert.equal(calls.length, 4); // grouped A/B for movers + date-grouped A/B for totals
  assert.deepEqual(calls[0], reqA);
  assert.deepEqual(calls[1], reqB);
  assert.deepEqual(calls[2], { ...reqA, dimensions: ['date'], rowLimit: 25000, startRow: 0 });
  assert.deepEqual(calls[3], { ...reqB, dimensions: ['date'], rowLimit: 25000, startRow: 0 });
});

test('comparePeriods warns when a "final" period is missing its unfinalized last days', async () => {
  // Regression: a "final" week ending yesterday returned only 5 of 7 days, so a
  // flat week was reported as a -40% click drop with no indication why.
  const { svc, calls } = comparator(b => dailyRows(b.startDate, b.startDate === '2026-09-28' ? 5 : 7));
  const c = await svc.comparePeriods('sc-domain:x', week('2026-09-28', '2026-10-04'), week('2026-09-21', '2026-09-27'), 25);
  assert.deepEqual(calls.map(b => b.dimensions), [['date'], ['date']]); // no dimensions: totals queries only
  assert.equal(c.periodA.dataThrough, '2026-10-02');
  assert.equal(c.periodB.dataThrough, '2026-09-27');
  assert.equal(c.delta.clicks.abs, -20);
  assert.equal(c.warnings.length, 1);
  assert.match(c.warnings[0], /^periodA has finalized data only through 2026-10-02 \(5 of 7 requested days\)/);
  assert.match(c.warnings[0], /shift both periods back 2 day\(s\)/);
});

test('comparePeriods does not warn when the last day was merely quiet (zero-impression row)', async () => {
  const { svc } = comparator(b => dailyRows(b.startDate, 7, { quietLast: true }));
  const c = await svc.comparePeriods('sc-domain:x', week('2026-09-21', '2026-09-27'), week('2026-09-14', '2026-09-20'), 25);
  assert.equal(c.periodA.dataThrough, '2026-09-27');
  assert.equal(c.warnings, undefined);
});

test('comparePeriods warns when a period returned no data at all', async () => {
  const { svc } = comparator(b => (b.startDate === '2020-01-01' ? [] : dailyRows(b.startDate, 7)));
  const c = await svc.comparePeriods('sc-domain:x', week('2026-09-21', '2026-09-27'), week('2020-01-01', '2020-01-07'), 25);
  assert.equal(c.periodB.dataThrough, null);
  assert.equal(c.warnings.length, 1);
  assert.match(c.warnings[0], /^periodB returned no data for 2020-01-01\.\.2020-01-07/);
  // Quiet days come back as zero rows, so "no traffic" is not a plausible cause; under
  // "final" the likeliest one is a period entirely inside the unfinalized window.
  assert.match(c.warnings[0], /none of its days are finalized yet/);
  assert.doesNotMatch(c.warnings[0], /no traffic/);
});

test('comparePeriods warns that dataState "all" undercounts days still being collected', async () => {
  // "all" returns rows through today, but the newest days are partial; Google reports
  // where that starts in metadata.firstIncompleteDate (date-grouped queries only).
  const { svc } = comparator(b => dailyRows(b.startDate, 8), b => (b.startDate === '2026-09-28' ? { firstIncompleteDate: '2026-10-04' } : undefined));
  const c = await svc.comparePeriods('sc-domain:x', week('2026-09-28', '2026-10-05', { dataState: 'all' }), week('2026-09-20', '2026-09-27', { dataState: 'all' }), 25);
  assert.equal(c.warnings.length, 1);
  assert.match(c.warnings[0], /^periodA includes 2026-10-04 onward, which Search Console is still collecting \(dataState "all"\)/);
  assert.match(c.warnings[0], /ending before 2026-10-04/);
});

test('comparePeriods groups hourly_all totals by hour (the API rejects date grouping there)', async () => {
  const hours = (date) => Array.from({ length: 3 }, (_, h) => ({ keys: [`${date}T0${h}:00:00-07:00`], clicks: 1, impressions: 10, position: 5 }));
  const { svc, calls } = comparator(b => hours(b.endDate));
  const c = await svc.comparePeriods('sc-domain:x', week('2026-10-04', '2026-10-04', { dataState: 'hourly_all' }), week('2026-10-03', '2026-10-03', { dataState: 'hourly_all' }), 25);
  assert.deepEqual(calls.map(b => b.dimensions), [['hour'], ['hour']]);
  assert.equal(c.periodA.dataThrough, '2026-10-04');
  assert.equal(c.periodA.totals.clicks, 3);
});

test('fetchSitemapUrls discovers via robots.txt and gunzips child sitemaps', async () => {
  const svc = new SearchConsoleService('/tmp/dummy.json', true);
  const gz = gzipSync(Buffer.from('<urlset><url><loc>https://ex.com/g1</loc></url></urlset>'));
  const routes = {
    'https://ex.com/robots.txt': { text: 'User-agent: *\nSitemap: https://ex.com/smindex.xml' },
    'https://ex.com/smindex.xml': { text: '<sitemapindex><sitemap><loc>https://ex.com/s1.xml.gz</loc></sitemap></sitemapindex>' },
    'https://ex.com/s1.xml.gz': { gz },
  };
  globalThis.fetch = async (url) => {
    const r = routes[url];
    if (!r) return { ok: false, text: async () => '', arrayBuffer: async () => Buffer.alloc(0) };
    return { ok: true, text: async () => r.text ?? '', arrayBuffer: async () => r.gz ?? Buffer.alloc(0) };
  };
  const urls = await svc.fetchSitemapUrls('sc-domain:ex.com');
  assert.deepEqual(urls, ['https://ex.com/g1']);
});

test('fetchSitemapUrls aggregates multiple independent sitemaps from robots.txt', async () => {
  const svc = new SearchConsoleService('/tmp/dummy.json', true);
  const routes = {
    'https://ex.com/robots.txt': { text: 'Sitemap: https://ex.com/a.xml\nSitemap: https://ex.com/b.xml' },
    'https://ex.com/a.xml': { text: '<urlset><url><loc>https://ex.com/p1</loc></url></urlset>' },
    'https://ex.com/b.xml': { text: '<urlset><url><loc>https://ex.com/p2</loc></url></urlset>' },
  };
  globalThis.fetch = async (url) => {
    const r = routes[url];
    return r ? { ok: true, text: async () => r.text, arrayBuffer: async () => Buffer.alloc(0) }
             : { ok: false, text: async () => '', arrayBuffer: async () => Buffer.alloc(0) };
  };
  const urls = await svc.fetchSitemapUrls('sc-domain:ex.com');
  assert.deepEqual(urls.sort(), ['https://ex.com/p1', 'https://ex.com/p2']);
});

test('coverageReport matches URLs across www/scheme/trailing-slash differences', async () => {
  const svc = new SearchConsoleService('/tmp/dummy.json', true);
  svc.fetchSitemapUrls = async () => ['https://www.ex.com/a/', 'http://ex.com/b', 'https://ex.com/orphan'];
  svc.searchAnalytics = async () => ({ data: { rows: [
    { keys: ['https://ex.com/a'], clicks: 1, impressions: 10, position: 3 },       // matches /a/ (www + slash)
    { keys: ['https://www.ex.com/b/'], clicks: 2, impressions: 20, position: 4 },  // matches /b (scheme + www + slash)
    { keys: ['https://ex.com/notinsitemap'], clicks: 3, impressions: 30, position: 5 },
  ] } });
  const r = await svc.coverageReport('sc-domain:ex.com', '2026-01-01', '2026-01-10');
  assert.equal(r.overlap, 2);
  assert.equal(r.inSitemapNoImpressions.length, 1);
  assert.equal(r.hasImpressionsNoSitemap.length, 1);
});

test('searchAnalyticsPaginated pages through and respects maxRows', async () => {
  const svc = new SearchConsoleService('/tmp/dummy.json', true);
  const DATASET = 30000;
  svc.searchAnalytics = async (_s, body) => {
    const start = body.startRow ?? 0;
    const n = Math.min(body.rowLimit ?? 1000, Math.max(0, DATASET - start));
    return { data: { rows: Array.from({ length: n }, (_, i) => ({ keys: ['k' + (start + i)] })) } };
  };
  const full = await svc.searchAnalyticsPaginated('sc-domain:x', { dimensions: ['query'] }, 30000);
  assert.equal(full.data.rows.length, 30000);
  assert.equal(full.data.pagesFetched, 2);
  const capped = await svc.searchAnalyticsPaginated('sc-domain:x', { dimensions: ['query'] }, 10000);
  assert.equal(capped.data.rows.length, 10000);
  assert.equal(capped.data.pagesFetched, 1);
});

test('detectCannibalization groups by query and keeps pages above minShare', async () => {
  const svc = new SearchConsoleService('/tmp/dummy.json', true);
  svc.searchAnalytics = async () => ({ data: { rows: [
    { keys: ['shoes', '/a'], clicks: 10, impressions: 600, position: 4 },
    { keys: ['shoes', '/b'], clicks: 5, impressions: 350, position: 7 },
    { keys: ['shoes', '/c'], clicks: 0, impressions: 50, position: 30 },  // 5% share: below 10%
    { keys: ['boots', '/a'], clicks: 3, impressions: 900, position: 2 },
    { keys: ['boots', '/d'], clicks: 0, impressions: 40, position: 40 },  // ~4%: only one page left
    { keys: ['rare', '/a'], clicks: 0, impressions: 20, position: 9 },
    { keys: ['rare', '/b'], clicks: 0, impressions: 20, position: 9 },    // total 40 < minImpressions
  ] } });
  const r = await svc.detectCannibalization('sc-domain:x', { rowLimit: 25000 }, { minImpressions: 50, minShare: 0.1, topN: 50 });
  assert.equal(r.totalCandidates, 1);
  assert.equal(r.queriesAnalyzed, 3);
  assert.equal(r.candidates[0].query, 'shoes');
  assert.equal(r.candidates[0].impressions, 1000);
  assert.deepEqual(r.candidates[0].pages.map(p => [p.page, p.share]), [['/a', 0.6], ['/b', 0.35]]);
  assert.equal(r.warning, undefined);
  const capped = await svc.detectCannibalization('sc-domain:x', { rowLimit: 7 }, { minImpressions: 50, minShare: 0.1, topN: 50 });
  assert.match(capped.warning, /7-row cap/);
});

test('richResultsCheck reports failed URLs instead of silently dropping them', async () => {
  // Regression: errors were swallowed, so a quota or permission failure read as "no rich results".
  const svc = new SearchConsoleService('/tmp/dummy.json', true);
  svc.quotaTracker.getRecommendedInspectionDelay = () => 0;
  svc.indexInspect = async ({ inspectionUrl }) => {
    if (inspectionUrl.endsWith('/bad')) throw Object.assign(new Error('Permission denied'), { code: 403 });
    return { data: { inspectionResult: { inspectionResultLink: 'https://search.google.com/x', richResultsResult: {
      verdict: 'PASS', detectedItems: [{ richResultType: 'FAQ', items: [{ name: 'q' }] }] } } } };
  };
  const r = await svc.richResultsCheck('sc-domain:ex.com', ['https://ex.com/ok', 'https://ex.com/bad'], 20, 'en-US');
  assert.equal(r.totalChecked, 2);
  assert.equal(r.urlsWithRichResults, 1);
  assert.equal(r.results[0].inspectionResultLink, 'https://search.google.com/x');
  assert.deepEqual(r.errors.map(e => e.url), ['https://ex.com/bad']);
});

test('batchInspect stops on a quota error and reports what it skipped', async () => {
  const svc = new SearchConsoleService('/tmp/dummy.json', true);
  svc.quotaTracker.getRecommendedInspectionDelay = () => 0;
  let calls = 0;
  svc.indexInspect = async () => {
    if (++calls === 2) throw parseGoogleApiError({ code: 429, message: 'Quota exceeded' });
    return { data: { inspectionResult: { inspectionResultLink: 'L', indexStatusResult: { verdict: 'FAIL', crawledAs: 'MOBILE', referringUrls: ['https://ex.com/r'] } } } };
  };
  const urls = ['https://ex.com/1', 'https://ex.com/2', 'https://ex.com/3', 'https://ex.com/4'];
  const r = await svc.batchInspect('sc-domain:ex.com', urls, 50, 'en-US');
  assert.equal(calls, 2);
  assert.equal(r.totalInspected, 2);
  assert.equal(r.stoppedEarly.notInspected, 2);
  assert.match(r.stoppedEarly.reason, /quota exceeded/i);
  assert.equal(r.results.fail[0].crawledAs, 'MOBILE');
  assert.equal(r.results.fail[0].inspectionResultLink, 'L');
  assert.deepEqual(r.results.fail[0].referringUrls, ['https://ex.com/r']);
});

test('RETRY_CONFIG makes the read-only POST calls retry a transient 503', async () => {
  // Real client against a local server: the library alone does not retry POSTs.
  const { createServer } = await import('node:http');
  const { searchconsole } = await import('@googleapis/searchconsole');
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    if (hits === 1) { res.writeHead(503).end('{}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"rows":[]}');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const rootUrl = `http://127.0.0.1:${server.address().port}/`;
  const query = (opts) => searchconsole({ version: 'v1', auth: 'test-api-key', rootUrl, ...opts })
    .searchanalytics.query({ siteUrl: 'sc-domain:x', requestBody: { startDate: '2026-01-01', endDate: '2026-01-02' } });
  try {
    await assert.rejects(query({}));   // library default: POST is not retried
    assert.equal(hits, 1);
    hits = 0;
    const resp = await query({ retryConfig: RETRY_CONFIG });
    assert.equal(hits, 2);
    assert.deepEqual(resp.data, { rows: [] });
  } finally {
    server.close();
  }
});

test('validateRegex follows RE2, the dialect Search Console uses', () => {
  // Valid RE2 that JS RegExp rejects: the old JS-based check refused these.
  for (const p of ['(?i)rolex|omega', '(?P<brand>acme)', '\\pL+', '[[:alpha:]]+']) validateRegex(p);
  // Invalid RE2 that Google silently treats as "match nothing" (verified live).
  for (const p of ['(?=a)', '(?!a)', '(?<=a)b', '(a)\\1', '([', 'a++']) {
    assert.throws(() => validateRegex(p), /RE2 syntax/, p);
  }
});

test('searchAnalytics rejects an invalid RE2 filter before calling the API', async () => {
  const svc = new SearchConsoleService('/tmp/dummy.json', true);
  let called = false;
  svc.getClient = async () => ({ searchanalytics: { query: async () => { called = true; return { data: {} }; } } });
  const body = (expression) => ({ startDate: '2026-01-01', endDate: '2026-01-10',
    dimensionFilterGroups: [{ groupType: 'and', filters: [{ dimension: 'query', operator: 'includingRegex', expression }] }] });
  await assert.rejects(svc.searchAnalytics('sc-domain:x.com', body('(?=brand)')), /RE2 syntax/);
  assert.equal(called, false);
  await svc.searchAnalytics('sc-domain:x.com', body('(?i)brand'));
  assert.equal(called, true);
});

test('enhancedSearchAnalytics applies regexFilter even without the query dimension', async () => {
  // Regression: it reported regexFilterApplied: true but skipped the filter unless grouping by query.
  const svc = new SearchConsoleService('/tmp/dummy.json', true);
  let sent;
  svc.searchAnalytics = async (_s, body) => { sent = body; return { data: { rows: [] } }; };
  const r = await svc.enhancedSearchAnalytics('sc-domain:x', { dimensions: ['page'] }, { regexFilter: '(?i)watch' });
  assert.deepEqual(sent.dimensionFilterGroups.at(-1).filters, [{ dimension: 'query', operator: 'includingRegex', expression: '(?i)watch' }]);
  assert.equal(r.data.metadata.regexFilterApplied, true);
});

test('permission fallback is skipped when the siteUrl is already sc-domain', async () => {
  const svc = new SearchConsoleService('/tmp/dummy.json', true);
  const seen = [];
  svc.getClient = async () => ({ searchanalytics: { query: async ({ siteUrl }) => {
    seen.push(siteUrl); throw Object.assign(new Error('User does not have sufficient permission'), { code: 403 });
  } } });
  await assert.rejects(svc.searchAnalytics('sc-domain:x.com', { startDate: '2026-01-01', endDate: '2026-01-02' }), /Permission denied/);
  assert.deepEqual(seen, ['sc-domain:x.com']);
  seen.length = 0;
  await assert.rejects(svc.searchAnalytics('https://x.com/', { startDate: '2026-01-01', endDate: '2026-01-02' }), /Permission denied/);
  assert.deepEqual(seen, ['https://x.com/', 'sc-domain:x.com']);
});
