import { gunzipSync } from 'node:zlib';
import { google, searchconsole_v1 } from 'googleapis';
import { GoogleAuth, AuthClient } from 'google-auth-library';
import { QuickWinsThresholds } from './schemas.js';
import { validateDateRange, validateHourlyRange, validateSiteUrl, validateRegex, validateArrayLength, parseGoogleApiError } from './validators.js';
import { QuotaTracker } from './quota-tracker.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Row data from Search Analytics API response
 */
export interface SearchAnalyticsRow {
  keys?: string[];
  clicks?: number;
  impressions?: number;
  ctr?: number;
  position?: number;
}

/**
 * Quick win opportunity identified from search data
 */
export interface QuickWin {
  query: string;
  page: string;
  currentPosition: number;
  impressions: number;
  currentClicks: number;
  currentCtr: number;
  potentialClicks: number;
  additionalClicks: number;
  estimatedValue: number;
  opportunity: 'High' | 'Medium' | 'Low';
  recommendation: string;
}

/**
 * Enhanced search analytics response with quick wins
 */
export interface EnhancedSearchAnalyticsResponse {
  rows?: SearchAnalyticsRow[];
  responseAggregationType?: string;
  quickWins?: QuickWin[];
  metadata?: {
    regexFilterApplied: boolean;
    quickWinsEnabled: boolean;
    rowLimit: number;
    totalRows: number;
  };
  /**
   * Data-freshness metadata returned by the API. `firstIncompleteHour` is
   * populated for hourly queries (dataState "hourly_all"); `firstIncompleteDate`
   * for daily queries with dataState "all". Values after these points may still change.
   */
  apiMetadata?: {
    firstIncompleteDate?: string | null;
    firstIncompleteHour?: string | null;
  };
}

/**
 * Options for enhanced search analytics
 */
export interface EnhancedSearchAnalyticsOptions {
  regexFilter?: string;
  enableQuickWins?: boolean;
  quickWinsThresholds?: Partial<QuickWinsThresholds>;
}

/** Aggregated totals for a period */
export interface PeriodTotals {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/** Result of comparing two date ranges */
export interface PeriodComparison {
  /** dataThrough: last date with data in the period (null if none) */
  periodA: { startDate: string | null; endDate: string | null; dataThrough: string | null; totals: PeriodTotals };
  periodB: { startDate: string | null; endDate: string | null; dataThrough: string | null; totals: PeriodTotals };
  /** Present when a period has no data for its final days, so the comparison is uneven */
  warnings?: string[];
  delta: {
    clicks: { abs: number; pct: number | null };
    impressions: { abs: number; pct: number | null };
    ctr: { abs: number };
    position: { abs: number };
  };
  totalKeys?: number;
  topChanges?: Array<{
    key: string;
    clicks: { a: number; b: number; delta: number };
    impressions: { a: number; b: number; delta: number };
    position: { a: number | null; b: number | null; delta: number | null };
  }>;
}

type SearchAnalyticsQueryRequest = searchconsole_v1.Params$Resource$Searchanalytics$Query['requestBody'];
type ListSitemapsRequest = searchconsole_v1.Params$Resource$Sitemaps$List;
type GetSitemapRequest = searchconsole_v1.Params$Resource$Sitemaps$Get;
type SubmitSitemapRequest = searchconsole_v1.Params$Resource$Sitemaps$Submit;
type DeleteSitemapRequest = searchconsole_v1.Params$Resource$Sitemaps$Delete;
type IndexInspectRequest = searchconsole_v1.Params$Resource$Urlinspection$Index$Inspect['requestBody'];

// ============================================================================
// Service Class
// ============================================================================

/**
 * Service for interacting with Google Search Console API
 *
 * Features:
 * - Caches auth client for performance
 * - Supports both readonly and write operations
 * - Automatic URL normalization with fallback
 * - Quick wins detection algorithm
 *
 * @see https://developers.google.com/webmaster-tools/v1/api_reference_index
 */
export class SearchConsoleService {
  private auth: GoogleAuth;
  private cachedAuthClient: AuthClient | null = null;
  private readonly hasWriteAccess: boolean;
  private quotaTracker: QuotaTracker;

  /**
   * Creates a new SearchConsoleService instance
   *
   * @param credentials - Path to the service account JSON key file
   * @param writeAccess - If true, uses full webmasters scope; otherwise readonly
   */
  constructor(credentials: string, writeAccess: boolean = true) {
    this.hasWriteAccess = writeAccess;
    this.quotaTracker = new QuotaTracker();

    // Use full scope if write access is needed, otherwise readonly
    // @see https://developers.google.com/webmaster-tools/v1/how-tos/authorizing
    const scopes = writeAccess
      ? ['https://www.googleapis.com/auth/webmasters']
      : ['https://www.googleapis.com/auth/webmasters.readonly'];

    this.auth = new google.auth.GoogleAuth({
      keyFile: credentials,
      scopes,
    });
  }

