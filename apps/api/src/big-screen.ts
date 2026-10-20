import type { LocalDataGateway } from "@datafoundry/data-gateway";

/**
 * Big-screen runtime.
 *
 * A screen definition never carries rendered markup — it only describes which
 * dataset feeds which field of a template's data contract. The template files
 * under `apps/web/bigscreen/<template>/` keep their own `DEFAULT_DATA` and
 * `mergeData` logic, so the runtime only ever emits a sparse patch that a
 * template merges over its own defaults.
 *
 * They live outside `apps/web/public/` on purpose: Next serves that directory
 * ahead of route handlers, and the `/bigscreen/[...path]` route is what splices
 * the data bridge into each page. A file under `public/` would reach the browser
 * un-spliced and render its bundled demo numbers forever.
 */

export type BigScreenFieldRule = {
  /** Column of the dataset result. */
  column: string;
  /** Dot path inside the template data contract, e.g. `kpi.execRate` or `months[]`. */
  target: string;
  /** Optional fixed label; `[]` targets then emit `{ name, value }` instead of a bare number. */
  label?: string;
  /**
   * Column to read the pair name from, for `[]` targets whose consumer wants
   * `{ name, value }` rows — ECharts pie data, ranked name lists. A template
   * cannot express this by mapping two rules at one target: whichever runs last
   * replaces the other, so the value column and the name column have to travel
   * together in one rule.
   */
  labelColumn?: string;
};

export type BigScreenDataset = {
  id: string;
  /** Datasource the SQL runs against; falls back to the screen's own datasourceId. */
  datasourceId?: string;
  sql: string;
  /** Refresh cadence for this dataset in ms; the fastest dataset drives the screen. */
  refreshMs?: number;
  /** Rows pulled per request; also the upper bound used for prefetch. */
  limit?: number;
  rules: BigScreenFieldRule[];
};

export type BigScreenDefinition = {
  templateId: string;
  title?: string;
  datasourceId?: string;
  refreshMs?: number;
  /** Extra rows kept in the browser buffer beyond the visible window. */
  prefetchRows?: number;
  /** How many points a scrolling template window shows; used to size prefetch. */
  visiblePoints?: number;
  datasets: BigScreenDataset[];
};

export type BigScreenDatasetResult = {
  id: string;
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  elapsedMs: number;
  error?: string;
};

/**
 * Screens refresh on an hourly-or-slower cadence: they read business tables on a
 * datasource with few connections to spare, and nobody watches a wall for
 * sub-hour changes. The value is still stored in milliseconds so existing
 * screens keep loading; only the bounds changed.
 */
export const HOUR_MS = 3_600_000;
export const DEFAULT_BIG_SCREEN_REFRESH_MS = HOUR_MS;
export const MIN_BIG_SCREEN_REFRESH_MS = HOUR_MS;
export const MAX_BIG_SCREEN_REFRESH_MS = 720 * HOUR_MS;
export const DEFAULT_BIG_SCREEN_LIMIT = 50;
export const MAX_BIG_SCREEN_LIMIT = 2000;
export const MAX_BIG_SCREEN_DATASETS = 24;

const clampNumber = (value: unknown, min: number, max: number, fallback: number): number => {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
};

const asString = (value: unknown): string => typeof value === "string" ? value.trim() : "";

/**
 * Coerce a SQL cell into the shape the templates chart. Numeric strings are the
 * common case (DECIMAL/MONEY columns arrive as strings from most drivers), but a
 * template that charts a category label must keep its text.
 */
export const coerceBigScreenValue = (value: unknown): number | string | null => {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") {
      return null;
    }
    const parsed = Number(trimmed.replace(/,/gu, ""));
    return Number.isFinite(parsed) ? parsed : trimmed;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Deep merge used both for assembling a patch from several datasets and for
 * computing the preview payload the console shows.
 */
export const mergeScreenPatch = (
  base: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key];
    out[key] = isPlainObject(value) && isPlainObject(current)
      ? mergeScreenPatch(current, value)
      : value;
  }
  return out;
};

const setNestedValue = (target: Record<string, unknown>, path: string[], value: unknown): void => {
  let cursor = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index] as string;
    if (!isPlainObject(cursor[key])) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[path[path.length - 1] as string] = value;
};

