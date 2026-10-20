import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { readSafeZipEntries } from "./zip-reader.js";

/**
 * The uploaded file this parser reads.
 *
 * Declared here rather than imported from the API's multipart reader: the two
 * are the same three fields, but this package is the one both processes share,
 * and the web server's reader is a different module from the API's.
 */
export type BigScreenTemplateUpload = {
  content: Buffer;
  filename: string;
  mimeType: string;
};

/**
 * Uploaded big-screen templates.
 *
 * A bundled template is a folder under `apps/web/bigscreen/<id>/` that only a
 * developer can change. This module is the other half of that arrangement: it
 * accepts a user-authored page as a zip, checks it against the contract the
 * bridge depends on, and — when it passes — unpacks it into a directory the
 * serve route reads. Everything below is deliberately DB-free and fs-light so
 * the checks can be exercised on a Buffer alone; only `installBigScreenBundle`
 * touches disk.
 *
 * Why validate at all, rather than letting a broken page render nothing: an
 * uploaded page that ignores the bridge still *looks* fine — it just shows its
 * own demo numbers forever, and the operator has no way to tell a live wall from
 * a dead one. Every rule here exists to catch a page that would fail that way
 * silently, and each failure is reported with the fix, not just the symptom.
 */

/** The public distribution includes no bundled business pages. */
export const BIG_SCREEN_BUILTIN_TEMPLATE_IDS: readonly string[] = [];

/** Static route names cannot be used as uploaded template identifiers. */
export const BIG_SCREEN_RESERVED_TEMPLATE_IDS = [
  "assets",
  "cleanup",
  "register",
  "storage-context",
  "repair",
  "design-prompt"
] as const;

export const MAX_BIG_SCREEN_BUNDLE_BYTES = 5 * 1024 * 1024;
export const MAX_BIG_SCREEN_BUNDLE_ENTRIES = 200;
export const MAX_BIG_SCREEN_BUNDLE_UNCOMPRESSED = 20 * 1024 * 1024;

/** Extensions a page bundle may contain. Anything else is refused outright. */
const ALLOWED_EXTENSIONS = new Set([
  ".html", ".htm", ".js", ".mjs", ".css", ".json",
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico",
  ".woff", ".woff2", ".ttf", ".otf", ".eot", ".map", ".txt", ".csv"
]);

export type BigScreenBundleViolation = {
  /** Stable id so the console can group and translate these. */
  code: string;
  /** What is wrong, in the operator's terms. */
  message: string;
  /** The change that would clear it. */
  fix: string;
  /** File the problem was found in, when it is specific to one. */
  file?: string;
};

export type BigScreenBundleFile = {
  /** Path relative to the template root, POSIX separators. */
  path: string;
  sizeBytes: number;
  /** SHA-256 of the bytes, so a re-upload of the same page is detectable. */
  sha256: string;
};

export type BigScreenBundleManifest = {
  /** True when the page reads a data file the bridge can intercept. */
  bindable: boolean;
  /** The single file the page fetches for its data, when it has one. */
  dataFile: string;
  entry: string;
  files: BigScreenBundleFile[];
  sizeBytes: number;
  /** Names the page publishes for the bridge's binding channel, when it has one. */
  binding?: { global: string; call: string; stop?: string };
  /** Dot paths found in the page's own `DEFAULT_DATA`, offered as a field list. */
  fields: Array<{ path: string; kind: "series" | "scalar" | "labels" }>;
};

export type BigScreenBundleParseResult =
  | { ok: true; manifest: BigScreenBundleManifest; files: Array<{ content: Buffer; path: string }> }
  | { ok: false; violations: BigScreenBundleViolation[]; entry?: BigScreenBundleSource };

/**
 * The entry page, kept alongside a refusal.
 *
 * A rejected upload has two ways forward: the operator fixes the page by hand, or
 * the configured model rewrites it. The second one needs the source, and after a
 * refusal nothing was installed, so this is the only chance to keep it — the
 * parser is holding the unpacked archive at exactly this moment. Only the entry
 * file is retained: a model asked to rewrite one page has no use for the images
 * beside it, and holding the whole bundle alive per request is how a console
 * runs a small server out of memory.
 */
export type BigScreenBundleSource = {
  /** The page the model is asked to rewrite, bundle-relative. */
  entry: string;
  /** How that entry was chosen, when the bundle's own structure was unreadable. */
  entryGuessed: boolean;
  /** Every path in the archive, so the model can see what it may reference. */
  files: string[];
  html: string;
};

const violation = (
  code: string,
  message: string,
  fix: string,
  file?: string
): BigScreenBundleViolation => ({ code, message, fix, ...(file ? { file } : {}) });

/**
 * Cap on the page text handed to the model for repair.
 *
 * This rides inside the upload's JSON error response, so it is a cap on a single
 * field rather than on the request; a page over it is one no single rewrite will
 * fix anyway, and truncating would hand the model a page with a torn-off ending
 * and invite it to "fix" the tear.
 */
export const MAX_BIG_SCREEN_REPAIR_SOURCE_BYTES = 512 * 1024;

/**
 * Picks the page a repair should rewrite, and keeps its text.
 *
 * The choice has to match `checkStructure`'s, but that function only reports the
 * entry on success — on the paths that reach here there is no entry to read back.
 * So it is re-derived: `index.html` first, then a lone html file, then a guess.
 * The guess matters because the commonest refusal is an entry page not named
 * `index.html` beside one or two other html files, and those are exactly the
 * uploads the model has the best chance of rescuing.
 */