  /**
   * Gets cached auth client or creates new one
   */
  private async getAuthClient(): Promise<AuthClient> {
    if (!this.cachedAuthClient) {
      this.cachedAuthClient = await this.auth.getClient() as AuthClient;
    }
    return this.cachedAuthClient;
  }

  /**
   * Gets the Search Console v1 API client.
   *
   * v1 (`searchconsole`) is the canonical namespace and a superset: it exposes
   * searchanalytics, sitemaps, sites, and urlInspection — so a single client
   * covers every call this service makes (the legacy `webmasters` v3 namespace
   * is no longer needed).
   */
  private async getClient(): Promise<searchconsole_v1.Searchconsole> {
    const authClient = await this.getAuthClient();
    return google.searchconsole({
      version: 'v1',
      auth: authClient,
    } as searchconsole_v1.Options);
  }

  /**
   * Normalizes URL to sc-domain format for fallback
   * Handles both regular URLs and existing sc-domain format
   */
  private normalizeUrl(url: string): string {
    // Already in sc-domain format
    if (url.startsWith('sc-domain:')) {
      return url;
    }

    try {
      const parsedUrl = new URL(url);
      return `sc-domain:${parsedUrl.hostname}`;
    } catch {
      // If URL parsing fails, assume it's a domain and prefix with sc-domain
      return `sc-domain:${url.replace(/^https?:\/\//, '').split('/')[0]}`;
    }
  }

  /**
   * Wraps an operation with an automatic retry against the normalized sc-domain
   * URL on permission errors, and converts any failure into an actionable error
   * via parseGoogleApiError. This is the single error-handling path for every
   * API call in this service, so callers do not need their own try/catch.
   */
  private async withPermissionFallback<T>(
    operation: () => Promise<T>,
    fallbackOperation: () => Promise<T>,
    context: string,
  ): Promise<T> {
    try {
      return await operation();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message.toLowerCase() : '';

      if (errorMessage.includes('permission') || errorMessage.includes('403')) {
        console.error(`[GSC] Permission error in ${context}, trying normalized URL...`);
        try {
          return await fallbackOperation();
        } catch (fallbackErr) {
          throw parseGoogleApiError(fallbackErr);
        }
      }

      throw parseGoogleApiError(err);
    }
  }

  // ==========================================================================
  // Search Analytics
  // ==========================================================================

  /**
   * Queries search analytics data
   * @see https://developers.google.com/webmaster-tools/v1/searchanalytics/query
   */
  async searchAnalytics(siteUrl: string, requestBody: SearchAnalyticsQueryRequest) {
    validateSiteUrl(siteUrl);
    if (requestBody?.startDate && requestBody?.endDate) {
      validateDateRange(requestBody.startDate, requestBody.endDate);
      // Hourly data (dataState "hourly_all") is limited to the last 10 days.
      if (requestBody.dataState === 'hourly_all') {
        validateHourlyRange(requestBody.startDate, requestBody.endDate);
      }
    }

    const quotaWarning = this.quotaTracker.recordSearchAnalytics();
    if (quotaWarning) {
      console.error(quotaWarning);
    }
    
    const webmasters = await this.getClient();

    return this.withPermissionFallback(
      () => webmasters.searchanalytics.query({ siteUrl, requestBody }),
      () => webmasters.searchanalytics.query({
        siteUrl: this.normalizeUrl(siteUrl),
        requestBody,
      }),
      'searchAnalytics',
    );
  }

  /**
   * Returns current API quota usage (per-minute / per-day, per site).
   */
  getQuotaStatus() {
    return this.quotaTracker.getStatus();
  }

  /**
   * Fetches search analytics rows beyond the 25,000-per-request cap by paginating
   * `startRow`, up to `maxRows`. Bounded in practice by the API's ~50,000
   * rows/day/searchType data cap.
   */
  async searchAnalyticsPaginated(
    siteUrl: string,
    requestBody: SearchAnalyticsQueryRequest,
    maxRows: number,
  ): Promise<{ data: { rows: SearchAnalyticsRow[]; totalRows: number; pagesFetched: number; reachedEnd: boolean } }> {
    const PAGE = 25000;
    const all: SearchAnalyticsRow[] = [];
    let startRow = 0;
    let pagesFetched = 0;
    let reachedEnd = false;

    while (all.length < maxRows) {
      const pageLimit = Math.min(PAGE, maxRows - all.length);
      const resp = await this.searchAnalytics(siteUrl, { ...requestBody, rowLimit: pageLimit, startRow });
      const rows = (resp.data.rows || []) as SearchAnalyticsRow[];
      pagesFetched++;
      all.push(...rows);
      if (rows.length < pageLimit) { reachedEnd = true; break; }
      startRow += rows.length;
    }

    return { data: { rows: all.slice(0, maxRows), totalRows: Math.min(all.length, maxRows), pagesFetched, reachedEnd } };
  }

