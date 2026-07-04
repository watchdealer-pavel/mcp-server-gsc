// Behavior + regression tests for the service logic and validators.
// Drives the real built code, stubbing only the network boundary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { SearchConsoleService } from '../dist/search-console.js';
import {
  validateDateRange, validateHourlyRange, validateSiteUrl,
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
  // Key off the request's startDate so both the grouped and the dimensionless
  // totals query for a period return that period's data.
  svc.searchAnalytics = async (_s, body) => {
    return body.startDate === '2026-02-01'
      ? { data: { rows: [{ keys: ['a'], clicks: 10, impressions: 100, ctr: 0.1, position: 5 }, { keys: ['b'], clicks: 5, impressions: 200, ctr: 0.025, position: 8 }] } }
      : { data: { rows: [{ keys: ['a'], clicks: 20, impressions: 120, ctr: 0.167, position: 4 }, { keys: ['c'], clicks: 3, impressions: 50, ctr: 0.06, position: 9 }] } };
  };
  const c = await svc.comparePeriods('sc-domain:x',
    { startDate: '2026-02-01', endDate: '2026-02-28', dimensions: ['query'] },
    { startDate: '2026-01-01', endDate: '2026-01-31', dimensions: ['query'] }, 25);
  assert.equal(c.periodA.totals.clicks, 15);
  assert.equal(c.periodA.totals.position, 7); // impression-weighted
  assert.equal(c.delta.clicks.abs, 8);
  assert.equal(c.delta.clicks.pct, 53.3);
  assert.equal(c.topChanges[0].key, 'a');
  assert.equal(c.totalKeys, 3);
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
