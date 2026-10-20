import { withTemplateStorage } from "../../../../lib/bigscreen-templates-server";
import { NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { removeBigScreenBundle } from "@datafoundry/bigscreen";
import { callApi, envelopeData, envelopeError, envelopeMessage } from "../../../../lib/api-server-client";
import {
  bigScreenUploadRoot,
  readUploadedTemplates,
  setUploadedTemplatePublished,
  writeUploadedTemplate,
  type UploadedBigScreenTemplate
} from "../../../../lib/bigscreen-templates-server";

/**
 * One uploaded page: reading it back, renaming it, publishing it, deleting it.
 *
 * Every mutation here writes twice — once to the folder the wall is served from,
 * once to the API row the console lists. The two are not transactional and
 * cannot be: the bytes belong to the web process and the row belongs to the
 * database. So the order is chosen per operation to leave the more recoverable
 * half behind — see the notes on each handler.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

const jsonError = (code: string, message: string, status: number): Response =>
  NextResponse.json({ success: false, error: { code, message } }, { status });

const localTemplate = (id: string): UploadedBigScreenTemplate | undefined =>
  readUploadedTemplates(bigScreenUploadRoot()).find((item) => item.id === id);

/**
 * Publish state as the console needs to reason about it, from both sides.
 *
 * `extra` is the API row's own fields, merged last so its view of the record
 * wins wherever the two overlap — the row is the durable half and the sidecar is
 * a cache of what was installed.
 */
const describe = (
  local: UploadedBigScreenTemplate,
  extra: Record<string, unknown> = {}
): Record<string, unknown> => ({
  id: local.id,
  templateId: local.id,
  name: local.name,
  description: local.description,
  published: local.published,
  entry: local.entry,
  dataFile: local.dataFile,
  ...(local.binding ? { binding: local.binding } : {}),
  fields: local.fields,
  ...(local.refreshMs ? { refreshMs: local.refreshMs } : {}),
  ...(local.visiblePoints ? { visiblePoints: local.visiblePoints } : {}),
  filePaths: [...local.filePaths],
  ...extra
});

/**
 * Reads the template id out of the request path.
 *
 * `params` is typed empty for this route because Next keys the handler's params
 * off the folder's own dynamic segments, and `[id]` belongs to the enclosing
 * level. The id is still in the URL, so it is read from there and validated
 * rather than used as a path component unchecked.
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

const isValidTemplateId = (value: string): boolean => /^[a-z0-9][a-z0-9-]{1,40}$/u.test(value);

async function handleGET(request: Request): Promise<Response> {
  const id = templateIdFromRequest(request);
  if (!isValidTemplateId(id)) {
    return jsonError("BIG_SCREEN_TEMPLATE_NOT_FOUND", "页面不存在。", 404);
  }
  const local = localTemplate(id);
  if (!local) {
    return jsonError("BIG_SCREEN_TEMPLATE_NOT_FOUND", `页面 “${id}” 不存在。`, 404);
  }
  const remote = await callApi(request, `/api/v1/big-screen-templates/${encodeURIComponent(id)}`);
  const row = envelopeData<Record<string, unknown>>(remote);

  // The operator edits the page somewhere else and re-uploads it, so the single
  // most useful thing this route can return is the page source itself: it is
  // what the repair prompt needs to be built against.
  const entryPath = path.resolve(bigScreenUploadRoot(), id, local.entry);
  const root = path.resolve(bigScreenUploadRoot(), id);
  let entrySource: string | undefined;
  if (entryPath.startsWith(root + path.sep)) {
    try {
      entrySource = readFileSync(entryPath, "utf8");
    } catch {
      entrySource = undefined;
    }
  }
  return NextResponse.json({
    success: true,
    data: describe(local, {
      ...(row ?? {}),
      ...(entrySource === undefined ? {} : { entrySource })
    })
  });
}

/**
 * Rename, describe, or publish.
 *
 * `action=publish|unpublish` moves the page's publish state; a plain PATCH only
 * touches the label. They are separate because a rename must never take a live
 * page down, and publishing must never be a side effect of editing a name.
 */
async function handlePATCH(request: Request): Promise<Response> {
  const id = templateIdFromRequest(request);
  if (!isValidTemplateId(id)) {
    return jsonError("BIG_SCREEN_TEMPLATE_NOT_FOUND", "页面不存在。", 404);
  }
  const local = localTemplate(id);
  if (!local) {
    return jsonError("BIG_SCREEN_TEMPLATE_NOT_FOUND", `页面 “${id}” 不存在。`, 404);
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const action = typeof body.action === "string" ? body.action : "";

  if (action === "publish" || action === "unpublish") {
    const published = action === "publish";
    const remote = await callApi(
      request,
      `/api/v1/big-screen-templates/${encodeURIComponent(id)}/${action}`,
      { method: "POST" }
    );
    if (!remote.ok) {
      // The API refuses to publish a page whose manifest cannot drive a wall.
      // Its reason is more specific than anything this side could invent, so it
      // is passed through and nothing local is changed.
      return jsonError(
        envelopeError(remote) ?? "BIG_SCREEN_TEMPLATE_PUBLISH_FAILED",
        published ? "发布失败。" : "下架失败。",
        remote.status || 502
      );
    }
    const updated = setUploadedTemplatePublished(bigScreenUploadRoot(), id, published);
    return NextResponse.json({
      success: true,
      data: describe(updated ?? local)
    });
  }

  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : local.name;
  const description =
    typeof body.description === "string" ? body.description.trim() : local.description;
  const next: UploadedBigScreenTemplate = { ...local, name, description };
  // Local first: the serving folder is what the wall reads, and a rename that
  // reached only the row would show a name the page does not have.
  writeUploadedTemplate(bigScreenUploadRoot(), next);
  const remote = await callApi(request, `/api/v1/big-screen-templates/${encodeURIComponent(id)}`, {
    method: "PATCH",
    contentType: "application/json",
    body: JSON.stringify({ description, name })
  });
  return NextResponse.json({
    success: true,
    data: describe(
      next,
      remote.ok ? {} : { syncWarning: envelopeError(remote) ?? "BIG_SCREEN_TEMPLATE_SYNC_FAILED" }
    )
  });
}

async function handleDELETE(request: Request): Promise<Response> {
  const id = templateIdFromRequest(request);
  if (!isValidTemplateId(id)) {
    return jsonError("BIG_SCREEN_TEMPLATE_NOT_FOUND", "页面不存在。", 404);
  }
  // The folder and the row are two halves of one page and either can outlive the
  // other, so neither alone decides whether there is anything to delete. A page
  // whose folder was lost still has a row, and that row is what refuses the next
  // upload of the same id — deleting has to clear it.
  const local = localTemplate(id);
  // The database owns publication and reference checks. The disk sidecar may
  // still say published after the last wall was deleted; it cannot veto this.
  const remote = await callApi(request, `/api/v1/big-screen-templates/${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
  if (!remote.ok) {
    const message = envelopeMessage(remote);
    const reason = message === "BIG_SCREEN_TEMPLATE_PUBLISHED" || message?.startsWith("BIG_SCREEN_TEMPLATE_IN_USE:")
      ? message.split(":")[0]!
      : envelopeError(remote) ?? "BIG_SCREEN_TEMPLATE_DELETE_FAILED";
    const missingRegistration = remote.status === 404
      && envelopeMessage(remote)?.startsWith("CONFIG_RESOURCE_NOT_FOUND:") === true;
    // Nothing on disk and nothing in the row: there is genuinely no such page,
    // which is a different answer from a delete the API refused.
    if (!local && missingRegistration) {
      return jsonError("BIG_SCREEN_TEMPLATE_NOT_FOUND", `页面 “${id}” 不存在。`, 404);
    }
    // A missing registration must not strand an owner's unpublished files.
    // Other errors (in use, published, auth, storage) still prevent deletion.
    if (!local || !missingRegistration) {
      return jsonError(reason, reason === "BIG_SCREEN_TEMPLATE_PUBLISHED"
        ? "该页面已发布，请先下架再删除。"
        : reason === "BIG_SCREEN_TEMPLATE_IN_USE" ? "该模板仍被大屏使用，请先删除关联的大屏。" : "删除失败。", remote.status || 502);
    }
  }

  removeBigScreenBundle({ id, root: bigScreenUploadRoot() });
  return NextResponse.json({
    success: true,
    data: { deleted: true, id, removedFromDisk: Boolean(local) }
  });
}

export const GET = withTemplateStorage(handleGET);
export const PATCH = withTemplateStorage(handlePATCH);
export const DELETE = withTemplateStorage(handleDELETE);