  /**
   * Compares two date ranges: per-period totals plus deltas, and — when
   * dimensions are supplied — per-key differences for the biggest movers.
   *
   * Totals come from a separate date-grouped query per period (hour-grouped
   * for dataState "hourly_all", the only grouping the API accepts there).
   * Summing the caller's dimension rows would understate them badly, because a
   * grouped query is capped at rowLimit and GSC omits anonymized long-tail
   * queries entirely. Grouping by date gives the same totals and shows which
   * days have data: each period reports `dataThrough`, and `warnings` flags a
   * period whose totals are not comparable (unfinalized days missing under
   * "final", partial days included under "all", or no data at all).
   */
  async comparePeriods(
    siteUrl: string,
    requestBodyA: SearchAnalyticsQueryRequest,
    requestBodyB: SearchAnalyticsQueryRequest,
    topN: number = 25,
  ): Promise<PeriodComparison> {
    const hasDims = Array.isArray(requestBodyA?.dimensions) && requestBodyA!.dimensions!.length > 0;

    // Grouped queries drive the per-key movers; a separate date-grouped query per
    // period gives accurate totals (keeping any filters) and shows which days have
    // data. dataState "final" silently omits the last ~2-3 unfinalized days, so a
    // window ending near today would otherwise compare a partial week to a full one.
    const byDate = (r: SearchAnalyticsQueryRequest) =>
      ({ ...r, dimensions: [r?.dataState === 'hourly_all' ? 'hour' : 'date'], rowLimit: 25000, startRow: 0 });
    const [a, b, ta, tb] = await Promise.all([
      hasDims ? this.searchAnalytics(siteUrl, requestBodyA) : Promise.resolve(null),
      hasDims ? this.searchAnalytics(siteUrl, requestBodyB) : Promise.resolve(null),
      this.searchAnalytics(siteUrl, byDate(requestBodyA)),
      this.searchAnalytics(siteUrl, byDate(requestBodyB)),
    ]);
    const rowsA = (a?.data.rows || []) as SearchAnalyticsRow[];
    const rowsB = (b?.data.rows || []) as SearchAnalyticsRow[];
    const dailyA = (ta.data.rows || []) as SearchAnalyticsRow[];
    const dailyB = (tb.data.rows || []) as SearchAnalyticsRow[];

    const totalsA = this.aggregateTotals(dailyA);
    const totalsB = this.aggregateTotals(dailyB);
    const pct = (from: number, to: number) => from === 0 ? (to === 0 ? 0 : null) : Number((((to - from) / from) * 100).toFixed(1));

    // Last day with data (hour keys start with their date); ISO dates compare correctly as strings.
    const dataThrough = (rows: SearchAnalyticsRow[]) =>
      rows.reduce<string | null>((max, r) => { const d = r.keys?.[0]?.slice(0, 10) ?? null; return d && (!max || d > max) ? d : max; }, null);
    const throughA = dataThrough(dailyA);
    const throughB = dataThrough(dailyB);
    const warnings = [
      this.periodWarning('periodA', requestBodyA, dailyA, throughA, ta.data.metadata),
      this.periodWarning('periodB', requestBodyB, dailyB, throughB, tb.data.metadata),
    ].filter((w): w is string => w !== null);

    // Deltas are primary (A) minus comparison (B): positive clicks = growth in the primary period.
    const result: PeriodComparison = {
      periodA: { startDate: requestBodyA?.startDate ?? null, endDate: requestBodyA?.endDate ?? null, dataThrough: throughA, totals: totalsA },
      periodB: { startDate: requestBodyB?.startDate ?? null, endDate: requestBodyB?.endDate ?? null, dataThrough: throughB, totals: totalsB },
      ...(warnings.length ? { warnings } : {}),
      delta: {
        clicks: { abs: totalsA.clicks - totalsB.clicks, pct: pct(totalsB.clicks, totalsA.clicks) },
        impressions: { abs: totalsA.impressions - totalsB.impressions, pct: pct(totalsB.impressions, totalsA.impressions) },
        ctr: { abs: Number((totalsA.ctr - totalsB.ctr).toFixed(2)) },
        position: { abs: Number((totalsA.position - totalsB.position).toFixed(1)) },
      },
    };

    // Per-key diff when grouped by dimensions.
    const dims = requestBodyA?.dimensions;
    if (dims && dims.length > 0) {
      const keyOf = (r: SearchAnalyticsRow) => (r.keys || []).join(' | ');
      const mapA = new Map(rowsA.map(r => [keyOf(r), r]));
      const mapB = new Map(rowsB.map(r => [keyOf(r), r]));
      const keys = new Set([...mapA.keys(), ...mapB.keys()]);

      const changes = [...keys].map(k => {
        const ra = mapA.get(k); const rb = mapB.get(k);
        const posA = ra?.position ?? null; const posB = rb?.position ?? null;
        return {
          key: k,
          clicks: { a: ra?.clicks ?? 0, b: rb?.clicks ?? 0, delta: (ra?.clicks ?? 0) - (rb?.clicks ?? 0) },
          impressions: { a: ra?.impressions ?? 0, b: rb?.impressions ?? 0, delta: (ra?.impressions ?? 0) - (rb?.impressions ?? 0) },
          position: { a: posA, b: posB, delta: (posA != null && posB != null) ? Number((posA - posB).toFixed(1)) : null },
        };
      });
      changes.sort((x, y) => Math.abs(y.clicks.delta) - Math.abs(x.clicks.delta));
      result.totalKeys = keys.size;
      result.topChanges = changes.slice(0, topN);
    }

    return result;
  }

