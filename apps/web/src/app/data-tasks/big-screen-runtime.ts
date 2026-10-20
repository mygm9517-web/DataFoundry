/**
 * Runtime for a rendered big screen.
 *
 * A template is a self-contained page: it holds its own `DEFAULT_DATA` +
 * `mergeData`, then `fetch`es its data file on boot. The host installs the
 * bridge below before that inline script parses, so the one request the
 * template makes is answered with the live payload instead — no template edit,
 * and no direct API access from inside the frame.
 */

export const BIG_SCREEN_BRIDGE_REQUEST = "datafoundry:bigscreen:request";
export const BIG_SCREEN_BRIDGE_RESPONSE = "datafoundry:bigscreen:response";
/** Frames post this once the bridge is live, so the host can push the first payload. */
export const BIG_SCREEN_BRIDGE_READY = "datafoundry:bigscreen:ready";
/**
 * Host-pushed payload for bound templates. Unsolicited — it carries no request id,
 * because nothing is parked behind it; the frame applies it through its page global.
 */
export const BIG_SCREEN_BRIDGE_PAYLOAD = "datafoundry:bigscreen:payload";

export type BigScreenBridgeRequest = {
  type: typeof BIG_SCREEN_BRIDGE_REQUEST;
  requestId: string;
  /** File the template asked for; lets one bridge serve templates with different data files. */
  url: string;
};

export type BigScreenBridgeResponse = {
  type: typeof BIG_SCREEN_BRIDGE_RESPONSE;
  requestId: string;
  ok: boolean;
  payload?: Record<string, unknown>;
  error?: string;
};

/**
 * How a template that never `fetch`es its data file takes a payload.
 *
 * The two bundled screens that were authored as self-contained prototypes keep
 * their data in a module-scope object and expose a global setter instead of
 * loading JSON. Overriding `fetch` does nothing for them, so the bridge needs a
 * second delivery path: wait for the global the page publishes, then hand the
 * payload to it. `stop` is called before the first payload so the page's own
 * demo jitter loop — which would otherwise race the live numbers and win — is
 * switched off the moment real data arrives.
 */
export type BigScreenBridgeBinding = {
  /** Global the page publishes, e.g. `FQC`. */
  global: string;
  /** Method on it that accepts the payload, e.g. `setData`. */
  call: string;
  /** Optional method to stop the page's built-in demo ticker. */
  stop?: string;
};

/** Narrows an incoming `message` event payload to a response addressed to us. */
export function isBigScreenBridgeRequest(value: unknown): value is BigScreenBridgeRequest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<BigScreenBridgeRequest>;
  return candidate.type === BIG_SCREEN_BRIDGE_REQUEST && typeof candidate.requestId === "string";
}

export function buildBigScreenBridgeMessage(
  requestId: string,
  result: { ok: true; payload: Record<string, unknown> } | { ok: false; error: string },
): BigScreenBridgeResponse {
  return result.ok
    ? { type: BIG_SCREEN_BRIDGE_RESPONSE, requestId, ok: true, payload: result.payload }
    : { type: BIG_SCREEN_BRIDGE_RESPONSE, requestId, ok: false, error: result.error };
}

/**
 * Injected ahead of the template's own scripts so it wins the `fetch` binding
 * the template resolves at parse time. Requests that are not the data file fall
 * through to the real `fetch`, so anything else the page loads behaves
 * normally. A stalled host falls back to the static file rather than blanking
 * the screen.
 *
 * With `binding` the payload is delivered through the page's own global setter
 * instead, for templates that carry a data object rather than a data file.
 * Either way the host answers exactly one question: what is the data now.
 *
 * `quiet` is for a page served with its demo data emptied: the page's own demo
 * tickers are switched off as soon as it boots, rather than on the first live
 * payload, so an unbound field stays empty instead of filling with demo rows.
 */
