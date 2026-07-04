/**
 * Simple quota tracker for the Google Search Console API.
 *
 * Official per-site limits (https://developers.google.com/webmaster-tools/limits):
 * - Search Analytics (searchanalytics.query): 1,200 QPM per site (per-MINUTE)
 * - URL Inspection (urlInspection.index.inspect): 600 QPM AND 2,000 QPD per site
 *
 * This tracker warns as we approach these limits; it does not enforce them
 * (the API enforces its own quotas). Counts are per-process and best-effort —
 * per-site/user/project accounting server-side may differ.
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
  private state: QuotaState;

  // Official per-site limits.
  private readonly SEARCH_ANALYTICS_PER_MINUTE_LIMIT = 1200;
  private readonly URL_INSPECTION_PER_MINUTE_LIMIT = 600;
  private readonly URL_INSPECTION_PER_DAY_LIMIT = 2000;

  constructor() {
    this.state = {
      saMinute: this.currentMinute(),
      saCountThisMinute: 0,
      inspectionMinute: this.currentMinute(),
      inspectionCountThisMinute: 0,
      inspectionDay: this.currentDay(),
      inspectionCountToday: 0,
    };
  }

  /** Current minute bucket, format YYYY-MM-DDTHH:MM */
  private currentMinute(): string {
    return new Date().toISOString().substring(0, 16);
  }

  /** Current day bucket, format YYYY-MM-DD */
  private currentDay(): string {
    return new Date().toISOString().substring(0, 10);
  }

  private rollSearchAnalytics(): void {
    const minute = this.currentMinute();
    if (minute !== this.state.saMinute) {
      this.state.saMinute = minute;
      this.state.saCountThisMinute = 0;
    }
  }

  private rollInspection(): void {
    const minute = this.currentMinute();
    if (minute !== this.state.inspectionMinute) {
      this.state.inspectionMinute = minute;
      this.state.inspectionCountThisMinute = 0;
    }
    const day = this.currentDay();
    if (day !== this.state.inspectionDay) {
      this.state.inspectionDay = day;
      this.state.inspectionCountToday = 0;
    }
  }

  /**
   * Records a Search Analytics API call.
   * @returns Warning message if approaching the per-minute limit, null otherwise.
   */
  recordSearchAnalytics(): string | null {
    this.rollSearchAnalytics();
    this.state.saCountThisMinute++;

    const pct = (this.state.saCountThisMinute / this.SEARCH_ANALYTICS_PER_MINUTE_LIMIT) * 100;
    if (pct >= 80) {
      return `⚠️  Search Analytics quota at ${pct.toFixed(0)}% this minute ` +
        `(${this.state.saCountThisMinute}/${this.SEARCH_ANALYTICS_PER_MINUTE_LIMIT} QPM per site).`;
    }
    return null;
  }

  /**
   * Records a URL Inspection API call.
   * @returns Warning message if approaching the per-minute or per-day limit, null otherwise.
   */
  recordUrlInspection(): string | null {
    this.rollInspection();
    this.state.inspectionCountThisMinute++;
    this.state.inspectionCountToday++;

    const pctMinute = (this.state.inspectionCountThisMinute / this.URL_INSPECTION_PER_MINUTE_LIMIT) * 100;
    const pctDay = (this.state.inspectionCountToday / this.URL_INSPECTION_PER_DAY_LIMIT) * 100;

    if (pctDay >= 80) {
      return `⚠️  URL Inspection at ${pctDay.toFixed(0)}% of the daily cap ` +
        `(${this.state.inspectionCountToday}/${this.URL_INSPECTION_PER_DAY_LIMIT} QPD per site). ` +
        `The daily limit is hard — remaining inspections today are limited.`;
    }
    if (pctMinute >= 80) {
      return `⚠️  URL Inspection at ${pctMinute.toFixed(0)}% this minute ` +
        `(${this.state.inspectionCountThisMinute}/${this.URL_INSPECTION_PER_MINUTE_LIMIT} QPM per site). Consider slowing down.`;
    }
    return null;
  }

  /**
   * Recommended delay (ms) between URL inspection calls to stay under 600 QPM.
   * 150ms ≈ 400/min, a safe margin below the 600/min ceiling.
   */
  getRecommendedInspectionDelay(): number {
    this.rollInspection();
    const n = this.state.inspectionCountThisMinute;
    if (n > 500) return 500;
    if (n > 400) return 300;
    if (n > 300) return 200;
    return 150;
  }

  /**
   * Current quota status (feeds the get_quota_status tool).
   */
  getStatus(): {
    searchAnalytics: { usedThisMinute: number; perMinuteLimit: number; percentThisMinute: number };
    urlInspection: {
      usedThisMinute: number; perMinuteLimit: number;
      usedToday: number; perDayLimit: number; percentToday: number;
    };
  } {
    this.rollSearchAnalytics();
    this.rollInspection();

    return {
      searchAnalytics: {
        usedThisMinute: this.state.saCountThisMinute,
        perMinuteLimit: this.SEARCH_ANALYTICS_PER_MINUTE_LIMIT,
        percentThisMinute: (this.state.saCountThisMinute / this.SEARCH_ANALYTICS_PER_MINUTE_LIMIT) * 100,
      },
      urlInspection: {
        usedThisMinute: this.state.inspectionCountThisMinute,
        perMinuteLimit: this.URL_INSPECTION_PER_MINUTE_LIMIT,
        usedToday: this.state.inspectionCountToday,
        perDayLimit: this.URL_INSPECTION_PER_DAY_LIMIT,
        percentToday: (this.state.inspectionCountToday / this.URL_INSPECTION_PER_DAY_LIMIT) * 100,
      },
    };
  }
}
