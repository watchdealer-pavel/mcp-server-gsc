<p align="center">
  <img src="assets/logo.png" alt="mcp-server-gsc" width="160" />
</p>

<h1 align="center">mcp-server-gsc</h1>

<p align="center">
  <strong>MCP server for Google Search Console.</strong><br>
  Search analytics, quick wins detection, URL inspection, sitemap management.<br>
  Works with OpenClaw, Claude Code, Cursor, or any MCP client.
</p>

---

## What It Does

Gives your AI agent direct access to Google Search Console data through 12 tools:

| Tool | What it does |
|------|-------------|
| `list_sites` | List all GSC properties you have access to |
| `search_analytics` | Query clicks, impressions, CTR, position (up to 25K rows) |
| `enhanced_search_analytics` | Regex filtering + auto quick-wins detection |
| `detect_quick_wins` | Find high-impression, low-CTR keywords with revenue estimates |
| `index_inspect` | Check indexing status of a single URL |
| `batch_inspect` | Inspect multiple URLs, grouped by verdict (PASS/FAIL/PARTIAL) |
| `coverage_report` | Cross-reference sitemap vs analytics — find orphaned pages |
| `rich_results_check` | Audit structured data (Product, FAQ, Review snippets) |
| `list_sitemaps` | List submitted sitemaps |
| `get_sitemap` | Get details for a specific sitemap |
| `submit_sitemap` | Submit a new sitemap |
| `delete_sitemap` | Remove a sitemap |

Built-in input validation (date ranges, siteUrl format, 16-month limit), quota tracking (daily search analytics, per-minute URL inspection), and numeric coercion for all parameters.

---

## Install

```bash
npm install -g mcp-server-gsc
```

Or clone and build from source:

```bash
git clone https://github.com/watchdealer-pavel/mcp-server-gsc.git
cd mcp-server-gsc
npm install
npm run build
```

---

## Setup

### 1. Create a Google Cloud service account

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → create or select a project
2. Enable the **Search Console API** in [APIs & Services → Library](https://console.cloud.google.com/apis/library)
3. Go to **IAM & Admin → Service Accounts** → create a service account
4. Create a **JSON key** and download it
5. Store it somewhere safe (e.g. `~/.config/gsc/credentials.json`)

### 2. Grant access in Search Console

1. Open [Google Search Console](https://search.google.com/search-console)
2. Select your property → **Settings → Users and permissions**
3. Add the service account email as **Owner**

Repeat for each property you want to access.

### 3. Configure your MCP client

#### OpenClaw

Add to `~/.openclaw/config/openclaw.json` under `mcpServers`:

```json
{
  "gsc": {
    "command": "mcp-server-gsc",
    "env": {
      "GOOGLE_APPLICATION_CREDENTIALS": "/path/to/credentials.json"
    }
  }
}
```

<details>
<summary><strong>Copy-paste for OpenClaw agent setup</strong></summary>

Paste this into your agent chat:

```
Install and configure mcp-server-gsc for Google Search Console access.

1. Run: npm install -g mcp-server-gsc
2. Add to MCP config:
   - server name: "gsc"
   - command: "mcp-server-gsc"
   - env GOOGLE_APPLICATION_CREDENTIALS pointing to the service account JSON
3. Test with: mcporter call gsc.list_sites
```

</details>

#### Claude Code

Add to your MCP settings (`.mcp.json` or via Settings → MCP Servers):

```json
{
  "mcpServers": {
    "gsc": {
      "command": "mcp-server-gsc",
      "env": {
        "GOOGLE_APPLICATION_CREDENTIALS": "/path/to/credentials.json"
      }
    }
  }
}
```

<details>
<summary><strong>Copy-paste for Claude Code setup</strong></summary>

Paste this into Claude Code:

```
Add mcp-server-gsc to my MCP configuration.

Install: npm install -g mcp-server-gsc

Config for .mcp.json:
{
  "mcpServers": {
    "gsc": {
      "command": "mcp-server-gsc",
      "env": {
        "GOOGLE_APPLICATION_CREDENTIALS": "/absolute/path/to/credentials.json"
      }
    }
  }
}

After adding, verify by calling the list_sites tool.
```

</details>

#### Cursor / Windsurf / Other MCP clients

Same pattern — point your MCP client at the `mcp-server-gsc` command with `GOOGLE_APPLICATION_CREDENTIALS` set. If building from source, point to `node /path/to/mcp-server-gsc/dist/index.js` instead.

---

## Usage

### Find Quick Wins

The main reason this exists. Find keywords where you're getting impressions but not clicks:

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

Returns prioritized opportunities with estimated monthly revenue impact per keyword.

### Search Analytics with Regex

Filter queries by pattern — useful for topic-specific analysis:

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

### Coverage Audit

Find pages missing from your sitemap or getting zero impressions:

```
Tool: coverage_report
  siteUrl: "sc-domain:example.com"
  startDate: "2026-01-01"
  endDate: "2026-03-20"
```

### Structured Data Check

Verify rich results eligibility across your top pages:

```
Tool: rich_results_check
  siteUrl: "sc-domain:example.com"
  maxUrls: 20
```

### Basic Analytics

Standard GSC query — clicks, impressions, CTR, position:

```
Tool: search_analytics
  siteUrl: "sc-domain:example.com"
  startDate: "2026-01-01"
  endDate: "2026-03-20"
  dimensions: "query"
  rowLimit: 1000
```

---

## Good to Know

**siteUrl format** — Use `sc-domain:example.com` for domain properties, `https://www.example.com/` for URL-prefix. Run `list_sites` to see the exact format.

**Data freshness** — GSC data lags 2-3 days. Use `dataState: "all"` to include unfinalized recent data.

**Row limits** — Default 1,000, max 25,000. Paginate with `startRow` for larger datasets.

**Date ranges** — Max 16 months per GSC API limit. Format: `YYYY-MM-DD`.

**Quota** — Search Analytics: ~1,200 requests/day. URL Inspection: ~600/minute. The server tracks usage internally, warns at 80%, and auto-throttles batch operations.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Permission denied | Add service account email as **Owner** in Search Console → Settings → Users |
| Invalid siteUrl | Use exact format from `list_sites` — common mistake: `example.com` instead of `sc-domain:example.com` |
| Quota exceeded | Wait for daily reset or reduce batch sizes |
| Date range error | Max 16 months. Break into multiple queries |
| Search Console API not found | Enable it in Google Cloud Console → APIs & Services → Library |

---

## License

MIT

---

<p align="center">
  <sub>Originally based on <a href="https://github.com/ahonn/mcp-server-gsc">ahonn/mcp-server-gsc</a>. Rewritten with input validation, quota tracking, quick wins detection, and batch tools.</sub>
</p>