const captureSource = (
  files: Array<{ content: Buffer; path: string }>
): BigScreenBundleSource | undefined => {
  const pages = files.filter((entry) => /\.html?$/iu.test(entry.path));
  const named = files.find((entry) => entry.path === "index.html");
  const guessed = !named && pages.length > 0;
  const page = named ?? pages[0];
  if (!page || page.content.length > MAX_BIG_SCREEN_REPAIR_SOURCE_BYTES) {
    return undefined;
  }
  return {
    entry: page.path,
    entryGuessed: guessed,
    files: files.map((entry) => entry.path),
    html: page.content.toString("utf8")
  };
};

/**
 * Unpacks a `.zip` or single `.html` template and checks it against the
 * contract. Returns the files and a manifest, or every reason it was refused —
 * the caller shows all of them at once so one round of editing clears them all.
 *
 * A refusal also carries the entry page's source when there is one to carry. Once
 * the archive is unpacked the parser is the last place the page text exists — the
 * caller has a buffer it is about to drop — and without it the "have the model fix
 * it" path has nothing to fix.
 */
export const parseBigScreenTemplateUpload = async (
  file: BigScreenTemplateUpload
): Promise<BigScreenBundleParseResult> => {
  const lower = file.filename.toLowerCase();
  if (file.content.length > MAX_BIG_SCREEN_BUNDLE_BYTES) {
    return {
      ok: false,
      violations: [violation(
        "bundle-too-large",
        `页面文件超过 ${Math.round(MAX_BIG_SCREEN_BUNDLE_BYTES / 1024 / 1024)}MB 上限。`,
        "把页面里的大体积资源（视频、未压缩图片、内联的基础库）换成 CDN 引用或压缩后再上传。"
      )]
    };
  }

  let files: Array<{ content: Buffer; path: string }>;
  if (lower.endsWith(".zip")) {
    let entries: Array<{ content: Buffer; name: string }>;
    try {
      entries = await readSafeZipEntries(file.content, {
        maxEntries: MAX_BIG_SCREEN_BUNDLE_ENTRIES,
        maxUncompressedBytes: MAX_BIG_SCREEN_BUNDLE_UNCOMPRESSED
      });
    } catch (error) {
      return {
        ok: false,
        violations: [violation(
          "zip-unreadable",
          `压缩包无法解析：${error instanceof Error ? error.message : String(error)}。`,
          "用系统自带的压缩工具重新打包（不要加密、不要分卷），并把页面文件放在压缩包根目录。"
        )]
      };
    }
    files = entries
      .map((entry) => ({ content: entry.content, path: normalizeBundlePath(entry.name) }))
      .filter((entry): entry is { content: Buffer; path: string } => entry.path !== "");
  } else if (lower.endsWith(".html") || lower.endsWith(".htm")) {
    files = [{ content: file.content, path: file.filename }];
  } else {
    return {
      ok: false,
      violations: [violation(
        "bundle-type-unsupported",
        "只接受 .zip 压缩包或单个 .html 文件。",
        "如果页面还引用了自己的 js/css/图片，请把这些文件一起打包成 zip 再上传。"
      )]
    };
  }

  files = unwrapSingleRootFolder(files);

  const structure = checkStructure(files);
  if (!structure.ok) {
    const source = captureSource(files);
    return {
      ok: false,
      violations: structure.violations,
      ...(source ? { entry: source } : {})
    };
  }

  const inspected = inspectBigScreenBundle({ entry: structure.entry, files });
  if (inspected.manifest) {
    return { ok: true, files, manifest: inspected.manifest };
  }
  // The structure was readable, so the entry is the real one, not a guess.
  const source = captureSource(files);
  return {
    ok: false,
    violations: inspected.violations,
    ...(source ? { entry: { ...source, entry: structure.entry, entryGuessed: false } } : {})
  };
};

/**
 * Checks a page that is *already installed* against the same contract an upload
 * has to satisfy, without writing anything.
 *
 * Upload validation and this share every rule below; what differs is the input.
 * An upload hands over bytes that were just unpacked and may be installed if
 * they pass. A page already on disk is read back — bundled templates were never
 * uploaded at all, and an uploaded one can fail the contract later, because the
 * contract is a property of the page rather than of the moment it arrived.
 *
 * A page that passes gets its manifest, the same document the upload would have
 * written, so nothing downstream can tell the two paths apart.
 */
export const inspectBigScreenBundle = (input: {
  entry: string;
  files: Array<{ content: Buffer; path: string }>;
}): { violations: BigScreenBundleViolation[]; manifest?: BigScreenBundleManifest } => {
  const { entry, files } = input;
  const page = files.find((item) => item.path === entry);
  if (!page) {
    return {
      violations: [violation(
        "entry-missing",
        `找不到入口页 ${entry}。`,
        "确认页面目录里有入口文件，或重新上传一次。",
        entry
      )]
    };
  }

  const html = page.content.toString("utf8");
  const violations = [
    ...checkPageContract(html, entry, files),
    ...checkLocalReferences(html, entry, files)
  ];
  if (violations.length > 0) {
    return { violations };
  }

  const analysis = analyzePage(html);
  return {
    violations: [],
    manifest: {
      bindable: analysis.dataFile !== "" || Boolean(analysis.binding),
      ...(analysis.binding ? { binding: analysis.binding } : {}),
      dataFile: analysis.dataFile,
      entry,
      fields: analysis.fields,
      files: files
        .map((file) => ({
          path: file.path,
          sha256: createHash("sha256").update(file.content).digest("hex"),
          sizeBytes: file.content.length
        }))
        .sort((left, right) => left.path.localeCompare(right.path)),
      sizeBytes: files.reduce((sum, file) => sum + file.content.length, 0)
    }
  };
};

