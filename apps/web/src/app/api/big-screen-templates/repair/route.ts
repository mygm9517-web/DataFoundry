import { NextResponse } from "next/server";
import {
  BIG_SCREEN_PAGE_DESIGN_PROMPT,
  type BigScreenBundleViolation
} from "@datafoundry/bigscreen";
import { callApi, envelopeData, envelopeError, envelopeMessage } from "../../../../lib/api-server-client";

/**
 * Asks the default model to fix a page that failed upload validation.
 *
 * The prompt is built here rather than in the API because the page source is
 * here: the web server read the upload, and after a rejection nothing was
 * installed, so there is no copy on disk for the API to read. The prompt text
 * travels with the request, and the API's job is only the model call itself —
 * it is the process that holds the credentials and the provider plumbing.
 *
 * The rewritten page is handed back for review; it is never installed by this
 * call. Whatever comes back goes through the same validator as a manual upload.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

type RepairBody = {
  html?: string;
  entry?: string;
  files?: string[];
  violations?: BigScreenBundleViolation[];
};

export async function POST(request: Request): Promise<Response> {
  let body: RepairBody = {};
  try {
    body = (await request.json()) as RepairBody;
  } catch {
    return NextResponse.json(
      { success: false, error: { code: "JSON_OBJECT_REQUIRED", message: "请求体不是合法 JSON。" } },
      { status: 400 }
    );
  }

  const html = typeof body.html === "string" ? body.html : "";
  if (html.trim() === "") {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "BIG_SCREEN_TEMPLATE_REPAIR_SOURCE_REQUIRED",
          message: "缺少要改造的页面源码。"
        }
      },
      { status: 400 }
    );
  }
  const entry = typeof body.entry === "string" && body.entry.trim() ? body.entry : "index.html";
  const files = Array.isArray(body.files) ? body.files.filter((item) => typeof item === "string") : [];
  const violations = Array.isArray(body.violations) ? body.violations : [];

  const remote = await callApi(request, "/api/v1/big-screen-templates/repair", {
    method: "POST",
    contentType: "application/json",
    // Only the facts travel: the API builds the prompt from them with the same
    // `buildBigScreenRepairPrompt` the console links to, so the text the model
    // sees cannot drift from the text the operator was shown.
    body: JSON.stringify({ entry, files, html, violations })
  });

  const data = envelopeData<{ entry: string; html: string; model: string; latencyMs: number }>(remote);
  if (!data) {
    // The API reports an empty model answer as a generic internal failure — its
    // error codes are a closed set it does not extend for one route — so the
    // reason is recovered from the message here and given a code of its own. The
    // console distinguishes it from a provider fault because the two have
    // different fixes, and the message itself is not forwarded: it carries the
    // model name and is not written for an operator.
    const reason = envelopeMessage(remote) ?? "";
    const empty = reason.startsWith("BIG_SCREEN_TEMPLATE_REPAIR_EMPTY");
    // A provider that could not be reached is named as such. It is the failure an
    // operator is most likely to meet on a fresh deployment, and the generic
    // "repair failed" text sends them to look at the page — which is not what is
    // wrong.
    const provider = reason.startsWith("PROVIDER_TEST_FAILED") || reason.startsWith("PROVIDER_CONFIG_MISSING");
    return NextResponse.json(
      {
        success: false,
        error: empty
          ? {
            code: "BIG_SCREEN_TEMPLATE_REPAIR_EMPTY",
            message: "默认模型这次没有返回可用页面。"
          }
          : provider
            ? {
              code: "PROVIDER_TEST_FAILED",
              message: "无法连接默认模型。"
            }
            : {
              code: envelopeError(remote) ?? "BIG_SCREEN_TEMPLATE_REPAIR_FAILED",
              message: "调用默认模型改造页面失败。"
            },
        data: { designPrompt: BIG_SCREEN_PAGE_DESIGN_PROMPT, violations }
      },
      { status: remote.status || 502 }
    );
  }
  return NextResponse.json({ success: true, data });
}