  /**
   * Why a period's totals are not comparable, or null. Quiet days come back as
   * zero-impression rows, so a period that stops early is genuinely missing days.
   */
  private periodWarning(
    name: string,
    body: SearchAnalyticsQueryRequest | undefined,
    rows: SearchAnalyticsRow[],
    through: string | null,
    metadata: { firstIncompleteDate?: string | null; firstIncompleteHour?: string | null } | null | undefined,
  ): string | null {
    const start = body?.startDate;
    const end = body?.endDate;
    if (!start || !end) return null;
    const state = body?.dataState ?? 'final';
    if (!through) {
      // Quiet days come back as zero-impression rows, so an empty period is about dates, not traffic.
      const why = state === 'final'
        ? `Under dataState "final" this usually means none of its days are finalized yet (Search Console lags ~2-3 days); `
          + `otherwise the dates are in the future or older than the 16-month retention.`
        : `The dates are in the future or older than the 16-month retention.`;
      return `${name} returned no data for ${start}..${end}. ${why} Its totals are 0 and deltas against it are meaningless: `
        + `end both periods earlier.`;
    }
    if (state === 'all' || state === 'hourly_all') {
      const incomplete = metadata?.firstIncompleteDate ?? metadata?.firstIncompleteHour?.slice(0, 10) ?? null;
      if (incomplete && incomplete <= end) {
        return `${name} includes ${incomplete} onward, which Search Console is still collecting (dataState "${state}"), `
          + `so its latest days are undercounted. For a fair comparison use dataState "final" with both periods ending before ${incomplete}.`;
      }
      return null;
    }
    if (through < end) {
      const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5) + 1;
      const requested = days(start, end);
      const have = new Set(rows.map(r => r.keys?.[0]?.slice(0, 10))).size;
      const gap = days(through, end) - 1;
      return `${name} has finalized data only through ${through} (${have} of ${requested} requested days): Search Console `
        + `finalizes data ~2-3 days late, so totals and deltas cover unequal spans. To compare like with like, shift both `
        + `periods back ${gap} day(s) so ${name} ends on ${through} (this keeps weekdays aligned).`;
    }
    return null;
  }

  /**
   * Aggregates rows into period totals. Position is impression-weighted (the
   * standard aggregate for Search Console position).
   */
  private aggregateTotals(rows: SearchAnalyticsRow[]): PeriodTotals {
    let clicks = 0, impressions = 0, weightedPos = 0;
    for (const r of rows) {
      clicks += r.clicks ?? 0;
      impressions += r.impressions ?? 0;
      weightedPos += (r.position ?? 0) * (r.impressions ?? 0);
    }
    return {
      clicks,
      impressions,
      ctr: impressions > 0 ? Number(((clicks / impressions) * 100).toFixed(2)) : 0,
      position: impressions > 0 ? Number((weightedPos / impressions).toFixed(1)) : 0,
    };
  }

