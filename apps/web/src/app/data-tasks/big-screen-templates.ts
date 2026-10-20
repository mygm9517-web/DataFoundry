/**
 * Big-screen templates bundled under `apps/web/bigscreen/<id>/index.html` and
 * served by the `/bigscreen/[...path]` route.
 *
 * Each template keeps its own inline `DEFAULT_DATA` + `mergeData` layer and
 * fetches its data file on boot. The console overrides that fetch with the live
 * payload, so a template never has to be rewritten when fields change — only
 * the field mapping in the screen definition changes.
 */

export type BigScreenTemplateField = {
  /** Dot path inside the template's data contract. */
  path: string;
  /** `series` renders as a chart series, `scalar` as a single KPI number. */
  kind: "series" | "scalar" | "labels";
  /** Serialized form used when writing the `target` of a rule. */
  target: string;
};

export type BigScreenTemplate = {
  id: string;
  name: string;
  description: string;
  /** Data file the template's own fetch expects in its folder. */
  dataFile: string;
  /** Points a scrolling window shows; used to size the prefetch buffer. */
  visiblePoints: number;
  /** Default refresh cadence, matching what the template was authored with. */
  refreshMs: number;
  /** True when the template actually reads its data file; false = static demo. */
  bindable: boolean;
  fields: BigScreenTemplateField[];
  /**
   * Set when the template carries its data in a global object instead of
   * loading the data file — the bridge then pushes the payload through that
   * global rather than answering a fetch. Shape matches
   * `BigScreenBridgeBinding` in `big-screen-runtime.ts`, which is a `.tsx`-free
   * module this one deliberately does not import from: the registry is read by
   * the route handler and by tests, and it should not drag the runtime in.
   */
  binding?: {
    /** Global the page publishes, e.g. `FQC`. */
    global: string;
    /** Method on it that accepts the payload, e.g. `setData`. */
    call: string;
    /** Optional method to stop the page's built-in demo ticker. */
    stop?: string;
  };
};

/** Public distribution starts without bundled business pages. Upload pages through the console. */
export const BIG_SCREEN_TEMPLATES: BigScreenTemplate[] = [];

export function getBigScreenTemplate(templateId: string): BigScreenTemplate | undefined {
  return BIG_SCREEN_TEMPLATES.find((template) => template.id === templateId);
}

/**
 * Path a template is served at, no leading slash — the `/bigscreen` route
 * mirrors the bundled folder one-for-one, so this is just the id.
 */
export function getBigScreenTemplatePath(templateId: string): string {
  const id = getBigScreenTemplate(templateId)?.id ?? BIG_SCREEN_TEMPLATES[0]?.id;
  return id ? `bigscreen/${id}/index.html` : "";
}

/**
 * Fields a template can bind, grouped by their top-level segment so the console
 * can present "数据类别" instead of one flat list.
 */
export function groupBigScreenTemplateFields(
  template: BigScreenTemplate,
): Array<{ group: string; fields: BigScreenTemplateField[] }> {
  const groups = new Map<string, BigScreenTemplateField[]>();
  for (const field of template.fields) {
    const head = field.path.split(".")[0] ?? field.path;
    const bucket = groups.get(head) ?? [];
    bucket.push(field);
    groups.set(head, bucket);
  }
  return [...groups].map(([group, fields]) => ({ group, fields }));
}

/**
 * Refresh cadence, mirrored from the API. Screens refresh hourly at the
 * fastest and monthly at the slowest; the editor shows hours, while the stored
 * value stays in milliseconds so older screens load unchanged.
 */
export const HOUR_MS = 3_600_000;
export const DEFAULT_BIG_SCREEN_REFRESH_MS = HOUR_MS;
export const DEFAULT_BIG_SCREEN_PREFETCH_ROWS = 0;
export const MIN_BIG_SCREEN_REFRESH_MS = HOUR_MS;
export const MAX_BIG_SCREEN_REFRESH_MS = 720 * HOUR_MS;
export const MIN_BIG_SCREEN_REFRESH_HOURS = MIN_BIG_SCREEN_REFRESH_MS / HOUR_MS;
export const MAX_BIG_SCREEN_REFRESH_HOURS = MAX_BIG_SCREEN_REFRESH_MS / HOUR_MS;

/** Whole hours for display; a legacy sub-hour value reads as the 1-hour floor. */
export function refreshMsToHours(ms: number | undefined): number {
  const hours = Math.round((ms ?? DEFAULT_BIG_SCREEN_REFRESH_MS) / HOUR_MS);
  return Math.min(MAX_BIG_SCREEN_REFRESH_HOURS, Math.max(MIN_BIG_SCREEN_REFRESH_HOURS, hours));
}

/**
 * Ceilings mirrored from the API's own clamps. The server truncates silently —
 * a 25th category would simply never appear on the wall — so the editor has to
 * refuse the input up front rather than let an operator build a screen that
 * quietly loses a query.
 */
export const MAX_BIG_SCREEN_DATASETS = 24;
export const MAX_BIG_SCREEN_PREFETCH_ROWS = 2000;
export const MAX_BIG_SCREEN_VISIBLE_POINTS = 2000;
export const DEFAULT_BIG_SCREEN_VISIBLE_POINTS = 7;
