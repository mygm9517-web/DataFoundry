import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { bigScreenTemplateRoot, bigScreenUploadRoot, withTemplateStorage } from "../../../lib/bigscreen-templates-server";
import { getBigScreenTemplate } from "../../data-tasks/big-screen-templates";
import {
  readUploadedTemplates,
  type UploadedBigScreenTemplate,
} from "../../data-tasks/big-screen-uploaded-templates";
import {
  buildBigScreenBridgeScript,
  type BigScreenBridgeBinding,
} from "../../data-tasks/big-screen-runtime";
import { buildBlankDefaultsScript, wrapDefaultData } from "../../data-tasks/big-screen-blank-defaults";

/**
 * Serves the big-screen templates bundled under `apps/web/bigscreen/`.
 *
 * Templates are authored to be opened by double-click: each keeps a
 * `DEFAULT_DATA` fallback, `fetch`es its own data file, and knows nothing about
 * this app. Serving them through this route — instead of editing them — lets the
 * data bridge be spliced in for the console while the same files stay portable,
 * and lets a screen whose host goes quiet fall back to its bundled data rather
 * than rendering blank.
 *
 * The files deliberately live outside `public/`: Next serves that directory
 * statically ahead of route handlers, so a template parked there would reach the
 * browser without the bridge and silently render its bundled demo numbers
 * forever. Reading them here is what makes the splice unconditional.
 *
 * Paths are mirrored one-for-one so every relative reference inside a template
 * resolves exactly as it does when the file is opened directly from disk:
 *
 *   /bigscreen/home/index.html       → bigscreen/home/index.html
 *   /bigscreen/home/home-data.json   → bigscreen/home/home-data.json
 *   /bigscreen/assets/echarts.min.js → bigscreen/assets/echarts.min.js
 */

type RouteContext = {
  params: Promise<{ path: string[] }>;
};

const BUNDLED_ROOT = bigScreenTemplateRoot();


const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

/** What the GET needs to know to render a page: its data contract, if it has one. */
type PageEntry = {
  dataFile: string;
  binding?: BigScreenBridgeBinding;
};

/**
 * An uploaded page, described by the manifest the upload route wrote beside it.
 *
 * This route is authenticated and scoped to the owner's storage, so an
 * unpublished upload must be available for management previews too. Public
 * publication checks belong to the separate public page route.
 *
 * Read once per request rather than cached at module scope: the console can
 * publish, take down, or replace a page while this process is running, and a
 * stale manifest would keep a taken-down page on air.
 */
function uploadedTemplate(id: string): UploadedBigScreenTemplate | undefined {
  const entry = readUploadedTemplates(bigScreenUploadRoot()).find((item) => item.id === id);
  return entry;
}

/** The registry entry when the request is a template page, else undefined. */
function findTemplate(segments: string[]): PageEntry | undefined {
  if (segments.length < 1) return undefined;

  const [id, ...rest] = segments;

  // Uploaded templates first: they are the operator's own pages, and an upload
  // under an id a bundled sample also uses is the page the console lists, edits
  // and hands a wall — so it must be the one the browser is given. Resolving the
  // bundled folder first would strand the upload: visible in the console,
  // unreachable in the browser.
  //
  // Both spellings are supported, `/id` (no extension) and `/id/entry.html`.
  const uploaded = uploadedTemplate(id);
  if (uploaded) {
    if (segments.length === 1) {
      return { dataFile: uploaded.dataFile, binding: uploaded.binding };
    }
    if (rest.join("/") === uploaded.entry || (segments.length === 2 && rest[0] === "index.html")) {
      return { dataFile: uploaded.dataFile, binding: uploaded.binding };
    }
    return undefined;
  }

  // Bundled templates: must be /id/index.html
  const bundled = getBigScreenTemplate(id);
  if (bundled) {
    if (segments.length === 2 && segments[1] === "index.html") {
      return { dataFile: bundled.dataFile, binding: bundled.binding };
    }
    return undefined;
  }

  return undefined;
}

/**
 * Whether this request is one the route is allowed to serve: a registered
 * template page, that template's own data file, or a shared asset. Anything
 * else — an unknown id, a stray file — is refused before it reaches the disk.
 */
function isServable(segments: string[]): boolean {
  if (segments.length < 1) return false;
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return false;

  const [head] = segments;

  // Shared vendor assets, e.g. `assets/echarts.min.js`.
  if (head === "assets") return true;

  // An uploaded page's own folder, checked first so it is the page served when
  // its id is also a bundled one.
  const uploaded = uploadedTemplate(head);
  if (uploaded) {
    // /id (no extension) serves the entry page.
    if (segments.length === 1) return true;
    // An uploaded page ships its own dependencies beside it, so anything it
    // references has to be named in the manifest captured at upload time. Serving
    // by path alone would turn one upload into a readable directory: a template
    // folder is a user's own file, but the same route serves every other
    // template's folder too, and a traversal would reach them all.
    return uploaded.filePaths.has(segments.slice(1).join("/"));
  }

  // Bundled templates own their folder: the page itself, whatever the page
  // fetches, and the `assets/` its own relative script tags point at. That last
  // case resolves to the shared folder below — the templates were authored as
  // siblings and each carries the same relative reference.
  const template = getBigScreenTemplate(head);
  if (template) {
    if (segments.length === 2) {
      return segments[1] === "index.html" || segments[1] === template.dataFile || segments[1] === "assets";
    }
    return segments[1] === "assets";
  }

  return false;
}

