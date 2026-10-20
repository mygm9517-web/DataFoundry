import { withTemplateStorage } from "../../../../../lib/bigscreen-templates-server";
import { NextResponse } from "next/server";
import path from "node:path";
import {
  BIG_SCREEN_PAGE_DESIGN_PROMPT,
  installBigScreenBundle,
  inspectBigScreenBundle
} from "@datafoundry/bigscreen";
import { callApi, envelopeData, envelopeError, envelopeMessage } from "../../../../../lib/api-server-client";
import {
  bigScreenUploadRoot,
  readArchive,
  readUploadedTemplates,
  writeArchive,
  writeUploadedTemplate
} from "../../../../../lib/bigscreen-templates-server";
import {
  checkBigScreenTemplate,
  readPageFiles
} from "../../../../../lib/bigscreen-compliance-server";

/**
 * Whether an installed page satisfies the import contract, and what to do about
 * it when it does not.
 *
 * Three actions, all aimed at the same outcome — a page that can be uploaded:
 *
 *   GET   read the page back and report what is wrong. The answer is computed
 *         from the files on disk every time, never remembered, so a page fixed
 *         by hand outside the console reads as fixed the moment it is saved.
 *   POST  hand the page to the default model and return a rewritten one. It is
 *         *not* installed: the operator sees the diff-worthy result and decides.
 *   PUT   install a rewritten page over the existing one, after the same
 *         inspection an upload would get. This is the second half of "两种方案
 *         共同确保页面模板能够上传": copy the prompt and fix it yourself, or let
 *         the platform's model fix it in place.
 *
 * On where the fix happens: the model is asked to repair the page, and the
 * console's only role is to carry the file. The page is authored elsewhere and
 * stays authored elsewhere — there is no editor here, on purpose.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

const jsonError = (code: string, message: string, status: number): Response =>
  NextResponse.json({ success: false, error: { code, message } }, { status });

/** A page id, validated before it is ever used as a path component. */
const isValidTemplateId = (value: string): boolean => /^[a-z0-9][a-z0-9-]{1,40}$/u.test(value);

const templateIdFromRequest = (request: Request): string => {
  const segments = new URL(request.url).pathname.split("/").filter(Boolean);
  const index = segments.lastIndexOf("big-screen-templates");
  const raw = index >= 0 ? segments[index + 1] : undefined;
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return "";
  }
};

async function handleGET(request: Request): Promise<Response> {
  const id = templateIdFromRequest(request);
  if (!isValidTemplateId(id)) {
    return jsonError("BIG_SCREEN_TEMPLATE_NOT_FOUND", "页面不存在。", 404);
  }
  const report = checkBigScreenTemplate(id);
  if (report.origin === "missing") {
    return jsonError("BIG_SCREEN_TEMPLATE_NOT_FOUND", `页面 “${id}” 不存在。`, 404);
  }
  return NextResponse.json({ success: true, data: report });
}

type RepairBody = { action?: string; html?: string; entry?: string; files?: string[] };

