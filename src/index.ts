#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { sanitizeForLogging } from './validators.js';

import {
  BatchInspectSchema,
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
const SERVER_VERSION = '0.7.0';

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

/**
 * Builds dimension filter groups from search analytics arguments
 */
function buildFilterGroups(args: QueryArgs): Array<{
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

  // Country, device, and searchAppearance only support 'equals' operator
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

const server = new Server(
  {
    name: SERVER_NAME,
    version: SERVER_VERSION,
  },
  {
    capabilities: {
      tools: {},
      logging: {},
    },
  },
);

// ============================================================================
// Tool Definitions
// ============================================================================

// Advertise the input shape, so arguments with defaults stay optional, while still
// rejecting unknown keys: a misspelled filter should fail, not be silently dropped.
function toolSchema(schema: z.ZodType) {
  return z.toJSONSchema(schema, {
    io: 'input',
    override: (ctx) => {
      if (ctx.jsonSchema.type === 'object' && ctx.jsonSchema.additionalProperties === undefined) {
        ctx.jsonSchema.additionalProperties = false;
      }
    },
  });
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'list_sites',
        description: 'List all sites you have access to in Google Search Console',
        inputSchema: toolSchema(z.object({})),
      },
      {
        name: 'search_analytics',
        description: 'Query search performance data (clicks, impressions, CTR, position) from Google Search Console',
        inputSchema: toolSchema(SearchAnalyticsSchema),
      },
      {
        name: 'enhanced_search_analytics',
        description: 'Advanced search analytics with up to 25,000 rows, regex filters, data freshness control, and optional quick wins detection',
        inputSchema: toolSchema(EnhancedSearchAnalyticsSchema),
      },
      {
        name: 'search_analytics_all',
        description: 'Fetch search analytics beyond the 25,000-row-per-request cap by auto-paginating (up to 50,000 rows; the API caps data at ~50k/day per property per search type)',
        inputSchema: toolSchema(SearchAnalyticsAllSchema),
      },
      {
        name: 'compare_periods',
        description: 'Compare two date ranges: per-period totals (clicks, impressions, CTR, position) with deltas and % change, plus top movers per key when grouped by dimensions. Deltas are the primary period (startDate/endDate) minus the comparison period, so positive click deltas mean growth. Each period reports dataThrough (last date with data); if the response has warnings, a period\'s totals are not comparable (missing unfinalized days under dataState "final", partial days under "all", or no data); follow the warning\'s advice and re-run. Do not switch to dataState "all" to avoid the warning: it includes partial recent days and is flagged too.',
        inputSchema: toolSchema(ComparePeriodsSchema),
      },
      {
        name: 'get_quota_status',
        description: 'Report current API quota usage this process is tracking (Search Analytics per-minute; URL Inspection per-minute and per-day, per site)',
        inputSchema: toolSchema(z.object({})),
      },
      {
        name: 'detect_quick_wins',
        description: 'Analyze search data to find SEO quick wins - keywords with high impressions but low CTR that could benefit from optimization',
        inputSchema: toolSchema(QuickWinsDetectionSchema),
      },
      {
        name: 'index_inspect',
        description: 'Inspect a URL to check its indexing status, crawl info, and any issues preventing indexing',
        inputSchema: toolSchema(IndexInspectSchema),
      },
      {
        name: 'list_sitemaps',
        description: 'List all sitemaps submitted for a site in Google Search Console',
        inputSchema: toolSchema(ListSitemapsSchema),
      },
      {
        name: 'get_sitemap',
        description: 'Get detailed information about a specific sitemap including status and error counts',
        inputSchema: toolSchema(GetSitemapSchema),
      },
      {
        name: 'submit_sitemap',
        description: 'Submit a new sitemap to Google Search Console for crawling',
        inputSchema: toolSchema(SubmitSitemapSchema),
      },
      {
        name: 'delete_sitemap',
        description: 'Delete a sitemap from Google Search Console',
        inputSchema: toolSchema(DeleteSitemapSchema),
      },
      {
        name: 'batch_inspect',
        description: 'Inspect multiple URLs in batch, grouping results by indexing verdict (PASS/FAIL/PARTIAL). Fetches URLs from sitemap if not provided.',
        inputSchema: toolSchema(BatchInspectSchema),
      },
      {
        name: 'coverage_report',
        description: 'Cross-reference sitemap URLs with search analytics to find unindexed pages and orphaned URLs not in sitemap',
        inputSchema: toolSchema(CoverageReportSchema),
      },
      {
        name: 'rich_results_check',
        description: 'Inspect URLs for rich results (structured data) issues and detected item types',
        inputSchema: toolSchema(RichResultsCheckSchema),
      },
    ],
  };
});

