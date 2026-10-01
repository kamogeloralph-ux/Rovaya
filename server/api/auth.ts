import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JSONWebKeySet } from "jose";
import type { Env } from "../_core/worker-env";
import { HttpError } from "./http";

export type AdminProfile = {
  id: string;
  auth_user_id: string;
  employee_number: string | null;
  full_name: string;
  phone: string | null;
  role: "admin" | "super_admin";
  company_id: string | null;
  active: boolean;
};

function bearer(request: Request): string | null {
  const value = request.headers.get("authorization") ?? "";
  return value.startsWith("Bearer ") ? value.slice(7) : null;
}

const JWKS_TTL_SECONDS = 3600;

/** The Supabase signing keys are fetched at most once an hour per edge location, then verified locally. */
async function loadJwks(env: Env, forceRefresh = false): Promise<JSONWebKeySet> {
  const url = `${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`;
  const cache = (caches as unknown as { default: Cache }).default;
  const key = new Request(url);
  if (!forceRefresh) {
    const hit = await cache.match(key);
    if (hit) return (await hit.json()) as JSONWebKeySet;
  }
  const fresh = await fetch(url, { headers: { apikey: env.SUPABASE_ANON_KEY } });
  if (!fresh.ok) throw new HttpError(503, "The sign-in service is temporarily unavailable.");
  const body = await fresh.text();
  await cache.put(key, new Response(body, { headers: { "content-type": "application/json", "cache-control": `public, max-age=${JWKS_TTL_SECONDS}` } }));
  return JSON.parse(body) as JSONWebKeySet;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Fallback for projects that still sign tokens with the legacy shared secret and no secret is configured here. */
async function verifyViaAuthServer(token: string, env: Env): Promise<string> {
  const cacheKey = `jwt:${await sha256Hex(token)}`;
  const cached = await env.KV_CACHE.get(cacheKey);
  if (cached) return cached;
  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new HttpError(401, "Your session is no longer valid. Please sign in again.");
  const user = (await response.json()) as { id?: string };
  if (!user.id) throw new HttpError(401, "Unable to identify the signed-in user.");
  await env.KV_CACHE.put(cacheKey, user.id, { expirationTtl: 300 });
  return user.id;
}

/** Verifies a Supabase access token and returns the auth user id (the `sub` claim). */
export async function verifyAccessToken(token: string, env: Env): Promise<string> {
  const issuer = `${env.SUPABASE_URL}/auth/v1`;
  try {
    const header = decodeProtectedHeader(token);
    if (header.alg === "HS256") {
      if (!env.SUPABASE_JWT_SECRET) return await verifyViaAuthServer(token, env);
      const { payload } = await jwtVerify(token, new TextEncoder().encode(env.SUPABASE_JWT_SECRET), { issuer, audience: "authenticated" });
      if (!payload.sub) throw new Error("missing sub");
      return payload.sub;
    }
    const verifyWith = async (refresh: boolean) => {
      const jwks = createLocalJWKSet(await loadJwks(env, refresh));
      return jwtVerify(token, jwks, { issuer, audience: "authenticated" });
    };
    try {
      const { payload } = await verifyWith(false);
      if (!payload.sub) throw new Error("missing sub");
      return payload.sub;
    } catch (error) {
      // A key rotation makes the cached key set stale: refresh once and retry.
      if ((error as { code?: string }).code !== "ERR_JWKS_NO_MATCHING_KEY") throw error;
      const { payload } = await verifyWith(true);
      if (!payload.sub) throw new Error("missing sub");
      return payload.sub;
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(401, "Your session is no longer valid. Please sign in again.");
  }
}

/** Authenticates the caller and loads their admin profile from D1. */
export async function requireAdmin(request: Request, env: Env): Promise<AdminProfile> {
  const token = bearer(request);
  if (!token) throw new HttpError(401, "Authentication required.");
  const userId = await verifyAccessToken(token, env);
  const row = await env.DB.prepare(
    "SELECT id, auth_user_id, employee_number, full_name, phone, role, company_id, active FROM drivers WHERE auth_user_id = ?"
  )
    .bind(userId)
    .first<Omit<AdminProfile, "active"> & { active: number }>();
  if (!row || !row.active) throw new HttpError(403, "Your account is not linked to an active fleet profile.");
  if (row.role !== "admin" && row.role !== "super_admin") throw new HttpError(403, "Administrator permission required.");
  return { ...row, active: true };
}

/** Super admins may act on any company; company admins only on their own. */
export function scopedCompanyId(profile: AdminProfile, requested: string | null | undefined): string {
  if (profile.role === "super_admin") {
    if (!requested) throw new HttpError(400, "companyId is required.");
    return requested;
  }
  if (!profile.company_id) throw new HttpError(403, "Your account is not linked to a company.");
  if (requested && requested !== profile.company_id) throw new HttpError(403, "That company is outside your account.");
  return profile.company_id;
}
