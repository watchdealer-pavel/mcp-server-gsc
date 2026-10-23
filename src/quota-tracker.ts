/**
 * Simple quota tracker for the Google Search Console API.
 *
 * Official per-site limits (https://developers.google.com/webmaster-tools/limits):
 * - Search Analytics (searchanalytics.query): 1,200 QPM per site (per-MINUTE)
 * - URL Inspection (urlInspection.index.inspect): 600 QPM AND 2,000 QPD per site
 *
 * Usage is counted per siteUrl, matching how Google applies the limits. This
 * tracker warns as we approach these limits; it does not enforce them (the API
 * enforces its own quotas). Counts are per-process and best-effort — per-site/
 * user/project accounting server-side may differ.
 */

interface QuotaState {
  // Search Analytics — per-minute (1,200 QPM/site)
  saMinute: string;
  saCountThisMinute: number;
  // URL Inspection — per-minute (600 QPM/site) + per-day (2,000 QPD/site)
  inspectionMinute: string;
  inspectionCountThisMinute: number;
  inspectionDay: string;
  inspectionCountToday: number;
}

export class QuotaTracker {
  private sites = new Map<string, QuotaState>();

  // Official per-site limits.
  private readonly SEARCH_ANALYTICS_PER_MINUTE_LIMIT = 1200;
  private readonly URL_INSPECTION_PER_MINUTE_LIMIT = 600;
  private readonly URL_INSPECTION_PER_DAY_LIMIT = 2000;

  /** Current minute bucket, format YYYY-MM-DDTHH:MM */
  private currentMinute(): string {
    return new Date().toISOString().substring(0, 16);
  }

  /** Current day bucket, format YYYY-MM-DD */
  private currentDay(): string {
    return new Date().toISOString().substring(0, 10);
  }

  private state(siteUrl: string): QuotaState {
    let s = this.sites.get(siteUrl);
    if (!s) {
      s = {
        saMinute: this.currentMinute(),
        saCountThisMinute: 0,
        inspectionMinute: this.currentMinute(),
        inspectionCountThisMinute: 0,
        inspectionDay: this.currentDay(),
        inspectionCountToday: 0,
      };
      this.sites.set(siteUrl, s);
    }
    return s;
  }

  private rollSearchAnalytics(s: QuotaState): void {
    const minute = this.currentMinute();
    if (minute !== s.saMinute) {
      s.saMinute = minute;
      s.saCountThisMinute = 0;
    }
  }

  private rollInspection(s: QuotaState): void {
    const minute = this.currentMinute();
    if (minute !== s.inspectionMinute) {
      s.inspectionMinute = minute;
      s.inspectionCountThisMinute = 0;
    }
    const day = this.currentDay();
    if (day !== s.inspectionDay) {
      s.inspectionDay = day;
      s.inspectionCountToday = 0;
    }
  }

  /**
   * Records a Search Analytics API call for a site.
   * @returns Warning message if approaching the per-minute limit, null otherwise.
   */
  recordSearchAnalytics(siteUrl: string): string | null {
    const s = this.state(siteUrl);
    this.rollSearchAnalytics(s);
    s.saCountThisMinute++;

    const pct = (s.saCountThisMinute / this.SEARCH_ANALYTICS_PER_MINUTE_LIMIT) * 100;
    if (pct >= 80) {
      return `⚠️  Search Analytics quota for ${siteUrl} at ${pct.toFixed(0)}% this minute ` +
        `(${s.saCountThisMinute}/${this.SEARCH_ANALYTICS_PER_MINUTE_LIMIT} QPM per site).`;
    }
    return null;
  }

  /**
   * Records a URL Inspection API call for a site.
   * @returns Warning message if approaching the per-minute or per-day limit, null otherwise.
   */
  recordUrlInspection(siteUrl: string): string | null {
    const s = this.state(siteUrl);
    this.rollInspection(s);
    s.inspectionCountThisMinute++;
    s.inspectionCountToday++;

    const pctMinute = (s.inspectionCountThisMinute / this.URL_INSPECTION_PER_MINUTE_LIMIT) * 100;
    const pctDay = (s.inspectionCountToday / this.URL_INSPECTION_PER_DAY_LIMIT) * 100;

    if (pctDay >= 80) {
      return `⚠️  URL Inspection for ${siteUrl} at ${pctDay.toFixed(0)}% of the daily cap ` +
        `(${s.inspectionCountToday}/${this.URL_INSPECTION_PER_DAY_LIMIT} QPD per site). ` +
        `The daily limit is hard — remaining inspections today are limited.`;
    }
    if (pctMinute >= 80) {
      return `⚠️  URL Inspection for ${siteUrl} at ${pctMinute.toFixed(0)}% this minute ` +
        `(${s.inspectionCountThisMinute}/${this.URL_INSPECTION_PER_MINUTE_LIMIT} QPM per site). Consider slowing down.`;
    }
    return null;
  }

  /**
   * Recommended delay (ms) between URL inspection calls for a site to stay under
   * 600 QPM. 150ms ≈ 400/min, a safe margin below the 600/min ceiling.
   */
  getRecommendedInspectionDelay(siteUrl: string): number {
    const s = this.state(siteUrl);
    this.rollInspection(s);
    const n = s.inspectionCountThisMinute;
    if (n > 500) return 500;
    if (n > 400) return 300;
    if (n > 300) return 200;
    return 150;
  }

  /**
   * Current quota status per site (feeds the get_quota_status tool). Sites this
   * process has not called yet are absent.
   */
  getStatus(): {
    sites: Record<string, {
      searchAnalytics: { usedThisMinute: number; perMinuteLimit: number; percentThisMinute: number };
      urlInspection: {
        usedThisMinute: number; perMinuteLimit: number;
        usedToday: number; perDayLimit: number; percentToday: number;
      };
    }>;
  } {
    const sites: ReturnType<QuotaTracker['getStatus']>['sites'] = {};
    for (const [siteUrl, s] of this.sites) {
      this.rollSearchAnalytics(s);
      this.rollInspection(s);
      sites[siteUrl] = {
        searchAnalytics: {
          usedThisMinute: s.saCountThisMinute,
          perMinuteLimit: this.SEARCH_ANALYTICS_PER_MINUTE_LIMIT,
          percentThisMinute: (s.saCountThisMinute / this.SEARCH_ANALYTICS_PER_MINUTE_LIMIT) * 100,
        },
        urlInspection: {
          usedThisMinute: s.inspectionCountThisMinute,
          perMinuteLimit: this.URL_INSPECTION_PER_MINUTE_LIMIT,
          usedToday: s.inspectionCountToday,
          perDayLimit: this.URL_INSPECTION_PER_DAY_LIMIT,
          percentToday: (s.inspectionCountToday / this.URL_INSPECTION_PER_DAY_LIMIT) * 100,
        },
      };
    }
    return { sites };
  }
}
