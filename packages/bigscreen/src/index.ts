/**
 * Big-screen page bundles, shared by the API and the web server.
 *
 * Both processes need the same answer to two questions — "is this zip a page we
 * can serve?" and "which files does it consist of?" — and they must agree, or an
 * upload will be accepted by the console and then 404 on the wall. They do not
 * share a process, a working directory, or a build, so the rules live here once
 * and each side imports them.
 */
export {
  BIG_SCREEN_PAGE_DESIGN_PROMPT,
  BIG_SCREEN_PAGE_DESIGN_PROMPT_EN,
  BIG_SCREEN_RESERVED_TEMPLATE_IDS,
  BIG_SCREEN_BUILTIN_TEMPLATE_IDS,
  MAX_BIG_SCREEN_BUNDLE_BYTES,
  MAX_BIG_SCREEN_BUNDLE_ENTRIES,
  MAX_BIG_SCREEN_BUNDLE_UNCOMPRESSED,
  MAX_BIG_SCREEN_REPAIR_SOURCE_BYTES,
  buildBigScreenRepairPrompt,
  inspectBigScreenBundle,
  installBigScreenBundle,
  parseBigScreenTemplateUpload,
  removeBigScreenBundle,
  type BigScreenBundleFile,
  type BigScreenBundleManifest,
  type BigScreenBundleParseResult,
  type BigScreenBundleSource,
  type BigScreenBundleViolation,
  type BigScreenTemplateUpload
} from "./bundle.js";
export { bigScreenTemplateRoot, bigScreenUploadRoot } from "./root.js";
export { readSafeZipEntries } from "./zip-reader.js";
