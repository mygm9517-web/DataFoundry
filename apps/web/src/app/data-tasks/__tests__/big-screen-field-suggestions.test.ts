import { describe, expect, it } from "vitest";
import { deflateRawSync } from "node:zlib";
import { parseBigScreenTemplateUpload } from "@datafoundry/bigscreen";

/**
 * Field suggestions for an uploaded page.
 *
 * The console offers the page's own dot paths as the list an operator binds
 * queries to, and they come from reading `DEFAULT_DATA` out of the page source.
 * A page is hand-written JavaScript, not JSON, so the reader has to accept the
 * syntax JavaScript actually allows — bare keys, single quotes, trailing commas,
 * a helper call standing in for a series. The failure mode when it does not is
 * the quiet one: the upload succeeds and the field list comes back empty, which
 * reads as "this page has nothing to bind" rather than "this page could not be
 * read".
 */

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

const crc32 = (buffer: Buffer): number => {
  let c = 0 ^ -1;
  for (const byte of buffer) c = (c >>> 8) ^ crcTable[(c ^ byte) & 0xff];
  return (c ^ -1) >>> 0;
};

/** Stored-or-deflated zip, enough to exercise the parser end to end. */
const buildZip = (files: Array<{ path: string; content: string }>): Buffer => {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
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

/**
 * A page that satisfies the upload contract with as little ceremony as possible,
 * so each test only has to vary the `DEFAULT_DATA` it is about.
 */
const page = (defaultData: string): string => `<!doctype html>
<html><head><meta charset="utf-8"><title>probe</title>
<script src="https://cdn.example.com/echarts.min.js"></script></head>
<body><div id="chart"></div>
<script>
  const DEFAULT_DATA = ${defaultData};
  const mergeData = (base, patch) => {
    const out = { ...base };
    Object.keys(patch).forEach((key) => { out[key] = patch[key]; });
    return out;
  };
  let current = mergeData(DEFAULT_DATA, {});
  function render() {}
  async function boot() {
    const response = await fetch('data.json');
    current = mergeData(current, await response.json());
    render();
  }
  window.PROBE = { setData: (next) => { current = mergeData(current, next); render(); }, stop: () => {} };
  boot();
</script></body></html>`;

const suggest = async (defaultData: string) => {
  const parsed = await parseBigScreenTemplateUpload({
    filename: "probe.zip",
    content: buildZip([
      { path: "index.html", content: page(defaultData) },
      { path: "data.json", content: "{}" },
    ]),
  });
  if (!parsed.ok) {
    throw new Error(`page rejected: ${parsed.violations.map((entry) => entry.code).join(",")}`);
  }
  return new Map(parsed.manifest.fields.map((field) => [field.path, field.kind]));
};

describe("uploaded page field suggestions", () => {
  it("reads a hand-written javascript literal, not just json", async () => {
    // The shape of every template in this repo: unquoted keys, single quotes,
    // and a comment inside the literal.
    const fields = await suggest(`{
      months: ['1月','2月','3月'],
      kpi: { passRate: 99, ngCount: 3 },
      /* 分布 */
      channels: [1, 2, 3],
    }`);
    expect(fields.get("months")).toBe("series");
    expect(fields.get("kpi.passRate")).toBe("scalar");
    expect(fields.get("kpi.ngCount")).toBe("scalar");
    expect(fields.get("channels")).toBe("series");
  });

  it("still reads a literal that happens to be valid json", async () => {
    const fields = await suggest('{"kpi": {"total": 1}, "trend": [1, 2]}');
    expect(fields.get("kpi.total")).toBe("scalar");
    expect(fields.get("trend")).toBe("series");
  });

  it("calls an array of named rows a label list and one of plain rows a series", async () => {
    const fields = await suggest(`{
      byChannel: [{ name: 'douyin', value: 12 }],
      byDay: [3, 9, 4],
    }`);
    // A row carrying `name` is what a chart's category axis binds to; the
    // distinction is what tells the editor which target to offer.
    expect(fields.get("byChannel")).toBe("labels");
    expect(fields.get("byDay")).toBe("series");
  });

  it("keeps suggesting fields when a value is a call the scanner cannot evaluate", async () => {
    // `genPdt(14)` is a placeholder the page fills in at runtime. It is not a
    // shape the reader can know, but the fields around it are.
    const fields = await suggest(`{
      pdt: genPdt(14),
      after: { complaint: 2 },
      scale: 1.5,
    }`);
    expect(fields.get("pdt")).toBe("scalar");
    expect(fields.get("after.complaint")).toBe("scalar");
    expect(fields.get("scale")).toBe("scalar");
  });

  it("offers nothing it cannot name for a computed key", async () => {
    const fields = await suggest(`{ ['dyn' + 'amic']: 1, stable: 2 }`);
    // An invented name would put a target in the editor that no query can reach.
    expect([...fields.keys()]).toEqual(["stable"]);
  });

  it("skips a key whose value is code, and keeps reading past it", async () => {
    // `helper` is a function, not data: no query can be bound to it, so it is
    // dropped rather than offered as a phantom target. What matters is that the
    // skip resynchronises — `after` sits behind a body full of braces, and a
    // scanner that lost its place there would take the rest of the literal with
    // it.
    const fields = await suggest(`{
      real: 1,
      helper: (x) => { return { inner: [x, { deep: x }] }; },
      after: 2,
      tail: [1, 2, 3],
    }`);
    expect([...fields.keys()]).toEqual(["real", "after", "tail"]);
    expect(fields.get("tail")).toBe("series");
  });
});
