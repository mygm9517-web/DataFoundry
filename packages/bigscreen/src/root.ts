import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where big-screen pages live on disk, resolved the same way by every process
 * that touches them.
 *
 * The API and the web server do not share a working directory — `npm --prefix
 * apps/api run start` leaves the API in `apps/api` while the web server runs
 * from `apps/web` — and Next.js does not preserve `process.cwd()` across a
 * build/start boundary either. So the defaults are resolved from *this file's*
 * location instead, four levels below the repository root, which every caller
 * agrees on by construction.
 *
 * Two directories, not one:
 *
 *   `bigscreen/`          the pages that ship with the repo. Read-only in
 *                         practice: an upload must never write into it, or a
 *                         packaged install would try to modify its own app
 *                         bundle at runtime.
 *   `storage/bigscreen/`  pages uploaded through the console, none of which
 *                         exist until an operator puts one there.
 *
 * `BIGSCREEN_ROOT` and `BIGSCREEN_UPLOAD_ROOT` override either, resolved
 * against the repository root so a relative value in `.env` means the same
 * thing to both processes.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const resolveFromRepoRoot = (value: string): string =>
  isAbsolute(value) ? value : resolve(REPO_ROOT, value);

/** Optional locally installed bundled pages; the public distribution includes none. */
export const bigScreenTemplateRoot = (): string => {
  const configured = process.env.BIGSCREEN_ROOT?.trim();
  return configured ? resolveFromRepoRoot(configured) : resolve(REPO_ROOT, "apps/web/bigscreen");
};

/** Pages an operator uploaded through the console. */
export const bigScreenUploadRoot = (): string => {
  const configured = process.env.BIGSCREEN_UPLOAD_ROOT?.trim();
  if (configured) {
    return resolveFromRepoRoot(configured);
  }
  const storageRoot = process.env.STORAGE_ROOT_DIR?.trim() || "storage";
  return resolve(resolveFromRepoRoot(storageRoot), "bigscreen");
};
