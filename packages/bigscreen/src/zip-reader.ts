import yauzl, { type Entry, type ZipFile } from "yauzl";

/** Ceilings applied when no explicit limit is passed. */
const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_MAX_UNCOMPRESSED_BYTES = 20 * 1024 * 1024;

/**
 * Read a zip into memory without touching the disk.
 *
 * A zip is attacker-controlled input: an entry named `../../server.js` that
 * reached a `writeFileSync` would escape whatever directory the caller had in
 * mind, and a 5MB archive can expand to gigabytes and exhaust the process
 * before anyone looks at it. Both ceilings are enforced here so callers do not
 * each have to remember them.
 */
export const readSafeZipEntries = (
  buffer: Buffer,
  limits: { maxEntries?: number; maxUncompressedBytes?: number } = {}
): Promise<Array<{ content: Buffer; name: string }>> =>
  new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (openError, zipFile) => {
      if (openError || !zipFile) {
        reject(openError ?? new Error("SKILL_ZIP_OPEN_FAILED"));
        return;
      }
      collectZipEntries(zipFile, limits).then(resolve, reject);
    });
  });

const collectZipEntries = (
  zipFile: ZipFile,
  limits: { maxEntries?: number; maxUncompressedBytes?: number } = {}
): Promise<Array<{ content: Buffer; name: string }>> =>
  new Promise((resolve, reject) => {
    const maxEntries = limits.maxEntries ?? DEFAULT_MAX_ENTRIES;
    const maxUncompressedBytes = limits.maxUncompressedBytes ?? DEFAULT_MAX_UNCOMPRESSED_BYTES;
    const files: Array<{ content: Buffer; name: string }> = [];
    let totalBytes = 0;
    let entryCount = 0;
    const fail = (error: unknown): void => {
      zipFile.close();
      reject(error);
    };
    zipFile.on("entry", (entry: Entry) => {
      entryCount += 1;
      if (entryCount > maxEntries || !isSafeZipPath(entry.fileName) || isSymlink(entry)) {
        fail(new Error("SKILL_ZIP_ENTRY_UNSAFE"));
        return;
      }
      if (entry.fileName.endsWith("/")) {
        zipFile.readEntry();
        return;
      }
      totalBytes += entry.uncompressedSize;
      if (totalBytes > maxUncompressedBytes) {
        fail(new Error("SKILL_ZIP_EXPANDED_TOO_LARGE"));
        return;
      }
      zipFile.openReadStream(entry, (streamError, stream) => {
        if (streamError || !stream) {
          fail(streamError ?? new Error("SKILL_ZIP_ENTRY_READ_FAILED"));
          return;
        }
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("error", fail);
        stream.on("end", () => {
          files.push({ content: Buffer.concat(chunks), name: entry.fileName });
          zipFile.readEntry();
        });
      });
    });
    zipFile.on("end", () => resolve(files));
    zipFile.on("error", reject);
    zipFile.readEntry();
  });

const isSafeZipPath = (value: string): boolean => {
  const normalized = value.replaceAll("\\", "/");
  return !normalized.startsWith("/")
    && !/^[a-zA-Z]:/u.test(normalized)
    && !normalized.split("/").includes("..")
    && !normalized.includes("\0");
};

const isSymlink = (entry: Entry): boolean => ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000;
