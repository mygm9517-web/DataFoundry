/**
 * Data loop for a rendered big screen.
 *
 * Kept apart from the component so the parts that decide *what* the wall shows
 * — when to refetch, how a failed refresh is treated, how an out-of-order
 * response is dropped — can be reasoned about and tested without a DOM.
 */

import type { BigScreenDataDto } from "../../lib/config-api";

export type BigScreenFetchState = {
  /** Latest patch merged over the template's own `DEFAULT_DATA`. */
  data: Record<string, unknown>;
  /** Successful fetches so far; 0 means the wall is still on bundled data. */
  successCount: number;
  /** Message for the most recent failure, cleared by the next success. */
  error: string | null;
  /** Epoch ms of the last successful fetch. */
  updatedAt: number | null;
  /**
   * Datasets the API answered with an error this cycle. The request itself
   * succeeded, so `error` stays null and the wall would otherwise look healthy
   * while that category renders its bundled demo numbers — the failure has to
   * be carried separately for the screen to admit it.
   */
  failedDatasets: Array<{ id: string; error: string }>;
};

export const EMPTY_BIG_SCREEN_FETCH_STATE: BigScreenFetchState = {
  data: {},
  successCount: 0,
  error: null,
  updatedAt: null,
  failedDatasets: [],
};

/**
 * Wall clocks are unattended: a screen showing last week's numbers is worse
 * than one showing today's with a stale badge, so a failed poll keeps the last
 * good patch rather than clearing it.
 */
export function applyBigScreenFetchResult(
  state: BigScreenFetchState,
  result: { ok: true; payload: BigScreenDataDto } | { ok: false; error: string },
  now: number,
): BigScreenFetchState {
  if (!result.ok) {
    return { ...state, error: result.error };
  }

  return {
    data: result.payload.data ?? {},
    successCount: state.successCount + 1,
    error: null,
    updatedAt: now,
    failedDatasets: (result.payload.datasets ?? [])
      .filter((dataset) => Boolean(dataset.error))
      .map((dataset) => ({ id: dataset.id, error: String(dataset.error) })),
  };
}

/**
 * Poll interval the wall should use. The screen's own cadence wins, but a
 * template's default of a few seconds would hammer the datasource once the
 * screen is saved with a slow query, so the response's resolved cadence is
 * preferred when the caller did not pin one.
 */
export function resolveBigScreenRefreshMs(
  configured: number | undefined,
  fromResponse: number | undefined,
  fallbackMs: number,
): number {
  const candidate = configured ?? fromResponse ?? fallbackMs;
  if (!Number.isFinite(candidate) || candidate <= 0) return fallbackMs;
  return candidate;
}

/**
 * When the wall should ask next, given the answer it was just handed.
 *
 * The server shares one SQL run per interval between every wall, so asking a
 * full interval after *our* request would, for a wall opened mid-interval, land
 * after the shared answer expired and start a second run against a datasource
 * with few connections — or, the other way round, keep receiving the cached
 * answer and drift a whole interval behind. The server says how long its answer
 * stays shared (`refreshInMs`), measured on its own clock, so asking just after
 * that keeps every wall on the same beat whatever the browser's clock reads.
 * An answer without it (older API, preview run) waits one interval.
 */
export function nextBigScreenPollAt(
  refreshInMs: number | undefined,
  cadenceMs: number,
  now: number,
): number {
  if (refreshInMs === undefined || !Number.isFinite(refreshInMs) || refreshInMs < 0 || refreshInMs > cadenceMs) {
    return now + cadenceMs;
  }
  // A few seconds past expiry, so the shared answer has certainly lapsed.
  return now + refreshInMs + 5_000;
}

/**
 * A poll that returns after a newer one started is discarded: on a slow query
 * the responses can invert, and applying the older patch would roll the wall
 * backwards.
 */
export function isLatestBigScreenRequest(
  requestSeq: number,
  latestSeq: number,
): boolean {
  return requestSeq === latestSeq;
}
