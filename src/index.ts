#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { sanitizeForLogging } from './validators.js';

import {
  BatchInspectSchema,
  CannibalizationSchema,
  ComparePeriodsSchema,
  CoverageReportSchema,
  DeleteSitemapSchema,
  EnhancedSearchAnalyticsSchema,
  GetSitemapSchema,
  IndexInspectSchema,
  ListSitemapsSchema,
  QuickWinsDetectionSchema,
  RichResultsCheckSchema,
  SearchAnalyticsAllSchema,
  SearchAnalyticsSchema,
  SubmitSitemapSchema,
  type SearchAnalytics,
} from './schemas.js';
import { SearchConsoleService } from './search-console.js';

// ============================================================================
// Constants
// ============================================================================

const SERVER_NAME = 'gsc-mcp-server';
// Keep in sync with "version" in package.json
const SERVER_VERSION = '0.8.0';

// ============================================================================
// Environment & Service Initialization
// ============================================================================

const GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS;

if (!GOOGLE_APPLICATION_CREDENTIALS) {
  console.error('Error: GOOGLE_APPLICATION_CREDENTIALS environment variable is required');
  console.error('Set it to the path of your Google Cloud service account JSON key file');
  process.exit(1);
}

// Create singleton service instance (with write access for sitemap operations)
const searchConsoleService = new SearchConsoleService(GOOGLE_APPLICATION_CREDENTIALS, true);

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Formats data as MCP tool response
 */
function formatResponse(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(data, null, 2),
    }],
  };
}

// Query args shared by search_analytics, search_analytics_all (no rowLimit/startRow),
// and compare_periods — rowLimit/startRow are optional so all three are accepted.
type QueryArgs = Omit<SearchAnalytics, 'rowLimit' | 'startRow'> &
  Partial<Pick<SearchAnalytics, 'rowLimit' | 'startRow'>>;

type FilterArgs = Pick<SearchAnalytics,
  'pageFilter' | 'queryFilter' | 'countryFilter' | 'deviceFilter' | 'searchAppearanceFilter' | 'filterOperator' | 'filters'>;

/**
 * Builds dimension filter groups from search analytics arguments
 */
function buildFilterGroups(args: FilterArgs): Array<{
  groupType: 'and';
  filters: Array<{ dimension: string; operator: string; expression: string }>;
}> | undefined {
  const filters: Array<{ dimension: string; operator: string; expression: string }> = [];

  if (args.pageFilter) {
    filters.push({
      dimension: 'page',
      operator: args.filterOperator,
      expression: args.pageFilter,
    });
  }

  if (args.queryFilter) {
    filters.push({
      dimension: 'query',
      operator: args.filterOperator,
      expression: args.queryFilter,
    });
  }

  // The country/device/searchAppearance shorthands match exactly; `filters` takes any operator.
  if (args.countryFilter) {
    filters.push({
      dimension: 'country',
      operator: 'equals',
      expression: args.countryFilter,
    });
  }

  if (args.deviceFilter) {
    filters.push({
      dimension: 'device',
      operator: 'equals',
      expression: args.deviceFilter,
    });
  }

  if (args.searchAppearanceFilter) {
    filters.push({
      dimension: 'searchAppearance',
      operator: 'equals',
      expression: args.searchAppearanceFilter,
    });
  }

  if (args.filters) filters.push(...args.filters);

  return filters.length > 0 ? [{ groupType: 'and', filters }] : undefined;
}

/**
 * Builds search analytics request body from parsed arguments
 */
function buildSearchAnalyticsRequest(args: QueryArgs) {
  return {
    startDate: args.startDate,
    endDate: args.endDate,
    dimensions: args.dimensions?.split(',').map(d => d.trim()),
    searchType: args.type,
    aggregationType: args.aggregationType,
    rowLimit: args.rowLimit,
    startRow: args.startRow,
    dataState: args.dataState,
    dimensionFilterGroups: buildFilterGroups(args),
  };
}

// ============================================================================
// Server Setup
// ============================================================================

const server = new McpServer({
  name: SERVER_NAME,
  version: SERVER_VERSION,
});

/**
 * Runs a tool and returns its result as JSON text. McpServer has already validated
 * the arguments against the tool's schema (unknown keys are rejected: the schemas
 * are strict objects) and reports a thrown error to the client as an `isError`
 * result. Errors are logged to stderr, the logging path the 2026-07-28 spec
 * prescribes for stdio servers, after redacting secrets and credential paths.
 */
async function respond(name: string, run: () => unknown) {
  try {
    return formatResponse(await run());
  } catch (error) {
    const sanitized = sanitizeForLogging(error instanceof Error ? error.message : String(error));
    console.error(`[${name}] ${sanitized}`);
    throw new Error(sanitized);
  }
}

const NoArgsSchema = z.strictObject({});

// MCP tool annotations: clients use them to auto-approve safe calls and to confirm risky ones.
const READ_ONLY = { readOnlyHint: true } as const;

