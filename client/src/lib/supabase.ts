/*
  Supabase is used for ONE thing only: sign-in for company admins (email + password, token refresh).

  All fleet data, photos and reports go through the Cloudflare Worker API (see ./api.ts), which reads
  D1 and R2 behind the Cloudflare edge cache. Nothing here queries tables, Storage or Edge Functions,
  so Supabase database/storage egress stays at zero. The publishable key below is public by design.
*/
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? "https://esbsguetydiqmaectoyu.supabase.co";
const supabaseAnonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ?? "sb_publishable_yQC3oOVE6IwXnexhTkQSXQ_5ZEC4BOi";

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null;

// A driver picks their company once (via an access code) and stays scoped to it on this device.
const COMPANY_STORAGE_KEY = "field-ledger-company";
export type StoredCompany = { code: string; companyId: string; companyName: string };

export function getStoredCompany(): StoredCompany | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(COMPANY_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredCompany) : null;
  } catch {
    return null;
  }
}

export function setStoredCompany(company: StoredCompany | null) {
  if (typeof window === "undefined") return;
  if (company) window.localStorage.setItem(COMPANY_STORAGE_KEY, JSON.stringify(company));
  else window.localStorage.removeItem(COMPANY_STORAGE_KEY);
}
