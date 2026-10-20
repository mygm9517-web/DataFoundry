import { describe, expect, it } from "vitest";
import type { BigScreenDataDto, BigScreenDto } from "../../../lib/config-api";
import {
  clampInteger,
  collectColumns,
  draftBody,
  draftDefinition,
  draftFromScreen,
  emptyDraft,
  type Draft,
} from "../big-screen-draft";
import {
  MAX_BIG_SCREEN_REFRESH_MS,
  MIN_BIG_SCREEN_REFRESH_MS,
} from "../big-screen-templates";

import { sampleTemplate as template } from "./sample-template";

function baseDraft(overrides: Partial<Draft> = {}): Draft {
  return { ...emptyDraft(template), name: "质量总览", ...overrides };
}

function screenDto(overrides: Partial<BigScreenDto> = {}): BigScreenDto {
  return {
    id: "screen-1",
    name: "质量总览",
    templateId: template.id,
    revision: 4,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    datasets: [],
    ...overrides,
  };
}

describe("big screen editor draft", () => {
  it("seeds a new draft from the template's own cadence and window", () => {
    for (const entry of [template]) {
      const draft = emptyDraft(entry);
      expect(draft.templateId).toBe(entry.id);
      expect(draft.refreshMs).toBe(entry.refreshMs);
      expect(draft.visiblePoints).toBe(entry.visiblePoints);
      // A new screen has no datasource of its own yet: it inherits the wall's.
      expect(draft.datasourceId).toBe("");
      expect(draft.id).toMatch(new RegExp(`^${template.id}-[0-9]+$`));
    }
  });

  it("keeps the stored cadence when editing a saved screen", () => {
    const draft = draftFromScreen(screenDto({ refreshMs: 7_200_000, visiblePoints: 12, prefetchRows: 40 }));
    expect(draft.refreshMs).toBe(7_200_000);
    expect(draft.visiblePoints).toBe(12);
    expect(draft.prefetchRows).toBe(40);
    expect(draft.revision).toBe(4);
  });

  it("falls back to the template window for a screen that stored none", () => {
    const draft = draftFromScreen(screenDto({ visiblePoints: undefined }));
    expect(draft.visiblePoints).toBe(template.visiblePoints);
  });

  it("renders a blank stored limit as an empty field, not zero", () => {
    const withLimit = draftFromScreen(
      screenDto({
        datasets: [
          { id: "dataset-1", sql: "select 1", limit: 500, rules: [] },
          { id: "dataset-2", sql: "select 2", rules: [] },
        ],
      }),
    );
    expect(withLimit.datasets[0].limit).toBe("500");
    expect(withLimit.datasets[1].limit).toBe("");
  });

  it("gives each dataset row a key that is unique even without an id", () => {
    const draft = draftFromScreen(
      screenDto({
        datasets: [
          { id: "", sql: "select 1", rules: [] },
          { id: "", sql: "select 2", rules: [] },
        ],
      }),
    );
    expect(new Set(draft.datasets.map((dataset) => dataset.key)).size).toBe(2);
  });
});

describe("big screen definition serialization", () => {
  it("drops a blank datasource so the screen's own is inherited", () => {
    const definition = draftDefinition(baseDraft({ datasourceId: "" }));
    expect(definition).not.toHaveProperty("datasourceId");
    expect(draftDefinition(baseDraft({ datasourceId: "db-1" })).datasourceId).toBe("db-1");
  });

  it("drops a blank title rather than storing an empty one", () => {
    expect(draftDefinition(baseDraft({ title: "   " }))).not.toHaveProperty("title");
    expect(draftDefinition(baseDraft({ title: "  生产  " })).title).toBe("生产");
  });

  it("omits a blank row limit so the prefetch setting sizes the query", () => {
    const [dataset] = draftDefinition(
      baseDraft({
        datasets: [{ key: "d", id: "dataset-1", sql: "select 1", datasourceId: "", limit: "", rules: [] }],
      }),
    ).datasets as Array<Record<string, unknown>>;
    expect(dataset).not.toHaveProperty("limit");
  });

  it("carries a positive row limit through as a number", () => {
    const [dataset] = draftDefinition(
      baseDraft({
        datasets: [{ key: "d", id: "dataset-1", sql: "select 1", datasourceId: "", limit: "250", rules: [] }],
      }),
    ).datasets as Array<Record<string, unknown>>;
    expect(dataset.limit).toBe(250);
  });

  it("ignores a dataset with no SQL instead of sending an empty query", () => {
    const definition = draftDefinition(
      baseDraft({
        datasets: [
          { key: "a", id: "dataset-1", sql: "select 1", datasourceId: "", limit: "", rules: [] },
          { key: "b", id: "dataset-2", sql: "   ", datasourceId: "", limit: "", rules: [] },
        ],
      }),
    );
    expect(definition.datasets).toHaveLength(1);
  });

  it("numbers an unnamed dataset by its surviving position", () => {
    const definition = draftDefinition(
      baseDraft({
        datasets: [
          { key: "a", id: "", sql: "select 1", datasourceId: "", limit: "", rules: [] },
          { key: "b", id: "", sql: "select 2", datasourceId: "", limit: "", rules: [] },
        ],
      }),
    );
    expect((definition.datasets as Array<{ id: string }>).map((dataset) => dataset.id)).toEqual([
      "dataset-1",
      "dataset-2",
    ]);
  });

  it("drops a half-filled field rule rather than one that binds nothing", () => {
    const definition = draftDefinition(
      baseDraft({
        datasets: [
          {
            key: "a",
            id: "dataset-1",
            sql: "select 1",
            datasourceId: "",
            limit: "",
            rules: [
              { column: "rate", target: "kpi.passRate" },
              { column: "", target: "kpi.empty" },
              { column: "orphan", target: "" },
              { column: "months", target: "months[]", label: "月份" },
            ],
          },
        ],
      }),
    );
    expect((definition.datasets as Array<{ rules: unknown[] }>)[0].rules).toEqual([
      { column: "rate", target: "kpi.passRate" },
      { column: "months", target: "months[]", label: "月份" },
    ]);
  });
});

