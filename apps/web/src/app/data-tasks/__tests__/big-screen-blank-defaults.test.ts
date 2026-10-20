import { describe, expect, it } from "vitest";
import {
  BIG_SCREEN_BLANK_GLOBAL,
  buildBlankDefaultsScript,
  wrapDefaultData,
} from "../big-screen-blank-defaults";

/** Runs a page script with the blanking function installed, returning DEFAULT_DATA. */
const evaluate = (html: string): unknown => {
  const wrapped = wrapDefaultData(html);
  if (wrapped === null) throw new Error("not wrapped");
  const script = wrapped.replace(/^[\s\S]*?<script>/u, "").replace(/<\/script>[\s\S]*$/u, "");
  const window: Record<string, unknown> = {};
  new Function("window", `${buildBlankDefaultsScript()}\n${script}\nwindow.result = DEFAULT_DATA;`)(window);
  return window.result;
};

describe("wrapDefaultData", () => {
  it("keeps every key and drops every value", () => {
    const result = evaluate(`<script>
      function gen(n){ var out=[]; for(var i=0;i<n;i++) out.push({ a:i }); return out; }
      var DEFAULT_DATA = {
        kpi: { inspected: 1286, rate: 98.5, note: 'x' },
        pdt: gen(14),
        defect: [{ name: '外观}缺陷', value: 20 }],
        monthly: { x: ['01', '02'], passRate: [98.9] },
        done: true,
      };
    </script>`);

    // Arrays empty (a page renders an empty table), scalars null (the page
    // shows its own blank marker), and every nested key still present so a
    // field bound later lands where the page reads it.
    expect(result).toEqual({
      kpi: { inspected: null, rate: null, note: null },
      pdt: [],
      defect: [],
      monthly: { x: [], passRate: [] },
      done: null,
    });
  });

  it("is not fooled by braces and quotes inside strings and comments", () => {
    const result = evaluate(`<script>
      const DEFAULT_DATA = {
        // a comment with a brace } and a quote '
        /* and a block { comment */
        label: "a } b",
        tpl: \`c { d\`,
        list: [1, 2],
      };
    </script>`);

    expect(result).toEqual({ label: null, tpl: null, list: [] });
  });

  it("leaves a page without DEFAULT_DATA untouched", () => {
    expect(wrapDefaultData("<script>var DATA = { a: 1 };</script>")).toBeNull();
  });

  it("refuses to guess where an unterminated literal ends", () => {
    expect(wrapDefaultData("<script>var DEFAULT_DATA = { a: 'open\n };</script>")).toBeNull();
  });

  it("names the global the bridge installs", () => {
    expect(buildBlankDefaultsScript()).toContain(BIG_SCREEN_BLANK_GLOBAL);
  });
});
