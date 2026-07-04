/**
 * Input validation utilities for business logic and security
 */

/**
 * Validates that a date range is within GSC API limits
 * @see https://developers.google.com/webmaster-tools/v1/searchanalytics/query
 */
export function validateDateRange(startDate: string, endDate: string): void {
  const start = new Date(startDate);
  const end = new Date(endDate);
  
  if (isNaN(start.getTime())) {
    throw new Error(`Invalid startDate: ${startDate}. Must be YYYY-MM-DD format.`);
  }
  
  if (isNaN(end.getTime())) {
    throw new Error(`Invalid endDate: ${endDate}. Must be YYYY-MM-DD format.`);
  }
  
  if (start > end) {
    throw new Error(`startDate (${startDate}) must be before or equal to endDate (${endDate})`);
  }
  
  // GSC keeps ~16 months of data (about 486 days). Use a UTC-safe day count
  // (getTime avoids the local-timezone off-by-one that getMonth would introduce).
  const diffDays = Math.round((end.getTime() - start.getTime()) / 86_400_000);
  if (diffDays > 486) {
    throw new Error(
      `Date range exceeds the Google Search Console limit of ~16 months (486 days). ` +
      `Requested: ${diffDays} days (${startDate} to ${endDate}). Use a shorter date range.`
    );
  }
}

/**
 * Validates the date range for hourly queries (dataState "hourly_all" + "hour"
 * dimension). The Search Analytics API returns hourly data for at most the last
 * 10 days.
 * @see https://developers.google.com/search/blog/2025/04/san-hourly-data
 */
export function validateHourlyRange(startDate: string, endDate: string): void {
  const start = new Date(startDate);
  const end = new Date(endDate);

  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    throw new Error(`Invalid date for hourly query: ${startDate} to ${endDate}. Must be YYYY-MM-DD.`);
  }

  const diffDays = Math.round((end.getTime() - start.getTime()) / 86_400_000);
  if (diffDays > 10) {
    throw new Error(
      `Hourly data (dataState "hourly_all") is available for at most 10 days. ` +
      `Requested ${diffDays} days (${startDate} to ${endDate}). Use a shorter, recent range.`
    );
  }
}

/**
 * Validates and normalizes a siteUrl for GSC API
 */
export function validateSiteUrl(siteUrl: string): string {
  if (!siteUrl || typeof siteUrl !== 'string') {
    throw new Error('siteUrl is required and must be a string');
  }
  
  // Already in sc-domain format
  if (siteUrl.startsWith('sc-domain:')) {
    const domain = siteUrl.substring(10);
    if (!domain || domain.includes(' ')) {
      throw new Error(`Invalid sc-domain format: ${siteUrl}`);
    }
    return siteUrl;
  }
  
  // Must be valid HTTPS URL
  try {
    const url = new URL(siteUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error(`siteUrl must use http or https protocol, got: ${url.protocol}`);
    }
    return siteUrl;
  } catch (err) {
    throw new Error(
      `Invalid siteUrl: ${siteUrl}. Must be a valid URL (https://example.com/) ` +
      `or sc-domain format (sc-domain:example.com)`
    );
  }
}

/**
 * Validates a regex pattern for safety (prevents ReDoS)
 */
export function validateRegex(pattern: string): void {
  if (!pattern) return;
  
  // Length limit. The pattern is forwarded to the GSC API (which enforces its
  // own limits) and is only compiled here for syntax validation, never executed
  // against input, so there is no ReDoS surface on this server to guard.
  if (pattern.length > 500) {
    throw new Error(
      `Regex pattern too long (${pattern.length} chars). Maximum: 500 characters. ` +
      `Use simpler patterns or break into multiple queries.`
    );
  }

  // Validate it's actually valid regex
  try {
    new RegExp(pattern);
  } catch (err) {
    throw new Error(`Invalid regex pattern: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Validates array input length (prevent DoS)
 */
export function validateArrayLength<T>(
  arr: T[] | undefined,
  maxLength: number,
  fieldName: string,
): T[] {
  if (!arr) return [];
  
  if (arr.length > maxLength) {
    throw new Error(
      `${fieldName} exceeds maximum length. Provided: ${arr.length}, Maximum: ${maxLength}. ` +
      `Please reduce the number of items or use pagination.`
    );
  }
  
  return arr;
}

/**
 * Redacts sensitive data from log messages
 */
export function sanitizeForLogging(message: string): string {
  // Redact common secret patterns
  return message
    .replace(/key=["']?[^"'\s]+["']?/gi, 'key=***')
    .replace(/token=["']?[^"'\s]+["']?/gi, 'token=***')
    .replace(/apikey=["']?[^"'\s]+["']?/gi, 'apikey=***')
    .replace(/password=["']?[^"'\s]+["']?/gi, 'password=***')
    .replace(/secret=["']?[^"'\s]+["']?/gi, 'secret=***')
    .replace(/authorization:\s*bearer\s+\S+/gi, 'authorization: Bearer ***')
    // Redact absolute filesystem paths to credential-like files, on any OS user
    // dir (/Users, /home, /root, /var, ...), not just /home.
    .replace(/(?:\/[\w.\-]+)+\.(json|key|pem|p12)/gi, '[REDACTED_PATH]');
}

/**
 * Parses Google API error and provides actionable guidance
 */
export function parseGoogleApiError(err: any): Error {
  const message = err?.message || String(err);
  const code = err?.code || err?.response?.status;
  
  // Sanitize error message
  const sanitized = sanitizeForLogging(message);
  
  // Provide actionable guidance based on error code
  if (code === 403 || sanitized.toLowerCase().includes('permission')) {
    return new Error(
      `Permission denied. Make sure:\n` +
      `1. Service account email is added as an Owner in Google Search Console\n` +
      `2. Search Console API is enabled in Google Cloud Console\n` +
      `3. siteUrl exactly matches a property you have access to (use list_sites to verify)\n` +
      `Original error: ${sanitized}`
    );
  }
  
  if (code === 429 || sanitized.toLowerCase().includes('quota')) {
    return new Error(
      `API quota exceeded. Google Search Console per-site limits:\n` +
      `- searchanalytics.query: 1,200 queries/minute per site\n` +
      `- urlInspection.index.inspect: 600 queries/minute AND 2,000 queries/day per site\n` +
      `Slow down (per-minute limits reset each minute); the URL Inspection daily cap resets after 24h.\n` +
      `Original error: ${sanitized}`
    );
  }
  
  if (code === 400 || sanitized.toLowerCase().includes('invalid')) {
    return new Error(
      `Invalid request. Common causes:\n` +
      `- siteUrl doesn't match a property (use list_sites to verify)\n` +
      `- Date range is invalid or exceeds 16 months\n` +
      `- Dimension/filter combination not supported\n` +
      `Original error: ${sanitized}`
    );
  }
  
  if (code === 500 || code === 503) {
    return new Error(
      `Google Search Console API is temporarily unavailable (${code}). ` +
      `This is usually transient. Retry in a few minutes. ` +
      `Original error: ${sanitized}`
    );
  }
  
  // Generic error with sanitized message
  return new Error(`Google Search Console API error: ${sanitized}`);
}