// ============================================================================
// Tools
// ============================================================================

// --------------------------------------------------------------------
// Sites
// --------------------------------------------------------------------
server.registerTool('list_sites', {
  description: 'List all sites you have access to in Google Search Console',
  inputSchema: NoArgsSchema,
  annotations: READ_ONLY,
}, () => respond('list_sites', async () => (await searchConsoleService.listSites()).data));

// --------------------------------------------------------------------
// Search Analytics
// --------------------------------------------------------------------
server.registerTool('search_analytics', {
  description: 'Query search performance data (clicks, impressions, CTR, position) from Google Search Console',
  inputSchema: SearchAnalyticsSchema,
  annotations: READ_ONLY,
}, (args) => respond('search_analytics', async () =>
  (await searchConsoleService.searchAnalytics(args.siteUrl, buildSearchAnalyticsRequest(args))).data));

server.registerTool('enhanced_search_analytics', {
  description: 'Advanced search analytics with up to 25,000 rows, regex filters, data freshness control, and optional quick wins detection',
  inputSchema: EnhancedSearchAnalyticsSchema,
  annotations: READ_ONLY,
}, (args) => respond('enhanced_search_analytics', async () =>
  (await searchConsoleService.enhancedSearchAnalytics(
    args.siteUrl,
    buildSearchAnalyticsRequest(args),
    {
      regexFilter: args.regexFilter,
      enableQuickWins: args.enableQuickWins,
      quickWinsThresholds: args.quickWinsThresholds,
    },
  )).data));

server.registerTool('search_analytics_all', {
  description: 'Fetch search analytics beyond the 25,000-row-per-request cap by auto-paginating (up to 50,000 rows; the API caps data at ~50k/day per property per search type)',
  inputSchema: SearchAnalyticsAllSchema,
  annotations: READ_ONLY,
}, (args) => respond('search_analytics_all', async () =>
  (await searchConsoleService.searchAnalyticsPaginated(
    args.siteUrl,
    buildSearchAnalyticsRequest(args),
    args.maxRows,
  )).data));

server.registerTool('compare_periods', {
  description: 'Compare two date ranges: per-period totals (clicks, impressions, CTR, position) with deltas and % change, plus top movers per key when grouped by dimensions. Deltas are the primary period (startDate/endDate) minus the comparison period, so positive click deltas mean growth. Each period reports dataThrough (last date with data); if the response has warnings, a period\'s totals are not comparable (missing unfinalized days under dataState "final", partial days under "all", or no data); follow the warning\'s advice and re-run. Do not switch to dataState "all" to avoid the warning: it includes partial recent days and is flagged too.',
  inputSchema: ComparePeriodsSchema,
  annotations: READ_ONLY,
}, (args) => respond('compare_periods', () =>
  searchConsoleService.comparePeriods(
    args.siteUrl,
    buildSearchAnalyticsRequest(args),
    buildSearchAnalyticsRequest({ ...args, startDate: args.compareStartDate, endDate: args.compareEndDate }),
    args.topN,
  )));

server.registerTool('get_quota_status', {
  description: 'Report current API quota usage this process is tracking (Search Analytics per-minute; URL Inspection per-minute and per-day, per site)',
  inputSchema: NoArgsSchema,
  annotations: READ_ONLY,
}, () => respond('get_quota_status', () => searchConsoleService.getQuotaStatus()));

server.registerTool('detect_quick_wins', {
  description: 'Analyze search data to find SEO quick wins - keywords with high impressions but low CTR that could benefit from optimization',
  inputSchema: QuickWinsDetectionSchema,
  annotations: READ_ONLY,
}, (args) => respond('detect_quick_wins', async () => {
  // Fetch comprehensive data for analysis (25K rows with query+page dimensions)
  const requestBody = {
    startDate: args.startDate,
    endDate: args.endDate,
    dimensions: ['query', 'page'],
    rowLimit: 25000,
    dataState: 'final' as const,
  };

  // Single API call with quick wins detection enabled
  const response = await searchConsoleService.enhancedSearchAnalytics(
    args.siteUrl,
    requestBody,
    {
      enableQuickWins: true,
      quickWinsThresholds: {
        minImpressions: args.minImpressions,
        maxCtr: args.maxCtr,
        positionRangeMin: args.positionRangeMin,
        positionRangeMax: args.positionRangeMax,
        targetCtr: args.targetCtr,
        estimatedClickValue: args.estimatedClickValue,
        conversionRate: args.conversionRate,
      },
    },
  );

  // Return focused quick wins report
  return {
    quickWins: response.data.quickWins ?? [],
    summary: {
      totalOpportunities: response.data.quickWins?.length ?? 0,
      totalAdditionalClicks: response.data.quickWins?.reduce((sum, qw) => sum + qw.additionalClicks, 0) ?? 0,
      totalEstimatedValue: response.data.quickWins?.reduce((sum, qw) => sum + qw.estimatedValue, 0) ?? 0,
      thresholds: {
        minImpressions: args.minImpressions,
        maxCtr: args.maxCtr,
        positionRange: `${args.positionRangeMin}-${args.positionRangeMax}`,
        targetCtr: args.targetCtr,
      },
    },
    analysisComplete: true,
  };
}));

