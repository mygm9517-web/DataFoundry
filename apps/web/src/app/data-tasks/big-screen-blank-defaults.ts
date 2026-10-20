/**
 * Empties an uploaded page's demo data while it runs on a live screen.
 *
 * An uploaded page ships a `DEFAULT_DATA` object so it can be opened on its own,
 * and those numbers are invented. On a screen, a field no SQL is bound to would
 * keep showing them forever — indistinguishable from real data. So when the
 * page is served for a screen, its `DEFAULT_DATA` literal is handed through a
 * function that keeps every key and drops every value: arrays become `[]`,
 * nested objects keep their shape, and every other leaf becomes `null`.
 *
 * The blanking happens at runtime, on the object the page itself built, rather
 * than by rewriting the literal's source. A hand-written page fills its demo
 * rows with calls like `genPdt(14)`, and only the evaluated value says that the
 * slot is an array — which is what decides between `[]` and `null`, and so
 * whether the page renders an empty table or skips the field and keeps its demo
 * rows. Keys survive, so a field bound later still lands where the page reads it.
 *
 * Kept free of React and the route so tests can exercise it directly.
 */

/** Page global the blanking function is installed under, ahead of the page's own scripts. */
export const BIG_SCREEN_BLANK_GLOBAL = "__DATAFOUNDRY_BLANK__";

/** Installs the blanking function. Must run before the page's own scripts. */
export function buildBlankDefaultsScript(): string {
  return `(function(){
  var blank = function(value){
    if (Array.isArray(value)) { return []; }
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      var out = {};
      Object.keys(value).forEach(function(key){ out[key] = blank(value[key]); });
      return out;
    }
    return null;
  };
  window[${JSON.stringify(BIG_SCREEN_BLANK_GLOBAL)}] = blank;
})();`;
}

/**
 * Wraps the page's `DEFAULT_DATA` object literal in the blanking function.
 *
 * Returns null when the page declares no `DEFAULT_DATA` or its literal cannot be
 * delimited safely; the caller then serves the page unchanged, because a guess
 * at where the literal ends would break the page outright.
 */
export function wrapDefaultData(html: string): string | null {
  const start = /(?:const|let|var)\s+DEFAULT_DATA\s*=\s*\{/u.exec(html);
  if (!start) return null;
  const open = start.index + start[0].length - 1;
  const close = matchObjectEnd(html, open);
  if (close < 0) return null;
  return (
    html.slice(0, open) +
    `window[${JSON.stringify(BIG_SCREEN_BLANK_GLOBAL)}](` +
    html.slice(open, close + 1) +
    ")" +
    html.slice(close + 1)
  );
}

/**
 * Index of the `}` closing the object literal opened at `open`, or -1.
 *
 * Strings and comments are stepped over, because a page's demo data is full of
 * both — Chinese labels, unit notes, a quoted example in a comment — and a brace
 * or quote inside either would otherwise throw the count off.
 */
function matchObjectEnd(source: string, open: number): number {
  let depth = 0;
  let index = open;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      const stop = source.indexOf("\n", index);
      if (stop < 0) return -1;
      index = stop + 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const stop = source.indexOf("*/", index + 2);
      if (stop < 0) return -1;
      index = stop + 2;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      const end = stringEnd(source, index);
      if (end < 0) return -1;
      index = end;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
    index += 1;
  }
  return -1;
}

/** Offset just past the string literal starting at `from`, or -1 if it never closes. */
function stringEnd(source: string, from: number): number {
  const quote = source[from];
  let index = from + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === quote) return index + 1;
    // A plain string cannot span lines; a stray quote in code that is not a
    // string would otherwise swallow the rest of the page.
    if (char === "\n" && quote !== "`") return -1;
    index += 1;
  }
  return -1;
}
