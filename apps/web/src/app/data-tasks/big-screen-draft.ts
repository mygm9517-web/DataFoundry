import type {
  BigScreenDataDto,
  BigScreenDto,
  BigScreenFieldRuleDto,
} from "../../lib/config-api";
import {
  DEFAULT_BIG_SCREEN_PREFETCH_ROWS,
  DEFAULT_BIG_SCREEN_REFRESH_MS,
  HOUR_MS,
  getBigScreenTemplate,
  refreshMsToHours,
  type BigScreenTemplate,
} from "./big-screen-templates";

/**
 * Pure state and serialization for the big-screen console.
 *
 * Kept out of the panel component so the rules that decide what reaches the API
 * — which blank fields are dropped, which datasets survive, how a column list is
 * matched back to its dataset — are unit-testable without a DOM.
 */

export type DraftRule = BigScreenFieldRuleDto;

export type DraftDataset = {
  /** Stable within the editor; the persisted id is `id`. */
  key: string;
  id: string;
  sql: string;
  datasourceId: string;
  limit: string;
  rules: DraftRule[];
};

export type Draft = {
  id?: string;
  revision?: number;
  name: string;
  title: string;
  templateId: string;
  datasourceId: string;
  refreshMs: number;
  prefetchRows: number;
  visiblePoints: number;
  datasets: DraftDataset[];
};

export function clampInteger(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function draftFromScreen(screen: BigScreenDto): Draft {
  return {
    id: screen.id,
    revision: screen.revision,
    name: screen.name,
    title: screen.title ?? "",
    templateId: screen.templateId,
    datasourceId: screen.datasourceId ?? "",
    // Held in whole hours on the way in, so a screen saved under the old
    // millisecond bounds reopens at the 1-hour floor rather than at 2.6 seconds.
    refreshMs: refreshMsToHours(screen.refreshMs) * HOUR_MS,
    prefetchRows: screen.prefetchRows ?? DEFAULT_BIG_SCREEN_PREFETCH_ROWS,
    // A screen saved before the template's window changed keeps what it stored;
    // only a screen with no visiblePoints falls back to the template's.
    visiblePoints:
      screen.visiblePoints ?? getBigScreenTemplate(screen.templateId)?.visiblePoints ?? 7,
    datasets: screen.datasets.map((dataset, index) => ({
      key: `${dataset.id || "dataset"}-${index}`,
      id: dataset.id,
      sql: dataset.sql,
      datasourceId: dataset.datasourceId ?? "",
      limit: dataset.limit === undefined ? "" : String(dataset.limit),
      rules: dataset.rules.map((rule) => ({ ...rule })),
    })),
  };
}

export function emptyDraft(template: BigScreenTemplate): Draft {
  // Generate a unique ID for new drafts based on template ID and timestamp
  const uniqueId = `${template.id}-${Date.now()}`;

  return {
    id: uniqueId,
    name: "",
    title: "",
    templateId: template.id,
    datasourceId: "",
    refreshMs: DEFAULT_BIG_SCREEN_REFRESH_MS,
    prefetchRows: DEFAULT_BIG_SCREEN_PREFETCH_ROWS,
    visiblePoints: template.visiblePoints,
    datasets: [
      {
        key: "dataset-0",
        id: "dataset-1",
        sql: "",
        datasourceId: "",
        limit: "",
        rules: [],
      },
    ],
  };
}

/**
 * Serializes the editor state into the shape the API stores.
 *
 * Blank optional fields are dropped rather than sent as `""`/`0`: the backend
 * reads an absent `datasourceId` as "inherit the screen's", and an absent
 * `limit` as "size it from the prefetch setting". Sending empty strings would
 * turn those inheritances into invalid ids and zero-row queries.
 */
export function draftDefinition(draft: Draft): Record<string, unknown> {
  return {
    templateId: draft.templateId,
    ...(draft.title.trim() ? { title: draft.title.trim() } : {}),
    ...(draft.datasourceId ? { datasourceId: draft.datasourceId } : {}),
    refreshMs: draft.refreshMs,
    prefetchRows: draft.prefetchRows,
    visiblePoints: draft.visiblePoints,
    datasets: draft.datasets
      .filter((dataset) => dataset.sql.trim().length > 0)
      .map((dataset, index) => {
        const limit = Number.parseInt(dataset.limit, 10);
        return {
          id: dataset.id.trim() || `dataset-${index + 1}`,
          ...(dataset.datasourceId ? { datasourceId: dataset.datasourceId } : {}),
          sql: dataset.sql,
          ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
          rules: dataset.rules.filter((rule) => rule.column && rule.target),
        };
      }),
  };
}

/** Request body for create/patch — the definition plus the resource envelope. */
export function draftBody(draft: Draft, datasourceId: string): Record<string, unknown> {
  return {
    // Include the id field so backend can use it directly
    ...(draft.id ? { id: draft.id } : {}),
    name: draft.name.trim() || draft.id || draft.templateId,
    ...(draft.id && draft.revision !== undefined ? { revision: draft.revision } : {}),
    connectionStatus: datasourceId ? "connected" : "untested",
    definition: draftDefinition(draft),
  };
}

/**
 * Column names per dataset, learned from the last successful run.
 *
 * Matched by position rather than id: the response echoes the id the backend
 * assigned, which for an unsaved draft is not the one the editor holds.
 */
export function collectColumns(
  draft: Draft,
  result: BigScreenDataDto,
): Record<string, string[]> {
  const next: Record<string, string[]> = {};
  draft.datasets.forEach((dataset, index) => {
    const entry = result.datasets[index];
    if (entry && !entry.error && entry.columns.length > 0) {
      next[dataset.id] = entry.columns;
    }
  });
  return next;
}
