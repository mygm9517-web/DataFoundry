import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  bigScreenTemplateRoot,
  bigScreenUploadRoot as sharedBigScreenUploadRoot,
  type BigScreenBundleManifest,
  type BigScreenBundleViolation
} from "@datafoundry/bigscreen";
import {
  UPLOADED_TEMPLATE_MANIFEST,
  readUploadedTemplates,
  serializeUploadedTemplate,
  type UploadedBigScreenTemplate
} from "../app/data-tasks/big-screen-uploaded-templates";

import { AsyncLocalStorage } from "node:async_hooks";
import { callApi, envelopeData } from "./api-server-client";
const templateStorage = new AsyncLocalStorage<string>();
export { bigScreenTemplateRoot };

export const ownerTemplateRoot = (ownerId: string): string => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/u.test(ownerId)) throw new Error("Invalid template owner");
  return path.join(sharedBigScreenUploadRoot(), "users", ownerId);
};

/** A request must establish its authenticated owner before reading or changing files. */
export const bigScreenUploadRoot = (): string => {
  const root = templateStorage.getStore();
  if (!root) throw new Error("Template storage owner is required");
  return root;
};

export function withTemplateStorage<T extends unknown[]>(handler: (request: Request, ...args: T) => Promise<Response>) {
  return async (request: Request, ...args: T): Promise<Response> => {
    const remote=await callApi(request,"/api/v1/big-screen-templates/storage-context",{
      method: request.method === "GET" || request.method === "HEAD" ? "GET" : "POST"
    });
    const owner=envelopeData<{userId:string}>(remote);
    if(!owner) return Response.json(remote.json ?? {success:false,error:{message:"Authentication required."}}, {status:remote.status||401});
    return templateStorage.run(ownerTemplateRoot(owner.userId),()=>handler(request,...args));
  };
}
export { UPLOADED_TEMPLATE_MANIFEST, readUploadedTemplates, serializeUploadedTemplate };
export type { UploadedBigScreenTemplate };
export type { BigScreenBundleManifest, BigScreenBundleViolation };

/**
 * Reading and writing an uploaded page's sidecar.
 *
 * The upload and delete routes write through here so that exactly one module
 * knows the on-disk shape of an uploaded template; the serving route reads the
 * same folder with the same parser.
 */

/** The `.template.json` path for a template id. */
export function manifestPath(root: string, id: string): string {
  return path.join(root, id, UPLOADED_TEMPLATE_MANIFEST);
}

export function writeUploadedTemplate(
  root: string,
  template: UploadedBigScreenTemplate
): void {
  mkdirSync(path.dirname(manifestPath(root, template.id)), { recursive: true });
  writeFileSync(
    manifestPath(root, template.id),
    `${JSON.stringify(serializeUploadedTemplate(template), null, 2)}\n`,
    "utf8"
  );
}

/**
 * Flips the published flag in the sidecar, leaving everything else alone.
 *
 * Read-modify-write rather than a targeted edit: the file is small, it is
 * written by one process, and an operator publishing a page is not competing
 * with anything.
 */
export function setUploadedTemplatePublished(
  root: string,
  id: string,
  published: boolean
): UploadedBigScreenTemplate | undefined {
  const existing = readUploadedTemplates(root).find((item) => item.id === id);
  if (!existing) return undefined;
  const updated: UploadedBigScreenTemplate = { ...existing, published };
  writeUploadedTemplate(root, updated);
  return updated;
}

/**
 * The safe on-disk path for an archive, or null when the name is unusable.
 *
 * `filename` is the multipart filename a client chose, so it is never trusted
 * as a path: only its last segment is used, and a name that would produce a
 * dotfile is refused outright rather than hidden inside the template folder.
 */
export function archivePath(root: string, id: string, filename: string): string | null {
  const dir = path.resolve(root, id);
  const safeName = path.basename(filename.replaceAll("\\", "/"));
  if (!safeName || safeName.startsWith(".")) return null;
  const target = path.join(dir, safeName);
  return target.startsWith(dir + path.sep) ? target : null;
}

/** Keeps the operator's own file, verbatim, so a download returns what they sent. */
export function writeArchive(root: string, id: string, filename: string, content: Buffer): void {
  const target = archivePath(root, id, filename);
  if (!target) throw new Error(`BIG_SCREEN_TEMPLATE_ARCHIVE_NAME_UNSAFE:${filename}`);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

export function readArchive(root: string, id: string, filename: string): Buffer | undefined {
  const target = archivePath(root, id, filename);
  if (!target) return undefined;
  return existsSync(target) ? readFileSync(target) : undefined;
}