async function handlePOST(request: Request): Promise<Response> {
  const id = templateIdFromRequest(request);
  if (!isValidTemplateId(id)) {
    return jsonError("BIG_SCREEN_TEMPLATE_NOT_FOUND", "页面不存在。", 404);
  }
  const report = checkBigScreenTemplate(id);
  if (report.origin === "missing") {
    return jsonError("BIG_SCREEN_TEMPLATE_NOT_FOUND", `页面 “${id}” 不存在。`, 404);
  }
  // A page that already satisfies the contract has nothing to repair; the
  // caller is looking at a stale list, and the honest answer is the current one.
  if (report.status === "compliant") {
    return NextResponse.json({ success: true, data: { alreadyCompliant: true } });
  }
  if (!report.repair) {
    return jsonError(
      "BIG_SCREEN_TEMPLATE_REPAIR_UNSUPPORTED",
      "这个页面没有可供改造的源码，请下载后在自己的工具里修改并重新上传。",
      409
    );
  }

  // The same call the upload-rejection flow uses. Reusing it is the point: the
  // model sees one prompt for one contract, and a page repaired here is not
  // repaired by a second, differently-worded set of instructions.
  const remote = await callApi(request, "/api/v1/big-screen-templates/repair", {
    method: "POST",
    contentType: "application/json",
    body: JSON.stringify({
      entry: report.repair.entry,
      files: report.repair.files,
      html: report.repair.html,
      violations: report.violations
    })
  });

  const data = envelopeData<{ entry: string; html: string; model: string; latencyMs: number }>(remote);
  if (!data) {
    const reason = envelopeMessage(remote) ?? "";
    const empty = reason.startsWith("BIG_SCREEN_TEMPLATE_REPAIR_EMPTY");
    const provider = reason.startsWith("PROVIDER_TEST_FAILED") || reason.startsWith("PROVIDER_CONFIG_MISSING");
    return NextResponse.json(
      {
        success: false,
        error: {
          code: empty
            ? "BIG_SCREEN_TEMPLATE_REPAIR_EMPTY"
            : provider
              ? "PROVIDER_TEST_FAILED"
              : envelopeError(remote) ?? "BIG_SCREEN_TEMPLATE_REPAIR_FAILED",
          message: empty
            ? "默认模型这次没有返回可用页面。"
            : provider
              ? "无法连接默认模型。"
              : "调用默认模型改造页面失败。"
        },
        data: { designPrompt: BIG_SCREEN_PAGE_DESIGN_PROMPT, violations: report.violations }
      },
      { status: remote.status || 502 }
    );
  }
  return NextResponse.json({ success: true, data: { ...data, violationsBefore: report.violations } });
}

type ApplyBody = { entry?: string; html?: string };

/**
 * Installs a repaired page over the one on disk, after checking it.
 *
 * The check is the same one an upload gets, and a page that still fails is
 * refused rather than written: a model answer is a proposal, and the point of
 * having one validator is that no path into the serving folder skips it. A page
 * that passes is described by the manifest the inspector returned, so the
 * sidecar is rewritten from the page rather than patched — a repair can add or
 * drop a bindable field, and the console's mapping list follows the page.
 *
 * Bundled pages are refused. They are repository files, not operator uploads:
 * rewriting one would edit the app, and the change would not survive an update.
 */
