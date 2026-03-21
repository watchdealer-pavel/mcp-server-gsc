/**
 * Simple quota tracker for Google Search Console API
 * 
 * GSC API limits (approximate):
 * - searchanalytics.query: ~1,200 requests per day
 * - urlInspection.index.inspect: ~600 requests per minute
 * 
 * This tracker warns when approaching limits but doesn't enforce them
 * (enforcement is handled by the API itself).
 */

interface QuotaState {
  searchAnalyticsCount: number;
  urlInspectionCount: number;
  lastResetDate: string;
  lastInspectionMinute: string;
  inspectionCountThisMinute: number;
}

export class QuotaTracker {
  private state: QuotaState;
  
  // Estimated daily limits (conservative)
  private readonly SEARCH_ANALYTICS_DAILY_LIMIT = 1200;
  private readonly URL_INSPECTION_PER_MINUTE_LIMIT = 600;
  
  constructor() {
    const today = new Date().toISOString().split('T')[0];
    this.state = {
      searchAnalyticsCount: 0,
      urlInspectionCount: 0,
      lastResetDate: today,
      lastInspectionMinute: this.getCurrentMinute(),
      inspectionCountThisMinute: 0,
    };
  }
  
  /**
   * Gets current minute in format YYYY-MM-DDTHH:MM
   */
  private getCurrentMinute(): string {
    const now = new Date();
    return now.toISOString().substring(0, 16); // YYYY-MM-DDTHH:MM
  }
  
  /**
   * Resets daily counters if it's a new day
   */
  private maybeResetDaily(): void {
    const today = new Date().toISOString().split('T')[0];
    if (today !== this.state.lastResetDate) {
      this.state.searchAnalyticsCount = 0;
      this.state.urlInspectionCount = 0;
      this.state.lastResetDate = today;
    }
  }
  
  /**
   * Resets per-minute counter if it's a new minute
   */
  private maybeResetMinute(): void {
    const currentMinute = this.getCurrentMinute();
    if (currentMinute !== this.state.lastInspectionMinute) {
      this.state.inspectionCountThisMinute = 0;
      this.state.lastInspectionMinute = currentMinute;
    }
  }
  
  /**
   * Records a search analytics API call
   * @returns Warning message if approaching limit, null otherwise
   */
  recordSearchAnalytics(): string | null {
    this.maybeResetDaily();
    this.state.searchAnalyticsCount++;
    
    const percentUsed = (this.state.searchAnalyticsCount / this.SEARCH_ANALYTICS_DAILY_LIMIT) * 100;
    
    if (percentUsed >= 90) {
      return `⚠️  Search Analytics quota at ${percentUsed.toFixed(0)}% (${this.state.searchAnalyticsCount}/${this.SEARCH_ANALYTICS_DAILY_LIMIT} today). Approaching daily limit.`;
    } else if (percentUsed >= 80) {
      return `⚠️  Search Analytics quota at ${percentUsed.toFixed(0)}% (${this.state.searchAnalyticsCount}/${this.SEARCH_ANALYTICS_DAILY_LIMIT} today).`;
    }
    
    return null;
  }
  
  /**
   * Records a URL inspection API call
   * @returns Warning message if approaching limit, null otherwise
   */
  recordUrlInspection(): string | null {
    this.maybeResetDaily();
    this.maybeResetMinute();
    
    this.state.urlInspectionCount++;
    this.state.inspectionCountThisMinute++;
    
    const percentUsedMinute = (this.state.inspectionCountThisMinute / this.URL_INSPECTION_PER_MINUTE_LIMIT) * 100;
    
    if (percentUsedMinute >= 80) {
      return `⚠️  URL Inspection quota at ${percentUsedMinute.toFixed(0)}% this minute (${this.state.inspectionCountThisMinute}/${this.URL_INSPECTION_PER_MINUTE_LIMIT}). Consider slowing down.`;
    }
    
    return null;
  }
  
  /**
   * Calculates recommended delay for URL inspection batch operations
   * to stay under rate limit (600/min = 1 request per 100ms minimum)
   */
  getRecommendedInspectionDelay(): number {
    this.maybeResetMinute();
    
    const requestsThisMinute = this.state.inspectionCountThisMinute;
    
    // If we're approaching limit, increase delay
    if (requestsThisMinute > 500) {
      return 500; // 500ms delay when near limit
    } else if (requestsThisMinute > 400) {
      return 300;
    } else if (requestsThisMinute > 300) {
      return 200;
    }
    
    return 150; // Default: 150ms = 400 req/min (safe margin)
  }
  
  /**
   * Gets current quota status
   */
  getStatus(): {
    searchAnalytics: { used: number; limit: number; percent: number };
    urlInspection: { usedToday: number; usedThisMinute: number; minuteLimit: number };
  } {
    this.maybeResetDaily();
    this.maybeResetMinute();
    
    return {
      searchAnalytics: {
        used: this.state.searchAnalyticsCount,
        limit: this.SEARCH_ANALYTICS_DAILY_LIMIT,
        percent: (this.state.searchAnalyticsCount / this.SEARCH_ANALYTICS_DAILY_LIMIT) * 100,
      },
      urlInspection: {
        usedToday: this.state.urlInspectionCount,
        usedThisMinute: this.state.inspectionCountThisMinute,
        minuteLimit: this.URL_INSPECTION_PER_MINUTE_LIMIT,
      },
    };
  }
}
