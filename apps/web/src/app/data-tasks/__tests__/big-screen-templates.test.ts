import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BIG_SCREEN_TEMPLATES,
  DEFAULT_BIG_SCREEN_PREFETCH_ROWS,
  DEFAULT_BIG_SCREEN_REFRESH_MS,
  DEFAULT_BIG_SCREEN_VISIBLE_POINTS,
  MAX_BIG_SCREEN_DATASETS,
  MAX_BIG_SCREEN_PREFETCH_ROWS,
  MAX_BIG_SCREEN_REFRESH_MS,
  MAX_BIG_SCREEN_VISIBLE_POINTS,
  MIN_BIG_SCREEN_REFRESH_MS,
  getBigScreenTemplate,
  getBigScreenTemplatePath,
  groupBigScreenTemplateFields,
} from "../big-screen-templates";
import {
  BIG_SCREEN_BRIDGE_READY,
  BIG_SCREEN_BRIDGE_REQUEST,
  BIG_SCREEN_BRIDGE_RESPONSE,
  buildBigScreenBridgeMessage,
  buildBigScreenBridgeScript,
  isBigScreenBridgeRequest,
  withEmbedParam,
} from "../big-screen-runtime";

import { sampleTemplate } from "./sample-template";

describe("big screen template registry", () => {
  it("ships no private business pages", () => {
    expect(BIG_SCREEN_TEMPLATES).toEqual([]);
  });

  it("keeps templates out of public/ so the bridge cannot be bypassed", () => {
    // Next serves `public/` statically ahead of route handlers; a template
    // parked there would reach the browser un-spliced.
    expect(existsSync(join(process.cwd(), "public", "bigscreen"))).toBe(false);
  });

  it("does not resolve removed bundled pages", () => {
    expect(getBigScreenTemplatePath("home")).toBe("");
    expect(getBigScreenTemplatePath("does-not-exist")).toBe("");
    expect(getBigScreenTemplate("incoming")).toBeUndefined();
  });

  it("keeps refresh defaults inside the allowed range", () => {
    expect(DEFAULT_BIG_SCREEN_REFRESH_MS).toBeGreaterThanOrEqual(MIN_BIG_SCREEN_REFRESH_MS);
    expect(DEFAULT_BIG_SCREEN_REFRESH_MS).toBeLessThanOrEqual(MAX_BIG_SCREEN_REFRESH_MS);
    expect(DEFAULT_BIG_SCREEN_PREFETCH_ROWS).toBe(0);
    for (const template of BIG_SCREEN_TEMPLATES) {
      expect(template.refreshMs).toBeGreaterThanOrEqual(MIN_BIG_SCREEN_REFRESH_MS);
      expect(template.visiblePoints).toBeGreaterThan(0);
    }
  });

  it("addresses every bindable field by a target matching its kind", () => {
    for (const template of BIG_SCREEN_TEMPLATES) {
      for (const field of template.fields) {
        if (field.kind === "scalar") {
          expect(field.target, `${template.id}/${field.path}`).toBe(field.path);
        } else {
          // `series` and `labels` both bind a whole array, so both carry `[]`.
          expect(field.target, `${template.id}/${field.path}`).toBe(`${field.path}[]`);
        }
      }
    }
  });

  it("groups fields by their top-level data category", () => {
    const template = sampleTemplate;
    const groups = groupBigScreenTemplateFields(template);
    const months = groups.find((group) => group.group === "months");
    expect(months?.fields).toHaveLength(1);
    const kpi = groups.find((group) => group.group === "kpi");
    expect(kpi?.fields.length).toBeGreaterThan(0);
    // Every field lands in exactly one group.
    expect(groups.reduce((total, group) => total + group.fields.length, 0)).toBe(
      template.fields.length,
    );
  });

  it("clamps exactly where the API clamps", () => {
    // The editor and the API each enforce these bounds. Getting them out of step
    // is silent in both directions: too loose and the server truncates a dataset
    // the operator believes they configured, too tight and the editor rejects a
    // value the server would have accepted. Read the API's own declarations
    // rather than restating the numbers, so a change on either side fails here.
    // Resolved from this file, not the process cwd: vitest's cwd is the web
    // workspace under `npm --workspace` but the repo root under a bare
    // `vitest run`.
    const apiSource = readFileSync(
      fileURLToPath(new URL("../../../../../api/src/big-screen.ts", import.meta.url)),
      "utf8",
    ).replace(/\r\n/g, "\n");
    const apiConstant = (name: string): number => {
      const match = new RegExp(`export const ${name} = ([^;]+);`).exec(apiSource);
      expect(match, `${name} in apps/api/src/big-screen.ts`).not.toBeNull();
      const expression = match![1].replace(/HOUR_MS/g, "3600000").replace(/_/g, "");
      if (!/^[0-9 *]+$/.test(expression)) throw new Error(`Unexpected expression: ${expression}`);
      return expression.split("*").reduce((value, factor) => value * Number(factor.trim()), 1);
    };

    expect(MIN_BIG_SCREEN_REFRESH_MS).toBe(apiConstant("MIN_BIG_SCREEN_REFRESH_MS"));
    expect(MAX_BIG_SCREEN_REFRESH_MS).toBe(apiConstant("MAX_BIG_SCREEN_REFRESH_MS"));
    expect(DEFAULT_BIG_SCREEN_REFRESH_MS).toBe(apiConstant("DEFAULT_BIG_SCREEN_REFRESH_MS"));
    expect(MAX_BIG_SCREEN_DATASETS).toBe(apiConstant("MAX_BIG_SCREEN_DATASETS"));
    expect(MAX_BIG_SCREEN_PREFETCH_ROWS).toBe(apiConstant("MAX_BIG_SCREEN_LIMIT"));
    expect(MAX_BIG_SCREEN_VISIBLE_POINTS).toBe(apiConstant("MAX_BIG_SCREEN_LIMIT"));
    expect(apiSource).toContain("source.prefetchRows ?? source.prefetch_rows,\n    0,");
    expect(DEFAULT_BIG_SCREEN_VISIBLE_POINTS).toBeGreaterThan(0);
    expect(DEFAULT_BIG_SCREEN_VISIBLE_POINTS).toBeLessThanOrEqual(MAX_BIG_SCREEN_VISIBLE_POINTS);
  });
});