export function buildBigScreenBridgeScript(
  dataFile: string,
  timeoutMs = 15000,
  binding?: BigScreenBridgeBinding,
  options: { quiet?: boolean } = {},
): string {
  return `(function(){
  var DATA_FILE = ${JSON.stringify(dataFile)};
  var QUIET = ${JSON.stringify(Boolean(options.quiet))};
  var REQUEST = ${JSON.stringify(BIG_SCREEN_BRIDGE_REQUEST)};
  var RESPONSE = ${JSON.stringify(BIG_SCREEN_BRIDGE_RESPONSE)};
  var READY = ${JSON.stringify(BIG_SCREEN_BRIDGE_READY)};
  var PAYLOAD = ${JSON.stringify(BIG_SCREEN_BRIDGE_PAYLOAD)};
  var TIMEOUT = ${JSON.stringify(timeoutMs)};
  var BINDING = ${JSON.stringify(binding ?? null)};
  var pending = {};
  var seq = 0;
  var bound = false;
  var stopped = false;
  var lastPayload = null;
  var bindTimer = null;
  var bindTries = 0;
  var silence = function(target){
    if (stopped) { return; }
    stopped = true;
    if (BINDING.stop && typeof target[BINDING.stop] === 'function') {
      try { target[BINDING.stop](); } catch (error) { /* page may not implement it */ }
      return;
    }
    // A page with no stop hook keeps running its own demo writers, and each tick
    // paints bundled numbers over the live ones until the next poll. Those
    // writers go through a silent sibling of the setter (IQC._applySilent beside
    // IQC.setData); making it a no-op means a demo tick can no longer overwrite
    // what the datasource returned.
    if (typeof target._applySilent === 'function') {
      target._applySilent = function(){ /* live data owns the screen now */ };
    }
  };
  var deliver = function(payload){
    if (!BINDING) { return; }
    var target = window[BINDING.global];
    if (!target || typeof target[BINDING.call] !== 'function') {
      // The page has not published its global yet — its own scripts (a large
      // chart library, say) are still loading. Hold the payload for the binding
      // loop: the host pushes only when the data changes and polls hourly at
      // most, so a push dropped here would leave the page on demo data.
      lastPayload = payload;
      if (!bindTimer) { bindTries = 0; awaitBinding(); }
      return;
    }
    silence(target);
    // Every payload is applied, not just the first. The host re-answers on each of
    // its polls, and dropping all but the first would pin the screen to whatever
    // arrived earliest. Pages with a binding are data-object templates whose own
    // file is only a seed, so re-applying is the intended behaviour.
    bound = true;
    if (bindTimer) { clearInterval(bindTimer); bindTimer = null; }
    try { target[BINDING.call](payload); } catch (error) { /* keep the last good frame */ }
  };
  var awaitBinding = function(){
    if (!BINDING) { return; }
    bindTimer = setInterval(function(){
      bindTries += 1;
      var target = window[BINDING.global];
      var ready = !!target && typeof target[BINDING.call] === 'function';
      // A page served with its demo data emptied must not refill it from its own
      // demo tickers either, so those are silenced as soon as the page is up —
      // not only once the first live payload arrives, which for a field no SQL
      // is bound to is never.
      if (ready && QUIET) { silence(target); }
      if (ready && lastPayload) { deliver(lastPayload); }
      // Up to 60s for the page to boot.
      if (bound || (QUIET && stopped && !lastPayload) || bindTries > 1200) { clearInterval(bindTimer); bindTimer = null; }
    }, 50);
  };
  window.addEventListener('message', function(event){
    var message = event.data;
    if (!message) { return; }
    if (message.type === PAYLOAD) { deliver(message.payload); return; }
    if (message.type !== RESPONSE || !message.requestId) { return; }
    var resolve = pending[message.requestId];
    if (!resolve) { return; }
    delete pending[message.requestId];
    resolve(new Response(JSON.stringify(message.payload || {}), {
      status: message.ok ? 200 : 502,
      headers: { 'Content-Type': 'application/json' }
    }));
  });
  var matches = function(url){
    // An empty data file means this page has no file to intercept — it either
    // carries its data object (binding) or is a static mock. Without this guard
    // the substring test below matches every request the page makes, hijacking
    // its own scripts and stylesheets into the payload channel.
    if (!DATA_FILE) { return false; }
    var value = String(url == null ? '' : url);
    return value === DATA_FILE || value.indexOf(DATA_FILE) !== -1;
  };
  var originalFetch = window.fetch ? window.fetch.bind(window) : null;
  var staticFallback = function(input, init){
    return originalFetch ? originalFetch(input, init) : new Response('{}', { status: 502 });
  };
  window.fetch = function(input, init){
    var url = (input && typeof input === 'object' && 'url' in input) ? input.url : input;
    if (!matches(url)) { return staticFallback(input, init); }
    return new Promise(function(resolve){
      var requestId = 'bs-' + (++seq);
      var respond = function(response){
        clearTimeout(timer);
        if (BINDING) {
          response.clone().json().then(function(payload){
            lastPayload = payload;
            // The binding loop picks this up and applies it through the page's
            // global; later updates arrive as host-pushed payloads.
          }).catch(function(){ /* non-JSON payload; the page keeps its own data */ });
        }
        resolve(response);
      };
      var timer = setTimeout(function(){
        delete pending[requestId];
        resolve(staticFallback(input, init));
      }, TIMEOUT);
      pending[requestId] = respond;
      try {
        window.parent.postMessage({ type: REQUEST, requestId: requestId, url: String(url) }, '*');
      } catch (error) {
        delete pending[requestId];
        resolve(staticFallback(input, init));
      }
    });
  };
  window.__DATAFOUNDRY_BIGSCREEN_BRIDGE__ = true;
  if (BINDING) { awaitBinding(); }
  try {
    window.parent.postMessage({ type: READY }, '*');
  } catch (error) { /* host may be gone; the static fallback still works */ }
})();`;
}

/** Appended as a query param so a template served in an iframe knows it is embedded. */
export function withEmbedParam(path: string, nonce: string): string {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}embed=1&nonce=${encodeURIComponent(nonce)}`;
}
