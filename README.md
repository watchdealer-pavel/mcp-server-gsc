<p align="center">
  <img src="assets/logo.png" alt="mcp-server-gsc" width="160" />
</p>

<h1 align="center">mcp-server-gsc</h1>

<p align="center">
  <strong>MCP server for Google Search Console.</strong><br>
  Search analytics, quick-wins detection, URL inspection, sitemap management.<br>
  Works with OpenClaw, Claude Code, Cursor, or any MCP client.
</p>

---

## What it does

Gives your AI agent direct access to Google Search Console through 15 tools:

| Tool | What it does |
|------|-------------|
| `list_sites` | List the GSC properties you have access to |
| `search_analytics` | Query clicks, impressions, CTR, and position (up to 25K rows) |
| `search_analytics_all` | Page past the 25K-per-request cap, up to ~50K rows |
| `enhanced_search_analytics` | Regex filtering plus automatic quick-wins detection |
| `compare_periods` | Diff two date ranges: totals, deltas, and the queries that moved most |
| `detect_quick_wins` | Find high-impression, low-CTR keywords with revenue estimates |
| `index_inspect` | Check the indexing status of a single URL |
| `batch_inspect` | Inspect many URLs at once, grouped by verdict (PASS/FAIL/PARTIAL) |
| `coverage_report` | Cross-reference sitemap URLs against analytics to find orphaned pages |
| `rich_results_check` | Audit structured data (Product, FAQ, Review snippets) |
| `list_sitemaps` | List submitted sitemaps |
| `get_sitemap` | Get details for a specific sitemap |
| `submit_sitemap` | Submit a new sitemap |
| `delete_sitemap` | Remove a sitemap |
| `get_quota_status` | Report the API quota usage the server is tracking |

**Hourly data.** `search_analytics` supports Google's hourly export. Pass `dimensions: "hour"` with `dataState: "hourly_all"` and a range of 10 days or less to get hour-by-hour clicks and impressions.

Every tool validates its input (date ranges, siteUrl format, the 16-month window) and coerces numeric parameters for you. The server also tracks API quota per site and warns before you run into the limits.

---

## Install

```bash
git clone https://github.com/watchdealer-pavel/mcp-server-gsc.git
cd mcp-server-gsc
npm install
npm run build
```

This builds the binary at `./dist/index.js`. Point your MCP client at it with `node /path/to/mcp-server-gsc/dist/index.js`.

---

## Setup

### 1. Create a Google Cloud service account