  /**
   * Enhanced search analytics with regex filtering and quick wins detection
   *
   * Features:
   * - Supports up to 25,000 rows (vs 1,000 default)
   * - Regex filtering on query dimension
   * - Automatic quick wins detection
   */
  async enhancedSearchAnalytics(
    siteUrl: string,
    requestBody: SearchAnalyticsQueryRequest,
    options: EnhancedSearchAnalyticsOptions = {},
  ): Promise<{ data: EnhancedSearchAnalyticsResponse }> {
    if (!requestBody) {
      throw new Error('Request body is required');
    }

    // Validate regex if provided
    if (options.regexFilter) {
      validateRegex(options.regexFilter);
    }

    // Clone request body to avoid mutation
    const enhancedRequestBody = { ...requestBody };

    // Apply regex filter if provided and query dimension is included
    if (options.regexFilter && enhancedRequestBody.dimensions?.includes('query')) {
      enhancedRequestBody.dimensionFilterGroups = [
        ...(enhancedRequestBody.dimensionFilterGroups || []),
        {
          groupType: 'and',
          filters: [{
            dimension: 'query',
            operator: 'includingRegex',
            expression: options.regexFilter,
          }],
        },
      ];
    }

    const result = await this.searchAnalytics(siteUrl, enhancedRequestBody);
    const rows = (result.data.rows || []) as SearchAnalyticsRow[];

    const enhancedResponse: EnhancedSearchAnalyticsResponse = {
      rows,
      responseAggregationType: result.data.responseAggregationType ?? undefined,
      metadata: {
        regexFilterApplied: !!options.regexFilter,
        quickWinsEnabled: !!options.enableQuickWins,
        rowLimit: enhancedRequestBody.rowLimit || 1000,
        totalRows: rows.length,
      },
    };

    // Surface API data-freshness metadata (firstIncompleteHour for hourly, etc.)
    if (result.data.metadata) {
      enhancedResponse.apiMetadata = {
        firstIncompleteDate: result.data.metadata.firstIncompleteDate,
        firstIncompleteHour: result.data.metadata.firstIncompleteHour,
      };
    }

    if (options.enableQuickWins && rows.length > 0) {
      enhancedResponse.quickWins = this.detectQuickWins(rows, options.quickWinsThresholds);
    }

    return { data: enhancedResponse };
  }

  /**
   * Detects SEO quick wins from search analytics data
   *
   * Identifies queries with:
   * - High impressions but low CTR
   * - Position between 4-10 (page 1 but not top 3)
   * - Potential for improvement with optimization
   */
  private detectQuickWins(
    rows: SearchAnalyticsRow[],
    thresholds: Partial<QuickWinsThresholds> = {},
  ): QuickWin[] {
    const {
      minImpressions = 50,
      maxCtr = 2.0,
      positionRangeMin = 4,
      positionRangeMax = 10,
      targetCtr = 5.0,
      estimatedClickValue = 1.0,
      conversionRate = 0.03,
    } = thresholds;

    return rows
      .filter((row): row is SearchAnalyticsRow & Required<Pick<SearchAnalyticsRow, 'impressions' | 'ctr' | 'position'>> => {
        const impressions = row.impressions ?? 0;
        const ctr = (row.ctr ?? 0) * 100; // Convert to percentage
        const position = row.position ?? 0;

        return (
          impressions >= minImpressions &&
          ctr <= maxCtr &&
          position >= positionRangeMin &&
          position <= positionRangeMax
        );
      })
      .map((row): QuickWin => {
        const impressions = row.impressions;
        const currentClicks = row.clicks ?? 0;
        const currentCtr = row.ctr * 100;
        const position = row.position;

        // Calculate potential with target CTR
        const potentialClicks = Math.round((impressions * targetCtr) / 100);
        const additionalClicks = Math.max(0, potentialClicks - currentClicks);

        // Calculate estimated value using clickValue and conversion rate
        const estimatedValue = Number((additionalClicks * estimatedClickValue * (1 + conversionRate)).toFixed(2));

        // Determine opportunity level based on additional clicks potential
        let opportunity: 'High' | 'Medium' | 'Low';
        if (additionalClicks >= 100) {
          opportunity = 'High';
        } else if (additionalClicks >= 25) {
          opportunity = 'Medium';
        } else {
          opportunity = 'Low';
        }

        // Generate actionable recommendation
        const recommendation = this.generateRecommendation(position, currentCtr, impressions);

        return {
          query: row.keys?.[0] ?? 'N/A',
          page: row.keys?.[1] ?? 'N/A',
          currentPosition: Number(position.toFixed(1)),
          impressions,
          currentClicks,
          currentCtr: Number(currentCtr.toFixed(2)),
          potentialClicks,
          additionalClicks,
          estimatedValue,
          opportunity,
          recommendation,
        };
      })
      .sort((a, b) => b.additionalClicks - a.additionalClicks);
  }

  /**
   * Generates actionable recommendation based on metrics
   */
  private generateRecommendation(position: number, ctr: number, impressions: number): string {
    const recommendations: string[] = [];

    if (position >= 4 && position <= 6) {
      recommendations.push('Improve content depth and relevance to reach top 3');
    } else if (position > 6 && position <= 10) {
      recommendations.push('Focus on on-page SEO and internal linking');
    }

    if (ctr < 1) {
      recommendations.push('Optimize title tag and meta description for higher CTR');
    }

    if (impressions >= 1000) {
      recommendations.push('High-volume keyword - prioritize optimization');
    }

    return recommendations.length > 0
      ? recommendations.join('. ')
      : 'Review content for optimization opportunities';
  }

  // ==========================================================================
  // Sites
  // ==========================================================================

  /**
   * Lists all sites accessible by the authenticated user
   */
  async listSites() {
    const webmasters = await this.getClient();
    return webmasters.sites.list();
  }