/**
 * Apply `{ column, target }` rules to one dataset result.
 *
 * `target` supports three forms:
 *   - `a.b.c`     → scalar taken from the first row, deep-merged into the patch
 *   - `a.b.c[]`   → array built from every row, with three shapes per row:
 *                     plain number                        (default)
 *                     `{ name: <fixed label>, value }`    (`label`)
 *                     `{ name: <column>, value }`         (`labelColumn`)
 *   - `a[].x`     → array of row objects, one per result row, each carrying the
 *                   rule's column under `x`. Every rule aimed at the same array
 *                   path contributes its own key, so a scrolling table is spelled
 *                   out one column at a time (`pdt[].time`, `pdt[].no`, ...).
 *
 * `labelColumn` exists for the paired case. A template that charts a
 * distribution needs `[{name, value}]`, and the only other way to produce that
 * is two rules on the same target — which collide, because an array target
 * replaces rather than appends, so the second rule would silently drop the
 * first. Carrying both columns in one rule is what keeps them aligned.
 *
 * Array targets replace rather than append, so a refresh never grows the chart
 * forever and the newest window always wins. Row-object arrays (`a[].x`) are the
 * exception to "one rule, one target": several rules share the path and each
 * fills in its own key, which is why those are assembled per row below rather
 * than written one rule at a time.
 */
export const applyFieldRules = (
  results: BigScreenDatasetResult[],
  datasets: BigScreenDataset[]
): Record<string, unknown> => {
  const byId = new Map(datasets.map((dataset) => [dataset.id, dataset]));
  let patch: Record<string, unknown> = {};
  for (const result of results) {
    const dataset = byId.get(result.id);
    if (!dataset || result.error) {
      continue;
    }
    const headerIndex = new Map(result.columns.map((column, index) => [column, index]));
    const chunks = new Map<string, unknown[]>();
    // Row-object arrays, keyed by the path of the `[]` slot, then by the key each
    // rule contributes. Collected apart from `chunks` because they are assembled
    // per row from every rule, not written once per rule.
    const rowArrays = new Map<string, Array<Record<string, unknown>>>();
    for (const rule of dataset.rules) {
      const column = asString(rule.column);
      const target = asString(rule.target);
      if (!column || !target) {
        continue;
      }
      const index = headerIndex.get(column);
      if (index === undefined) {
        continue;
      }

      // `a[].x` — an array element that is an object, not a scalar slot.
      const rowArray = matchRowArrayTarget(target);
      if (rowArray) {
        const bucket = rowArrays.get(rowArray.arrayPath) ?? [];
        result.rows.forEach((row, rowIndex) => {
          const value = coerceBigScreenValue(row[index]);
          if (value === null) {
            return;
          }
          const entry = (bucket[rowIndex] ??= {});
          setNestedValue(entry, rowArray.rest, value);
        });
        rowArrays.set(rowArray.arrayPath, bucket);
        continue;
      }

      const isArray = target.endsWith("[]");
      const path = (isArray ? target.slice(0, -2) : target).split(".").filter(Boolean);
      if (path.length === 0) {
        continue;
      }
      if (isArray) {
        const label = asString(rule.label);
        const labelColumn = asString(rule.labelColumn);
        // A missing name column degrades to the fixed label (or a bare number)
        // rather than dropping the whole series — a screen that lost its labels
        // still shows its numbers.
        const labelIndex = labelColumn ? headerIndex.get(labelColumn) : undefined;
        const bucket = chunks.get(target) ?? [];
        for (const row of result.rows) {
          const value = coerceBigScreenValue(row[index]);
          if (value === null) {
            continue;
          }
          if (labelIndex === undefined && !label) {
            bucket.push(value);
            continue;
          }
          const pairName = labelIndex === undefined
            ? label
            : coerceBigScreenValue(row[labelIndex]);
          if (pairName === null || pairName === "") {
            continue;
          }
          bucket.push({ name: String(pairName), value });
        }
        chunks.set(target, bucket);
      } else {
        const value = coerceBigScreenValue(result.rows[0]?.[index]);
        if (value === null) {
          continue;
        }
        patch = mergeScreenPatch(patch, buildPathPatch(path, value));
      }
    }
    for (const [target, values] of chunks) {
      const path = target.slice(0, -2).split(".").filter(Boolean);
      if (path.length > 0) {
        patch = mergeScreenPatch(patch, buildPathPatch(path, values));
      }
    }
    // Rows that contributed nothing to any key are dropped rather than emitted
    // as empty objects, so a fully-null SQL row does not become a blank table row.
    for (const [arrayPath, rows] of rowArrays) {
      const filled = rows.filter((entry) => entry && Object.keys(entry).length > 0);
      patch = mergeScreenPatch(patch, buildPathPatch(arrayPath.split(".").filter(Boolean), filled));
    }
  }
  return patch;
};

