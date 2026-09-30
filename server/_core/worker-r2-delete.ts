import type { Env } from "./worker-env";

const ALLOWED_ORIGINS = [
  "https://rovaya.co.za",
  "https://www.rovaya.co.za",
  "https://rovaya.pages.dev",
];

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin") ?? "";
  return {
    "content-type": "application/json",
    "access-control-allow-origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "3600",
    vary: "Origin",
  };
}

function json(request: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders(request) });
}

function bearer(request: Request): string | null {
  const value = request.headers.get("authorization") ?? "";
  return value.startsWith("Bearer ") ? value.slice(7) : null;
}

async function supabaseRequest(env: Env, path: string, init: RequestInit = {}, serviceRole = false): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("apikey", serviceRole ? env.SUPABASE_SERVICE_ROLE_KEY : env.SUPABASE_ANON_KEY);
  if (serviceRole) headers.set("Authorization", `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`);
  return fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, { ...init, headers });
}

export async function handleR2PhotoDelete(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });
  if (request.method !== "POST") return json(request, { error: "Method not allowed" }, 405);

  const token = bearer(request);
  if (!token) return json(request, { error: "Authentication required" }, 401);

  let body: { photoId?: string; storagePath?: string };
  try {
    body = await request.json();
  } catch {
    return json(request, { error: "Invalid JSON body" }, 400);
  }
  const photoId = body.photoId?.trim();
  const storagePath = body.storagePath?.trim();
  if (!photoId || !storagePath || !/^inspections\/[A-Za-z0-9-]+\//.test(storagePath)) {
    return json(request, { error: "A valid R2 photo ID and storage path are required" }, 400);
  }

  const userResponse = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!userResponse.ok) return json(request, { error: "Your session is no longer valid" }, 401);
  const user = (await userResponse.json()) as { id?: string };
  if (!user.id) return json(request, { error: "Unable to identify the signed-in user" }, 401);

  const driverResponse = await supabaseRequest(
    env,
    `drivers?auth_user_id=eq.${encodeURIComponent(user.id)}&select=role,company_id,active`,
    {},
    true
  );
  const drivers = (await driverResponse.json()) as Array<{ role?: string; company_id?: string; active?: boolean }>;
  const driver = drivers[0];
  if (!driver?.active || !["admin", "super_admin"].includes(driver.role ?? "")) {
    return json(request, { error: "Administrator permission required" }, 403);
  }

  const photoResponse = await supabaseRequest(
    env,
    `inspection_photos?id=eq.${encodeURIComponent(photoId)}&select=storage_path,inspection_id,storage_provider`,
    {},
    true
  );
  const photos = (await photoResponse.json()) as Array<{ storage_path?: string; inspection_id?: string; storage_provider?: string }>;
  const photo = photos[0];
  if (!photo || photo.storage_path !== storagePath || photo.storage_provider !== "r2" || !photo.inspection_id) {
    return json(request, { error: "R2 photo not found" }, 404);
  }

  const inspectionResponse = await supabaseRequest(
    env,
    `daily_inspections?id=eq.${encodeURIComponent(photo.inspection_id)}&select=company_id`,
    {},
    true
  );
  const inspections = (await inspectionResponse.json()) as Array<{ company_id?: string }>;
  if (!inspections[0] || (driver.role !== "super_admin" && inspections[0].company_id !== driver.company_id)) {
    return json(request, { error: "Photo is outside your company" }, 403);
  }

  await env.R2_BUCKET.delete(storagePath);
  const deleteResponse = await supabaseRequest(
    env,
    `inspection_photos?id=eq.${encodeURIComponent(photoId)}`,
    { method: "DELETE", headers: { Prefer: "return=minimal" } },
    true
  );
  if (!deleteResponse.ok) {
    console.error("[R2Delete] Object deleted but database row removal failed", await deleteResponse.text());
    return json(request, { error: "The R2 object was deleted, but the photo record could not be removed" }, 502);
  }
  return json(request, { deleted: true, photoId });
}
