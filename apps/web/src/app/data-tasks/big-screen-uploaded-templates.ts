import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Uploaded big-screen page templates, as the serving route sees them.
 *
 * An upload lands as a folder under the template root plus a `.template.json`
 * beside its files. The sidecar is what makes an uploaded page different from a
 * folder of loose files: it names the entry, the data file the bridge should
 * intercept, the page global to push through when the page has no data file,
 * and whether the operator has published the page at all.
 *
 * Published state is written by the upload and publish routes, which run in
 * this same web process, so the serving route reads it straight from disk with
 * no cross-process lookup and no window in which the console and the wall
 * disagree about whether a page is live.
 *
 * Like the bundled registry, this module stays free of React and of the bridge
 * runtime: it is read by the route handler and by tests.
 */

export type UploadedBigScreenTemplate = {
  id: string;
  name: string;
  description: string;
  /** False until the operator publishes it; an unpublished page is not served. */
  published: boolean;
  /** Entry file inside the folder, normally `index.html`. */
  entry: string;
  /** Data file the page fetches, when it reads one. Empty for binding templates. */
  dataFile: string;
  binding?: { global: string; call: string; stop?: string };
  /** Bundle-relative paths recorded at upload, used to gate what may be served. */
  filePaths: Set<string>;
  fields: Array<{ path: string; kind: string }>;
  refreshMs?: number;
  visiblePoints?: number;
};

export const UPLOADED_TEMPLATE_MANIFEST = ".template.json";

/**
 * The sidecar as it is stored: `filePaths` is an array on disk and a `Set` in
 * memory, so the same document is usable for a membership test.
 */
type StoredManifest = Omit<UploadedBigScreenTemplate, "filePaths"> & { filePaths: string[] };

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

const toTemplate = (value: unknown, fallbackId: string): UploadedBigScreenTemplate | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const entry = asString(record.entry) || "index.html";
  const binding = record.binding && typeof record.binding === "object"
    ? (record.binding as Record<string, unknown>)
    : undefined;
  const globalName = asString(binding?.global);
  const call = asString(binding?.call);
  // Read once into a local: narrowing `binding` from a test on `binding?.stop`
  // does not survive into the object literal below.
  const stop = asString(binding?.stop);
  return {
    id: asString(record.id) || fallbackId,
    name: asString(record.name) || fallbackId,
    description: asString(record.description),
    published: record.published === true,
    entry,
    dataFile: asString(record.dataFile),
    ...(globalName && call
      ? {
        binding: {
          global: globalName,
          call,
          ...(stop ? { stop } : {}),
        },
      }
      : {}),
    filePaths: new Set(Array.isArray(record.filePaths) ? record.filePaths.filter((item) => typeof item === "string") : []),
    fields: Array.isArray(record.fields)
      ? record.fields
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
        .map((item) => ({ path: asString(item.path), kind: asString(item.kind) || "scalar" }))
        .filter((item) => item.path !== "")
      : [],
    ...(typeof record.refreshMs === "number" ? { refreshMs: record.refreshMs } : {}),
    ...(typeof record.visiblePoints === "number" ? { visiblePoints: record.visiblePoints } : {}),
  };
};

/**
 * Every uploaded template under `root`, keyed by folder name.
 *
 * A folder without a readable sidecar is skipped rather than served: it is
 * either a half-finished upload or something the operator copied in by hand,
 * and neither should reach a wall unnoticed.
 */
export function readUploadedTemplates(root: string): UploadedBigScreenTemplate[] {
  let names: string[];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const templates: UploadedBigScreenTemplate[] = [];
  for (const name of names) {
    const manifestPath = path.join(root, name, UPLOADED_TEMPLATE_MANIFEST);
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
      const template = toTemplate(parsed, name);
      if (template) templates.push(template);
    } catch {
      continue;
    }
  }
  return templates;
}

/** Serializes a manifest for the sidecar, turning the path set back into an array. */
export function serializeUploadedTemplate(template: UploadedBigScreenTemplate): StoredManifest {
  return { ...template, filePaths: [...template.filePaths] };
}
