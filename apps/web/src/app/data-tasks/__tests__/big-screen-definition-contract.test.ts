import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { draftDefinition, emptyDraft, type Draft } from "../big-screen-draft";
import { resolveBigScreenRefreshMs } from "../big-screen-data-loop";
import { sampleTemplate } from "./sample-template";

/**
 * The console builds a definition and the API normalizes it. Nothing type-checks
 * across that seam — `draftDefinition` returns `Record<string, unknown>` and
 * `normalizeBigScreenDefinition` takes one — so a field the console starts
 * sending, or stops sending, is only caught here.
 *
 * `normalize` below is a hand-kept mirror of the API's normalizer, not an
 * import: the API never imports the web app, and reaching across two tsconfig
 * roots would tie the suites together. The drift test at the bottom reads the
 * API source and fails when the shape it mirrors moves, so the mirror cannot
 * quietly go stale.
 */

const apiSource = readFileSync(
  fileURLToPath(new URL("../../../../../api/src/big-screen.ts", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

const apiConstant = (name: string): number => {
  const match = new RegExp(`export const ${name} = ([^;]+);`).exec(apiSource);
  expect(match, `${name} in apps/api/src/big-screen.ts`).not.toBeNull();
  const expression = match![1].replace(/HOUR_MS/g, "3600000").replace(/_/g, "");
  if (!/^[0-9 *]+$/.test(expression)) throw new Error(`Unexpected expression: ${expression}`);
  return expression.split("*").reduce((value, factor) => value * Number(factor.trim()), 1);
};

const MAX_DATASETS = apiConstant("MAX_BIG_SCREEN_DATASETS");
const MAX_LIMIT = apiConstant("MAX_BIG_SCREEN_LIMIT");
const DEFAULT_LIMIT = apiConstant("DEFAULT_BIG_SCREEN_LIMIT");
const DEFAULT_REFRESH = apiConstant("DEFAULT_BIG_SCREEN_REFRESH_MS");
const MIN_REFRESH = apiConstant("MIN_BIG_SCREEN_REFRESH_MS");
const MAX_REFRESH = apiConstant("MAX_BIG_SCREEN_REFRESH_MS");

const asString = (value: unknown): string => (typeof value === "string" ? value : "");
const clampNumber = (value: unknown, min: number, max: number, fallback: number): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
};

/** Mirror of `normalizeBigScreenDefinition` in apps/api/src/big-screen.ts. */
const normalize = (payload: Record<string, unknown>) => {
  const rawDatasets = Array.isArray(payload.datasets) ? payload.datasets : [];
  const datasets = rawDatasets
    .slice(0, MAX_DATASETS)
    .map((raw, index) => {
      const entry = raw as Record<string, unknown>;
      const rawRules = Array.isArray(entry.rules) ? entry.rules : [];
      const rules = rawRules
        .map((rawRule) => {
          const rule = rawRule as Record<string, unknown>;
          const normalized = {
            column: asString(rule.column),
            target: asString(rule.target),
          } as { column: string; target: string; label?: string };
          const label = asString(rule.label);
          return label ? { ...normalized, label } : normalized;
        })
        .filter((rule) => rule.column !== "" && rule.target !== "");
      return {
        id: asString(entry.id) || `dataset-${index + 1}`,
        sql: typeof entry.sql === "string" ? entry.sql : "",
        rules,
        datasourceId: asString(entry.datasourceId) || undefined,
        limit: entry.limit === undefined ? undefined : clampNumber(entry.limit, 1, MAX_LIMIT, DEFAULT_LIMIT),
      };
    });

  return {
    templateId: asString(payload.templateId),
    title: asString(payload.title) || undefined,
    datasourceId: asString(payload.datasourceId) || undefined,
    refreshMs: Math.round(clampNumber(payload.refreshMs, MIN_REFRESH, MAX_REFRESH, DEFAULT_REFRESH) / MIN_REFRESH) * MIN_REFRESH,
    prefetchRows: clampNumber(payload.prefetchRows, 0, MAX_LIMIT, 0),
    visiblePoints: clampNumber(payload.visiblePoints, 1, MAX_LIMIT, 7),
    datasets,
  };
};

const draftWith = (patch: Partial<Draft>): Draft => ({
  ...emptyDraft(sampleTemplate),
  ...patch,
});

describe("console definition against the API normalizer", () => {
  it("round-trips a fully specified screen without losing a field", () => {
    const draft = draftWith({
      templateId: "home",
      title: "质量总览",
      datasourceId: "db-1",
      refreshMs: 7_200_000,
      prefetchRows: 120,
      visiblePoints: 9,
      datasets: [
        {
          key: "a",
          id: "kpi-daily",
          datasourceId: "db-2",
          sql: "select * from kpi",
          limit: "80",
          rules: [
            { column: "pass_rate", target: "kpi.passRate" },
            { column: "month", target: "months[]", label: "month" },
          ],
        },
      ],
    });

    const normalized = normalize(draftDefinition(draft));

    expect(normalized.templateId).toBe("home");
    expect(normalized.title).toBe("质量总览");
    expect(normalized.datasourceId).toBe("db-1");
    expect(normalized.refreshMs).toBe(7_200_000);
    expect(normalized.prefetchRows).toBe(120);
    expect(normalized.visiblePoints).toBe(9);
    expect(normalized.datasets).toEqual([
      {
        id: "kpi-daily",
        sql: "select * from kpi",
        datasourceId: "db-2",
        limit: 80,
        rules: [
          { column: "pass_rate", target: "kpi.passRate" },
          { column: "month", target: "months[]", label: "month" },
        ],
      },
    ]);
  });

  it("leaves a blank datasource undefined so the screen's own is inherited", () => {
    // The console relies on `??` chains on the API side: an empty string would
    // be truthy-checked away by `asString(...) || undefined` anyway, but sending
    // "" would also break the `requestedDatasourceId ?? definition.datasourceId`
    // fallback if the API ever stopped trimming.
    const normalized = normalize(draftDefinition(draftWith({ datasourceId: "" })));
    expect(normalized.datasourceId).toBeUndefined();
    expect("datasourceId" in draftDefinition(draftWith({ datasourceId: "" }))).toBe(false);
  });

  it("leaves a blank row limit undefined so the prefetch buffer sizes the query", () => {
    // A `0` here would otherwise be clamped up to 1 and starve every query.
    const draft = draftWith({
      datasets: [{ key: "a", id: "d1", datasourceId: "", sql: "select 1", limit: "", rules: [] }],
    });
    const definition = draftDefinition(draft);
    expect((definition.datasets as Array<Record<string, unknown>>)[0]).not.toHaveProperty("limit");
    expect(normalize(definition).datasets[0].limit).toBeUndefined();
  });

  it("drops a dataset with no SQL instead of sending an empty query", () => {
    const draft = draftWith({
      datasets: [
        { key: "a", id: "kept", datasourceId: "", sql: "select 1", limit: "", rules: [] },
        { key: "b", id: "dropped", datasourceId: "", sql: "   ", limit: "", rules: [] },
      ],
    });
    const normalized = normalize(draftDefinition(draft));
    expect(normalized.datasets.map((entry) => entry.id)).toEqual(["kept"]);
  });

  it("drops a half-filled binding rather than sending a rule with a blank half", () => {
    const draft = draftWith({
      datasets: [
        {
          key: "a",
          id: "d1",
          datasourceId: "",
          sql: "select 1",
          limit: "",
          rules: [
            { column: "ok", target: "kpi.ok" },
            { column: "", target: "kpi.orphan" },
            { column: "orphan2", target: "" },
          ],
        },
      ],
    });
    const [dataset] = normalize(draftDefinition(draft)).datasets;
    expect(dataset.rules).toEqual([{ column: "ok", target: "kpi.ok" }]);
  });

  it("never exceeds the dataset ceiling the API truncates at", () => {
    // The API `.slice(0, 24)`s silently. If the console let an operator build a
    // 25th category, the screen would save "successfully" minus one query.
    const draft = draftWith({
      datasets: Array.from({ length: MAX_DATASETS }, (_, index) => ({
        key: `k${index}`,
        id: `d${index}`,
        datasourceId: "",
        sql: `select ${index}`,
        limit: "",
        rules: [],
      })),
    });
    const definition = draftDefinition(draft);
    expect((definition.datasets as unknown[]).length).toBe(MAX_DATASETS);
    expect(normalize(definition).datasets).toHaveLength(MAX_DATASETS);
  });

  it("keeps typed numbers inside the range the API clamps to", () => {
    const normalized = normalize(
      draftDefinition(draftWith({ refreshMs: 1, prefetchRows: 99_999, visiblePoints: 99_999 })),
    );
    expect(normalized.refreshMs).toBe(MIN_REFRESH);
    expect(normalized.prefetchRows).toBe(MAX_LIMIT);
    expect(normalized.visiblePoints).toBe(MAX_LIMIT);
  });
});

describe("wall cadence resolution", () => {
  it("prefers the live override, then the saved screen, then the template", () => {
    // The override is what the console passes while previewing, and the template
    // figure is the last resort for a screen saved before the field existed.
    expect(resolveBigScreenRefreshMs(1200, 3000, 2600)).toBe(1200);
    expect(resolveBigScreenRefreshMs(undefined, 3000, 2600)).toBe(3000);
    expect(resolveBigScreenRefreshMs(undefined, undefined, 2600)).toBe(2600);
  });

  it("discards a non-positive cadence rather than polling continuously", () => {
    // `0` would otherwise become a setInterval that fires as fast as the network
    // answers, so a broken value falls through to the caller's fallback.
    expect(resolveBigScreenRefreshMs(0, 3000, 2600)).toBe(2600);
    expect(resolveBigScreenRefreshMs(undefined, 0, 2600)).toBe(2600);
    expect(resolveBigScreenRefreshMs(-1, -1, 2600)).toBe(2600);
  });
});

describe("normalizer mirror drift", () => {
  it("still matches the API source it mirrors", () => {
    // Every structural claim `normalize` above encodes, asserted against the
    // real file — so the mirror is only allowed to be wrong for one commit.
    expect(apiSource).toContain(".slice(0, MAX_BIG_SCREEN_DATASETS)");
    // The cadence and the two row budgets are clamped on the way in, each with
    // its own ceiling — visiblePoints deliberately falls back to a chart-sized
    // window rather than the full prefetch budget.
    expect(apiSource).toContain("clampNumber(\n    source.refreshMs ?? source.refresh_ms,\n    MIN_BIG_SCREEN_REFRESH_MS,\n    MAX_BIG_SCREEN_REFRESH_MS,\n    DEFAULT_BIG_SCREEN_REFRESH_MS\n  )");
    expect(apiSource).toContain("clampNumber(\n    source.prefetchRows ?? source.prefetch_rows,\n    0,\n    MAX_BIG_SCREEN_LIMIT,\n    0\n  )");
    expect(apiSource).toContain("clampNumber(\n    source.visiblePoints ?? source.visible_points,\n    1,\n    MAX_BIG_SCREEN_LIMIT,\n    7\n  )");
    // A per-dataset cadence or row limit is clamped too, and stays absent when
    // the dataset did not ask for one.
    expect(apiSource).toContain("clampNumber(refreshMs, MIN_BIG_SCREEN_REFRESH_MS, MAX_BIG_SCREEN_REFRESH_MS, DEFAULT_BIG_SCREEN_REFRESH_MS)");
    expect(apiSource).toContain("clampNumber(limit, 1, MAX_BIG_SCREEN_LIMIT, DEFAULT_BIG_SCREEN_LIMIT)");
    // Absent optional fields must stay absent on the way through, not become "".
    expect(apiSource).toContain("...(asString(source.title) ? { title: asString(source.title) } : {})");
    expect(apiSource).toContain("...(datasourceId ? { datasourceId } : {})");
    expect(apiSource).toContain("...(limit === undefined\n          ? {}\n          : { limit:");
    expect(apiSource).toContain('.filter((rule) => rule.column !== "" && rule.target !== "")');
  });
});
