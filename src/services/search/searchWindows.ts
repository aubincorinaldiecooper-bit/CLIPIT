/**
 * Prompt-size budgeting for the index-backed search.
 *
 * The index search sends the whole video's evidence — every scene and every
 * transcript line — in one request. That is correct and cheap for a 20-minute
 * video and impossible for a six-hour one: a 6h transcript alone runs past any
 * current context window, which fails the request outright at the moment the
 * user asks a question.
 *
 * Rather than truncate (which silently loses the answer) the timeline is split
 * into ordered windows, each searched independently. Timestamps are global
 * throughout, so results merge with the same aggregation used for chunk
 * boundaries.
 */

export interface TimedText {
  startSeconds: number;
  endSeconds: number;
}

/**
 * Approximate token count for a string.
 *
 * Deliberately a heuristic: the exact tokenizer varies by model, and the
 * budget only needs to decide "one request or several". Four characters per
 * token is the common English approximation; it over-counts rather than
 * under-counts on the timestamp-dense text this builds.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * How many equal windows the timeline must be split into for each request to
 * fit the budget. Always at least 1.
 */
export function planWindowCount(estimatedTokens: number, budgetTokens: number): number {
  if (!Number.isFinite(estimatedTokens) || estimatedTokens <= 0) return 1;
  if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) return 1;
  return Math.max(1, Math.ceil(estimatedTokens / budgetTokens));
}

export interface SearchWindow {
  index: number;
  startSeconds: number;
  endSeconds: number;
}

/**
 * Splits [0, durationSeconds) into `count` contiguous windows. The last window
 * ends exactly at the duration so nothing past the final boundary is lost.
 */
export function planSearchWindows(durationSeconds: number, count: number): SearchWindow[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return [];
  const windows = Math.max(1, Math.floor(count));
  const step = durationSeconds / windows;

  return Array.from({ length: windows }, (_, index) => ({
    index,
    startSeconds: Number((index * step).toFixed(3)),
    endSeconds: Number((index === windows - 1 ? durationSeconds : (index + 1) * step).toFixed(3)),
  }));
}

/**
 * Items overlapping a window, by the same half-open rule the transcript query
 * uses: an item counts if it ends after the window starts and starts before it
 * ends. An item straddling a boundary therefore appears in both windows, which
 * is what keeps a moment on the seam findable; duplicate matches are merged
 * downstream.
 */
export function itemsInWindow<T extends TimedText>(items: T[], window: SearchWindow): T[] {
  return items.filter((item) => item.endSeconds > window.startSeconds && item.startSeconds < window.endSeconds);
}