  // ==========================================================================
  // Sitemaps
  // ==========================================================================

  /**
   * Lists sitemaps for a site
   */
  async listSitemaps(request: ListSitemapsRequest) {
    const webmasters = await this.getClient();

    return this.withPermissionFallback(
      () => webmasters.sitemaps.list(request),
      () => webmasters.sitemaps.list({
        ...request,
        siteUrl: this.normalizeUrl(request.siteUrl!),
      }),
      'listSitemaps',
    );
  }

  /**
   * Gets details for a specific sitemap
   */
  async getSitemap(request: GetSitemapRequest) {
    const webmasters = await this.getClient();

    return this.withPermissionFallback(
      () => webmasters.sitemaps.get(request),
      () => webmasters.sitemaps.get({
        ...request,
        siteUrl: this.normalizeUrl(request.siteUrl!),
      }),
      'getSitemap',
    );
  }

  /**
   * Submits a sitemap for a site
   *
   * NOTE: Requires write access (webmasters scope, not readonly)
   */
  async submitSitemap(request: SubmitSitemapRequest) {
    if (!this.hasWriteAccess) {
      throw new Error('Write access required to submit sitemaps. Initialize service with writeAccess: true');
    }

    const webmasters = await this.getClient();

    return this.withPermissionFallback(
      () => webmasters.sitemaps.submit(request),
      () => webmasters.sitemaps.submit({
        ...request,
        siteUrl: this.normalizeUrl(request.siteUrl!),
      }),
      'submitSitemap',
    );
  }

  /**
   * Deletes a sitemap from a site
   *
   * NOTE: Requires write access (webmasters scope, not readonly)
   */
  async deleteSitemap(request: DeleteSitemapRequest) {
    if (!this.hasWriteAccess) {
      throw new Error('Write access required to delete sitemaps. Initialize service with writeAccess: true');
    }

    const webmasters = await this.getClient();

    return this.withPermissionFallback(
      () => webmasters.sitemaps.delete(request),
      () => webmasters.sitemaps.delete({
        ...request,
        siteUrl: this.normalizeUrl(request.siteUrl!),
      }),
      'deleteSitemap',
    );
  }

  // ==========================================================================
  // URL Inspection
  // ==========================================================================

  /**
   * Inspects a URL for indexing status
   *
   * @see https://developers.google.com/webmaster-tools/v1/urlInspection.index/inspect
   */
  async indexInspect(requestBody: IndexInspectRequest) {
    if (requestBody?.siteUrl) {
      validateSiteUrl(requestBody.siteUrl);
    }
    
    const quotaWarning = this.quotaTracker.recordUrlInspection();
    if (quotaWarning) {
      console.error(quotaWarning);
    }
    
    const searchConsole = await this.getClient();

    // Retry with the normalized sc-domain siteUrl on a permission error, matching
    // searchAnalytics (a URL-prefix siteUrl against a domain property would fail).
    return this.withPermissionFallback(
      () => searchConsole.urlInspection.index.inspect({ requestBody }),
      () => searchConsole.urlInspection.index.inspect({
        requestBody: { ...requestBody, siteUrl: this.normalizeUrl(requestBody!.siteUrl!) },
      }),
      'indexInspect',
    );
  }

  // ==========================================================================
  // Sitemap URL Fetching
  // ==========================================================================

  /** Max child sitemaps to follow from a sitemap index, fetched concurrently. */
  private static readonly MAX_CHILD_SITEMAPS = 50;

