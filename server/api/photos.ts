import type { Env } from "../_core/worker-env";
import { HttpError, withHeaders, type ApiContext } from "./http";

/** Signed links are valid for 6-12 hours and stay identical within a 6 hour bucket, so browsers and the CDN can cache them. */
const BUCKET_SECONDS = 6 * 3600;

async function hmacKey(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(`rovaya-photo-v1:${env.JWT_SECRET}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

const toHex = (buffer: ArrayBuffer) => Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (hex: string) => new Uint8Array((hex.match(/.{1,2}/g) ?? []).map((byte) => parseInt(byte, 16)));

export async function signPhotoPath(env: Env, key: string): Promise<string> {
  const exp = (Math.floor(Date.now() / 1000 / BUCKET_SECONDS) + 2) * BUCKET_SECONDS;
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(env), new TextEncoder().encode(`${key}.${exp}`));
  const path = key.split("/").map(encodeURIComponent).join("/");
  return `/api/v1/photo/${path}?e=${exp}&s=${toHex(signature)}`;
}

/** Streams a photo from R2 after checking its signature. The edge cache is keyed on the path only. */
export async function handlePhoto({ request, env, ctx, url }: ApiContext): Promise<Response> {
  const key = decodeURIComponent(url.pathname.replace("/api/v1/photo/", ""));
  const exp = Number(url.searchParams.get("e"));
  const sig = url.searchParams.get("s") ?? "";
  if (!key.startsWith("inspections/") || !Number.isFinite(exp) || exp < Date.now() / 1000 || !/^[0-9a-f]{64}$/.test(sig)) {
    throw new HttpError(403, "This photo link is invalid or has expired.");
  }
  const valid = await crypto.subtle.verify("HMAC", await hmacKey(env), fromHex(sig), new TextEncoder().encode(`${key}.${exp}`));
  if (!valid) throw new HttpError(403, "This photo link is invalid or has expired.");

  const cache = (caches as unknown as { default: Cache }).default;
  const cacheKey = new Request(`${url.origin}${url.pathname}`, { method: "GET" });
  const cors = { "access-control-allow-origin": "*" };
  const hit = await cache.match(cacheKey);
  if (hit) return withHeaders(hit, { ...cors, "x-cache": "HIT" });

  const object = await env.R2_BUCKET.get(key);
  if (!object) throw new HttpError(404, "Photo not found.");
  const response = new Response(object.body as unknown as BodyInit, {
    headers: {
      "content-type": object.httpMetadata?.contentType ?? "image/jpeg",
      "cache-control": "public, max-age=86400",
      etag: object.httpEtag,
    },
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return withHeaders(response, { ...cors, "x-cache": "MISS" });
}

/** Drop the cached copy of a deleted photo from this edge location. */
export async function evictPhoto(origin: string, key: string): Promise<void> {
  const cache = (caches as unknown as { default: Cache }).default;
  const path = key.split("/").map(encodeURIComponent).join("/");
  await cache.delete(new Request(`${origin}/api/v1/photo/${path}`, { method: "GET" }));
}