describe("big screen save body", () => {
  it("marks the screen connected only when a datasource is reachable", () => {
    expect(draftBody(baseDraft(), "db-1").connectionStatus).toBe("connected");
    expect(draftBody(baseDraft(), "").connectionStatus).toBe("untested");
  });

  it("falls back through name, id, then template for the resource name", () => {
    expect(draftBody(baseDraft({ name: "  大屏 A  " }), "").name).toBe("大屏 A");
    expect(draftBody(baseDraft({ name: "  ", id: "screen-9" }), "").name).toBe("screen-9");
    expect(draftBody(baseDraft({ name: "", id: undefined }), "").name).toBe(template.id);
  });

  it("sends the revision only when patching an existing screen", () => {
    expect(draftBody(baseDraft({ id: "screen-1", revision: 7 }), "").revision).toBe(7);
    expect(draftBody(baseDraft(), "")).not.toHaveProperty("revision");
  });
});

describe("big screen column discovery", () => {
  const draft = baseDraft({
    datasets: [
      { key: "a", id: "dataset-1", sql: "select 1", datasourceId: "", limit: "", rules: [] },
      { key: "b", id: "dataset-2", sql: "select 2", datasourceId: "", limit: "", rules: [] },
    ],
  });

  const result = (datasets: BigScreenDataDto["datasets"]): BigScreenDataDto => ({
    screenId: "",
    templateId: template.id,
    generatedAt: "",
    refreshMs: 2600,
    prefetchRows: 20,
    data: {},
    datasets,
  });

  it("matches columns to datasets by position, not by the echoed id", () => {
    // The backend assigns ids; a draft's own ids need not survive the round trip.
    const columns = collectColumns(
      draft,
      result([
        { id: "backend-a", columns: ["month", "rate"], rows: [], rowCount: 2, elapsedMs: 3 },
        { id: "backend-b", columns: ["total"], rows: [], rowCount: 1, elapsedMs: 4 },
      ]),
    );
    expect(columns).toEqual({ "dataset-1": ["month", "rate"], "dataset-2": ["total"] });
  });

  it("leaves a failed dataset out so its picker keeps the previous columns", () => {
    const columns = collectColumns(
      draft,
      result([
        { id: "a", columns: [], rows: [], rowCount: 0, elapsedMs: 1, error: "boom" },
        { id: "b", columns: ["total"], rows: [], rowCount: 1, elapsedMs: 4 },
      ]),
    );
    expect(columns).toEqual({ "dataset-2": ["total"] });
  });

  it("tolerates a response with fewer datasets than the draft", () => {
    const columns = collectColumns(
      draft,
      result([{ id: "a", columns: ["month"], rows: [], rowCount: 1, elapsedMs: 1 }]),
    );
    expect(columns).toEqual({ "dataset-1": ["month"] });
  });
});

describe("integer field clamping", () => {
  it("holds a typed value inside the allowed range", () => {
    expect(clampInteger(1, 10, 100, 50)).toBe(10);
    expect(clampInteger(5000, 10, 100, 50)).toBe(100);
    expect(clampInteger(42.6, 10, 100, 50)).toBe(43);
  });

  it("falls back rather than storing NaN from an empty input", () => {
    expect(clampInteger(Number.NaN, MIN_BIG_SCREEN_REFRESH_MS, MAX_BIG_SCREEN_REFRESH_MS, 2600)).toBe(2600);
    expect(clampInteger(Number.POSITIVE_INFINITY, 1, 10, 5)).toBe(5);
  });
});