describe("big screen bridge script", () => {
  const script = buildBigScreenBridgeScript("home-data.json", 5000);

  it("only intercepts the template's own data file", () => {
    expect(script).toContain(JSON.stringify(BIG_SCREEN_BRIDGE_REQUEST));
    expect(script).toContain(JSON.stringify(BIG_SCREEN_BRIDGE_RESPONSE));
    expect(script).toContain(JSON.stringify(BIG_SCREEN_BRIDGE_READY));
    expect(script).toContain('"home-data.json"');
    // Anything that is not the data file goes to the untouched fetch.
    expect(script).toContain("if (!matches(url)) { return staticFallback(input, init); }");
  });

  it("parses as valid javascript", () => {
    // Catches an unescaped backtick or `${}` leak from the template literal.
    expect(() => new Function(script)).not.toThrow();
  });

  it("escapes a data file name that would otherwise close the string", () => {
    const hostile = buildBigScreenBridgeScript('we"ird\\name.json');
    expect(() => new Function(hostile)).not.toThrow();
    expect(hostile).toContain('"we\\"ird\\\\name.json"');
  });

  it("announces readiness so an idle screen can be pushed its first payload", () => {
    expect(script).toContain("window.__DATAFOUNDRY_BIGSCREEN_BRIDGE__ = true;");
    expect(script).toContain("postMessage({ type: READY }");
  });
});

