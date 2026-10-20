/**
 * Local stand-in for the OpenAI-compatible endpoint the repair path calls, so
 * requirement B can be exercised end to end on a machine whose configured model
 * host is unreachable. Serves chat completions until it is killed, because a
 * stub that exits after one call turns the next check into a bare connection
 * refusal — which reads like a code fault when it is only the test rig.
 */
import { createServer } from "node:http";

const html = `<!doctype html><html><head><meta charset="utf-8"><title>repair</title>
<script src="echarts.min.js"></script></head><body><div id="chart"></div>
<script>
const DEFAULT_DATA = { months: ['1月'], kpi: { total: 1 } };
const mergeData = (base, patch) => ({ ...base, ...patch });
let current = mergeData(DEFAULT_DATA, {});
function render() {}
async function boot() { const r = await fetch('data.json'); current = mergeData(current, await r.json()); render(); }
window.PROBE = { setData: (next) => { current = mergeData(current, next); render(); }, stop: () => {} };
boot();
</script></body></html>`;

const server = createServer((request, response) => {
  let raw = "";
  request.on("data", (chunk) => { raw += chunk; });
  request.on("end", () => {
    console.log(`[stub] ${request.method} ${request.url} bytes=${raw.length}`);
    if (!request.url?.includes("/chat/completions")) {
      response.writeHead(404).end("{}");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      choices: [{ finish_reason: "stop", index: 0, message: { content: html, role: "assistant" } }],
      created: Math.floor(Date.now() / 1000),
      id: "stub-1",
      model: "stub-model",
      object: "chat.completion",
      usage: { completion_tokens: 10, prompt_tokens: 10, total_tokens: 20 }
    }));
    console.log(`[stub] served a repaired page (${html.length} bytes)`);
  });
});

server.listen(4199, "127.0.0.1", () => console.log("[stub] listening on 127.0.0.1:4199"));
