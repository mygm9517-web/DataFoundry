import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createAuthenticatedTestClient } from "./lib/authenticated-test-client.mjs";

const baseUrl = "http://127.0.0.1:3000";
const client = createAuthenticatedTestClient({ baseUrl });
const credentialFile = new URL("../storage/local-runtime/demo-account.json", import.meta.url);
let account;
if (existsSync(credentialFile)) {
  account = JSON.parse(readFileSync(credentialFile, "utf8"));
  await client.fetchJson("/api/v1/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(account)
  });
} else {
  account = { email: "local-demo@example.test", password: randomBytes(18).toString("base64url"), displayName: "Local Demo" };
  await client.registerAndLogin(account);
  writeFileSync(credentialFile, JSON.stringify(account, null, 2));
}
console.log("Local account registration/login and same-origin BFF: OK. Credentials saved locally.");
writeFileSync(new URL("../storage/local-runtime/browser-state.json", import.meta.url), JSON.stringify({
  cookies: Object.entries(client.cookies.snapshot()).map(([name, value]) => ({
    name, value, domain: "127.0.0.1", path: "/", expires: -1,
    httpOnly: name === "df_session", secure: false, sameSite: "Lax"
  })), origins: []
}));
for (const endpoint of ["capabilities", "datasources", "model-profiles", "run-defaults"]) {
  const { body } = await client.fetchJson(`/api/v1/${endpoint}`);
  console.log(endpoint, JSON.stringify(body));
}
if (process.argv.includes("--run")) {
  const threadId = `local-verification-${randomUUID()}`;
  const response = await client.fetch("/api/copilotkit", {
    method: "POST", headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
    signal: AbortSignal.timeout(180000),
    body: JSON.stringify({ method: "agent/run", params: { agentId: "dataFoundry" }, body: {
      threadId, runId: randomUUID(), messages: [{ id: randomUUID(), role: "user", content: "仅使用内置 DTC Growth Review 数据源，先检查 schema，再以只读 SQL 查询订单总数。请返回查询 SQL 和真实结果，不生成文件，不执行命令。" }],
      state: {}, tools: [], context: [], forwardedProps: { run_config: { activeDatasourceId: "dtc-growth-demo", enabledDatasourceIds: ["dtc-growth-demo"], activeLlmProfileId: "server-default" } }
    } })
  });
  assert.equal(response.status, 200);
  const stream = await response.text();
  writeFileSync(new URL("../storage/local-runtime/verification-events.txt", import.meta.url), stream);
  const events = stream.split(/\r?\n/).filter(line => line.startsWith("data: ") && line !== "data: [DONE]").flatMap(line => { try { return [JSON.parse(line.slice(6))]; } catch { return []; } });
  console.log("Event types:", [...new Set(events.map(event => event.type))].join(", "));
  console.log("Tools:", events.filter(event => event.type === "TOOL_CALL_START").map(event => event.toolCallName).join(", "));
  console.log("Answer:", events.filter(event => event.type === "TEXT_MESSAGE_CONTENT").map(event => event.delta).join(""));
  const errors = events.filter(event => event.type === "RUN_ERROR");
  console.log("Run errors:", JSON.stringify(errors));
  assert.equal(errors.length, 0);
  assert.ok(events.some(event => event.type === "RUN_FINISHED"));
  console.log("Live model run completed. Thread:", threadId);
}