/**
 * Splits a row-object-array target into the array's path and the key path inside
 * each element. `pdt[].time` yields path `pdt` and inner key `time`.
 *
 * The brackets always ride on the segment they follow — splitting `pdt[].time`
 * on `.` gives `["pdt[]", "time"]`, never a bare `"[]"` segment — which is why
 * the match is a suffix test on each segment rather than a lookup for `[]`.
 *
 * A target whose brackets come last (`documents.rows[]`) is *not* matched here:
 * that spelling means "one scalar per row" and is handled by the array branch of
 * `applyFieldRules`, which is how the bundled procurement page declares its table
 * columns. This handles only the object-per-row form.
 */
const matchRowArrayTarget = (target: string): { arrayPath: string; rest: string[] } | null => {
  const segments = target.split(".");
  const bracket = segments.findIndex((segment) => segment.endsWith("[]"));
  // `segment === "[]"` means the brackets were their own segment (`a.[].b`),
  // which carries no name and leaves nothing to key the element by.
  if (bracket === -1 || segments[bracket] === "[]") {
    return null;
  }
  const rest = segments.slice(bracket + 1).filter(Boolean);
  if (rest.length === 0) {
    return null;
  }
  const path = [...segments.slice(0, bracket), (segments[bracket] as string).slice(0, -2)]
    .filter(Boolean)
    .join(".");
  return path === "" ? null : { arrayPath: path, rest };
};

/**
 * Build a nested object patch for one path. Scalars written into a `key[]` slot
 * would otherwise be overwritten by a later sibling, so each assignment starts
 * from a fresh object and `mergeScreenPatch` folds them together.
 */
const buildPathPatch = (path: string[], value: unknown): Record<string, unknown> => {
  const holder: Record<string, unknown> = {};
  setNestedValue(holder, path, value);
  return holder;
};

/**
 * The console persists a screen as `{ name, connectionStatus, definition }`, and
 * `definition` is not a reserved config key, so it is stored verbatim inside the
 * resource payload. Readers that only consult the top level therefore see an
 * empty definition. Unwrap it here, at the single point every read path funnels
 * through, so a saved screen and a console draft normalize identically.
 */
export const unwrapScreenDefinition = (payload: Record<string, unknown>): Record<string, unknown> =>
  isPlainObject(payload.definition) ? payload.definition : payload;