/**
 * Strips a wrapper folder. Zipping a folder is the default in every file
 * manager, so `myscreen/index.html` has to mean the same thing as
 * `index.html` — refusing it would be a rule about the archiver, not the page.
 */
const unwrapSingleRootFolder = (
  files: Array<{ content: Buffer; path: string }>
): Array<{ content: Buffer; path: string }> => {
  const heads = new Set(files.map((entry) => entry.path.split("/")[0] ?? ""));
  if (heads.size !== 1 || files.some((entry) => !entry.path.includes("/"))) {
    return files;
  }
  const strip = (value: string): string => value.slice(value.indexOf("/") + 1);
  const stripped = files.map((entry) => ({ content: entry.content, path: strip(entry.path) }));
  // Only strip when it actually produced a page, so a folder literally named
  // `index.html` cannot swallow the bundle.
  return stripped.some((entry) => entry.path === "index.html") ? stripped : files;
};

/** Rejects absolute paths, drive letters and traversal; drops junk entries. */
const normalizeBundlePath = (value: string): string => {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\/+/u, "");
  if (!normalized || normalized.startsWith("/") || /^[a-zA-Z]:/u.test(normalized)) return "";
  const parts = normalized.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.includes("..")) return "";
  for (const part of parts) {
    if (part.includes("\0")) return "";
  }
  return parts.join("/");
};

type StructureCheck =
  | { ok: true; entry: string }
  | { ok: false; violations: BigScreenBundleViolation[] };

const checkStructure = (files: Array<{ path: string }>): StructureCheck => {
  const violations: BigScreenBundleViolation[] = [];
  const pages = files.filter((entry) => /\.html?$/iu.test(entry.path));

  // macOS archives routinely carry `__MACOSX/._x` and `.DS_Store`; they are not
  // the user's fault and carry nothing, so they are dropped rather than refused.
  const meaningful = files.filter((entry) => !isJunkEntry(entry.path));
  if (meaningful.length === 0) {
    return {
      ok: false,
      violations: [violation(
        "bundle-empty",
        "压缩包里没有可用的页面文件。",
        "至少放入一个 index.html 作为大屏入口页。"
      )]
    };
  }

  if (pages.length === 0) {
    return {
      ok: false,
      violations: [violation(
        "page-missing",
        "压缩包里没有 .html 页面文件。",
        "把大屏入口页命名为 index.html 并放在压缩包根目录。"
      )]
    };
  }

  const unsupported = files
    .map((entry) => entry.path)
    .filter((entry) => !isJunkEntry(entry) && !ALLOWED_EXTENSIONS.has(extensionOf(entry)));
  if (unsupported.length > 0) {
    violations.push(violation(
      "file-type-unsupported",
      `包含不支持的文件类型：${unsupported.slice(0, 5).join("、")}${unsupported.length > 5 ? " 等" : ""}。`,
      "页面只能携带 html/js/css/图片/字体/数据文件；其他格式请改用外链或先转换。"
    ));
  }

  const entry = files.some((item) => item.path === "index.html")
    ? "index.html"
    : (pages.length === 1 ? pages[0]!.path : "");
  if (!entry) {
    return {
      ok: false,
      violations: [
        ...violations,
        violation(
          "entry-ambiguous",
          `压缩包里有 ${pages.length} 个 html 文件，无法判断哪个是入口页。`,
          "把入口页命名为 index.html 放在压缩包根目录，其他页面放到子目录。"
        )
      ]
    };
  }
  if (violations.length > 0) {
    return { ok: false, violations };
  }
  return { ok: true, entry };
};

const isJunkEntry = (value: string): boolean => {
  const base = value.split("/").at(-1) ?? "";
  return value.startsWith("__MACOSX/")
    || base === ".DS_Store"
    || base === "Thumbs.db"
    || base === "";
};

const extensionOf = (value: string): string => {
  const base = value.split("/").at(-1) ?? "";
  const index = base.lastIndexOf(".");
  return index <= 0 ? "" : base.slice(index).toLowerCase();
};

/**
 * The contract the bridge relies on. Each rule maps to one way a page can look
 * correct while showing nothing real, so a page that fails any of them is
 * refused rather than installed and left for the operator to debug on a wall.
 */
