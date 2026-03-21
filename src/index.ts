#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { sanitizeForLogging } from './validators.js';

import {
  BatchInspectSchema,
  CoverageReportSchema,
  DeleteSitemapSchema,
  EnhancedSearchAnalyticsSchema,
  GetSitemapSchema,
  IndexInspectSchema,
  ListSitemapsSchema,
  QuickWinsDetectionSchema,
  RichResultsCheckSchema,
  SearchAnalyticsSchema,
  SubmitSitemapSchema,
  type SearchAnalytics,
} from './schemas.js';
import { SearchConsoleService } from './search-console.js';

// ============================================================================
// Constants
// ============================================================================

const SERVER_NAME = 'gsc-mcp-server';
const SERVER_VERSION = '0.2.2';

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

/**
 * Builds dimension filter groups from search analytics arguments
 */
function buildFilterGroups(args: SearchAnalytics): Array<{
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

  // Country and device only support 'equals' operator
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

  return filters.length > 0 ? [{ groupType: 'and', filters }] : undefined;
}

/**
 * Builds search analytics request body from parsed arguments
 */
function buildSearchAnalyticsRequest(args: SearchAnalytics) {
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

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'list_sites',
        description: 'List all sites you have access to in Google Search Console',
        inputSchema: z.toJSONSchema(z.object({})),
      },
      {
        name: 'search_analytics',
        description: 'Query search performance data (clicks, impressions, CTR, position) from Google Search Console',
        inputSchema: z.toJSONSchema(SearchAnalyticsSchema),
      },
      {
        name: 'enhanced_search_analytics',
        description: 'Advanced search analytics with up to 25,000 rows, regex filters, data freshness control, and optional quick wins detection',
        inputSchema: z.toJSONSchema(EnhancedSearchAnalyticsSchema),
      },
      {
        name: 'detect_quick_wins',
        description: 'Analyze search data to find SEO quick wins - keywords with high impressions but low CTR that could benefit from optimization',
        inputSchema: z.toJSONSchema(QuickWinsDetectionSchema),
      },
      {
        name: 'index_inspect',
        description: 'Inspect a URL to check its indexing status, crawl info, and any issues preventing indexing',
        inputSchema: z.toJSONSchema(IndexInspectSchema),
      },
      {
        name: 'list_sitemaps',
        description: 'List all sitemaps submitted for a site in Google Search Console',
        inputSchema: z.toJSONSchema(ListSitemapsSchema),
      },
      {
        name: 'get_sitemap',
        description: 'Get detailed information about a specific sitemap including status and error counts',
        inputSchema: z.toJSONSchema(GetSitemapSchema),
      },
      {
        name: 'submit_sitemap',
        description: 'Submit a new sitemap to Google Search Console for crawling',
        inputSchema: z.toJSONSchema(SubmitSitemapSchema),
      },
      {
        name: 'delete_sitemap',
        description: 'Delete a sitemap from Google Search Console',
        inputSchema: z.toJSONSchema(DeleteSitemapSchema),
      },
      {
        name: 'batch_inspect',
        description: 'Inspect multiple URLs in batch, grouping results by indexing verdict (PASS/FAIL/PARTIAL). Fetches URLs from sitemap if not provided.',
        inputSchema: z.toJSONSchema(BatchInspectSchema),
      },
      {
        name: 'coverage_report',
        description: 'Cross-reference sitemap URLs with search analytics to find unindexed pages and orphaned URLs not in sitemap',
        inputSchema: z.toJSONSchema(CoverageReportSchema),
      },
      {
        name: 'rich_results_check',
        description: 'Inspect URLs for rich results (structured data) issues and detected item types',
        inputSchema: z.toJSONSchema(RichResultsCheckSchema),
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