1. Go to [Google Cloud Console](https://console.cloud.google.com/) and create or select a project
2. Enable the **Search Console API** in [APIs & Services → Library](https://console.cloud.google.com/apis/library)
3. Go to **IAM & Admin → Service Accounts** and create a service account
4. Create a **JSON key** and download it
5. Store it somewhere safe (for example `~/.config/gsc/credentials.json`)

### 2. Grant access in Search Console

1. Open [Google Search Console](https://search.google.com/search-console)
2. Select your property, then go to **Settings → Users and permissions**
3. Add the service account email as **Owner**

Repeat for each property you want to access.

### 3. Configure your MCP client

#### OpenClaw

Add to `~/.openclaw/config/openclaw.json` under `mcpServers`:

```json
{
  "gsc": {
    "command": "node",
    "args": ["/path/to/mcp-server-gsc/dist/index.js"],
    "env": {
      "GOOGLE_APPLICATION_CREDENTIALS": "/path/to/credentials.json"
    }
  }
}
```

#### Claude Code

Add to `.mcp.json` or via Settings → MCP Servers:

```json
{
  "mcpServers": {
    "gsc": {
      "command": "node",
      "args": ["/path/to/mcp-server-gsc/dist/index.js"],
      "env": {
        "GOOGLE_APPLICATION_CREDENTIALS": "/path/to/credentials.json"
      }
    }
  }
}
```

#### Cursor / Windsurf / other MCP clients

Same pattern: point at `node /path/to/mcp-server-gsc/dist/index.js` with `GOOGLE_APPLICATION_CREDENTIALS` set.

---

## Usage

### Find quick wins

The main reason this exists. Find keywords where you get impressions but not clicks:

```
Tool: detect_quick_wins
  siteUrl: "sc-domain:example.com"
  startDate: "2026-01-01"
  endDate: "2026-03-20"
  minImpressions: 10
  maxCtr: 5
  positionRangeMin: 3
  positionRangeMax: 20
  targetCtr: 8
  estimatedClickValue: 5
  conversionRate: 0.02
```

Returns prioritized opportunities with an estimated revenue impact per keyword.

### Compare two periods

See what changed between two date ranges:

```
Tool: compare_periods
  siteUrl: "sc-domain:example.com"
  startDate: "2026-02-01"
  endDate: "2026-02-28"
  compareStartDate: "2026-01-01"
  compareEndDate: "2026-01-31"
  dimensions: "query"
```

Returns totals for both periods, the deltas and percentage change, and the queries that moved the most. Deltas are the primary period (`startDate`/`endDate`) minus the comparison period, so a positive click delta means growth.

### Search analytics with regex

Filter queries by pattern, useful for topic-specific analysis:

```
Tool: enhanced_search_analytics
  siteUrl: "sc-domain:example.com"
  startDate: "2026-01-01"
  endDate: "2026-03-20"
  dimensions: "query,page"
  rowLimit: 500
  regexFilter: "buy|price|review"
  enableQuickWins: true
```

### Pull more than 25,000 rows

When one request is not enough, this pages through the API and returns the combined rows:

```
Tool: search_analytics_all
  siteUrl: "sc-domain:example.com"
  startDate: "2026-01-01"
  endDate: "2026-03-20"
  dimensions: "query,page"
  maxRows: 50000
```

### Coverage audit

Find pages missing from your sitemap or getting zero impressions:

```
Tool: coverage_report
  siteUrl: "sc-domain:example.com"
  startDate: "2026-01-01"
  endDate: "2026-03-20"
```

### Structured data check

Verify rich-results eligibility across your top pages:

```
Tool: rich_results_check
  siteUrl: "sc-domain:example.com"
  maxUrls: 20
```

---

## Good to know

**siteUrl format.** Use `sc-domain:example.com` for domain properties or `https://www.example.com/` for URL-prefix properties. Run `list_sites` to see the exact string.

**Data freshness.** GSC data lags two to three days. Use `dataState: "all"` to include recent unfinalized data, or `dataState: "hourly_all"` with the `hour` dimension for hourly data over the last 10 days.

**Row limits.** One request returns up to 25,000 rows. For more, use `search_analytics_all`, which pages up to 50,000. The API caps data at roughly 50,000 rows per day per property per search type.

**Date ranges.** Up to 16 months, formatted `YYYY-MM-DD`.

**Quota.** Google's per-site limits are 1,200 queries per minute for Search Analytics, and 600 per minute plus 2,000 per day for URL Inspection. The server tracks usage, warns at 80%, throttles batch inspections automatically, and reports what it sees through `get_quota_status`.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Permission denied | Add the service account email as **Owner** in Search Console → Settings → Users |
| Invalid siteUrl | Use the exact string from `list_sites`. A common mistake is `example.com` instead of `sc-domain:example.com` |
| Quota exceeded | Per-minute limits reset each minute; the URL Inspection daily cap resets after 24 hours. Reduce batch sizes if you hit it often |
| Date range error | The limit is 16 months. Break longer spans into multiple queries |
| Search Console API not found | Enable it in Google Cloud Console → APIs & Services → Library |

---

## License

MIT

---

<p align="center">
  <sub>Originally based on <a href="https://github.com/ahonn/mcp-server-gsc">ahonn/mcp-server-gsc</a>. Rewritten with input validation, quota tracking, quick-wins detection, and batch tools.</sub>
</p>
