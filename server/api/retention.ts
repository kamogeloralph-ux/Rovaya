import type { Env } from "../_core/worker-env";

const DEFAULT_RETENTION_DAYS = 30;
const ORPHAN_GRACE_MS = 3 * 24 * 3600 * 1000;
const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(",");

/**
 * Nightly job (Cloudflare Cron Trigger) that replaces the two Supabase pg_cron jobs.
 * Unlike those, it deletes the R2 objects too, so storage no longer fills up with orphaned files.
 *  1. Delete photos older than the company's retention setting (30 days when unset).
 *  2. Sweep R2 objects that no database row points to (failed or abandoned uploads), after a 3 day grace period.
 */
export async function runRetention(env: Env): Promise<{ expired: number; orphans: number }> {
  let expired = 0;
  for (let round = 0; round < 10; round++) {
    const rows = (await env.DB.prepare(
      `SELECT p.id, p.storage_path FROM inspection_photos p
       JOIN daily_inspections i ON i.id = p.inspection_id JOIN companies c ON c.id = i.company_id
       WHERE p.captured_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || COALESCE(c.photo_retention_days, ${DEFAULT_RETENTION_DAYS}) || ' days')
       LIMIT 100`
    ).all<{ id: string; storage_path: string }>()).results;
    if (rows.length === 0) break;
    await env.R2_BUCKET.delete(rows.map((r) => r.storage_path));
    await env.DB.prepare(`DELETE FROM inspection_photos WHERE id IN (${placeholders(rows.length)})`).bind(...rows.map((r) => r.id)).run();
    expired += rows.length;
  }

  // Orphan sweep: look at one page of the bucket per run, remembering where we stopped.
  let orphans = 0;
  const cursor = (await env.KV_CACHE.get("retention:cursor")) ?? undefined;
  const page = await env.R2_BUCKET.list({ prefix: "inspections/", limit: 200, cursor });
  const old = page.objects.filter((o) => Date.now() - new Date(o.uploaded).getTime() > ORPHAN_GRACE_MS);
  if (old.length > 0) {
    const known = new Set<string>();
    for (let i = 0; i < old.length; i += 50) {
      const chunk = old.slice(i, i + 50).map((o) => o.key);
      const found = await env.DB.prepare(`SELECT storage_path FROM inspection_photos WHERE storage_path IN (${placeholders(chunk.length)})`).bind(...chunk).all<{ storage_path: string }>();
      found.results.forEach((r) => known.add(r.storage_path));
    }
    const doomed = old.filter((o) => !known.has(o.key)).map((o) => o.key);
    if (doomed.length > 0) await env.R2_BUCKET.delete(doomed);
    orphans = doomed.length;
  }
  if (page.truncated && page.cursor) await env.KV_CACHE.put("retention:cursor", page.cursor);
  else await env.KV_CACHE.delete("retention:cursor");
  return { expired, orphans };
}
