import type { Env } from "../_core/worker-env";
import { handleAdmin } from "./admin";
import { handleBootstrap, handlePhotoUpload, handleSubmitInspection } from "./driver";
import { corsHeaders, errorResponse, HttpError, json, type ApiContext, type ExecutionContext } from "./http";
import { handlePhoto } from "./photos";

/** Everything under /api/v1. Returns null for paths it does not own. */
export async function handleApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/v1/")) return null;
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });

  const api: ApiContext = { request, env, ctx, url };
  const path = url.pathname.slice("/api/v1/".length).replace(/\/+$/, "");
  try {
    if (path === "health") {
      const row = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
      return json(request, { ok: row?.ok === 1, time: new Date().toISOString() });
    }
    if (path.startsWith("photo/") && request.method === "GET") return await handlePhoto(api);
    if (path === "driver/bootstrap" && request.method === "GET") return await handleBootstrap(api);
    if (path === "driver/photo" && request.method === "POST") return await handlePhotoUpload(api);
    if (path === "driver/inspections" && request.method === "POST") return await handleSubmitInspection(api);
    if (path.startsWith("admin/")) return await handleAdmin(api, path.slice("admin/".length).split("/").map(decodeURIComponent));
    throw new HttpError(404, "Not found.");
  } catch (error) {
    return errorResponse(request, error);
  }
}
