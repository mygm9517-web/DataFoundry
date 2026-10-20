import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const envPath = new URL(".env", root);
if (!existsSync(envPath)) copyFileSync(new URL(".env.example", root), envPath);
let content = readFileSync(envPath, "utf8");
const keys = ["AUTH_SESSION_SECRET", "SECRET_MASTER_KEY"];
const changes = [];
for (const key of keys) {
  const pattern = new RegExp(`^${key}=(.*)$`, "m");
  const current = content.match(pattern)?.[1].trim();
  if (current && !current.startsWith("replace-with-")) continue;
  if (key === "SECRET_MASTER_KEY" && ["storage/metadata/workbench.sqlite", "apps/api/storage/metadata/workbench.sqlite"].some(p => existsSync(new URL(p, root)))) {
    throw new Error("Existing metadata detected; preserve its master key.");
  }
  const line = `${key}=${randomBytes(32).toString("hex")}`;
  content = pattern.test(content) ? content.replace(pattern, line) : `${content}\n${line}\n`;
  changes.push(key);
}
const llmUrlPattern = /^LLM_BASE_URL=(.*)$/m;
const llmUrl = content.match(llmUrlPattern)?.[1].trim();
if (llmUrl && /\/chat\/completions\/?$/.test(llmUrl)) {
  content = content.replace(llmUrlPattern, `LLM_BASE_URL=${llmUrl.replace(/\/chat\/completions\/?$/, "")}`);
  changes.push("LLM_BASE_URL normalized");
}
if (changes.length) {
  copyFileSync(envPath, new URL(`.env.backup-${Date.now()}`, root));
  writeFileSync(envPath, content);
}
const webLocal = new URL("apps/web/.env.local", root);
if (!existsSync(webLocal)) {
  copyFileSync(new URL("apps/web/.env.example", root), webLocal);
}
console.log(`Local config ready at ${fileURLToPath(root)}. Updated: ${changes.join(", ") || "none"}. Model credentials preserved.`);
