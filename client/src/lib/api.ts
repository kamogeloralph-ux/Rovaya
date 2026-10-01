/*
  Client for the Rovaya Worker API (Cloudflare Worker + D1 + R2, fronted by the edge cache).
  Drivers call the public /driver/* routes with their company code; admins call /admin/* with their
  Supabase access token, which the Worker verifies locally (no Supabase round trip).
*/
import { supabase, type StoredCompany } from "./supabase";

export const API_BASE = (
  (import.meta.env.VITE_API_URL as string | undefined) ??
  (import.meta.env.VITE_R2_API_URL as string | undefined) ??
  "https://rovaya-api.kamogeloralph.workers.dev"
).replace(/\/$/, "") + "/api/v1";

export class ApiError extends Error {
  constructor(message: string, public status: number, public retryable = false) {
    super(message);
  }
}

type Options = { method?: string; body?: unknown; auth?: boolean; raw?: { body: Blob | File; contentType: string } };

async function accessToken(): Promise<string> {
  if (!supabase) throw new ApiError("Sign-in is not configured.", 401);
  const { data, error } = await supabase.auth.getSession(); // reads local storage; refreshes only when expired
  if (error || !data.session?.access_token) throw new ApiError("Your admin session has expired. Please sign in again.", 401);
  return data.session.access_token;
}

export async function api<T = unknown>(path: string, options: Options = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.auth) headers.authorization = `Bearer ${await accessToken()}`;
  let body: BodyInit | undefined;
  if (options.raw) { headers["content-type"] = options.raw.contentType; body = options.raw.body; }
  else if (options.body !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(options.body); }
  const response = await fetch(`${API_BASE}${path}`, { method: options.method ?? "GET", headers, body }); // network failure -> TypeError (retryable)
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError((payload as { error?: string }).error || `Request failed (${response.status}).`, response.status, Boolean((payload as { retryable?: boolean }).retryable));
  return payload as T;
}

export const adminApi = {
  get: <T = unknown>(path: string) => api<T>(`/admin/${path}`, { auth: true }),
  post: <T = unknown>(path: string, body: unknown) => api<T>(`/admin/${path}`, { method: "POST", body, auth: true }),
  patch: <T = unknown>(path: string, body: unknown) => api<T>(`/admin/${path}`, { method: "PATCH", body, auth: true }),
  delete: <T = unknown>(path: string) => api<T>(`/admin/${path}`, { method: "DELETE", auth: true }),
};

// ---- driver workflow -------------------------------------------------------------------
export type DriverBootstrap = {
  company: StoredCompany;
  trucks: { fleet_number: string; registration: string }[];
  checklist: { templateId: string | null; items: { id: string; section_number: string; section_title: string; prompt: string; sort_order: number; required: boolean }[] };
};

const BOOTSTRAP_CACHE_PREFIX = "field-ledger-bootstrap:";

/**
 * One request returns company, fleet list and checklist. It is cached by the Cloudflare edge and the
 * service worker; if the device is offline the last copy stored on the phone is used.
 */
export async function fetchBootstrap(code: string): Promise<DriverBootstrap> {
  const trimmed = code.trim();
  try {
    const data = await api<DriverBootstrap>(`/driver/bootstrap?code=${encodeURIComponent(trimmed)}`);
    try { window.localStorage.setItem(BOOTSTRAP_CACHE_PREFIX + trimmed, JSON.stringify(data)); } catch { /* storage full or blocked */ }
    return data;
  } catch (error) {
    if (!(error instanceof ApiError) || error.status >= 500) {
      try {
        const stored = window.localStorage.getItem(BOOTSTRAP_CACHE_PREFIX + trimmed);
        if (stored) return JSON.parse(stored) as DriverBootstrap;
      } catch { /* fall through */ }
    }
    throw error;
  }
}

export async function resolveCompanyCode(code: string): Promise<{ data: StoredCompany | null; error: Error | null }> {
  const trimmed = code.trim();
  if (!trimmed) return { data: null, error: new Error("Enter your company access code.") };
  try {
    const bootstrap = await fetchBootstrap(trimmed);
    return { data: { ...bootstrap.company, code: trimmed }, error: null };
  } catch (error) {
    return { data: null, error: error instanceof Error ? error : new Error("Unable to check that access code.") };
  }
}

export async function uploadDriverPhoto(file: File, inspectionId: string, photoType: string, code: string): Promise<{ objectKey: string }> {
  const contentType = file.type || "image/jpeg";
  return api<{ objectKey: string }>(
    `/driver/photo?inspectionId=${encodeURIComponent(inspectionId)}&photoType=${encodeURIComponent(photoType)}&code=${encodeURIComponent(code)}`,
    { method: "POST", raw: { body: file, contentType } }
  );
}