  /**
   * Fetches a URL and returns its text, transparently gunzipping `.gz` responses.
   * Returns null on any failure (non-OK, timeout, network error).
   */
  private async fetchText(url: string): Promise<string | null> {
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) return null;
      if (url.endsWith('.gz')) {
        return gunzipSync(Buffer.from(await resp.arrayBuffer())).toString('utf-8');
      }
      return await resp.text();
    } catch {
      return null;
    }
  }

  /** Extracts <loc> values from sitemap XML. */
  private extractLocs(xml: string): string[] {
    return [...xml.matchAll(/<loc>\s*(https?:\/\/[^<\s]+)\s*<\/loc>/g)].map(m => m[1].trim());
  }

  /**
   * Fetches and parses sitemap URLs for a given site.
   *
   * Discovers sitemaps from robots.txt (Sitemap: directives) plus common paths,
   * follows a sitemap index (capped, concurrent child fetches), and handles
   * gzipped sitemaps.
   */
  async fetchSitemapUrls(siteUrl: string): Promise<string[]> {
    const domain = siteUrl.startsWith('sc-domain:')
      ? siteUrl.replace('sc-domain:', '')
      : (() => { try { return new URL(siteUrl).hostname; } catch { return siteUrl; } })();

    // Resolve one sitemap URL into page URLs, following one level of sitemap index.
    const collectFrom = async (sitemapUrl: string): Promise<string[]> => {
      const xml = await this.fetchText(sitemapUrl);
      if (!xml) return [];
      const childLocs = [...xml.matchAll(/<sitemap>\s*<loc>\s*(.*?)\s*<\/loc>/gs)].map(m => m[1].trim());
      if (childLocs.length > 0) {
        if (childLocs.length > SearchConsoleService.MAX_CHILD_SITEMAPS) {
          console.error(`[GSC] Sitemap index has ${childLocs.length} child sitemaps; fetching the first ${SearchConsoleService.MAX_CHILD_SITEMAPS}.`);
        }
        const children = childLocs.slice(0, SearchConsoleService.MAX_CHILD_SITEMAPS);
        const results = await Promise.all(children.map(c => this.fetchText(c)));
        return results.flatMap(cx => (cx ? this.extractLocs(cx) : []));
      }
      return this.extractLocs(xml);
    };

    // Prefer robots.txt-declared sitemaps, aggregating across ALL of them (a site
    // may list several independent top-level sitemaps rather than one index).
    const robots = await this.fetchText(`https://${domain}/robots.txt`);
    const declared = robots
      ? [...robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map(m => m[1].trim())
      : [];
    if (declared.length > 0) {
      const all = (await Promise.all(declared.map(collectFrom))).flat();
      if (all.length > 0) return [...new Set(all)];
    }

    // Fallback: guess common paths, first that yields.
    for (const url of [
      `https://${domain}/sitemap.xml`,
      `https://${domain}/sitemap_index.xml`,
      `https://www.${domain}/sitemap.xml`,
    ]) {
      const urls = await collectFrom(url);
      if (urls.length > 0) return [...new Set(urls)];
    }

    return [];
  }

  // ==========================================================================
  // Batch Inspection
  // ==========================================================================

  /**
   * Inspects multiple URLs in batch, grouping results by verdict
   */
  async batchInspect(
    siteUrl: string,
    urls: string[] | undefined,
    maxUrls: number,
    languageCode: string,
  ) {
    validateSiteUrl(siteUrl);
    if (urls) {
      validateArrayLength(urls, 500, 'urls');
    }
    
    let sitemapUrlCount: number | undefined;
    if (!urls || urls.length === 0) {
      urls = await this.fetchSitemapUrls(siteUrl);
      sitemapUrlCount = urls.length;
    }

    const urlsToInspect = urls.slice(0, maxUrls);
    const pass: Array<{ url: string; lastCrawlTime?: string | null }> = [];
    const fail: Array<{
      url: string; coverageState?: string | null; pageFetchState?: string | null;
      robotsTxtState?: string | null; indexingState?: string | null;
      lastCrawlTime?: string | null; googleCanonical?: string | null; userCanonical?: string | null;
    }> = [];
    const partial: Array<{ url: string; coverageState?: string | null; pageFetchState?: string | null; lastCrawlTime?: string | null }> = [];
    const neutral: Array<{ url: string; coverageState?: string | null }> = [];
    const errors: Array<{ url: string; error: string }> = [];

    for (const url of urlsToInspect) {
      try {
        const resp = await this.indexInspect({ siteUrl, inspectionUrl: url, languageCode });
        const idx = resp.data?.inspectionResult?.indexStatusResult;
        const verdict = idx?.verdict ?? 'VERDICT_UNSPECIFIED';

        if (verdict === 'PASS') {
          pass.push({ url, lastCrawlTime: idx?.lastCrawlTime });
        } else if (verdict === 'FAIL') {
          fail.push({
            url, coverageState: idx?.coverageState, pageFetchState: idx?.pageFetchState,
            robotsTxtState: idx?.robotsTxtState, indexingState: idx?.indexingState,
            lastCrawlTime: idx?.lastCrawlTime, googleCanonical: idx?.googleCanonical,
            userCanonical: idx?.userCanonical,
          });
        } else if (verdict === 'PARTIAL') {
          partial.push({ url, coverageState: idx?.coverageState, pageFetchState: idx?.pageFetchState, lastCrawlTime: idx?.lastCrawlTime });
        } else {
          neutral.push({ url, coverageState: idx?.coverageState });
        }
        
        // Use adaptive delay based on quota tracker
        const delay = this.quotaTracker.getRecommendedInspectionDelay();
        await new Promise(r => setTimeout(r, delay));
      } catch (err) {
        errors.push({ url, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return {
      summary: { pass: pass.length, fail: fail.length, partial: partial.length, neutral: neutral.length, errors: errors.length },
      results: { pass, fail, partial, neutral, errors },
      totalInspected: urlsToInspect.length,
      ...(sitemapUrlCount !== undefined ? { sitemapUrlCount } : {}),
    };
  }

  // ==========================================================================
  // Coverage Report
  // ==========================================================================

  /**
   * Cross-references sitemap URLs with search analytics to find coverage gaps
   */
  async coverageReport(siteUrl: string, startDate: string, endDate: string) {
    validateSiteUrl(siteUrl);
    validateDateRange(startDate, endDate);
    
    // Match on a normalized key (scheme-, www-, case-, trailing-slash-insensitive;
    // query/hash ignored) so a sitemap URL and its analytics page URL line up even
    // when they differ in those ways. Original URLs are kept for display.
    const normKey = (u: string): string => {
      try {
        const url = new URL(u);
        return url.hostname.toLowerCase().replace(/^www\./, '') + (url.pathname.replace(/\/+$/, '') || '/');
      } catch {
        return u.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
      }
    };

    const sitemapUrls = await this.fetchSitemapUrls(siteUrl);
    const sitemapMap = new Map<string, string>(); // normKey -> original url
    for (const u of sitemapUrls) {
      const k = normKey(u);
      if (!sitemapMap.has(k)) sitemapMap.set(k, u);
    }

    const analyticsResp = await this.searchAnalytics(siteUrl, {
      startDate, endDate, dimensions: ['page'], rowLimit: 25000, dataState: 'final',
    });

    const rows = analyticsResp.data.rows ?? [];
    const analyticsMap = new Map<string, { url: string; clicks: number; impressions: number; position: number }>();
    for (const row of rows) {
      const pageUrl = row.keys?.[0];
      if (pageUrl) analyticsMap.set(normKey(pageUrl), { url: pageUrl, clicks: row.clicks ?? 0, impressions: row.impressions ?? 0, position: row.position ?? 0 });
    }

    const inSitemapNoImpressions: Array<{ url: string }> = [];
    let overlap = 0;
    for (const [key, url] of sitemapMap) {
      if (analyticsMap.has(key)) overlap++;
      else inSitemapNoImpressions.push({ url });
    }

    const hasImpressionsNoSitemap: Array<{ url: string; clicks: number; impressions: number; position: number }> = [];
    for (const [key, data] of analyticsMap) {
      if (!sitemapMap.has(key)) hasImpressionsNoSitemap.push({ url: data.url, clicks: data.clicks, impressions: data.impressions, position: data.position });
    }
    hasImpressionsNoSitemap.sort((a, b) => b.impressions - a.impressions);

    return {
      sitemapUrls: sitemapMap.size,
      analyticsUrls: analyticsMap.size,
      inSitemapNoImpressions: inSitemapNoImpressions.slice(0, 100),
      hasImpressionsNoSitemap: hasImpressionsNoSitemap.slice(0, 100),
      overlap,
      coveragePercent: sitemapMap.size > 0 ? Number(((overlap / sitemapMap.size) * 100).toFixed(1)) : 0,
    };
  }

  // ==========================================================================
  // Rich Results Check
  // ==========================================================================

  /**
   * Inspects URLs and extracts rich results data and issues
   */
  async richResultsCheck(siteUrl: string, urls: string[] | undefined, maxUrls: number, languageCode: string) {
    validateSiteUrl(siteUrl);
    if (urls) {
      validateArrayLength(urls, 500, 'urls');
    }
    
    if (!urls || urls.length === 0) urls = await this.fetchSitemapUrls(siteUrl);
    const urlsToCheck = urls.slice(0, maxUrls);

    const results: Array<{
      url: string;
      verdict?: string | null;
      detectedItems: Array<{ type: string; items: Array<{ name?: string | null; issues?: Array<{ issueMessage?: string | null; severity?: string | null }> }> }>;
    }> = [];
    const issuesSummary: Record<string, number> = {};

    for (const url of urlsToCheck) {
      try {
        const resp = await this.indexInspect({ siteUrl, inspectionUrl: url, languageCode });
        const rich = resp.data?.inspectionResult?.richResultsResult;
        if (rich?.detectedItems && rich.detectedItems.length > 0) {
          const detectedItems = rich.detectedItems.map(di => ({
            type: di.richResultType ?? 'unknown',
            items: (di.items ?? []).map(item => {
              const issues = (item.issues ?? []).map(issue => {
                if (issue.issueMessage) issuesSummary[issue.issueMessage] = (issuesSummary[issue.issueMessage] ?? 0) + 1;
                return { issueMessage: issue.issueMessage, severity: issue.severity };
              });
              return { name: item.name, ...(issues.length > 0 ? { issues } : {}) };
            }),
          }));
          results.push({ url, verdict: rich.verdict, detectedItems });
        }
        // Use adaptive delay based on quota tracker
        const delay = this.quotaTracker.getRecommendedInspectionDelay();
        await new Promise(r => setTimeout(r, delay));
      } catch { /* skip */ }
    }

    return { totalChecked: urlsToCheck.length, urlsWithRichResults: results.length, results, issuesSummary };
  }
}
