import type { Env } from "../_core/worker-env";

/** Error with an HTTP status that the router turns into a JSON response. */
export class HttpError extends Error {
  constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

const STATIC_ORIGINS = [
  "https://rovaya.co.za",
  "https://www.rovaya.co.za",
  "https://rovaya.pages.dev",
  "https://kamogeloralph-ux.github.io",
];
const ORIGIN_PATTERNS = [/^https:\/\/[a-z0-9-]+\.rovaya\.pages\.dev$/, /^http:\/\/localhost:\d+$/];

export function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  return STATIC_ORIGINS.includes(origin) || ORIGIN_PATTERNS.some((p) => p.test(origin));
}

export function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  const headers: Record<string, string> = {
    "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
  if (origin && isAllowedOrigin(origin)) headers["access-control-allow-origin"] = origin;
  return headers;
}

/** Returns a copy of `response` with extra headers (responses from the cache are immutable). */
export function withHeaders(response: Response, extra: Record<string, string>): Response {
  const copy = new Response(response.body, response);
  for (const [k, v] of Object.entries(extra)) copy.headers.set(k, v);
  return copy;
}

export function json(request: Request, body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...corsHeaders(request), ...extra },
  });
}

export async function readJson<T = Record<string, unknown>>(request: Request): Promise<T> {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object") throw new Error("not an object");
    return body as T;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function str(value: unknown, max = 500): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** True when D1 refused the query because the Workers Free daily row limit was hit. */
export function isD1LimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /exceeded D1's|free tier daily row/i.test(message);
}

/** Turns any thrown value into a JSON response. Limit errors become a retryable 503 so the app queues the work on the device. */
export function errorResponse(request: Request, error: unknown): Response {
  if (error instanceof HttpError) return json(request, { error: error.message, ...error.extra }, error.status);
  if (isD1LimitError(error)) {
    return json(
      request,
      { error: "The service is busy right now. Your work is saved on this device and will sync automatically.", retryable: true },
      503,
      { "retry-after": "900" }
    );
  }
  console.error("[api] unhandled error", error);
  return json(request, { error: "Something went wrong on the server." }, 500);
}

/**
 * Serve GET responses from the Cloudflare edge cache. `produce` must return a response WITHOUT cors headers
 * (they depend on the caller's origin); they are added on the way out.
 */
export async function edgeCached(
  request: Request,
  ctx: ExecutionContext,
  produce: () => Promise<Response>
): Promise<Response> {
  const cache = (caches as unknown as { default: Cache }).default;
  const key = new Request(request.url, { method: "GET" });
  const hit = await cache.match(key);
  if (hit) return withHeaders(hit, { ...corsHeaders(request), "x-cache": "HIT" });
  const fresh = await produce();
  if (fresh.status === 200) ctx.waitUntil(cache.put(key, fresh.clone()));
  return withHeaders(fresh, { ...corsHeaders(request), "x-cache": "MISS" });
}

export type ApiContext = { request: Request; env: Env; ctx: ExecutionContext; url: URL };

export type ExecutionContext = { waitUntil(promise: Promise<unknown>): void; passThroughOnException?(): void };