export const normalizeBigScreenDefinition = (payload: Record<string, unknown>): BigScreenDefinition => {
  const source = unwrapScreenDefinition(payload);
  const rawDatasets = Array.isArray(source.datasets) ? source.datasets : [];
  const datasets: BigScreenDataset[] = rawDatasets
    .filter((entry): entry is Record<string, unknown> => isPlainObject(entry))
    .slice(0, MAX_BIG_SCREEN_DATASETS)
    .map((entry, index) => {
      const rawRules = Array.isArray(entry.rules) ? entry.rules : [];
      const rules: BigScreenFieldRule[] = rawRules
        .filter((rule): rule is Record<string, unknown> => isPlainObject(rule))
        .map((rule) => {
          const normalized: BigScreenFieldRule = {
            column: asString(rule.column),
            target: asString(rule.target)
          };
          const label = asString(rule.label);
          const labelColumn = asString(rule.labelColumn) || asString(rule.label_column);
          return {
            ...normalized,
            ...(label ? { label } : {}),
            ...(labelColumn ? { labelColumn } : {})
          };
        })
        .filter((rule) => rule.column !== "" && rule.target !== "");
      const datasourceId = asString(entry.datasourceId) || asString(entry.datasource_id);
      const refreshMs = entry.refreshMs ?? entry.refresh_ms;
      const limit = entry.limit ?? entry.rowLimit ?? entry.row_limit;
      return {
        id: asString(entry.id) || `dataset-${index + 1}`,
        ...(datasourceId ? { datasourceId } : {}),
        sql: typeof entry.sql === "string" ? entry.sql : "",
        ...(refreshMs === undefined
          ? {}
          : { refreshMs: clampNumber(refreshMs, MIN_BIG_SCREEN_REFRESH_MS, MAX_BIG_SCREEN_REFRESH_MS, DEFAULT_BIG_SCREEN_REFRESH_MS) }),
        ...(limit === undefined
          ? {}
          : { limit: clampNumber(limit, 1, MAX_BIG_SCREEN_LIMIT, DEFAULT_BIG_SCREEN_LIMIT) }),
        rules
      };
    });

  // Whole hours, like the editor shows it. A screen saved under the old
  // millisecond bounds (300000 = five minutes) reads as the 1-hour floor, so
  // what the SQL runs on and what the wall polls on is always what the editor says.
  const refreshMs = Math.round(clampNumber(
    source.refreshMs ?? source.refresh_ms,
    MIN_BIG_SCREEN_REFRESH_MS,
    MAX_BIG_SCREEN_REFRESH_MS,
    DEFAULT_BIG_SCREEN_REFRESH_MS
  ) / HOUR_MS) * HOUR_MS;
  // Zero is a real setting: a screen with little data wants exactly its fetch
  // rows and no buffer beyond them.
  const prefetchRows = clampNumber(
    source.prefetchRows ?? source.prefetch_rows,
    0,
    MAX_BIG_SCREEN_LIMIT,
    0
  );
  const visiblePoints = clampNumber(
    source.visiblePoints ?? source.visible_points,
    1,
    MAX_BIG_SCREEN_LIMIT,
    7
  );

  return {
    templateId: asString(source.templateId) || asString(source.template_id),
    ...(asString(source.title) ? { title: asString(source.title) } : {}),
    ...(asString(source.datasourceId) || asString(source.datasource_id)
      ? { datasourceId: asString(source.datasourceId) || asString(source.datasource_id) }
      : {}),
    refreshMs,
    prefetchRows,
    visiblePoints,
    datasets
  };
};

/**
 * Rows to request per query: the rows the screen shows (数据获取行数) plus the
 * rows held in reserve (预取数据行数). The reserve is what the screen keeps
 * rendering while the next query is still running, so it is added on top of the
 * shown rows rather than competing with them — `max(limit, prefetch)` let the
 * reserve silently vanish whenever it was the smaller of the two.
 */
export const bigScreenFetchLimit = (
  dataset: BigScreenDataset,
  definition: BigScreenDefinition
): number => {
  const shown = dataset.limit ?? DEFAULT_BIG_SCREEN_LIMIT;
  const reserve = definition.prefetchRows ?? 0;
  return clampNumber(shown + reserve, 1, MAX_BIG_SCREEN_LIMIT, DEFAULT_BIG_SCREEN_LIMIT);
};

export type RunBigScreenDatasetInput = {
  dataset: BigScreenDataset;
  definition: BigScreenDefinition;
  userId: string;
  workspaceId: string;
  fallbackDatasourceId?: string;
  signal?: AbortSignal;
};

const runDataset = async (
  gateway: LocalDataGateway,
  input: RunBigScreenDatasetInput
): Promise<BigScreenDatasetResult> => {
  const base: BigScreenDatasetResult = {
    id: input.dataset.id,
    columns: [],
    rows: [],
    rowCount: 0,
    elapsedMs: 0
  };
  const datasourceId = input.dataset.datasourceId ?? input.definition.datasourceId ?? input.fallbackDatasourceId;
  if (!datasourceId) {
    return { ...base, error: "SCREEN_DATASOURCE_MISSING" };
  }
  if (input.dataset.sql.trim() === "") {
    return { ...base, error: "SCREEN_SQL_MISSING" };
  }
  const startedAt = Date.now();
  try {
    const result = await gateway.runSqlReadonly({
      user_id: input.userId,
      workspace_id: input.workspaceId,
      datasource_id: datasourceId,
      sql: input.dataset.sql,
      limit: bigScreenFetchLimit(input.dataset, input.definition),
      ...(input.signal ? { signal: input.signal } : {})
    });
    return {
      id: input.dataset.id,
      columns: result.columns,
      rows: result.rows,
      rowCount: result.row_count,
      elapsedMs: Date.now() - startedAt
    };
  } catch (error) {
    // A failing dataset must not blank the whole screen — templates already fall
    // back to DEFAULT_DATA, and the console surfaces the per-dataset reason.
    return {
      ...base,
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    };
  }
};

