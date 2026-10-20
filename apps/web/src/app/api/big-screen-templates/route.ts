import { withTemplateStorage } from "../../../lib/bigscreen-templates-server";
import { NextResponse } from "next/server";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  BIG_SCREEN_PAGE_DESIGN_PROMPT,
  BIG_SCREEN_RESERVED_TEMPLATE_IDS,
  bigScreenTemplateRoot,
  installBigScreenBundle,
  parseBigScreenTemplateUpload,
  removeBigScreenBundle,
  type BigScreenBundleViolation
} from "@datafoundry/bigscreen";
import { callApi, envelopeData, envelopeError } from "../../../lib/api-server-client";
import {
  checkBigScreenTemplate,
  type BigScreenComplianceReport
} from "../../../lib/bigscreen-compliance-server";
import {
  bigScreenUploadRoot,
  readUploadedTemplates,
  setUploadedTemplatePublished,
  writeArchive,
  writeUploadedTemplate,
  type UploadedBigScreenTemplate
} from "../../../lib/bigscreen-templates-server";

/**
 * The console's endpoint for uploaded big-screen pages.
 *
 * This route owns the whole upload — reading the archive, validating it, and
 * unpacking it into the directory the serving route reads. The API only records
 * a row describing the result, and it is called *first* so that a page the
 * console would refuse (a published page or an id that collides with a system
 * route) is rejected before anything is written to a directory the web
 * server is already serving from.
 *
 * The same split applies to a download: the bytes live in the upload directory,
 * which both processes resolve from `@datafoundry/bigscreen`.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

type UploadedTemplateDto = {
  id: string;
  templateId: string;
  name: string;
  description: string;
  published: boolean;
  entry: string;
  dataFile: string;
  archiveFilename: string;
  fields: Array<{ path: string; kind: string }>;
  revision: number;
  /** Page-level facts recorded at upload, so the console can explain the page. */
  sizeBytes: number;
};

const jsonError = (code: string, message: string, status: number): Response =>
  NextResponse.json({ success: false, error: { code, message } }, { status });

/**
 * A body the console can show as-is.
 *
 * A refused upload is not only an error: it is the moment the operator needs
 * the design prompt, so that the page can be fixed somewhere else and sent
 * back. Both travel together — the violations explain what failed now, the
 * prompt explains what the page has to satisfy at all.
 */
type UploadFailureBody = {
  success: false;
  error: { code: string; message: string };
  data: {
    violations: BigScreenBundleViolation[];
    designPrompt: string;
    /** Present when the page was parsed far enough to know its entry file. */
    repair?: RepairSource;
  };
};

/**
 * Everything the console needs to hand the page to the model.
 *
 * The html rides along because after a refusal nothing was written to disk, so a
 * second request to fetch the page would have nothing to fetch. The console holds
 * this in memory and posts it back only if the operator asks for the repair.
 */
type RepairSource = {
  templateId: string;
  entry: string;
  entryGuessed: boolean;
  files: string[];
  html: string;
};

const uploadFailure = (
  code: string,
  message: string,
  violations: BigScreenBundleViolation[],
  status = 422,
  repair?: RepairSource
): Response =>
  NextResponse.json(
    {
      success: false,
      error: { code, message },
      data: {
        violations,
        designPrompt: BIG_SCREEN_PAGE_DESIGN_PROMPT,
        ...(repair ? { repair } : {})
      }
    } satisfies UploadFailureBody,
    { status }
  );

/** A page id derived from the file the operator picked, when none was typed. */
const deriveTemplateId = (filename: string): string =>
  filename
    .replace(/\.(zip|html?)$/iu, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40);

const isValidTemplateId = (value: string): boolean => /^[a-z0-9][a-z0-9-]{1,40}$/u.test(value);

/** The verdict without the evidence: what a list row needs and nothing more. */
type BigScreenComplianceSummary = {
  origin: BigScreenComplianceReport["origin"];
  status: BigScreenComplianceReport["status"];
  violationCount: number;
  reason?: string;
};