const checkPageContract = (
  html: string,
  entry: string,
  files: Array<{ path: string }>
): BigScreenBundleViolation[] => {
  const violations: BigScreenBundleViolation[] = [];
  const analysis = analyzePage(html);

  if (!analysis.hasDefaultData) {
    violations.push(violation(
      "default-data-missing",
      "页面缺少 DEFAULT_DATA 兜底数据：数据源断开时大屏会白屏。",
      "在页面脚本顶部补一个 DEFAULT_DATA 对象，并让页面先用它渲染一次；真实数据到达后再覆盖。",
      entry
    ));
  }

  if (analysis.binding) {
    // A page that publishes a global setter is fine without a fetch — that is
    // the second delivery path the bridge supports.
  } else if (!analysis.dataFile) {
    violations.push(violation(
      "data-file-missing",
      "页面没有 fetch 自己的数据文件，也没有暴露可供注入的全局对象，因此拿不到实时数据。",
      '二选一：① 在页面里 fetch 一个同目录下的 json（例如 fetch("data.json")）；'
      + "② 把数据放在模块级对象里，并暴露一个全局写法（例如 window.SCREEN = { setData(d){...}, stop(){} }）。",
      entry
    ));
  }

  if (analysis.externalDataFile) {
    violations.push(violation(
      "data-file-not-local",
      "页面 fetch 的数据文件不在页面同目录下，无法被数据桥接接管。",
      "把数据文件放在压缩包内与页面同级，并把 fetch 路径改成相对路径（例如 \"data.json\"）。",
      entry
    ));
  }

  if (analysis.absoluteLocalReference) {
    violations.push(violation(
      "absolute-path",
      `页面引用了本机绝对路径（${analysis.absoluteLocalReference}），换一台机器就加载不到。`,
      "改成相对路径（例如 \"assets/echarts.min.js\"），并把被引用的文件一并放进压缩包。",
      entry
    ));
  }

  if (analysis.protocolRelativeReference) {
    violations.push(violation(
      "protocol-relative-path",
      "页面用了 //host/path 形式的外链，在 https 页面下会被浏览器拦截。",
      "把协议写全（https://…）。",
      entry
    ));
  }

  if (!analysis.usesMergeOnUpdate) {
    violations.push(violation(
      "no-incremental-update",
      "页面没有在数据刷新时合并新数据（缺少 merge 逻辑），每次刷新会整屏重建，滚动与动画会跳。",
      "提供 mergeData(next) 之类的合并入口：把新数据并进当前数据对象后重建图表，而不是替换整个数据源。",
      entry
    ));
  }

  if (!analysis.hasChartLib && files.some((item) => /echarts|chart|highcharts|d3/iu.test(item.path))) {
    violations.push(violation(
      "chart-lib-not-loaded",
      "压缩包里有图表库文件，但页面里没有引用它。",
      "在页面里加上对应的 <script src=\"assets/…\"></script>。",
      entry
    ));
  }

  return violations;
};

/**
 * Every relative `src`/`href`/`url()` in the page must resolve to a file in the
 * bundle. Left unchecked, a typo'd path is invisible until the wall is deployed.
 *
 * Only the page's own markup and style are searched. A page is allowed to carry
 * a vendor bundle inline, and a minified library is full of string literals that
 * read like references — `href="'+s+'"` inside a template literal, `url(#id)`
 * inside an SVG filter — none of which name a file. Reading those as references
 * reports a page as broken over code the operator did not write and cannot fix.
 */
const checkLocalReferences = (
  html: string,
  entry: string,
  files: Array<{ path: string }>
): BigScreenBundleViolation[] => {
  const available = new Set(files.map((item) => item.path));
  const missing: string[] = [];
  for (const reference of extractLocalReferences(html)) {
    const resolved = resolveRelativePath(entry, reference);
    if (resolved !== "" && !available.has(resolved)) {
      missing.push(reference);
    }
  }
  if (missing.length === 0) {
    return [];
  }
  return [violation(
    "reference-missing",
    `页面引用了压缩包里不存在的文件：${[...new Set(missing)].slice(0, 8).join("、")}。`,
    "把这些文件一起打包，或删掉对应引用；只有 http(s) 地址才允许指向外部。",
    entry
  )];
};

/**
 * Splits a page into the parts worth reading for references — the markup outside
 * `<script>` (attribute references, including a script's own `src`) and the CSS
 * (`<style>` blocks). A script's *body* is handed back separately because it is
 * read for a different purpose: it is where the data layer lives, and it is the
 * last place a file path should be taken at face value.
 */
const splitPageSource = (html: string): { markup: string; script: string } => {
  const markup: string[] = [];
  const script: string[] = [];
  let cursor = 0;
  while (cursor < html.length) {
    const open = html.slice(cursor).search(/<script\b/iu);
    if (open === -1) break;
    const start = cursor + open;
    const close = html.slice(start).search(/<\/script\s*>/iu);
    // An unterminated `<script>` swallows the rest of the file, which is also
    // what a browser does with it.
    const end = close === -1 ? html.length : start + close + "</script>".length;
    // The opening tag stays in the markup: `src` on it is a real reference.
    const tagEnd = html.slice(start).indexOf(">");
    const tagEndAt = tagEnd === -1 ? end : start + tagEnd + 1;
    markup.push(html.slice(start, tagEndAt));
    script.push(html.slice(tagEndAt, end));
    cursor = end;
  }
  markup.push(html.slice(cursor));
  return { markup: markup.join("\n"), script: script.join("\n") };
};