/**
 * Resolves to a file on disk, or null when the request is not servable.
 *
 * Bundled templates and uploaded ones do not lay their assets out the same way,
 * which is the whole reason this has to branch:
 *
 *   bundled    home/index.html       references `assets/echarts.min.js`
 *              assets/echarts.min.js              ← one shared vendor folder
 *
 *   uploaded   <id>/index.html       references `assets/echarts.min.js`
 *              <id>/assets/echarts.min.js         ← a copy inside its own folder
 *
 * A bundled page resolves `assets/...` against the bundled root, where the one
 * shared folder sits. An uploaded page resolves it against its own folder, so
 * the `assets/` in the URL really means `<id>/assets/`. Resolving an uploaded
 * page's asset at the bundled root 404s, because a deployment bind-mounts
 * storage over that directory and the shared folder that would have been there
 * is shadowed.
 *
 * Every candidate is confined to a root before it is read, so a manifest cannot
 * turn one upload into a readable path elsewhere.
 */
function resolveBundledFile(segments: string[]): string | null {
  if (!isServable(segments)) return null;

  const [head, second] = segments;
  const containment = (root: string, relative: string): string | null => {
    const resolved = path.resolve(root, relative);
    return resolved.startsWith(root + path.sep) ? resolved : null;
  };

  // Shared vendor assets with no template prefix belong to the bundled folder.
  if (head === "assets") return containment(BUNDLED_ROOT, segments.join("/"));

  // An uploaded page carries its own assets inside its own folder, and comes
  // first so an upload sharing an id with a bundled sample is the page served.
  // The bundled vendor folder is the fallback for an asset the page referenced
  // without shipping one — tested by existence, since a null from the
  // containment check means "escaped the root" and says nothing about whether
  // the file is there.
  if (uploadedTemplate(head)) {
    const own = containment(bigScreenUploadRoot(), segments.join("/"));
    if (own && existsSync(own)) return own;
    if (second === "assets") {
      const shared = containment(BUNDLED_ROOT, segments.slice(1).join("/"));
      if (shared && existsSync(shared)) return shared;
    }
    return own;
  }

  // A bundled template's page and data file are the app's own, but the shared
  // vendor folder its script tag points at is also the bundled root's.
  if (getBigScreenTemplate(head)) {
    return containment(BUNDLED_ROOT, second === "assets" ? segments.slice(1).join("/") : segments.join("/"));
  }

  return null;
}

async function handleGET(_request: Request, context: RouteContext): Promise<Response> {
  const { path: segments = [] } = await context.params;

  // Check if this is a template page request (no extension or with entry file)
  const entry = findTemplate(segments);

  // The editor uses /id/index.html for built-in names. Resolve that alias to
  // the owner's uploaded entry as well as supporting extensionless /id.
  let actualSegments = segments;
  if (entry && (segments.length === 1 || (segments.length === 2 && segments[1] === "index.html"))) {
    const uploaded = uploadedTemplate(segments[0]);
    if (uploaded) {
      actualSegments = [segments[0], uploaded.entry];
    }
  }

  const filePath = resolveBundledFile(actualSegments);

  if (!filePath) {
    return new NextResponse("Not found", { status: 404 });
  }

  let body: Buffer;
  try {
    body = await readFile(filePath);
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }

  const contentType =
    CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";

  // If it's not a template page, serve it as a static asset
  if (!entry) {
    return new NextResponse(new Uint8Array(body), {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=300",
      },
    });
  }

  // Injected ahead of the template's first script so the bridge owns `fetch`
  // before the template's own data layer runs.
  //
  // An uploaded page is served with its demo data emptied: every key of its
  // `DEFAULT_DATA` stays, every value goes, so a field no SQL is bound to shows
  // nothing rather than invented numbers, and a field bound later still lands
  // where the page reads it. Bundled templates keep theirs — they are the
  // platform's own samples, with no screen of their own to be mistaken for.
  //
  // Asked of the manifest rather than inferred from "no bundled page has this
  // id": an upload may legitimately take a bundled id, and the page served in
  // that case is the operator's, which is the one that must be blanked.
  const [templateId] = segments;
  const uploadedPage = Boolean(uploadedTemplate(templateId));
  let html = body.toString("utf8");
  const blanked = uploadedPage ? wrapDefaultData(html) : null;
  if (blanked) html = blanked;
  const bridge = buildBigScreenBridgeScript(entry.dataFile, undefined, entry.binding, {
    quiet: blanked !== null,
  });
  html = html.replace(
    /<script/i,
    `<script>${blanked ? buildBlankDefaultsScript() : ""}${bridge}</script>\n  <script`,
  );

  // An uploaded page is served at `/bigscreen/<id>` with no trailing slash, so
  // the browser resolves its relative `assets/...` against `/bigscreen/` and asks
  // for `/bigscreen/assets/...` — the bundled vendor folder, which a deployment
  // that bind-mounts storage over it no longer has. A `<base>` pins relative
  // URLs to the page's own folder, where its uploaded assets actually live.
  if (uploadedPage && !/<base\s/i.test(html)) {
    const entryDir = uploadedTemplate(templateId)!.entry.split("/").slice(0, -1).map(encodeURIComponent).join("/");
    const base = `<base href="/bigscreen/${encodeURIComponent(templateId)}/${entryDir ? entryDir + "/" : ""}">`;
    html = /<head[^>]*>/i.test(html)
      ? html.replace(/<head[^>]*>/i, (tag) => `${tag}\n  ${base}`)
      : `${base}\n${html}`;
  }

  return new NextResponse(html, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      // The bridge handshake is per-load, so a cached page could outlive the
      // registry entry it was rendered from.
      "Cache-Control": "no-store",
    },
  });
}

export const GET = withTemplateStorage(handleGET);