/** The console's rows, paired with what is actually on disk. */
const listTemplates = async (request: Request): Promise<Response> => {  const root = bigScreenUploadRoot();
  const api = await callApi(request, "/api/v1/big-screen-templates");
  const rows = envelopeData<UploadedTemplateDto[]>(api);
  if (!rows) {
    return jsonError(
      envelopeError(api) ?? "BIG_SCREEN_TEMPLATES_UNAVAILABLE",
      "读取页面模板列表失败。",
      api.status || 502
    );
  }
  const onDisk = new Map(readUploadedTemplates(root).map((item) => [item.id, item]));
  const summarise = (id: string): BigScreenComplianceSummary => {
    const compliance = checkBigScreenTemplate(id);
    return {
      origin: compliance.origin,
      status: compliance.status,
      violationCount: compliance.violations.length,
      ...(compliance.reason ? { reason: compliance.reason } : {})
    };
  };
  return NextResponse.json({
    success: true,
    data: rows.map((row) => {
      const folder = onDisk.get(row.templateId);
      // API-only actions (including deleting the last wall) can change this
      // flag. Reconcile the cached sidecar before offering upload/delete again.
      if (folder && folder.published !== row.published) {
        setUploadedTemplatePublished(root, folder.id, row.published);
      }
      return {
        ...row,
        // The folder is the source of truth for what the wall will serve; the
        // row is source of truth for what the operator called it. Reporting both
        // lets the console show "recorded but missing on disk" rather than
        // silently rendering a page that 404s.
        installed: Boolean(folder),
        fileCount: folder ? folder.filePaths.size : 0,
        // Only the verdict travels with the list; the violations, the page source,
        // and the repair prompt belong to the detail endpoint. Every row carrying
        // them would put the text of every page into one response.
        compliance: summarise(row.templateId)
      };
    }),
    // The rows above are the *uploaded* pages. The console's template library
    // also offers the bundled ones — and those were written before the contract
    // existed, so they are the likeliest to be out of date. They have no row
    // here, so their verdicts travel alongside instead: same shape, keyed by id,
    // so both lists can render one badge from one source.
    //
    // A directory is a page when it holds an entry file. The bundled root also
    // holds `assets`, the shared library and background the pages load, which is
    // a folder like any other and would otherwise be listed as a broken page.
    complianceSummaries: Object.fromEntries(
      readdirSync(bigScreenTemplateRoot(), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .filter((entry) => existsSync(path.join(bigScreenTemplateRoot(), entry.name, "index.html")))
        .map((entry) => [entry.name, summarise(entry.name)])
    )
  });
};

async function handleGET(request: Request): Promise<Response> {
  return listTemplates(request);
}

async function handlePOST(request: Request): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return jsonError("BIG_SCREEN_TEMPLATE_MULTIPART_REQUIRED", "上传需要使用表单提交。", 400);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError("BIG_SCREEN_TEMPLATE_UPLOAD_UNREADABLE", "无法读取上传内容。", 400);
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return jsonError("BIG_SCREEN_TEMPLATE_FILE_REQUIRED", "请选择要上传的 zip 或 html 文件。", 400);
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return uploadFailure("BIG_SCREEN_TEMPLATE_TOO_LARGE", "上传文件超过 5MB 上限。", [
      {
        code: "bundle-too-large",
        message: `页面文件 ${(file.size / 1024 / 1024).toFixed(1)}MB 超过 5MB 上限。`,
        fix: "把页面里的大体积资源换成 CDN 引用或压缩后再上传。"
      }
    ]);
  }

  const requestedId = String(form.get("templateId") ?? "").trim().toLowerCase();
  const templateId = requestedId || deriveTemplateId(file.name);
  if (!isValidTemplateId(templateId)) {
    return uploadFailure(
      "BIG_SCREEN_TEMPLATE_ID_INVALID",
      "页面标识不合法。",
      [
        {
          code: "id-invalid",
          message: `页面标识 “${templateId}” 不合法，只能用 2-41 位小写字母、数字和短横线，且以字母或数字开头。`,
          fix: "在上传时填写一个合规的页面标识，或用英文名重命名压缩包。"
        }
      ]
    );
  }
  if ((BIG_SCREEN_RESERVED_TEMPLATE_IDS as readonly string[]).includes(templateId)) {
    return uploadFailure(
      "BIG_SCREEN_TEMPLATE_ID_RESERVED",
      "该页面标识与系统路由冲突。",
      [
        {
          code: "id-reserved",
          message: `“${templateId}” 是系统路由的标识，不能用于上传页面。`,
          fix: `请换一个标识。系统保留标识：${BIG_SCREEN_RESERVED_TEMPLATE_IDS.join("、")}。`
        }
      ]
    );
  }

  const root = bigScreenUploadRoot();
  const existing = readUploadedTemplates(root).find((item) => item.id === templateId);
  if (existing?.published) {
    return jsonError(
      "BIG_SCREEN_TEMPLATE_PUBLISHED",
      "该页面已发布，请先下架再上传新版本。",
      409
    );
  }

  const content = Buffer.from(await file.arrayBuffer());
  const parsed = await parseBigScreenTemplateUpload({
    content,
    filename: file.name,
    mimeType: file.type
  });
  if (!parsed.ok) {
    return uploadFailure(
      "BIG_SCREEN_TEMPLATE_INVALID",
      "页面未通过上传校验。",
      parsed.violations,
      422,
      parsed.entry ? { ...parsed.entry, templateId } : undefined
    );
  }

  const manifest = parsed.manifest;
  // Record first, install second. A row with no folder is visibly broken and
  // re-uploadable; a folder with no row is a page nobody can see, edit or
  // delete from the console — the worse of the two failures to leave behind.
  //
  // `/register` rather than the collection itself: a page's row is not a plain
  // config resource, because the facts that describe it — the entry file, the
  // data file, the fields — live one level down inside a `manifest`, and the
  // publish check reads them from the top. Posting to the collection stores the
  // envelope as-is and the page ends up registered, listed, and unpublishable.
  const registration = await callApi(request, "/api/v1/big-screen-templates/register", {
    method: "POST",
    contentType: "application/json",
    body: JSON.stringify({
      archiveFilename: file.name,
      description: String(form.get("description") ?? "").trim(),
      manifest: {
        dataFile: manifest.dataFile,
        entry: manifest.entry,
        fields: manifest.fields,
        ...(manifest.binding ? {binding:manifest.binding} : {})
      },
      name: String(form.get("name") ?? "").trim() || templateId,
      templateId
    })
  });
  if (!registration.ok) {
    return jsonError(
      envelopeError(registration) ?? "BIG_SCREEN_TEMPLATE_REGISTER_FAILED",
      "登记页面模板失败。",
      registration.status || 502
    );
  }
  const row = envelopeData<UploadedTemplateDto>(registration);

  const name = String(form.get("name") ?? "").trim() || row?.name || templateId;
  const description = String(form.get("description") ?? "").trim() || row?.description || "";
  const template: UploadedBigScreenTemplate = {
    id: templateId,
    name,
    description,
    published: false,
    entry: manifest.entry,
    dataFile: manifest.dataFile,
    ...(manifest.binding ? { binding: manifest.binding } : {}),
    filePaths: new Set(manifest.files.map((entry) => entry.path)),
    fields: manifest.fields.map((field) => ({ path: field.path, kind: field.kind })),
    refreshMs: numberOrUndefined(form.get("refreshMs")),
    visiblePoints: numberOrUndefined(form.get("visiblePoints"))
  };

  try {
    installBigScreenBundle({
      files: parsed.files,
      id: templateId,
      root
    });
    // The archive is kept verbatim so "download" returns the file the operator
    // sent, not a re-zip of what it unpacked into. It is written *after* the
    // bundle, so an archive on disk always means a page that installed.
    writeArchive(root, templateId, file.name, content);
    writeUploadedTemplate(root, template);
  } catch (error) {
    // The row is already recorded, so a failure here would leave a template the
    // console lists and the wall cannot serve. Undo it rather than report a page
    // that does not exist.
    removeBigScreenBundle({ id: templateId, root });
    await callApi(request, `/api/v1/big-screen-templates/${encodeURIComponent(templateId)}`, {
      method: "DELETE"
    });
    return jsonError(
      "BIG_SCREEN_TEMPLATE_INSTALL_FAILED",
      `页面写入磁盘失败：${error instanceof Error ? error.message : String(error)}`,
      500
    );
  }

  return NextResponse.json(
    {
      success: true,
      data: {
        ...(row ?? {}),
        id: row?.id ?? templateId,
        templateId,
        installed: true,
        manifest: {
          dataFile: manifest.dataFile,
          entry: manifest.entry,
          fields: manifest.fields,
          files: manifest.files.map((entry) => entry.path),
          sizeBytes: manifest.sizeBytes
        }
      }
    },
    { status: 201 }
  );
}

const numberOrUndefined = (value: FormDataEntryValue | null): number | undefined => {
  const parsed = Number(String(value ?? "").trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

export const GET = withTemplateStorage(handleGET);
export const POST = withTemplateStorage(handlePOST);