const extractLocalReferences = (html: string): string[] => {
  const { markup } = splitPageSource(html);
  const found: string[] = [];
  const attribute = /(?:src|href)\s*=\s*["']([^"']+)["']/giu;
  for (const match of markup.matchAll(attribute)) {
    const value = match[1]?.trim() ?? "";
    if (isLocalReference(value)) {
      found.push(value);
    }
  }
  const cssUrl = /url\(\s*["']?([^"')]+)["']?\s*\)/giu;
  for (const match of markup.matchAll(cssUrl)) {
    const value = match[1]?.trim() ?? "";
    // A bare `#id` inside a `url()` is an SVG paint server, not a file, and
    // `url(#…)` is also how a minified library writes one from a variable.
    if (isLocalReference(value) && !/^['"]?\s*\+/u.test(value)) {
      found.push(value);
    }
  }
  return found;
};

const isLocalReference = (value: string): boolean =>
  value !== ""
  && !value.startsWith("#")
  && !value.startsWith("data:")
  && !value.startsWith("blob:")
  && !value.startsWith("mailto:")
  && !value.startsWith("javascript:")
  && !/^https?:\/\//iu.test(value)
  && !value.startsWith("//")
  && !value.startsWith("/");

/** Resolves `a/b/index.html` + `../c.png` → `a/c.png`, or "" when it escapes the bundle. */
const resolveRelativePath = (entry: string, reference: string): string => {
  const clean = reference.split("?")[0]?.split("#")[0] ?? "";
  if (clean === "") return "";
  const base = entry.split("/").slice(0, -1);
  const parts = [...base, ...clean.split("/")];
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (stack.length === 0) return "";
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return stack.join("/");
};

type PageAnalysis = {
  absoluteLocalReference: string;
  /** The data file when the page fetches one from its own folder. */
  dataFile: string;
  /** Set when a fetch target looks like a data file but resolves off-folder. */
  externalDataFile: boolean;
  binding?: { call: string; global: string; stop?: string };
  fields: Array<{ path: string; kind: "series" | "scalar" | "labels" }>;
  hasChartLib: boolean;
  hasDefaultData: boolean;
  protocolRelativeReference: boolean;
  usesMergeOnUpdate: boolean;
};

/**
 * Reads the page the way the bridge will: what it fetches, what global it
 * publishes, and what shape its data has. Regex rather than a parser — a page
 * is arbitrary user JS, and a real parser would turn a syntax error into an
 * opaque parse failure instead of one clear violation.
 */
const analyzePage = (html: string): PageAnalysis => {
  const fetchTargets = [...html.matchAll(/fetch\s*\(\s*["'`]([^"'`]+)["'`]/gu)]
    .map((match) => match[1]?.trim() ?? "");
  const dataFile = fetchTargets.find((target) =>
    isLocalReference(target) && /\.json(\?|#|$)/iu.test(target)
  ) ?? "";
  const externalDataFile = !dataFile
    && fetchTargets.some((target) => /\.json(\?|#|$)/iu.test(target));

  const bindingMatch = /window\s*\.\s*([A-Za-z_$][\w$]*)\s*=\s*\{[\s\S]{0,600}?\}/u.exec(html);
  const bindingCalls = bindingMatch
    ? [...bindingMatch[0].matchAll(/(?:^|[,{\s])([A-Za-z_$][\w$]*)\s*[:(]/gu)].map((match) => match[1] ?? "")
    : [];
  const call = bindingCalls.find((name) => /^set[A-Z]|^update|^apply|^render/iu.test(name));
  const stop = bindingCalls.find((name) => /^stop|^pause|^halt/iu.test(name));
  const binding = bindingMatch && call
    ? { call, global: bindingMatch[1] ?? "", ...(stop ? { stop } : {}) }
    : undefined;

  const defaults = extractDefaultData(html);
  const absoluteMatch = /(?:src|href)\s*=\s*["'](?:[a-zA-Z]:[\\/]|file:\/\/\/)/u.exec(html);

  return {
    absoluteLocalReference: absoluteMatch?.[0]?.replace(/^.*?["']/u, "") ?? "",
    ...(binding ? { binding } : {}),
    dataFile,
    externalDataFile,
    fields: defaults.fields,
    hasChartLib: /\becharts\b|\bChart\s*\(|\bhighcharts\b|\bd3\s*\./iu.test(html),
    hasDefaultData: defaults.found,
    protocolRelativeReference: /(?:src|href)\s*=\s*["']\/\//u.test(html),
    usesMergeOnUpdate: /merge[A-Za-z]*\s*\(|setData\s*\(/u.test(html)
  };
};

/**
 * Pulls the page's `DEFAULT_DATA` object out of the source and flattens it into
 * dot paths. Numbers become scalars, arrays of numbers become series, and
 * arrays of objects contribute their own `name`/`value` shape — which is what
 * the field editor then offers as 数据类别.
 *
 * The literal is read structurally rather than through `JSON.parse`. A page
 * written by hand — which is every page an operator uploads — quotes its keys
 * the way JavaScript allows, not the way JSON requires: bare identifiers,
 * single quotes, trailing commas, `genPdt(14)` standing in for a real series.
 * `JSON.parse` rejects all four, and the failure was invisible, because an
 * empty field list still looks like a page that simply has nothing to bind. So
 * the shape is walked directly and the values are never evaluated: a call, an
 * identifier, a template literal all contribute a leaf of unguessable type,
 * which is enough to offer the field.
 */
const extractDefaultData = (html: string): {
  fields: Array<{ path: string; kind: "series" | "scalar" | "labels" }>;
  found: boolean;
} => {
  const start = /(?:const|let|var)\s+DEFAULT_DATA\s*=\s*\{/u.exec(html);
  if (!start || start.index === undefined) {
    return { fields: [], found: false };
  }
  const open = html.indexOf("{", start.index);
  const end = matchClosingBrace(html, open);
  if (open < 0 || end < 0) {
    return { fields: [], found: false };
  }
  const scanned = scanObjectShape(html, open, end);
  // `found` stays true even when nothing could be read: the page does declare a
  // `DEFAULT_DATA`, and the two states mean different things to the operator —
  // "you have no defaults to suggest from" versus "you have defaults I could not
  // read". Reporting them as one sends the second operator to the wrong fix.
  return { fields: flattenDataShape(scanned), found: true };
};

/**
 * Walks one object literal and returns an object carrying only the shape that
 * matters: nested objects, arrays (with a single representative element, or
 * none), and `null` for every scalar. Values are never looked at, so nothing
 * here can execute or evaluate.
 */
const scanObjectShape = (source: string, open: number, close: number): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  let cursor = open + 1;
  while (cursor < close) {
    const key = readObjectKey(source, cursor);
    if (!key) {
      // Not at a key: skip a separator, a comment, or a value whose key never
      // arrived, and try again one character on. A malformed literal still
      // yields every field declared before the damage.
      cursor += 1;
      continue;
    }
    cursor = skipSpaceAndComments(source, key.end);
    if (source[cursor] !== ":") {
      cursor = key.end;
      continue;
    }
    cursor += 1;
    const unparsed = readValueShape(source, cursor, close);
    if (unparsed) {
      out[key.name] = unparsed.value;
      cursor = unparsed.end;
    } else {
      cursor = skipToNextEntry(source, key.end, close);
    }
  }
  return out;
};

const isIdentifierStart = (char: string): boolean => /[A-Za-z_$]/u.test(char);
const isIdentifierPart = (char: string): boolean => /[A-Za-z0-9_$]/u.test(char);
const isSpace = (char: string): boolean => char === " " || char === "\t" || char === "\n" || char === "\r";

/** Steps over whitespace and `//` / block comments. */
const skipSpaceAndComments = (source: string, from: number): number => {
  let cursor = from;
  while (cursor < source.length) {
    const char = source[cursor] ?? "";
    if (isSpace(char)) {
      cursor += 1;
      continue;
    }
    const next = source[cursor + 1];
    if (char === "/" && next === "/") {
      const stop = source.indexOf("\n", cursor);
      cursor = stop < 0 ? source.length : stop + 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const stop = source.indexOf("*/", cursor);
      cursor = stop < 0 ? source.length : stop + 2;
      continue;
    }
    break;
  }
  return cursor;
};

/**
 * Reads one `key:` at `from` — bare, single-quoted, double-quoted or computed.
 * Returns null when the position does not start a key, so the caller can step
 * forward. A computed key is dropped: `[monthName]: 1` has no stable name, and
 * inventing one would put a field in the editor that no query can target.
 */
const readObjectKey = (
  source: string,
  from: number
): { end: number; name: string } | null => {
  const cursor = skipSpaceAndComments(source, from);
  const char = source[cursor] ?? "";
  if (char === "'" || char === '"' || char === "`") {
    const literal = readStringLiteral(source, cursor);
    if (!literal) {
      return null;
    }
    return { end: literal.end, name: literal.value };
  }
  if (char === "[") {
    // Computed key — consume it so its contents are not mistaken for entries.
    const inner = readValueShape(source, cursor, source.length);
    return inner ? { end: inner.end, name: "" } : null;
  }
  if (!isIdentifierStart(char)) {
    return null;
  }
  let end = cursor;
  while (end < source.length && isIdentifierPart(source[end] ?? "")) {
    end += 1;
  }
  return { end, name: source.slice(cursor, end) };
};

/**
 * Reads a string in any of the three quoting styles, resolving the escapes that
 * can appear in a key. An unterminated literal — a page truncated mid-object —
 * stops at the line end rather than swallowing the rest of the file.
 */
const readStringLiteral = (
  source: string,
  from: number
): { end: number; value: string } | null => {
  const quote = source[from] ?? "";
  let value = "";
  let cursor = from + 1;
  while (cursor < source.length) {
    const char = source[cursor] ?? "";
    if (char === "\\") {
      const escaped = source[cursor + 1] ?? "";
      value += escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped;
      cursor += 2;
      continue;
    }
    if (char === quote) {
      return { end: cursor + 1, value };
    }
    if (char === "\n" && quote !== "`") {
      return { end: cursor, value };
    }
    value += char;
    cursor += 1;
  }
  return null;
};

/**
 * Reads one value's shape and returns where it ended. Scalars come back as
 * `null`, arrays come back holding a single representative element, and objects
 * recurse. A value the scanner cannot describe — an arrow function, a `new`
 * expression — returns null so the caller resynchronises on the next key
 * instead of reading into it.
 */
const readValueShape = (
  source: string,
  from: number,
  limit: number
): { end: number; value: unknown } | null => {
  const cursor = skipSpaceAndComments(source, from);
  if (cursor >= limit) {
    return null;
  }
  const char = source[cursor] ?? "";
  if (char === "{") {
    const end = matchClosingBrace(source, cursor);
    if (end < 0 || end > limit) {
      return null;
    }
    return { end: end + 1, value: scanObjectShape(source, cursor, end) };
  }
  if (char === "[") {
    const end = matchClosingBracket(source, cursor);
    if (end < 0 || end > limit) {
      return null;
    }
    const element = readArrayElementShape(source, cursor + 1, end);
    return { end: end + 1, value: element === undefined ? [] : [element] };
  }
  if (char === "'" || char === '"' || char === "`") {
    const literal = readStringLiteral(source, cursor);
    return literal ? { end: literal.end, value: null } : null;
  }
  if (char === "-" || char === "+" || char === "." || /[0-9]/u.test(char)) {
    return { end: readNumericLiteralEnd(source, cursor, limit), value: null };
  }
  if (isIdentifierStart(char)) {
    // `true`, `null`, and any identifier — including a function call, whose
    // arguments are stepped over rather than inspected.
    let end = cursor;
    while (end < limit && isIdentifierPart(source[end] ?? "")) {
      end += 1;
    }
    const after = skipSpaceAndComments(source, end);
    if (source[after] === "(") {
      const close = matchClosingParen(source, after);
      if (close < 0 || close > limit) {
        return null;
      }
      return { end: close + 1, value: null };
    }
    if (source[after] === "=" && source[after + 1] === ">") {
      // Arrow function: skip to the end of its body so its braces are not read
      // as a nested object.
      const body = readArrowBodyEnd(source, after + 2, limit);
      return body < 0 ? null : { end: body, value: null };
    }
    return { end, value: null };
  }
  return null;
};

/**
 * Reads the first element of an array literal, skipping empty slots and
 * comments, so `[1, 2, 3]` and `[{ name: 'a', value: 1 }]` are told apart. Only
 * the first element is read: the kind of a series is decided by what a row
 * looks like, and reading further would offer fields no query produces.
 */
const readArrayElementShape = (source: string, from: number, close: number): unknown => {
  const cursor = skipSpaceAndComments(source, from);
  if (cursor >= close || source[cursor] === "," || source[cursor] === "]") {
    return undefined;
  }
  const shape = readValueShape(source, cursor, close);
  return shape ? shape.value : undefined;
};

/** End offset just past a numeric literal. */
const readNumericLiteralEnd = (source: string, from: number, limit: number): number => {
  let cursor = from;
  while (cursor < limit && /[0-9a-fA-FxX.eE+\-]/u.test(source[cursor] ?? "")) {
    cursor += 1;
  }
  return cursor;
};

const readArrowBodyEnd = (source: string, from: number, limit: number): number => {
  const cursor = skipSpaceAndComments(source, from);
  const char = source[cursor] ?? "";
  if (char === "{") {
    const end = matchClosingBrace(source, cursor);
    return end < 0 || end > limit ? -1 : end + 1;
  }
  const shape = readValueShape(source, cursor, limit);
  return shape ? shape.end : -1;
};

/**
 * Advances past a value the scanner declined to read, stopping at the comma or
 * the closing brace that ends the entry. Braces and brackets are balanced on
 * the way, so a resynchronisation cannot land inside a nested literal.
 */
const skipToNextEntry = (source: string, from: number, limit: number): number => {
  let cursor = from;
  let depth = 0;
  while (cursor < limit) {
    const char = source[cursor] ?? "";
    if (char === "{" || char === "[" || char === "(") {
      depth += 1;
    } else if (char === "}" || char === "]" || char === ")") {
      if (depth === 0) {
        return cursor;
      }
      depth -= 1;
    } else if (char === "," && depth === 0) {
      return cursor + 1;
    } else if ((char === "'" || char === '"' || char === "`")) {
      const literal = readStringLiteral(source, cursor);
      if (!literal) {
        return cursor + 1;
      }
      cursor = literal.end;
      continue;
    }
    cursor += 1;
  }
  return cursor;
};

const matchClosingBracket = (source: string, open: number): number =>
  matchClosingDelimiter(source, open, "[", "]");

const matchClosingParen = (source: string, open: number): number =>
  matchClosingDelimiter(source, open, "(", ")");

const matchClosingDelimiter = (
  source: string,
  open: number,
  opener: string,
  closer: string
): number => {
  if (open < 0) return -1;
  let depth = 0;
  let quote = "";
  for (let index = open; index < source.length; index += 1) {
    const char = source[index] ?? "";
    if (quote) {
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === opener) depth += 1;
    if (char === closer) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
};

const matchClosingBrace = (source: string, open: number): number => {
  if (open < 0) return -1;
  let depth = 0;
  let quote = "";
  for (let index = open; index < source.length; index += 1) {
    const char = source[index] ?? "";
    if (quote) {
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
};

/**
 * Flattens the scanned shape into dot paths. Scalars become single-value slots,
 * arrays become series — or label lists when their rows carry a `name`, which
 * is what makes a chart axis bindable — and objects recurse, to the same depth
 * the scanner would have produced.
 */
const flattenDataShape = (
  value: unknown,
  prefix = "",
  depth = 0
): Array<{ path: string; kind: "series" | "scalar" | "labels" }> => {
  if (depth > 4 || typeof value !== "object" || value === null) {
    return [];
  }
  const fields: Array<{ path: string; kind: "series" | "scalar" | "labels" }> = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    // A computed key was read as the empty string; it has no name to bind to.
    if (key === "") {
      continue;
    }
    const path = prefix ? `${prefix}.${key}` : key;
    if (Array.isArray(child)) {
      const first = child[0];
      if (typeof first === "object" && first !== null) {
        const keys = Object.keys(first as Record<string, unknown>);
        fields.push({ path, kind: keys.includes("name") ? "labels" : "series" });
      } else {
        fields.push({ path, kind: "series" });
      }
      continue;
    }
    if (typeof child === "object" && child !== null) {
      fields.push(...flattenDataShape(child, path, depth + 1));
      continue;
    }
    fields.push({ path, kind: "scalar" });
  }
  return fields;
};

/**
 * Unpacks a validated bundle into `<root>/<id>/`. The directory is replaced
 * wholesale, because a stale file from a previous upload would otherwise keep
 * being served after the page stopped referencing it.
 */
export const installBigScreenBundle = (input: {
  files: Array<{ content: Buffer; path: string }>;
  id: string;
  root: string;
}): string => {
  const target = resolve(input.root, input.id);
  if (!target.startsWith(resolve(input.root) + sep)) {
    throw new Error("BIG_SCREEN_TEMPLATE_PATH_UNSAFE");
  }
  rmSync(target, { force: true, recursive: true });
  mkdirSync(target, { recursive: true });
  for (const file of input.files) {
    const destination = resolve(target, file.path);
    if (!destination.startsWith(target + sep)) {
      throw new Error("BIG_SCREEN_TEMPLATE_PATH_UNSAFE");
    }
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, file.content);
  }
  return target;
};

export const removeBigScreenBundle = (input: { id: string; root: string }): void => {
  const target = join(input.root, input.id);
  rmSync(target, { force: true, recursive: true });
};

/**
 * The prompt handed to the operator when an upload is refused. It restates the
 * same contract as a specification, so the page can be fixed somewhere else and
 * re-uploaded instead of guessed at from a list of errors.
 */
export const BIG_SCREEN_PAGE_DESIGN_PROMPT = `你是一名数据大屏前端工程师。请把下面这份页面改造成可以接入实时数据的模板页，改完后这份页面会作为页面模板装进管理后台。

【我会怎么接】
装进去之后，我会在管理后台里把数据库查询结果的列，逐条映射到这份数据对象里的路径上：单值走 a.b.c，数组走 a.b.c[]；环形图、排名表这类需要 {name, value} 的点位，我会指定名称列与数值列配成一对。所以请保证兜底数据里的字段路径清晰、命名可读——这是后面所有绑定能对上的前提。

【交付形式】
1. 页面入口必须是一个 HTML 文件，放在页面根目录。样式和脚本可以直接内联，也可以拆成同目录的 .css / .js。
2. 页面引用的所有本地文件（js、css、图片、字体、数据 json）都必须一起带上，路径使用相对路径，例如 assets/echarts.min.js、data.json。
3. 禁止使用本机绝对路径（C:\\…、file:///…）和 //host/path 这种省略协议的写法。

【必须实现的数据层】
4. 页面顶部必须有一个 DEFAULT_DATA 对象作为兜底数据，并保证数据源不可用时页面用它渲染，不能白屏。
5. 页面必须 fetch 自己同目录下的一个 json 数据文件（例如 fetch("data.json")）—— 宿主会拦截这次请求并换成本地实时数据；或者，把数据保存在模块级对象里并暴露一个全局写法，例如：
     window.SCREEN = { setData(next){...}, stop(){...} }
   其中 setData 接收整份数据对象，stop 用于停掉页面自带的演示定时器。两种方式任选一种，不要两种都不做。
6. 页面必须提供数据合并入口（例如 mergeData(next)）：收到新数据时把新值并进当前数据对象后重绘，而不是整屏重建。这样滚动和动画才不会每刷新一次就跳一次。
7. 数据对象的结构要稳定：同一类数据的字段名、数组长度语义不要随刷新变化。数组型数据（趋势、分布）请用数组，单值指标（KPI 数字）请用标量。

【页面本身】
8. 页面自适应铺满视口，不出现滚动条，不依赖固定的窗口尺寸。
9. 页面自带的演示定时器（随机抖动、模拟推送）必须在收到真实数据后停止。
10. 页面只读取自己的数据层，不要直接请求后端接口、不要硬编码任何环境地址。

改好后请把页面（含所有本地依赖）交给我。`;

/** The same contract, in English, for pages authored outside a Chinese team. */
export const BIG_SCREEN_PAGE_DESIGN_PROMPT_EN = `You are a front-end engineer building a data-wall page. Rework the page below into a template page that can be wired to live data; it will end up installed in an admin console as a page template.

How it gets wired
Once it is installed I map database result columns onto paths in this data object: scalars go to a.b.c, arrays go to a.b.c[]. Slots that need {name, value} rows (pie charts, ranked lists) are bound as a name column paired with a value column. So keep the paths in the fallback data clear and the names readable — that is what every later binding is matched against.

Deliverable
1. The page entry must be a single HTML file at the root of the page folder. Inline styles and scripts are fine; splitting into sibling .css / .js files is fine too.
2. Every locally referenced file (js, css, image, font, data json) must come along and be referenced by a relative path, e.g. assets/echarts.min.js, data.json.
3. No absolute local paths (C:\\..., file:///...) and no protocol-relative URLs (//host/path).

Required data layer
4. A DEFAULT_DATA object at the top of the page, used to render when the data source is unreachable. The page must never render blank.
5. The page must either fetch a json data file from its own folder (e.g. fetch("data.json")) — the host intercepts that request and answers with live data — or keep its data in a module-scope object behind a page global, e.g. window.SCREEN = { setData(next){...}, stop(){...} }. Pick one; do not skip both.
6. Provide a merge entry point (e.g. mergeData(next)) that folds new values into the current data object and redraws, instead of rebuilding the whole page on every refresh — otherwise scrolling and animations jump on each poll.
7. Keep the data shape stable: field names and array-length semantics must not change between refreshes. Series belong in arrays; KPIs belong in scalars.

The page
8. Fill the viewport responsively, with no page scrollbar and no dependence on a fixed window size.
9. Any built-in demo ticker (random jitter, simulated pushes) must stop once live data arrives.
10. Read only your own data layer — do not call backend endpoints or hardcode environment URLs.

Send the page back, including all local dependencies.`;

/**
 * The same contract again, addressed to a model rather than a person: this is
 * what the console sends to the configured default model when the operator asks
 * it to repair the page instead of doing it by hand.
 */
export const buildBigScreenRepairPrompt = (input: {
  entry: string;
  html: string;
  files: string[];
  violations: BigScreenBundleViolation[];
}): string => `下面是一份要接入实时数据的大屏页面模板，它没有通过上传校验。

【整改要求】
${BIG_SCREEN_PAGE_DESIGN_PROMPT}

【本次未通过的原因】
${input.violations.map((item, index) => `${index + 1}. [${item.code}] ${item.message}（改法：${item.fix}）`).join("\n")}

【压缩包内文件】
${input.files.join("\n")}

【入口页 ${input.entry} 的完整源码】
\`\`\`html
${input.html}
\`\`\`

请直接输出改造后的完整入口页源码，只输出这一个文件的代码，不要解释、不要输出 markdown 代码块以外的内容。不要改动页面的视觉设计与业务含义，只做接入实时数据所必需的改造。`;
