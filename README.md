# mcp-server-gsc

Google Search Console MCP server — query analytics, detect quick wins, inspect URLs, manage sitemaps.

## Features

- **Search Analytics**: Query clicks, impressions, CTR, position data (up to 25K rows)
- **Quick Wins Detection**: Find high-impression, low-CTR keywords ready for optimization
- **URL Inspection**: Check indexing status, rich results, crawl info
- **Batch Operations**: Inspect multiple URLs, cross-reference sitemap vs analytics
- **Sitemap Management**: List, submit, delete sitemaps
- **Smart Throttling**: Auto-adapts to API rate limits, tracks quota usage

Originally based on [ahonn/mcp-server-gsc](https://github.com/ahonn/mcp-server-gsc).

## Install

### For Claude Desktop

```bash
npm install -g mcp-server-gsc
```

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "gsc": {
      "command": "mcp-server-gsc",
      "env": {
        "GOOGLE_APPLICATION_CREDENTIALS": "/path/to/your-service-account-key.json"
      }
    }
  }
}
```

### For other MCP clients

Install as a dev dependency or globally, then configure your MCP client to run:

```bash
mcp-server-gsc
```

with `GOOGLE_APPLICATION_CREDENTIALS` set to your service account JSON path.

## Authentication

You need a Google Cloud service account with Search Console access.

### Step 1: Create a service account

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create or select a project
3. Navigate to **APIs & Services** → **Credentials**
4. Click **Create Credentials** → **Service Account**
5. Fill in details, create a **JSON key**, download it

### Step 2: Enable Search Console API

1. Go to [APIs & Services → Library](https://console.cloud.google.com/apis/library)
2. Search for **"Search Console API"**
3. Click **Enable**

### Step 3: Grant access in Search Console

1. Open [Google Search Console](https://search.google.com/search-console)
2. Select your property
3. Go to **Settings** → **Users and permissions**
4. Add the service account email (looks like `name@project-id.iam.gserviceaccount.com`) as **Owner**

### Step 4: Set environment variable

```bash
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/your-key.json"
```

Or add to your MCP client config (see Install section above).

## Tools

| Tool | Purpose |
|------|---------|
| `list_sites` | List all GSC properties you have access to |
| `search_analytics` | Query search performance (clicks, impressions, CTR, position) |
| `enhanced_search_analytics` | Advanced query with regex filters and quick wins detection |
| `detect_quick_wins` | Find SEO quick wins (high impressions, low CTR, positions 4-10) |
| `index_inspect` | Check indexing status of a URL |
| `batch_inspect` | Inspect multiple URLs, group by verdict (PASS/FAIL/PARTIAL) |
| `coverage_report` | Cross-reference sitemap URLs vs search analytics to find gaps |
| `rich_results_check` | Inspect URLs for structured data / rich results |
| `list_sitemaps` | List submitted sitemaps |
| `get_sitemap` | Get details for a specific sitemap |
| `submit_sitemap` | Submit a new sitemap |
| `delete_sitemap` | Remove a sitemap |

## Example Workflows

### Find Quick Wins

```
1. List sites:
   Tool: list_sites

2. Detect opportunities:
   Tool: detect_quick_wins
   siteUrl: "sc-domain:example.com"
   startDate: "2026-01-01"
   endDate: "2026-03-31"
   minImpressions: 100
   maxCtr: 2.0

3. Inspect top URLs:
   Tool: index_inspect
   siteUrl: "sc-domain:example.com"
   inspectionUrl: "https://example.com/page-to-optimize"
```

### Coverage Audit

```
Tool: coverage_report
siteUrl: "sc-domain:example.com"
startDate: "2026-01-01"
endDate: "2026-03-31"

Returns:
- Pages in sitemap with no impressions
- Pages with impressions not in sitemap (orphaned)
- Coverage percentage
```

### Query Analytics with Filters

```
Tool: search_analytics
siteUrl: "https://www.example.com/"
startDate: "2026-01-01"
endDate: "2026-01-31"
dimensions: "query,page"
queryFilter: "watches"
filterOperator: "contains"
deviceFilter: "MOBILE"
rowLimit: 5000
```

## Tips

**siteUrl format:**
- Domain properties: `sc-domain:example.com`
- URL-prefix properties: `https://www.example.com/`

Use `list_sites` to see exact format.

**Data freshness:**
- GSC data has ~2-3 day lag
- Use `dataState: "final"` for stable data (default)
- Use `dataState: "all"` to include fresh unfinalized data

**Row limits:**
- Default: 1,000 rows
- Max: 25,000 rows
- For larger datasets, paginate with `startRow`

**Quota limits:**
- Search Analytics: ~1,200 requests/day
- URL Inspection: ~600 requests/minute
- Server warns at 80% usage and auto-throttles batch operations

**Date ranges:**
- Max: 16 months per GSC API limits
- Format: `YYYY-MM-DD`

## Troubleshooting

**"Permission denied"**

Make sure:
1. Service account email is added as **Owner** in Search Console
2. Search Console API is **enabled** in Google Cloud
3. `siteUrl` exactly matches a property from `list_sites`

**"Quota exceeded"**

Wait 24 hours for quota reset or reduce batch sizes. Check [Google Search Console API quotas](https://developers.google.com/webmaster-tools/v1/limits).

**"Invalid siteUrl"**

Use exact format from `list_sites`. Common mistake: `sc-domain:example.com` (correct) vs `example.com` (incorrect).

**"Date range exceeds 16 months"**

GSC API supports max 16 months of data. Break into multiple queries.

## Credits

Built on the Google Search Console API.

Originally created by [ahonn](https://github.com/ahonn). Enhanced version maintained by [watchdealer-pavel](https://github.com/watchdealer-pavel).

## License

MIT