describe("big screen bridge binding", () => {
  // The bridge ships as a browser IIFE, so it is run against a stub `window`
  // rather than imported. This is the only place its runtime behaviour — as
  // opposed to its text — is exercised.
  type Stub = {
    window: Record<string, unknown>;
    posts: Record<string, unknown>[];
    /** Answers an intercepted fetch the way the host would. */
    answer: (requestId: string, payload: unknown) => void;
  };

  function runBridge(
    binding: { global: string; call: string; stop?: string } | undefined,
    globals: Record<string, unknown> = {},
  ): Stub {
    const posts: Record<string, unknown>[] = [];
    const listeners: ((event: { data: unknown }) => void)[] = [];
    const window: Record<string, unknown> = {
      fetch: () => Promise.resolve(new Response("{}", { status: 200 })),
      addEventListener: (type: string, handler: (event: { data: unknown }) => void) => {
        if (type === "message") listeners.push(handler);
      },
      parent: { postMessage: (message: Record<string, unknown>) => posts.push(message) },
      ...globals,
    };
    window.window = window;
    const script = buildBigScreenBridgeScript("b-data.json", 5000, binding);
    // `window` is shadowed by the parameter so the IIFE's globals resolve here.
    new Function(
      "window",
      "Response",
      "setTimeout",
      "setInterval",
      "clearTimeout",
      "clearInterval",
      script,
    )(window, Response, setTimeout, setInterval, clearTimeout, clearInterval);
    return {
      window,
      posts,
      answer: (requestId, payload) => {
        for (const listener of listeners) {
          listener({ data: { type: BIG_SCREEN_BRIDGE_RESPONSE, requestId, ok: true, payload } });
        }
      },
    };
  }

  /** Rewrites the page's HTTP body with the payload, between delivery windows. */
  const waitForDelivery = (stub: Stub, payload: unknown) => {
    (stub.window.fetch as (url: string) => Promise<unknown>)("b-data.json");
    const request = stub.posts.find((post) => post.type === BIG_SCREEN_BRIDGE_REQUEST)!;
    expect(request, "bridge asked the host for data").toBeTruthy();
    stub.answer(String(request.requestId), payload);
    // Poll interval is 50ms; two ticks is enough for the payload to land.
    return new Promise((resolve) => setTimeout(resolve, 140));
  };

  it("waits for the page's global, switches off its demo loop, then delivers", async () => {
    const calls: unknown[] = [];
    const stub = runBridge(
      { global: "FQC", call: "setData", stop: "stopDemo" },
      {
        FQC: {
          setData: (data: unknown) => calls.push(data),
          stopDemo: () => calls.push("stopped"),
        },
      },
    );
    await waitForDelivery(stub, { kpi: { passRate: 91 } });
    // The demo ticker is stopped before the first payload lands: otherwise its
    // jitter overwrites the live numbers a frame later and the screen lies.
    expect(calls).toEqual(["stopped", { kpi: { passRate: 91 } }]);
  });

  it("delivers nothing when the template never publishes the global", async () => {
    const stub = runBridge({ global: "Absent", call: "setData" });
    await waitForDelivery(stub, { kpi: { passRate: 91 } });
    // No throw, no partial delivery — the page keeps its own baked-in data.
    expect(stub.window.Absent).toBeUndefined();
  });

  it("leaves a fetch-only template on the plain path", () => {
    const stub = runBridge(undefined);
    expect(stub.posts.some((post) => post.type === BIG_SCREEN_BRIDGE_READY)).toBe(true);
  });
});

describe("bridge message envelope", () => {
  it("accepts only well-formed requests", () => {
    expect(isBigScreenBridgeRequest({ type: BIG_SCREEN_BRIDGE_REQUEST, requestId: "1" })).toBe(true);
    expect(isBigScreenBridgeRequest({ type: BIG_SCREEN_BRIDGE_REQUEST })).toBe(false);
    expect(isBigScreenBridgeRequest({ type: BIG_SCREEN_BRIDGE_RESPONSE, requestId: "1" })).toBe(false);
    expect(isBigScreenBridgeRequest(null)).toBe(false);
    expect(isBigScreenBridgeRequest("datafoundry:bigscreen:request")).toBe(false);
  });

  it("carries the patch on success and the reason on failure", () => {
    expect(buildBigScreenBridgeMessage("r1", { ok: true, payload: { kpi: { passRate: 86 } } })).toEqual({
      type: BIG_SCREEN_BRIDGE_RESPONSE,
      requestId: "r1",
      ok: true,
      payload: { kpi: { passRate: 86 } },
    });
    expect(buildBigScreenBridgeMessage("r2", { ok: false, error: "boom" })).toEqual({
      type: BIG_SCREEN_BRIDGE_RESPONSE,
      requestId: "r2",
      ok: false,
      error: "boom",
    });
  });
});

describe("embed url", () => {
  it("appends the embed marker without dropping an existing query", () => {
    expect(withEmbedParam("bigscreen/home/index.html", "abc")).toBe(
      "bigscreen/home/index.html?embed=1&nonce=abc",
    );
    expect(withEmbedParam("bigscreen/home/index.html?v=2", "abc")).toBe(
      "bigscreen/home/index.html?v=2&embed=1&nonce=abc",
    );
  });

  it("encodes a nonce that would otherwise break the url", () => {
    expect(withEmbedParam("a.html", "a&b=c")).toContain("nonce=a%26b%3Dc");
  });
});
