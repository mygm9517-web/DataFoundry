/**
 * Requirement B: ask the configured default model to repair a page that failed
 * upload validation, and check that what comes back is re-validated rather than
 * installed. Drives the same two requests the console makes.
 */
import { deflateRawSync } from "node:zlib";

const WEB = "http://127.0.0.1:3000";
// Set when the configured model host is down — which is this deployment's real
// state, since .env points at a host that does not answer. The two modes ask
// different questions, so each reports only what it can actually observe.
const OFFLINE = process.env.REPAIR_CHECK_OFFLINE === "1";

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
const crc32 = (buffer) => {
  let c = -1;
  for (const byte of buffer) c = (c >>> 8) ^ crcTable[(c ^ byte) & 0xff];
  return (c ^ -1) >>> 0;
};
/** Stored-or-deflated zip, so the upload sees a real archive. */
const buildZip = (files) => {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.path, "utf8");
    const raw = Buffer.from(file.content, "utf8");
    const deflated = deflateRawSync(raw);
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(useDeflate ? 8 : 0, 10);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + body.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
};

const cookies = new Map();
const cookieHeader = () => [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
const absorb = (response) => {
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(";");
    const index = pair.indexOf("=");
    cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
};
const call = async (path, init = {}) => {
  const response = await fetch(`${WEB}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), cookie: cookieHeader() },
    redirect: "manual"
  });
  absorb(response);
  return response;
};
const ok = (label, condition, detail = "") =>
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);

await call("/api/v1/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "local-demo@example.test", password: "LSe4dhksoKRapaCKtnXZGqiG" })
});
const csrf = (await (await call("/api/v1/auth/csrf")).json())?.data?.csrfToken ?? "";

const broken = `<!doctype html><html><head><meta charset="utf-8"><script src="echarts.min.js"></script></head>
<body><div id="chart"></div><script>const chart = 1; window.PROBE = { setData: () => {} };</script></body></html>`;
const form = new FormData();
form.set("file", new File([buildZip([{ path: "index.html", content: broken }])], "repair-probe.zip"));
form.set("templateId", "repair-probe");
const refused = await call("/api/big-screen-templates", {
  method: "POST",
  headers: { "x-csrf-token": csrf },
  body: form
});
const refusedBody = await refused.json();
ok("upload refused with a repair source", refused.status === 422 && refusedBody.data?.repair?.html === broken,
  `status=${refused.status} entry=${refusedBody.data?.repair?.entry} files=${refusedBody.data?.repair?.files?.join("|")}`);

const repair = await call("/api/big-screen-templates/repair", {
  method: "POST",
  headers: { "content-type": "application/json", "x-csrf-token": csrf },
  body: JSON.stringify({
    entry: refusedBody.data.repair.entry,
    files: refusedBody.data.repair.files,
    html: refusedBody.data.repair.html,
    violations: refusedBody.data.violations
  })
});
const repaired = await repair.json();
if (OFFLINE) {
  console.log("SKIP  repair returns a rewritten page (no model to answer)");
} else {
  ok("repair returns a rewritten page", repair.status === 200 && (repaired.data?.html ?? "").includes("DEFAULT_DATA"),
    `status=${repair.status} model=${repaired.data?.model} latencyMs=${repaired.data?.latencyMs} error=${JSON.stringify(repaired.error ?? "")}`);
}
console.log(`--- repair with the model endpoint ${OFFLINE ? "down" : "answering"}:`);

// Closing the loop: the repaired page is only useful if it uploads. It is put
// through the same validator as any manual upload — nothing was installed on the
// model's say-so, so this is the step that proves the model's answer is real.
//
// The page's own asset goes in beside it. A repair rewrites index.html and
// nothing else, so a page that pulls in a chart library still needs the operator
// to ship that library — which is exactly what the validator says when it is
// missing, and is the correct answer rather than a defect.
const retryForm = new FormData();
retryForm.set("file", new File([buildZip([
  { path: "index.html", content: repaired.data?.html ?? "" },
  { path: "echarts.min.js", content: "/* chart library stand-in */\n" }
])], "repaired.zip"));
retryForm.set("templateId", "repair-probe");
retryForm.set("name", "repair probe");
const retried = OFFLINE ? null : await call("/api/big-screen-templates", { method: "POST", headers: { "x-csrf-token": csrf }, body: retryForm });
const retriedBody = retried ? await retried.json() : {};
if (retried) {
  ok("the repaired page passes the same validator", retried.status === 201,
    `status=${retried.status} fields=${(retriedBody.data?.fields ?? []).map((f) => `${f.path}:${f.kind}`).join(",")} violations=${JSON.stringify(retriedBody.data?.violations ?? "")}`);
} else {
  console.log("SKIP  the repaired page passes the same validator (nothing was rewritten)");
}

// Leave the workspace as it was found.
if (retried?.status === 201) {
  const deleted = await call("/api/big-screen-templates/repair-probe", { method: "DELETE", headers: { "x-csrf-token": csrf } });
  ok("cleanup removed the probe template", deleted.status === 200, `status=${deleted.status}`);
}

// Only meaningful when nothing is listening on the model endpoint: this is the
// deployment's real state, where the configured host does not answer. What the
// console shows then is part of the feature — an operator who gets a blank
// failure has no way to tell an unreachable host from a model that answered
// badly. Skipped rather than failed when the stub is up, so the two runs can be
// read independently.
if (OFFLINE) {
const offline = await call("/api/big-screen-templates/repair", {
  method: "POST",
  headers: { "content-type": "application/json", "x-csrf-token": csrf },
  body: JSON.stringify({ entry: "index.html", files: ["index.html"], html: broken, violations: [] })
});
const offlineBody = await offline.json();
ok("an unreachable model is reported, not swallowed", offline.status >= 400 && Boolean(offlineBody.error?.code),
  `status=${offline.status} code=${offlineBody.error?.code} message=${offlineBody.error?.message}`);
} else {
  console.log("SKIP  unreachable-model reporting (set REPAIR_CHECK_OFFLINE=1 with the model host down)");
}
