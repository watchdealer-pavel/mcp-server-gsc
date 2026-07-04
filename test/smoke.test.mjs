// Smoke test: boot the built server on stdio and confirm the full tool list.
// Zero dependencies — uses Node's built-in test runner (`node --test`).
// Auth is lazy (GoogleAuth reads the key file only on the first API call), so a
// dummy GOOGLE_APPLICATION_CREDENTIALS path lets the server boot without real creds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

const EXPECTED_TOOLS = [
  'batch_inspect', 'compare_periods', 'coverage_report', 'delete_sitemap',
  'detect_quick_wins', 'enhanced_search_analytics', 'get_quota_status', 'get_sitemap',
  'index_inspect', 'list_sitemaps', 'list_sites', 'rich_results_check',
  'search_analytics', 'search_analytics_all', 'submit_sitemap',
];

test('server boots on stdio and lists all 15 tools', async () => {
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, GOOGLE_APPLICATION_CREDENTIALS: '/tmp/gsc-smoke-dummy.json' },
    stdio: ['pipe', 'pipe', 'ignore'],
  });

  // Parse newline-delimited JSON-RPC from stdout; resolve pending waiters on match.
  const pending = [];
  let buf = '';
  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      for (let k = pending.length - 1; k >= 0; k--) {
        if (pending[k].match(msg)) { pending[k].resolve(msg); pending.splice(k, 1); }
      }
    }
  });

  const waitFor = (match, ms = 5000) => new Promise((resolve, reject) => {
    const entry = { match, resolve };
    pending.push(entry);
    setTimeout(() => {
      const idx = pending.indexOf(entry);
      if (idx >= 0) { pending.splice(idx, 1); reject(new Error('timeout waiting for JSON-RPC response')); }
    }, ms).unref();
  });

  const send = (msg) => proc.stdin.write(JSON.stringify(msg) + '\n');

  try {
    send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0.0.0' } },
    });
    await waitFor((m) => m.id === 1);

    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const resp = await waitFor((m) => m.id === 2);

    const names = resp.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, EXPECTED_TOOLS);
  } finally {
    proc.kill();
  }
});
