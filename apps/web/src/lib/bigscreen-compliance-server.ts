import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  BIG_SCREEN_PAGE_DESIGN_PROMPT,
  inspectBigScreenBundle,
  type BigScreenBundleManifest,
  type BigScreenBundleViolation
} from "@datafoundry/bigscreen";
import {
  bigScreenTemplateRoot,
  bigScreenUploadRoot,
  readUploadedTemplates,
  UPLOADED_TEMPLATE_MANIFEST
} from "./bigscreen-templates-server";

/**
 * Whether an installed page satisfies the import contract, read back from disk.
 *
 * The upload route already validates a page on the way in, so the obvious
 * question is why this exists. Two answers:
 *
 *   - The five bundled templates never went through an upload. They ship with
 *     the repository, and nothing has ever checked them against the contract
 *     they are supposed to demonstrate.
 *   - An uploaded page can drift out of compliance without being re-uploaded.
 *     A page that was refused, hand-edited, and copied into the upload root is
 *     exactly the case the operator is trying to find.
 *
 * So compliance is computed here rather than remembered at upload time: it is a
 * property of the bytes on disk, and it stays true only as long as it is read
 * from them. It is deliberately read-only — this module never writes a page, so
 * asking the question can never change the answer.
 */

/** Where a page's files came from, which decides what may be done to them. */
export type BigScreenTemplateOrigin =
  /** Ships with the repository, under `apps/web/bigscreen/`. */
  | "bundled"
  /** Uploaded through the console, under the upload root. */
  | "uploaded"
  /** A row with no files on disk. */
  | "missing";

export type BigScreenComplianceStatus = "compliant" | "non-compliant" | "unverifiable";

export type BigScreenComplianceReport = {
  templateId: string;
  origin: BigScreenTemplateOrigin;
  status: BigScreenComplianceStatus;
  violations: BigScreenBundleViolation[];
  /** The contract as parsed, present whenever the page passed. */
  manifest?: BigScreenBundleManifest;
  /**
   * The entry page's own text, so a violation can be acted on without a second
   * round trip to fetch it. Absent when the page could not be read at all.
   */
  repair?: { entry: string; files: string[]; html: string };
  /** Why the page could not be checked, when the status is `unverifiable`. */
  reason?: string;
  /** The prompt that describes what a page has to satisfy, for the copy action. */
  designPrompt: string;
};

/** Cap on the page text carried in a compliance report; mirrors the upload's own. */
const MAX_REPORT_SOURCE_BYTES = 512 * 1024;

/**
 * Every file in a page's folder, read into memory.
 *
 * Walked rather than listed from a manifest because the point is to describe the
 * folder as it is. A manifest can be stale — it is written at upload and never
 * rewritten when someone edits the page by hand — so a check that trusted it
 * would be checking the record rather than the page.
 *
 * The upload root's own bookkeeping files are skipped: `.template.json` names
 * the page, it is not part of it, and counting it would make every page look
 * like it ships an unsupported file type.
 */
export function readPageFiles(root: string): Array<{ content: Buffer; path: string }> {
  const files: Array<{ content: Buffer; path: string }> = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute, relative);
        continue;
      }
      // The uploaded archive is kept verbatim beside the page, for download. It
      // is the same page in compressed form and would otherwise be reported as
      // an unsupported file type.
      if (entry.name === UPLOADED_TEMPLATE_MANIFEST || /\.(zip|rar|7z)$/iu.test(entry.name)) {
        continue;
      }
      try {
        files.push({ content: readFileSync(absolute), path: relative });
      } catch {
        continue;
      }
    }
  };
  try {
    if (!statSync(root).isDirectory()) {
      return [];
    }
  } catch {
    return [];
  }
  walk(root, "");
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

/** The entry file for a folder: `index.html`, else the lone html file. */
function resolveEntry(files: Array<{ path: string }>): string {
  if (files.some((file) => file.path === "index.html")) return "index.html";
  const pages = files.filter((file) => /\.html?$/iu.test(file.path));
  return pages.length === 1 ? pages[0]!.path : "";
}

/**
 * Adds the page's own folder as a prefix, and splices in the shared assets, so a
 * bundled page can be checked by the same rules an upload is.
 *
 * An upload arrives as a self-contained archive: `index.html` at the root and
 * everything it references beside it, which is exactly the shape the contract
 * rules are written against. A bundled page is not shaped like that — it lives
 * in a subfolder, and the vendor files it loads live one level up. The rewrite
 * makes the two shapes agree for the length of one check.
 *
 * The shared assets are copied in under every name a bundled page might reach
 * them by: `assets/x` (the page's own folder is its root), `page/assets/x`
 * (resolved against the prefixed entry), and `../assets/x`. Rewriting the page's
 * references instead would have been the tidier-looking option, but it would
 * mean checking something other than the file on disk, and the whole point of
 * this module is that the check describes the bytes as they are.
 */
function namespacedAgainstSharedAssets(
  files: Array<{ content: Buffer; path: string }>,
  bundledRoot: string
): Array<{ content: Buffer; path: string }> {
  const prefixed = files.map((file) => ({ content: file.content, path: `page/${file.path}` }));
  const shared = readPageFiles(path.join(bundledRoot, "assets"));
  return [
    ...prefixed,
    ...shared.map((file) => ({ content: file.content, path: `assets/${file.path}` })),
    ...shared.map((file) => ({ content: file.content, path: `page/assets/${file.path}` }))
  ];
}

