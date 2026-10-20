/**
 * Requirements A and C, driven against a running stack (`npm run start`).
 *
 * A: a page that cannot work is refused with the reasons, a copyable design
 *    prompt, and its own source handed back so the console can offer the model.
 * C: upload, download, publish, unpublish, delete — including that a published
 *    page cannot be deleted until it is taken down.
 *
 * These are the three things the operator asked for, checked end to end rather
 * than through unit seams, so this is the script to run after changing anything
 * on the big-screen upload path. `repair-flow.mjs` covers requirement B.
 */
import { deflateRawSync } from "node:zlib";

const WEB = "http://127.0.0.1:3000";

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

let cookies = new Map();
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

const csrf = async () => {
  const response = await call("/api/v1/auth/csrf");
  const body = await response.json();
  return body?.data?.csrfToken ?? "";
};

const ok = (label, condition, detail = "") =>
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);

// --- login ---------------------------------------------------------------
const login = await call("/api/v1/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "local-demo@example.test", password: "LSe4dhksoKRapaCKtnXZGqiG" })
});
ok("login", login.status === 200, `status=${login.status}`);
let token = await csrf();

const upload = async (id, zip, filename) => {
  const form = new FormData();
  form.set("file", new File([zip], filename));
  form.set("templateId", id);
  form.set("name", id);
  const response = await call("/api/big-screen-templates", {
    method: "POST",
    headers: { "x-csrf-token": token },
    body: form
  });
  return { status: response.status, body: await response.json() };
};

// --- a page that violates the contract -----------------------------------
const brokenPage = `<!doctype html><html><head><meta charset="utf-8"><script src="echarts.min.js"></script></head>
<body><div id="chart"></div><script>const chart = 1; window.PROBE = { setData: () => {} };</script></body></html>`;
const broken = await upload("acceptance-broken", buildZip([{ path: "index.html", content: brokenPage }]), "acceptance-broken.zip");
ok("refused upload returns violations", broken.status === 422 && broken.body.data.violations.length > 0,
  `status=${broken.status} codes=${broken.body.data?.violations?.map((v) => v.code).join(",")}`);
ok("refused upload carries the design prompt", (broken.body.data?.designPrompt ?? "").length > 500,
  `chars=${broken.body.data?.designPrompt?.length}`);
ok("refused upload carries the page back for repair", typeof broken.body.data?.repair?.html === "string",
  `files=${broken.body.data?.repair?.files?.join("|")}`);

// --- a page that satisfies it --------------------------------------------
const goodPage = `<!doctype html><html><head><meta charset="utf-8"><title>验收</title>
<script src="echarts.min.js"></script></head><body><div id="chart"></div>
<script>
const DEFAULT_DATA = { months: ['1月','2月','3月'], kpi: { total: 3 }, byChannel: [{ name: 'douyin', value: 7 }] };
const mergeData = (base, patch) => { const out = { ...base }; Object.keys(patch).forEach((k) => { out[k] = patch[k]; }); return out; };
let current = mergeData(DEFAULT_DATA, {});
function render() { document.getElementById('chart').textContent = JSON.stringify(current.kpi); }
async function boot() { const r = await fetch('data.json'); current = mergeData(current, await r.json()); render(); }
window.PROBE = { setData: (next) => { current = mergeData(current, next); render(); }, stop: () => {} };
boot();
</script></body></html>`;
const goodZip = buildZip([
  { path: "index.html", content: goodPage },
  { path: "data.json", content: JSON.stringify({ kpi: { total: 3 } }) },
  { path: "echarts.min.js", content: "/* stub */" }
]);
const good = await upload("acceptance-page", goodZip, "acceptance-page.zip");
ok("upload accepted", good.status === 201 || good.status === 200, `status=${good.status} ${JSON.stringify(good.body.error ?? "")}`);
const fieldKinds = new Map((good.body.data?.fields ?? []).map((f) => [f.path, f.kind]));
ok("upload records the page's own fields",
  fieldKinds.get("months") === "series" && fieldKinds.get("kpi.total") === "scalar" && fieldKinds.get("byChannel") === "labels",
  `fields=${[...fieldKinds].map(([p, k]) => `${p}:${k}`).join(",")}`);

// --- serving, download, delete gating ------------------------------------
const wall = await call("/bigscreen/acceptance-page/index.html");
const wallBody = await wall.text();
ok("unpublished page is not served", wall.status === 404 || wallBody === "" || wall.status >= 400, `status=${wall.status}`);

const publish = await call("/api/big-screen-templates/acceptance-page", {
  method: "PATCH",
  headers: { "content-type": "application/json", "x-csrf-token": token },
  body: JSON.stringify({ action: "publish" })
});
ok("publish", publish.status === 200, `status=${publish.status} ${JSON.stringify((await publish.clone().json()).error ?? "")}`);

const served = await call("/bigscreen/acceptance-page/index.html");
const servedBody = await served.text();
ok("published page is served", served.status === 200 && servedBody.includes("DEFAULT_DATA"), `status=${served.status}`);
const servedData = await call("/bigscreen/acceptance-page/data.json");
ok("published page's data file is served", servedData.status === 200, `status=${servedData.status}`);

const download = await call("/api/big-screen-templates/acceptance-page/download");
const bytes = Buffer.from(await download.arrayBuffer());
ok("download returns the uploaded archive byte-for-byte", bytes.equals(goodZip) && download.status === 200,
  `status=${download.status} bytes=${bytes.length}/${goodZip.length}`);

const blocked = await call("/api/big-screen-templates/acceptance-page", {
  method: "DELETE",
  headers: { "x-csrf-token": token }
});
const blockedBody = await blocked.json();
ok("a published page refuses deletion", blocked.status === 409 && blockedBody.error?.code === "BIG_SCREEN_TEMPLATE_PUBLISHED",
  `status=${blocked.status} code=${blockedBody.error?.code} msg=${blockedBody.error?.message}`);

const unpublish = await call("/api/big-screen-templates/acceptance-page", {
  method: "PATCH",
  headers: { "content-type": "application/json", "x-csrf-token": token },
  body: JSON.stringify({ action: "unpublish" })
});
ok("unpublish", unpublish.status === 200, `status=${unpublish.status}`);

const removed = await call("/api/big-screen-templates/acceptance-page", {
  method: "DELETE",
  headers: { "x-csrf-token": token }
});
ok("unpublished page deletes", removed.status === 200, `status=${removed.status}`);

const gone = await call("/bigscreen/acceptance-page/index.html");
ok("deleted page stops being served", gone.status >= 400, `status=${gone.status}`);

const list = await call("/api/big-screen-templates");
const listBody = await list.json();
ok("list is empty again", Array.isArray(listBody.data) && listBody.data.length === 0, JSON.stringify(listBody.data));

// --- the design prompt is reachable where the client needs it -------------
const prompt = await call("/api/big-screen-templates/design-prompt");
const promptBody = await prompt.json();
ok("design prompt endpoint", prompt.status === 200 && (promptBody.data?.prompt ?? "").length > 500,
  `status=${prompt.status} chars=${(promptBody.data?.prompt ?? "").length}`);
