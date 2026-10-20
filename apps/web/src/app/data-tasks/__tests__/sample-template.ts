import type { BigScreenTemplate } from "../big-screen-templates";

/** Synthetic data contract for editor tests; contains no business page or SQL. */
export const sampleTemplate: BigScreenTemplate = {
  id: "test-page", name: "Test page", description: "",
  dataFile: "data.json", visiblePoints: 7, refreshMs: 3_600_000, bindable: true,
  fields: [
    { path: "months", kind: "labels", target: "months[]" },
    { path: "kpi.total", kind: "scalar", target: "kpi.total" },
  ],
};
