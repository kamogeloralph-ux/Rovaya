import type { D1Database, KVNamespace, R2Bucket } from "@cloudflare/workers-types";

/**
 * Cloudflare Worker environment bindings.
 *
 * Kept in its own file with no other imports on purpose: worker-context.ts
 * needs this type for the shared tRPC context (which client/src/lib/trpc.ts
 * needs for AppRouter), and previously imported it from src/worker.ts.
 * That pulled the *entire* src/worker.ts file — including its import of
 * worker-storage-proxy.ts and dynamic import of worker-oauth.ts, both of
 * which use Cloudflare-specific Headers/ReadableStream/Response types — into
 * the client-only type-check, causing unrelated compile errors there.
 */
export interface Env {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  /** Optional. Only needed if the Supabase project still signs tokens with the legacy HS256 secret. */
  SUPABASE_JWT_SECRET?: string;
  DATABASE_URL: string;
  JWT_SECRET: string;
  OAUTH_SERVER_URL: string;
  OWNER_OPEN_ID: string;
  /** Cloudflare D1: the system of record for all fleet data (no Supabase data reads or writes). */
  DB: D1Database;
  R2_BUCKET: R2Bucket;
  KV_CACHE: KVNamespace;
  ENVIRONMENT: "production" | "development";
}