/**
 * Checks one installed page.
 *
 * A bundled page that fails is reported as non-compliant like any other — the
 * contract is the contract, and a bundled page that fails it is the clearest
 * possible demonstration of what the console is for. The origin is carried
 * separately so the caller can decide what to offer: only an uploaded page can
 * be repaired in place, because a bundled page's files belong to the repository.
 */
export function checkBigScreenTemplate(templateId: string): BigScreenComplianceReport {
  const bundledRoot = bigScreenTemplateRoot();
  const uploadRoot = bigScreenUploadRoot();
  const bundledDir = path.join(bundledRoot, templateId);
  const uploadedRow = readUploadedTemplates(uploadRoot).find((item) => item.id === templateId);

  const bundledExists = (() => {
    try {
      return statSync(bundledDir).isDirectory();
    } catch {
      return false;
    }
  })();

  const origin: BigScreenTemplateOrigin = uploadedRow
    ? "uploaded"
    : bundledExists
      ? "bundled"
      : "missing";
  const dir = uploadedRow ? path.join(uploadRoot, templateId) : bundledDir;

  const base: Pick<BigScreenComplianceReport, "templateId" | "origin" | "designPrompt"> = {
    templateId,
    origin,
    designPrompt: BIG_SCREEN_PAGE_DESIGN_PROMPT
  };

  if (origin === "missing") {
    return {
      ...base,
      status: "unverifiable",
      violations: [],
      reason: "页面的文件不在磁盘上，无法检查。请重新上传这个页面。"
    };
  }

  const files = readPageFiles(dir);
  if (files.length === 0) {
    return {
      ...base,
      status: "unverifiable",
      violations: [],
      reason: "页面目录是空的，无法检查。请重新上传这个页面。"
    };
  }

  const entry = resolveEntry(files) || (uploadedRow?.entry ?? "index.html");

  // A bundled page's shared vendor assets are siblings of its folder, not files
  // inside it: `home/index.html` loads `assets/echarts.min.js` from the same
  // `bigscreen/` directory the templates sit in, and the serving route resolves
  // that reference the same way. Checking the folder alone would report every
  // bundled page as broken on a file it can actually load.
  // The entry moves with the files: inside the rewritten tree the page lives at
  // `page/<entry>`, and a check that still looked for `<entry>` would report the
  // folder as having no entry page at all.
  const namespaced = origin === "bundled" ? namespacedAgainstSharedAssets(files, bundledRoot) : files;
  const checkedEntry = origin === "bundled" ? `page/${entry}` : entry;
  const inspected = inspectBigScreenBundle({ entry: checkedEntry, files: namespaced });

  // The report carries the page text so the repair action has something to send.
  // A page too large for it is still reported honestly; it just has no repair.
  //
  // The paths are the page's own, not the `page/`-prefixed ones the check used:
  // they travel to the model inside the repair prompt, which is written in terms
  // of a page folder, and a bundled page's real folder is what the operator
  // would repackage.
  const page = files.find((file) => file.path === entry);
  const repair =
    page && page.content.length <= MAX_REPORT_SOURCE_BYTES
      ? {
        entry,
        files: files.map((file) => file.path),
        html: page.content.toString("utf8")
      }
      : undefined;

  // The manifest that comes back describes the rewritten tree, so for a bundled
  // page its paths carry the `page/` prefix the check needed. What leaves this
  // module is always the page's real folder, so the prefix is stripped here
  // rather than at each of the callers that would otherwise have to know.
  const manifest = inspected.manifest
    ? origin === "bundled"
      ? {
        ...inspected.manifest,
        entry,
        files: inspected.manifest.files.map((file) => ({
          ...file,
          path: stripPagePrefix(file.path)
        }))
      }
      : inspected.manifest
    : undefined;

  return {
    ...base,
    status: manifest ? "compliant" : "non-compliant",
    violations: inspected.violations,
    ...(manifest ? { manifest } : {}),
    ...(repair ? { repair } : {})
  };
}

/** `page/a/b.js` → `a/b.js`; anything outside `page/` is left alone. */
const stripPagePrefix = (value: string): string =>
  value.startsWith("page/") ? value.slice("page/".length) : value;

/**
 * Checks every page that is installed, keyed by id, for the list view.
 *
 * Bundled and uploaded pages are both included: the list shows one row per page
 * the operator can see, and a page's compliance is not less interesting because
 * it arrived with the app.
 */
export function checkAllBigScreenTemplates(): Record<string, BigScreenComplianceReport> {
  const ids = new Set<string>();
  try {
    for (const entry of readdirSync(bigScreenTemplateRoot(), { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) ids.add(entry.name);
    }
  } catch {
    // No bundled root: nothing to add.
  }
  for (const row of readUploadedTemplates(bigScreenUploadRoot())) {
    ids.add(row.id);
  }

  const reports: Record<string, BigScreenComplianceReport> = {};
  for (const id of ids) {
    reports[id] = checkBigScreenTemplate(id);
  }
  return reports;
}
