import { describe, expect, it } from "vitest";
import type { BigScreenDataDto } from "../../../lib/config-api";
import {
  EMPTY_BIG_SCREEN_FETCH_STATE,
  applyBigScreenFetchResult,
  isLatestBigScreenRequest,
  nextBigScreenPollAt,
  resolveBigScreenRefreshMs,
} from "../big-screen-data-loop";

const payload = (data: Record<string, unknown>): BigScreenDataDto =>
  ({
    screenId: "s1",
    templateId: "home",
    generatedAt: "2026-01-01T00:00:00.000Z",
    refreshMs: 2600,
    prefetchRows: 50,
    data,
    datasets: [],
  }) as BigScreenDataDto;

describe("applyBigScreenFetchResult", () => {
  it("records the patch, count and time on success", () => {
    const next = applyBigScreenFetchResult(
      EMPTY_BIG_SCREEN_FETCH_STATE,
      { ok: true, payload: payload({ kpi: { passRate: 86 } }) },
      1000,
    );

    expect(next).toEqual({
      data: { kpi: { passRate: 86 } },
      successCount: 1,
      error: null,
      updatedAt: 1000,
      failedDatasets: [],
    });
  });

  it("surfaces datasets the API answered with an error", () => {
    // The request itself succeeded, so `error` stays null — without this list the
    // wall would look healthy while that category renders bundled demo numbers.
    const next = applyBigScreenFetchResult(
      EMPTY_BIG_SCREEN_FETCH_STATE,
      {
        ok: true,
        payload: {
          ...payload({ kpi: { passRate: 86 } }),
          datasets: [
            { id: "monthly", error: undefined },
            { id: "issues", error: "no such column: created_at" },
          ],
        } as BigScreenDataDto,
      },
      1000,
    );

    expect(next.error).toBeNull();
    expect(next.failedDatasets).toEqual([
      { id: "issues", error: "no such column: created_at" },
    ]);
  });

  it("drops the failure list once every dataset succeeds again", () => {
    const broken = applyBigScreenFetchResult(
      EMPTY_BIG_SCREEN_FETCH_STATE,
      {
        ok: true,
        payload: {
          ...payload({}),
          datasets: [{ id: "issues", error: "no such column: created_at" }],
        } as BigScreenDataDto,
      },
      1000,
    );
    const healed = applyBigScreenFetchResult(
      broken,
      { ok: true, payload: payload({ kpi: { passRate: 90 } }) },
      2000,
    );

    expect(healed.failedDatasets).toEqual([]);
  });

  it("keeps the last good patch when a poll fails", () => {
    const good = applyBigScreenFetchResult(
      EMPTY_BIG_SCREEN_FETCH_STATE,
      { ok: true, payload: payload({ kpi: { passRate: 86 } }) },
      1000,
    );
    const failed = applyBigScreenFetchResult(good, { ok: false, error: "timeout" }, 2000);

    // Unattended wall: stale numbers with a badge beat a blank screen.
    expect(failed.data).toEqual({ kpi: { passRate: 86 } });
    expect(failed.successCount).toBe(1);
    expect(failed.updatedAt).toBe(1000);
    expect(failed.error).toBe("timeout");
  });

  it("clears the failure message once a poll succeeds", () => {
    const failed = applyBigScreenFetchResult(
      EMPTY_BIG_SCREEN_FETCH_STATE,
      { ok: false, error: "timeout" },
      1000,
    );
    const recovered = applyBigScreenFetchResult(
      failed,
      { ok: true, payload: payload({ kpi: { passRate: 90 } }) },
      2000,
    );

    expect(recovered.error).toBeNull();
    expect(recovered.updatedAt).toBe(2000);
    expect(recovered.successCount).toBe(1);
  });

  it("treats a response with no patch as an empty one", () => {
    const next = applyBigScreenFetchResult(
      { ...EMPTY_BIG_SCREEN_FETCH_STATE, data: { months: ["1月"] } },
      { ok: true, payload: { ...payload({}), data: undefined as never } },
      500,
    );

    expect(next.data).toEqual({});
  });
});

describe("resolveBigScreenRefreshMs", () => {
  it("prefers the cadence the caller pinned", () => {
    expect(resolveBigScreenRefreshMs(9000, 2600, 5000)).toBe(9000);
  });

  it("falls back to the cadence the backend resolved", () => {
    expect(resolveBigScreenRefreshMs(undefined, 12000, 2600)).toBe(12000);
  });

  it("uses the template default when neither is set", () => {
    expect(resolveBigScreenRefreshMs(undefined, undefined, 2600)).toBe(2600);
  });

  it("rejects a cadence that would busy-loop or never fire", () => {
    expect(resolveBigScreenRefreshMs(0, undefined, 2600)).toBe(2600);
    expect(resolveBigScreenRefreshMs(-1, undefined, 2600)).toBe(2600);
    expect(resolveBigScreenRefreshMs(Number.NaN, undefined, 2600)).toBe(2600);
    expect(resolveBigScreenRefreshMs(Number.POSITIVE_INFINITY, undefined, 2600)).toBe(2600);
    // Zero from the backend is "unset", not "poll forever".
    expect(resolveBigScreenRefreshMs(undefined, 0, 2600)).toBe(2600);
  });
});

describe("isLatestBigScreenRequest", () => {
  it("accepts only the newest in-flight poll", () => {
    expect(isLatestBigScreenRequest(4, 4)).toBe(true);
    // A slow query can return after the poll that superseded it.
    expect(isLatestBigScreenRequest(3, 4)).toBe(false);
  });
});

describe("nextBigScreenPollAt", () => {
  const HOUR = 3_600_000;

  it("asks just after the server's shared answer lapses", () => {
    // A wall opened 40 minutes into the interval asks 20 minutes later, not an
    // hour later — so it neither drifts behind nor starts a second SQL run.
    expect(nextBigScreenPollAt(20 * 60_000, HOUR, 1000)).toBe(1000 + 20 * 60_000 + 5_000);
  });

  it("waits one interval when the server gave no expiry", () => {
    expect(nextBigScreenPollAt(undefined, HOUR, 1000)).toBe(1000 + HOUR);
  });

  it("ignores an expiry the interval could not have produced", () => {
    expect(nextBigScreenPollAt(-5, HOUR, 1000)).toBe(1000 + HOUR);
    expect(nextBigScreenPollAt(2 * HOUR, HOUR, 1000)).toBe(1000 + HOUR);
    expect(nextBigScreenPollAt(Number.NaN, HOUR, 1000)).toBe(1000 + HOUR);
  });
});