server.registerTool('detect_cannibalization', {
  description: 'Find keyword cannibalization: queries where two or more of your pages each get a meaningful share of the impressions, so they compete for the same searches. Returns each such query with its competing pages (impressions, clicks, position, share). Accepts the same filters as search_analytics, e.g. to limit it to one site section or to non-branded queries.',
  inputSchema: CannibalizationSchema,
  annotations: READ_ONLY,
}, (args) => respond('detect_cannibalization', () =>
  searchConsoleService.detectCannibalization(
    args.siteUrl,
    {
      startDate: args.startDate,
      endDate: args.endDate,
      dimensions: ['query', 'page'],
      searchType: args.type,
      dataState: args.dataState,
      rowLimit: 25000,
      dimensionFilterGroups: buildFilterGroups(args),
    },
    { minImpressions: args.minImpressions, minShare: args.minShare, topN: args.topN },
  )));

// --------------------------------------------------------------------
// URL Inspection
// --------------------------------------------------------------------
server.registerTool('index_inspect', {
  description: 'Inspect a URL to check its indexing status, crawl info, and any issues preventing indexing',
  inputSchema: IndexInspectSchema,
  annotations: READ_ONLY,
}, (args) => respond('index_inspect', async () =>
  (await searchConsoleService.indexInspect({
    siteUrl: args.siteUrl,
    inspectionUrl: args.inspectionUrl,
    languageCode: args.languageCode,
  })).data));

// --------------------------------------------------------------------
// Sitemaps
// --------------------------------------------------------------------
server.registerTool('list_sitemaps', {
  description: 'List all sitemaps submitted for a site in Google Search Console',
  inputSchema: ListSitemapsSchema,
  annotations: READ_ONLY,
}, (args) => respond('list_sitemaps', async () =>
  (await searchConsoleService.listSitemaps({ siteUrl: args.siteUrl, sitemapIndex: args.sitemapIndex })).data));

server.registerTool('get_sitemap', {
  description: 'Get detailed information about a specific sitemap including status and error counts',
  inputSchema: GetSitemapSchema,
  annotations: READ_ONLY,
}, (args) => respond('get_sitemap', async () =>
  (await searchConsoleService.getSitemap({ siteUrl: args.siteUrl, feedpath: args.feedpath })).data));

server.registerTool('submit_sitemap', {
  description: 'Submit a new sitemap to Google Search Console for crawling',
  inputSchema: SubmitSitemapSchema,
  // Resubmitting the same sitemap is harmless.
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
}, (args) => respond('submit_sitemap', async () => {
  const response = await searchConsoleService.submitSitemap({ siteUrl: args.siteUrl, feedpath: args.feedpath });
  return { success: true, message: `Sitemap ${args.feedpath} submitted successfully`, data: response.data };
}));

server.registerTool('delete_sitemap', {
  description: 'Delete a sitemap from Google Search Console',
  inputSchema: DeleteSitemapSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
}, (args) => respond('delete_sitemap', async () => {
  const response = await searchConsoleService.deleteSitemap({ siteUrl: args.siteUrl, feedpath: args.feedpath });
  return { success: true, message: `Sitemap ${args.feedpath} deleted successfully`, data: response.data };
}));

// --------------------------------------------------------------------
// Batch Inspect, Coverage Report, Rich Results Check
// --------------------------------------------------------------------
server.registerTool('batch_inspect', {
  description: 'Inspect multiple URLs in batch, grouping results by indexing verdict (PASS/FAIL/PARTIAL). Fetches URLs from sitemap if not provided.',
  inputSchema: BatchInspectSchema,
  annotations: READ_ONLY,
}, (args) => respond('batch_inspect', () =>
  searchConsoleService.batchInspect(args.siteUrl, args.urls, args.maxUrls, args.languageCode)));

server.registerTool('coverage_report', {
  description: 'Cross-reference sitemap URLs with search analytics to find unindexed pages and orphaned URLs not in sitemap',
  inputSchema: CoverageReportSchema,
  annotations: READ_ONLY,
}, (args) => respond('coverage_report', () =>
  searchConsoleService.coverageReport(args.siteUrl, args.startDate, args.endDate)));

server.registerTool('rich_results_check', {
  description: 'Inspect URLs for rich results (structured data) issues and detected item types',
  inputSchema: RichResultsCheckSchema,
  annotations: READ_ONLY,
}, (args) => respond('rich_results_check', () =>
  searchConsoleService.richResultsCheck(args.siteUrl, args.urls, args.maxUrls, args.languageCode)));

// ============================================================================
// Server Startup
// ============================================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`${SERVER_NAME} v${SERVER_VERSION} running on stdio`);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