// ============================================================================
// Tool Handlers
// ============================================================================

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const args = request.params.arguments ?? {};

  try {
    switch (toolName) {
      // --------------------------------------------------------------------
      // Sites
      // --------------------------------------------------------------------
      case 'list_sites': {
        const response = await searchConsoleService.listSites();
        return formatResponse(response.data);
      }

      // --------------------------------------------------------------------
      // Search Analytics
      // --------------------------------------------------------------------
      case 'search_analytics': {
        const parsed = SearchAnalyticsSchema.parse(args);
        const requestBody = buildSearchAnalyticsRequest(parsed);
        const response = await searchConsoleService.searchAnalytics(parsed.siteUrl, requestBody);
        return formatResponse(response.data);
      }

      case 'enhanced_search_analytics': {
        const parsed = EnhancedSearchAnalyticsSchema.parse(args);
        const requestBody = buildSearchAnalyticsRequest(parsed);

        const response = await searchConsoleService.enhancedSearchAnalytics(
          parsed.siteUrl,
          requestBody,
          {
            regexFilter: parsed.regexFilter,
            enableQuickWins: parsed.enableQuickWins,
            quickWinsThresholds: parsed.quickWinsThresholds,
          },
        );

        return formatResponse(response.data);
      }

      case 'search_analytics_all': {
        const parsed = SearchAnalyticsAllSchema.parse(args);
        const requestBody = buildSearchAnalyticsRequest(parsed);
        const response = await searchConsoleService.searchAnalyticsPaginated(
          parsed.siteUrl,
          requestBody,
          parsed.maxRows,
        );
        return formatResponse(response.data);
      }

      case 'compare_periods': {
        const parsed = ComparePeriodsSchema.parse(args);
        const requestBodyA = buildSearchAnalyticsRequest(parsed);
        const requestBodyB = buildSearchAnalyticsRequest({
          ...parsed,
          startDate: parsed.compareStartDate,
          endDate: parsed.compareEndDate,
        });
        const response = await searchConsoleService.comparePeriods(
          parsed.siteUrl,
          requestBodyA,
          requestBodyB,
          parsed.topN,
        );
        return formatResponse(response);
      }

      case 'get_quota_status': {
        return formatResponse(searchConsoleService.getQuotaStatus());
      }

      case 'detect_quick_wins': {
        const parsed = QuickWinsDetectionSchema.parse(args);

        // Fetch comprehensive data for analysis (25K rows with query+page dimensions)
        const requestBody = {
          startDate: parsed.startDate,
          endDate: parsed.endDate,
          dimensions: ['query', 'page'],
          rowLimit: 25000,
          dataState: 'final' as const,
        };

        // Single API call with quick wins detection enabled
        const response = await searchConsoleService.enhancedSearchAnalytics(
          parsed.siteUrl,
          requestBody,
          {
            enableQuickWins: true,
            quickWinsThresholds: {
              minImpressions: parsed.minImpressions,
              maxCtr: parsed.maxCtr,
              positionRangeMin: parsed.positionRangeMin,
              positionRangeMax: parsed.positionRangeMax,
              targetCtr: parsed.targetCtr,
              estimatedClickValue: parsed.estimatedClickValue,
              conversionRate: parsed.conversionRate,
            },
          },
        );

        // Return focused quick wins report
        return formatResponse({
          quickWins: response.data.quickWins ?? [],
          summary: {
            totalOpportunities: response.data.quickWins?.length ?? 0,
            totalAdditionalClicks: response.data.quickWins?.reduce((sum, qw) => sum + qw.additionalClicks, 0) ?? 0,
            totalEstimatedValue: response.data.quickWins?.reduce((sum, qw) => sum + qw.estimatedValue, 0) ?? 0,
            thresholds: {
              minImpressions: parsed.minImpressions,
              maxCtr: parsed.maxCtr,
              positionRange: `${parsed.positionRangeMin}-${parsed.positionRangeMax}`,
              targetCtr: parsed.targetCtr,
            },
          },
          analysisComplete: true,
        });
      }

      // --------------------------------------------------------------------
      // URL Inspection
      // --------------------------------------------------------------------
      case 'index_inspect': {
        const parsed = IndexInspectSchema.parse(args);
        const response = await searchConsoleService.indexInspect({
          siteUrl: parsed.siteUrl,
          inspectionUrl: parsed.inspectionUrl,
          languageCode: parsed.languageCode,
        });
        return formatResponse(response.data);
      }

      // --------------------------------------------------------------------
      // Sitemaps
      // --------------------------------------------------------------------
      case 'list_sitemaps': {
        const parsed = ListSitemapsSchema.parse(args);
        const response = await searchConsoleService.listSitemaps({
          siteUrl: parsed.siteUrl,
          sitemapIndex: parsed.sitemapIndex,
        });
        return formatResponse(response.data);
      }

      case 'get_sitemap': {
        const parsed = GetSitemapSchema.parse(args);
        const response = await searchConsoleService.getSitemap({
          siteUrl: parsed.siteUrl,
          feedpath: parsed.feedpath,
        });
        return formatResponse(response.data);
      }

      case 'submit_sitemap': {
        const parsed = SubmitSitemapSchema.parse(args);
        const response = await searchConsoleService.submitSitemap({
          siteUrl: parsed.siteUrl,
          feedpath: parsed.feedpath,
        });
        return formatResponse({
          success: true,
          message: `Sitemap ${parsed.feedpath} submitted successfully`,
          data: response.data,
        });
      }

      case 'delete_sitemap': {
        const parsed = DeleteSitemapSchema.parse(args);
        const response = await searchConsoleService.deleteSitemap({
          siteUrl: parsed.siteUrl,
          feedpath: parsed.feedpath,
        });
        return formatResponse({
          success: true,
          message: `Sitemap ${parsed.feedpath} deleted successfully`,
          data: response.data,
        });
      }

      // --------------------------------------------------------------------
      // Batch Inspect
      // --------------------------------------------------------------------
      case 'batch_inspect': {
        const parsed = BatchInspectSchema.parse(args);
        const response = await searchConsoleService.batchInspect(
          parsed.siteUrl,
          parsed.urls,
          parsed.maxUrls,
          parsed.languageCode,
        );
        return formatResponse(response);
      }

      // --------------------------------------------------------------------
      // Coverage Report
      // --------------------------------------------------------------------
      case 'coverage_report': {
        const parsed = CoverageReportSchema.parse(args);
        const response = await searchConsoleService.coverageReport(
          parsed.siteUrl,
          parsed.startDate,
          parsed.endDate,
        );
        return formatResponse(response);
      }

      // --------------------------------------------------------------------
      // Rich Results Check
      // --------------------------------------------------------------------
      case 'rich_results_check': {
        const parsed = RichResultsCheckSchema.parse(args);
        const response = await searchConsoleService.richResultsCheck(
          parsed.siteUrl,
          parsed.urls,
          parsed.maxUrls,
          parsed.languageCode,
        );
        return formatResponse(response);
      }

      // --------------------------------------------------------------------
      // Unknown Tool
      // --------------------------------------------------------------------
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  } catch (error) {
    // Sanitize error message before logging
    const errorMessage = error instanceof Error ? error.message : String(error);
    const sanitized = sanitizeForLogging(errorMessage);
    
    // Send to MCP logging channel
    await server.sendLoggingMessage({
      level: 'error',
      data: `[${toolName}] ${sanitized}`,
    });

    // Handle Zod validation errors with detailed messages
    if (error instanceof z.ZodError) {
      const issues = error.issues.map(issue => {
        const path = issue.path.length > 0 ? issue.path.join('.') : 'input';
        return `${path}: ${issue.message}`;
      });
      throw new Error(`Invalid arguments for ${toolName}: ${issues.join('; ')}`);
    }

    // Re-throw other errors (already sanitized)
    if (error instanceof Error) {
      error.message = sanitized;
    }
    throw error;
  }
});

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
