import { describe, expect, it, vi } from "vitest";
import { applyRepairResponse, completionText, repairBigScreenHtml, validateRepairScripts } from "./big-screen-repair.js";

describe("big-screen repair response", () => {
  const html = "<!doctype html><html><body>demo</body></html>";
  it("accepts complete HTML in a markdown fence", () => {
    expect(applyRepairResponse(html, "```html\n<html><body>live</body></html>\n```"))
      .toBe("<html><body>live</body></html>");
  });
  it("applies patches across Windows line endings", () => {
    expect(applyRepairResponse("<html>\r\n<body>demo</body>\r\n</html>",
      "<<<SEARCH\r\n<body>demo</body>\r\n===\r\n<body>live</body>\r\n>>>REPLACE"))
      .toContain("<body>live</body>");
  });
  it("rejects an unmatched block even when an earlier block matches", () => {
    expect(() => applyRepairResponse(html,
      "<<<SEARCH\ndemo\n===\nlive\n>>>REPLACE\n<<<SEARCH\nmissing\n===\nx\n>>>REPLACE"))
      .toThrow("patch 2 must match exactly once");
  });
  it("rejects ambiguous and incomplete patches", () => {
    expect(() => applyRepairResponse("demo demo", "<<<SEARCH\ndemo\n===\nlive\n>>>REPLACE"))
      .toThrow("match exactly once");
    expect(() => applyRepairResponse(html, "<<<SEARCH\ndemo\n===\nlive\n>>>REPLACE\n<<<SEARCH\nunfinished"))
      .toThrow("incomplete patch");
  });
  it("rejects explanations, incomplete HTML and unchanged pages", () => {
    for (const response of ["Please add DEFAULT_DATA.", "<html><body>unfinished", html]) {
      expect(() => applyRepairResponse(html, response)).toThrow("BIG_SCREEN_TEMPLATE_REPAIR_INVALID");
    }
  });
  it("reads text parts without using reasoning as page code", () => {
    expect(completionText([{type:"reasoning",text:"thinking"},{type:"text",text:"<html>"},{type:"text",text:"</html>"}]))
      .toBe("<html></html>");
    expect(completionText(null)).toBe("");
  });
  it("rejects malformed blocks that combine multiple replacements", () => {
    expect(()=>applyRepairResponse(html,"<<<SEARCH\ndemo\n===\nlive\n===\nsecond\n>>>REPLACE"))
      .toThrow("exactly one === separator");
  });
  it("rejects duplicate JavaScript declarations and never executes inline code", () => {
    expect(()=>validateRepairScripts("<script>let timer; let timer;</script>"))
      .toThrow("JavaScript syntax");
    expect(()=>validateRepairScripts("<script>throw new Error('not executed');</script>")).not.toThrow();
    expect(()=>validateRepairScripts('<script type="application/json">{"a":1}</script>')).not.toThrow();
  });
});

describe("repair model request", () => {
  const input = {entry:"index.html",html:"<html><body>demo</body></html>",files:["index.html"],violations:[],
    baseUrl:"http://model.test/v1/",apiKey:"test-key",model:"deepseek-flash",timeoutMs:1000};
  it("disables DeepSeek thinking and gives page generation enough output tokens", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({model:"deepseek-flash",choices:[{
      finish_reason:"stop",message:{content:"<<<SEARCH\ndemo\n===\nlive\n>>>REPLACE"}}]}));
    expect((await repairBigScreenHtml({...input,fetchImpl})).html).toContain("live");
    const request=JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string);
    expect(request.thinking).toEqual({type:"disabled"});
    expect(request.max_tokens).toBeGreaterThan(4096);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://model.test/v1/chat/completions");
  });
  it("rejects budget exhaustion before treating reasoning-only output as a page", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({choices:[{
      finish_reason:"length",message:{content:"",reasoning_content:"thinking"}}]}));
    await expect(repairBigScreenHtml({...input,fetchImpl})).rejects.toThrow("output truncated");
  });
  it("rejects empty output", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({choices:[{finish_reason:"stop",message:{content:""}}]}));
    await expect(repairBigScreenHtml({...input,fetchImpl})).rejects.toThrow("BIG_SCREEN_TEMPLATE_REPAIR_EMPTY");
  });
  it("does not send DeepSeek-only options to other models", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({choices:[{
      finish_reason:"stop",message:{content:"<html><body>live</body></html>"}}]}));
    await repairBigScreenHtml({...input,model:"other-model",fetchImpl});
    expect(JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string)).not.toHaveProperty("thinking");
  });
  it("asks the model to correct an invalid patch against the original source", async () => {
    const fetchImpl=vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({choices:[{finish_reason:"stop",message:{content:"<<<SEARCH\nmissing\n===\nlive\n>>>REPLACE"}}]}))
      .mockResolvedValueOnce(Response.json({choices:[{finish_reason:"stop",message:{content:"<<<SEARCH\ndemo\n===\nlive\n>>>REPLACE"}}]}));
    expect((await repairBigScreenHtml({...input,fetchImpl})).html).toContain("live");
    const request=JSON.parse(fetchImpl.mock.calls[1]?.[1]?.body as string);
    expect(request.messages.at(-1).content).toContain("must match exactly once");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("bounds invalid patch retries", async () => {
    const fetchImpl=vi.fn<typeof fetch>().mockImplementation(async()=>Response.json({choices:[{
      finish_reason:"stop",message:{content:"invalid proposal"}}]}));
    await expect(repairBigScreenHtml({...input,fetchImpl})).rejects.toThrow("BIG_SCREEN_TEMPLATE_REPAIR_INVALID");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