export type BigScreenDataResponse = {
  screenId: string;
  templateId: string;
  generatedAt: string;
  refreshMs: number;
  prefetchRows: number;
  /**
   * How long this answer stays shared before the SQL runs again, in ms. Walls
   * schedule their next ask from it; absent on preview runs, which never share.
   */
  refreshInMs?: number;
  /** Sparse patch merged over the template's own DEFAULT_DATA. */
  data: Record<string, unknown>;
  datasets: BigScreenDatasetResult[];
};

/**
 * Answers recently served, keyed by screen and definition.
 *
 * Every open wall polls on its own timer, and every poll used to reach the
 * database. A datasource with only a handful of connections to spare cannot
 * carry that: three tabs on one screen tripled the load for identical rows. An
 * answer is reused until the screen's own refresh interval has passed, so the
 * database sees one run per interval however many walls are watching; editing
 * the definition changes the key and so is never served stale.
 */
const screenDataCache = new Map<string, { at: number; value: Promise<BigScreenDataResponse> }>();

export const buildBigScreenData = async (
  gateway: LocalDataGateway,
  screenId: string,
  payload: Record<string, unknown>,
  identity: { userId: string; workspaceId: string; fallbackDatasourceId?: string },
  signal?: AbortSignal,
  options: { fresh?: boolean } = {}
): Promise<BigScreenDataResponse> => {
  const definition = normalizeBigScreenDefinition(payload);
  // 试跑预览 asks for exactly the draft on screen, so it always runs; only the
  // wall's polling shares answers.
  if (options.fresh) {
    return runScreenDatasets(gateway, screenId, definition, identity, signal);
  }
  const key = JSON.stringify([identity.userId, identity.workspaceId, screenId, identity.fallbackDatasourceId ?? "", definition]);
  // Each wall is told when this answer lapses (`refreshInMs`) and asks again
  // just after, so the TTL can be the interval itself: the SQL runs once per
  // interval however many walls are open or when each was opened.
  const ttl = definition.refreshMs ?? DEFAULT_BIG_SCREEN_REFRESH_MS;
  const now = Date.now();
  let cached = screenDataCache.get(key);
  if (!cached || now - cached.at >= ttl) {
    const value = runScreenDatasets(gateway, screenId, definition, identity, signal);
    cached = { at: now, value };
    screenDataCache.set(key, cached);
    // A failed run must not be served until the interval lapses.
    value.catch(() => screenDataCache.delete(key));
    if (screenDataCache.size > 200) {
      screenDataCache.delete(screenDataCache.keys().next().value as string);
    }
  }
  const at = cached.at;
  const response = await cached.value;
  return { ...response, refreshInMs: Math.max(0, at + ttl - Date.now()) };
};

const runScreenDatasets = async (
  gateway: LocalDataGateway,
  screenId: string,
  definition: BigScreenDefinition,
  identity: { userId: string; workspaceId: string; fallbackDatasourceId?: string },
  signal?: AbortSignal
): Promise<BigScreenDataResponse> => {
  // One dataset at a time: each run opens its own connection, and running them
  // together would hold one per dataset at once against a server that may only
  // allow a few.
  const results: BigScreenDatasetResult[] = [];
  for (const dataset of definition.datasets) {
    results.push(await runDataset(gateway, {
      dataset,
      definition,
      userId: identity.userId,
      workspaceId: identity.workspaceId,
      ...(identity.fallbackDatasourceId ? { fallbackDatasourceId: identity.fallbackDatasourceId } : {}),
      ...(signal ? { signal } : {})
    }));
  }
  return {
    screenId,
    templateId: definition.templateId,
    generatedAt: new Date().toISOString(),
    refreshMs: definition.refreshMs ?? DEFAULT_BIG_SCREEN_REFRESH_MS,
    prefetchRows: definition.prefetchRows ?? 0,
    data: applyFieldRules(results, definition.datasets),
    datasets: results
  };
};