async function handlePUT(request: Request): Promise<Response> {
  const id = templateIdFromRequest(request);
  if (!isValidTemplateId(id)) {
    return jsonError("BIG_SCREEN_TEMPLATE_NOT_FOUND", "页面不存在。", 404);
  }
  const report = checkBigScreenTemplate(id);
  if (report.origin === "missing") {
    return jsonError("BIG_SCREEN_TEMPLATE_NOT_FOUND", `页面 “${id}” 不存在。`, 404);
  }
  let body: ApplyBody = {};
  try {
    body = (await request.json()) as ApplyBody;
  } catch {
    return jsonError("JSON_OBJECT_REQUIRED", "请求体不是合法 JSON。", 400);
  }
  const html = typeof body.html === "string" ? body.html : "";
  if (html.trim() === "") {
    return jsonError("BIG_SCREEN_TEMPLATE_REPAIR_SOURCE_REQUIRED", "缺少要写回的页面源码。", 400);
  }

  const root = bigScreenUploadRoot();
  const existing = readUploadedTemplates(root).find((item) => item.id === id);
  if (!existing) {
    return jsonError("BIG_SCREEN_TEMPLATE_NOT_FOUND", `页面 “${id}” 不存在。`, 404);
  }
  // Only the entry page is replaced. The rewritten source carries the page's
  // whole front end, but the folder's other files — data json, assets — are the
  // operator's, and are read from where they already are, so a repair cannot
  // quietly drop a file the page still loads.
  const entry = typeof body.entry === "string" && body.entry.trim() ? body.entry : existing.entry;
  // The folder walk the check used, with exactly one file replaced. The archive
  // is skipped by that walk — it is the page in compressed form, not a file of
  // it — and it is restored below, after the install has replaced the folder.
  const siblings = readPageFiles(path.join(root, id)).filter((file) => file.path !== entry);
  const next = [
    ...siblings,
    { content: Buffer.from(html, "utf8"), path: entry }
  ];

  const inspected = inspectBigScreenBundle({ entry, files: next });
  if (!inspected.manifest) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "BIG_SCREEN_TEMPLATE_STILL_INVALID",
          message: "改好的页面仍然不符合要求，没有写回。"
        },
        data: { violations: inspected.violations, designPrompt: BIG_SCREEN_PAGE_DESIGN_PROMPT }
      },
      { status: 422 }
    );
  }

  // The archive is captured before the install, which replaces the folder
  // wholesale — including the archive the download route reads from it. Its name
  // is remembered on the API row rather than in the sidecar, so it is read from
  // there, the same way the download route finds it.
  const archiveRow = envelopeData<{ archiveFilename?: string }>(
    await callApi(request, `/api/v1/big-screen-templates/${encodeURIComponent(id)}`)
  );
  const archiveFilename = archiveRow?.archiveFilename?.trim();
  const archive = archiveFilename ? readArchive(root, id, archiveFilename) : undefined;

  const sync = await callApi(request, `/api/v1/big-screen-templates/${encodeURIComponent(id)}`, {
    method:"PATCH",contentType:"application/json",
    body:JSON.stringify({entry,dataFile:inspected.manifest.dataFile,fields:inspected.manifest.fields,
      binding:inspected.manifest.binding ?? null})
  });
  if(!sync.ok)return jsonError("BIG_SCREEN_TEMPLATE_SYNC_FAILED","保存页面数据契约失败。",sync.status||502);
  installBigScreenBundle({ files: next, id, root });
  // Written after the install, so the sidecar never describes a page that is not
  // there. The entry, the data file and the fields are taken from the inspection
  // rather than patched, because a repair can change any of the three and the
  // console's mapping list has to follow the page that is actually installed.
  writeUploadedTemplate(root, {
    ...existing,
    entry,
    dataFile: inspected.manifest.dataFile,
    ...(inspected.manifest.binding ? { binding: inspected.manifest.binding } : {}),
    filePaths: new Set(inspected.manifest.files.map((file) => file.path)),
    fields: inspected.manifest.fields.map((field) => ({ path: field.path, kind: field.kind }))
  });

  // Restored, so "download" keeps returning something: the operator's original
  // archive when it is still readable, and otherwise the page as it now stands.
  if (archiveFilename) {
    writeArchive(root, id, archiveFilename, archive ?? buildStoreZip(next));
  }

  return NextResponse.json({
    success: true,
    data: {
      id,
      entry,
      dataFile: inspected.manifest.dataFile,
      fieldCount: inspected.manifest.fields.length,
      sizeBytes: inspected.manifest.sizeBytes,
      repaired: true
    }
  });
}

/**
 * Packs files back into a zip the console can hand back as a download.
 *
 * Stored, not deflated: Node has no zip writer, the pages here are hundreds of
 * kilobytes, and a download that is a little larger is a much smaller problem
 * than one that needs a compression library the project does not carry.
 */
function buildStoreZip(files: Array<{ content: Buffer; path: string }>): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.path, "utf8");
    const crc = crc32(file.content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(file.content.length, 18);
    local.writeUInt32LE(file.content.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, file.content);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(0, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(0, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(file.content.length, 20);
    entry.writeUInt32LE(file.content.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt16LE(0, 30);
    entry.writeUInt16LE(0, 32);
    entry.writeUInt16LE(0, 34);
    entry.writeUInt16LE(0, 36);
    entry.writeUInt32LE(0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + file.content.length;
  }
  const table = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(table.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, table, eocd]);
}

/** The zip CRC-32 the format requires; small table, computed once. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}


export const GET = withTemplateStorage(handleGET);
export const POST = withTemplateStorage(handlePOST);
export const PUT = withTemplateStorage(handlePUT);
