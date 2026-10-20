import { NextResponse } from "next/server";
import { BIG_SCREEN_PAGE_DESIGN_PROMPT } from "@datafoundry/bigscreen";

/**
 * The page-design contract, on its own.
 *
 * It is served from here rather than bundled into the console because the prompt
 * lives in `@datafoundry/bigscreen`, which reads and writes the filesystem — a
 * client component importing it would drag `node:fs` into the browser build. The
 * same text already rides along with every refused upload; this route exists for
 * the case where the operator wants it *before* uploading, or wants it again
 * after the failure panel has been dismissed.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

export function GET(): NextResponse {
  return NextResponse.json(
    { success: true, data: { prompt: BIG_SCREEN_PAGE_DESIGN_PROMPT } },
    { headers: { "Cache-Control": "no-store" } }
  );
}
