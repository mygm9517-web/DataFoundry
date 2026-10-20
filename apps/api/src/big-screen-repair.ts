import { BIG_SCREEN_PAGE_DESIGN_PROMPT, type BigScreenBundleViolation } from "@datafoundry/bigscreen";
import { Script } from "node:vm";

type RepairInput = {
  entry: string;
  html: string;
  files: string[];
  violations: BigScreenBundleViolation[];
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
};

type Completion = {
  model?: string;
  choices?: Array<{ finish_reason?: string; message?: { content?: unknown } }>;
  usage?: { completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } };
};

export const completionText = (content: unknown): string => {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.map((part: unknown) => {
    if (typeof part !== "object" || part === null) return "";
    const item = part as { type?: string; text?: unknown };
    return item.type === "text" && typeof item.text === "string" ? item.text : "";
  }).join("").trim();
};

/** Apply every block or reject the response, so a partial patch cannot be reported as success. */
export const applyRepairResponse = (html: string, response: string): string => {
  const normalize = (value: string): string => value.replace(/\r\n?/gu, "\n");
  const original = normalize(html);
  const text = normalize(response).trim();
  const blocks = [...text.matchAll(/<<<SEARCH\n([\s\S]*?)\n===\n([\s\S]*?)\n>>>REPLACE/gu)];
  let result = original;
  if (blocks.length > 0) {
    if ((text.match(/<<<SEARCH/gu) ?? []).length !== blocks.length) {
      throw new Error("BIG_SCREEN_TEMPLATE_REPAIR_INVALID:incomplete patch block");
    }
    for (const [index, block] of blocks.entries()) {
      const search = block[1] ?? "";
      const replacement = block[2] ?? "";
      if (/^(?:===|<<<SEARCH|>>>REPLACE)\s*$/mu.test(search + "\n" + replacement)) {
        throw new Error("BIG_SCREEN_TEMPLATE_REPAIR_INVALID:each patch needs exactly one === separator and its own >>>REPLACE terminator");
      }
      const at = search ? result.indexOf(search) : -1;
      if (at < 0 || result.indexOf(search, at + 1) >= 0) {
        throw new Error(`BIG_SCREEN_TEMPLATE_REPAIR_INVALID:patch ${index + 1} must match exactly once`);
      }
      result = result.slice(0, at) + replacement + result.slice(at + search.length);
    }
  } else {
    // Some compatible models still return a whole HTML file, optionally fenced.
    const raw = text.replace(/^```(?:html)?\s*\n/iu, "").replace(/\n```\s*$/u, "").trim();
    if (!/^(?:<!doctype html[^>]*>\s*)?<html[\s>]/iu.test(raw) || !/<\/html>\s*$/iu.test(raw)) {
      throw new Error("BIG_SCREEN_TEMPLATE_REPAIR_INVALID:expected patches or a complete HTML page");
    }
    result = raw;
  }
  if (!result.trim() || result === original) {
    throw new Error("BIG_SCREEN_TEMPLATE_REPAIR_INVALID:response did not change the page");
  }
  validateRepairScripts(result);
  return result;
};

/** Parse classic inline scripts without executing model-generated code on the server. */
export const validateRepairScripts = (html: string): void => {
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu)) {
    const attrs = match[1] ?? "";
    const code = match[2] ?? "";
    const type = /\btype\s*=\s*["']([^"']+)["']/iu.exec(attrs)?.[1]?.toLowerCase();
    if (!code.trim() || (type && !/^(?:text|application)\/(?:java|ecma)script$/u.test(type))) continue;
    try { new Script(code); } catch (error) {
      throw new Error(`BIG_SCREEN_TEMPLATE_REPAIR_INVALID:JavaScript syntax: ${error instanceof Error ? error.message : "invalid script"}`);
    }
  }
};

export const repairBigScreenHtml = async (input: RepairInput): Promise<{ html: string; model: string }> => {
  const prompt = [
    "Repair this big-screen HTML page. Preserve its visual design and business meaning.",
    "REQUIREMENTS:", BIG_SCREEN_PAGE_DESIGN_PROMPT,
    "VIOLATIONS:",
    input.violations.map((v, i) => `${i + 1}. [${v.code}] ${v.message}\nFix: ${v.fix}`).join("\n"),
    "EXISTING FILES:", input.files.join("\n"),
    "Reuse existing data, variables and chart redraw functions. Avoid duplicate declarations.",
    "Expose window.SCREEN.setData(next) and stop(). setData must stop demo timers, merge new data and redraw.",
    "Do not introduce new local files or fetch files that are not present. Prefer the global setData interface.",
    "Return ONLY SEARCH/REPLACE blocks with exact, unique source text, including indentation:",
    "<<<SEARCH\n<exact lines to find>\n===\n<replacement lines>\n>>>REPLACE",
    "Do not output the entire file or explanations. Make all changes needed to satisfy the requirements.",
    `FILE ${input.entry}:\n${input.html}`
  ].join("\n\n");
  // DeepSeek's output budget includes reasoning. With 4096 tokens it can return
  // finish_reason=length and content="" after consuming the entire budget thinking.
  const thinkingOptions = /deepseek/iu.test(input.model) ? { thinking: { type: "disabled" } } : {};
  const deadline = Date.now() + input.timeoutMs;
  const messages = [{ role: "user", content: prompt }];
  for (let attempt = 0; attempt < 3; attempt += 1) {
  const response = await (input.fetchImpl ?? fetch)(`${input.baseUrl.replace(/\/+$/u, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${input.apiKey}` },
    signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    body: JSON.stringify({
      model: input.model,
      messages,
      max_tokens: 16384,
      temperature: 0,
      stream: false,
      ...thinkingOptions
    })
  });
  if (!response.ok) throw new Error(`PROVIDER_TEST_FAILED:HTTP ${response.status}`);
  const completion = await response.json() as Completion;
  const choice = completion.choices?.[0];
  const model = completion.model ?? input.model;
  // Log metadata only; never page contents, reasoning text or credentials.
  console.info("[big-screen-repair] completion", {
    model, attempt: attempt + 1, finishReason: choice?.finish_reason,
    outputTokens: completion.usage?.completion_tokens,
    reasoningTokens: completion.usage?.completion_tokens_details?.reasoning_tokens
  });
  if (choice?.finish_reason === "length") {
    throw new Error(`BIG_SCREEN_TEMPLATE_REPAIR_INVALID:output truncated (${model})`);
  }
  const text = completionText(choice?.message?.content);
  if (!text) throw new Error(`BIG_SCREEN_TEMPLATE_REPAIR_EMPTY:${model}`);
  try {
    return { html: applyRepairResponse(input.html, text), model };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn("[big-screen-repair] validation", { model, attempt: attempt + 1, reason });
    if (attempt === 2 || Date.now() >= deadline) throw error;
    messages.push({ role: "assistant", content: text });
    messages.push({ role: "user", content: `The proposed patch failed validation: ${reason}. Return a corrected complete set of SEARCH/REPLACE blocks against the ORIGINAL file. Each block must have exactly one === separator and end with >>>REPLACE. No duplicate declarations, and no explanatory text.` });
  }
  }
  throw new Error("BIG_SCREEN_TEMPLATE_REPAIR_INVALID:retry limit reached");
};
