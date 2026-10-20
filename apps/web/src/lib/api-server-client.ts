import { getApiProxyTarget } from "./api-proxy";

/**
 * Server-to-server calls to the API from a Next route handler.
 *
 * Route handlers run in the web process, which holds the session cookie the
 * browser sent but no other way to identify the user; the API resolves identity
 * from that cookie alone. So the caller's own `cookie` header is forwarded
 * verbatim rather than reconstructed, and the CSRF token travels with it, which
 * is what makes a mutating request acceptable to the API's own checks.
 *
 * This is deliberately not `proxyToApi`: that helper streams a request body
 * straight through to the API, which cannot work for a route that has to
 * inspect the bytes before deciding whether they are allowed.
 */

/** Origin of the API, with the trailing slash trimmed. */
export function apiOrigin(): string {
  return getApiProxyTarget();
}

export type ApiFetchResult = {
  ok: boolean;
  status: number;
  json: unknown;
};

/**
 * Calls the API with the caller's own credentials.
 *
 * Returns the parsed envelope instead of throwing on a non-2xx, because every
 * caller here has to render the API's error code to the operator — a thrown
 * error would flatten the specific reason into a generic failure.
 */
export async function callApi(
  request: Request,
  pathname: string,
  init: { method?: string; body?: BodyInit; contentType?: string } = {},
): Promise<ApiFetchResult> {
  const headers = new Headers();
  const cookie = request.headers.get("cookie");
  if (cookie) headers.set("cookie", cookie);
  const csrf = request.headers.get("x-csrf-token");
  if (csrf) headers.set("x-csrf-token", csrf);
  if (init.contentType) headers.set("content-type", init.contentType);

  const response = await fetch(`${apiOrigin()}${pathname}`, {
    method: init.method ?? "GET",
    headers,
    ...(init.body === undefined ? {} : { body: init.body }),
    cache: "no-store",
  });

  let json: unknown = undefined;
  const text = await response.text();
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }
  return { ok: response.ok, status: response.status, json };
}

/** The `data` field of a successful envelope, or undefined when there is none. */
export function envelopeData<T>(result: ApiFetchResult): T | undefined {
  const body = result.json;
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  return record.success === true ? (record.data as T) : undefined;
}

/** The API's error code, when it reported one. */
export function envelopeError(result: ApiFetchResult): string | undefined {
  const body = result.json;
  if (!body || typeof body !== "object") return undefined;
  const error = (body as Record<string, unknown>).error;
  if (!error || typeof error !== "object") return undefined;
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * The API's raw error message, when it reported one.
 *
 * The message is the only place the API puts the specific reason for failures it
 * has no code for — its code set is closed and shared with clients that switch on
 * it. Callers that need one of those reasons recover it here and translate it into
 * a code of their own; the text itself is not for display.
 */
export function envelopeMessage(result: ApiFetchResult): string | undefined {
  const body = result.json;
  if (!body || typeof body !== "object") return undefined;
  const error = (body as Record<string, unknown>).error;
  if (!error || typeof error !== "object") return undefined;
  const message = (error as Record<string, unknown>).message;
  return typeof message === "string" ? message : undefined;
}
