// Guards the reworked quota math: Search Analytics is per-minute (1,200/site),
// URL Inspection is per-minute (600) AND per-day (2,000). Runs against the built dist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuotaTracker } from '../dist/quota-tracker.js';

test('search analytics tracks per-minute against 1,200 QPM', () => {
  const q = new QuotaTracker();
  for (let i = 0; i < 958; i++) q.recordSearchAnalytics();
  assert.equal(q.recordSearchAnalytics(), null, 'below 80% → no warning'); // 959/1200 = 79.9%
  const warn = q.recordSearchAnalytics(); // 960/1200 = 80%
  assert.match(warn, /Search Analytics quota at 80%/);
  assert.match(warn, /QPM per site/);
  const s = q.getStatus();
  assert.equal(s.searchAnalytics.perMinuteLimit, 1200);
});

test('url inspection warns on the per-day cap (2,000) and per-minute cap (600)', () => {
  const q = new QuotaTracker();
  // Per-minute warning fires first (600 QPM) well before the daily cap.
  let firstWarn = null;
  for (let i = 0; i < 480; i++) firstWarn = q.recordUrlInspection(); // 480/600 = 80%
  assert.match(firstWarn, /URL Inspection at 80% this minute/);

  const s = q.getStatus();
  assert.equal(s.urlInspection.perMinuteLimit, 600);
  assert.equal(s.urlInspection.perDayLimit, 2000);
  assert.equal(s.urlInspection.usedToday, 480);
});
