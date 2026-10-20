import { withTemplateStorage } from "../../../../../lib/bigscreen-templates-server";
import { NextResponse } from "next/server";
import { callApi, envelopeData } from "../../../../../lib/api-server-client";
import { bigScreenUploadRoot, readArchive, readUploadedTemplates } from "../../../../../lib/bigscreen-templates-server";

/**
 * Hands the operator back the file they uploaded.
 *
 * The archive is read from the upload folder rather than asked of the API,
 * because that is where it lives: the API stores a row describing the page, and
 * the bytes sit beside the page itself. Keeping the original file matters — the
 * operator edits it locally and uploads it again, so a re-generated zip would
 * be a different file to diff against and to replace.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * Reads the template id out of the request path.
 *
 * The `[id]` folder is a parent segment, not this route's own, so Next types the
 * handler's params as empty here. The id is still in the URL — but it only
 * reaches nested routes unchecked, so it is decoded and validated rather than
 * trusted as a path component.
 */
const templateIdFromRequest = (request: Request): string => {
  const segments = new URL(request.url).pathname.split("/").filter(Boolean);
  const index = segments.lastIndexOf("big-screen-templates");
  const id = index >= 0 ? segments[index + 1] : undefined;
  if (!id) return "";
  try {
    return decodeURIComponent(id);
  } catch {
    return "";
  }
};

async function handleGET(request: Request): Promise<Response> {
  const id = templateIdFromRequest(request);
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/u.test(id)) {
    return NextResponse.json(
      { success: false, error: { code: "BIG_SCREEN_TEMPLATE_NOT_FOUND", message: "页面不存在。" } },
      { status: 404 }
    );
  }
  const root = bigScreenUploadRoot();
  if (!readUploadedTemplates(root).some((item) => item.id === id)) {
    return NextResponse.json(
      { success: false, error: { code: "BIG_SCREEN_TEMPLATE_NOT_FOUND", message: `页面 “${id}” 不存在。` } },
      { status: 404 }
    );
  }

  // The filename is remembered on the row, not in the sidecar: it is part of the
  // upload request, and the row is the record of that request.
  const remote = await callApi(request, `/api/v1/big-screen-templates/${encodeURIComponent(id)}`);
  const row = envelopeData<{ archiveFilename?: string }>(remote);
  const filename = row?.archiveFilename?.trim();
  if (!filename) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "BIG_SCREEN_TEMPLATE_ARCHIVE_REQUIRED",
          message: "该页面没有保存原始上传文件。"
        }
      },
      { status: 404 }
    );
  }

  const body = readArchive(root, id, filename);
  if (!body) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "BIG_SCREEN_TEMPLATE_ARCHIVE_MISSING",
          message: `原始上传文件 “${filename}” 已不在磁盘上。`
        }
      },
      { status: 404 }
    );
  }

  const zip = filename.toLowerCase().endsWith(".zip");
  return new NextResponse(new Uint8Array(body), {
    status: 200,
    headers: {
      "Content-Disposition": `attachment; filename="${filename.replace(/["\\\r\n]/gu, "_")}"`,
      "Content-Type": zip ? "application/zip" : "text/html; charset=utf-8",
      "Content-Length": String(body.byteLength),
      "Cache-Control": "no-store"
    }
  });
}

export const GET = withTemplateStorage(handleGET);
