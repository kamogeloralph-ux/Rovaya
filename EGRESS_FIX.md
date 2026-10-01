# Cloudflare-first data path (zero Supabase egress)

```
Phone / admin browser
   -> Cloudflare Pages (static app, CDN)
   -> Cloudflare Worker  /api/v1/*   <- edge cache in front of everything below
        |-- D1  (rovaya-d1)  all fleet data
        |-- R2               photos (served through the CDN cache with signed links)
        '-- Supabase Auth    sign-in only (token issue/refresh, ~1 KB)
```

Supabase tables, Storage and Edge Functions are no longer called by the app.

## What changed
| Before | After |
| --- | --- |
| Driver app queried `trucks`, `checklist_*` and the company code on every session | One cached `GET /driver/bootstrap` (edge 5 min + browser + service worker + offline copy) |
| Submit = 6 Supabase writes | One idempotent `POST /driver/inspections` -> single atomic D1 batch |
| Photo upload via Supabase Edge Function + presigned R2 URL | `POST /driver/photo` straight into R2, idempotent per photo slot |
| Admin loaded nested joins and signed every photo on every load | `GET /admin/reports` -> one query set; signed photo links are stable for 6h so the CDN/browser cache them |
| Nightly pg_cron deleted photo rows but left the R2 files | Worker cron (03:00 SAST) deletes rows **and** files, plus an orphan sweep |
| Worker verified admin tokens by calling Supabase | Tokens verified locally with Supabase's public signing keys (fetched at most hourly) |

## Deploy
1. Merge to `main` (Pages + Worker deploy automatically). `rovaya-d1` is already created, migrated and loaded.
2. Optional Worker secret `SUPABASE_JWT_SECRET`: only if admin login fails with 401 and the project still uses a legacy HS256 secret.
3. After deploy, run a final delta sync of any inspections submitted during the cutover window.
4. In Supabase, disable the `purge-expired-inspection-photos` and `cleanup-30-day-photo-metadata` cron jobs.

## D1 free-tier limits are per ACCOUNT
Row-write (100K/day) and row-read (5M/day) allowances are shared by every D1 database on the account. If another project exhausts them, writes fail until 00:00 UTC. The Worker returns a retryable 503 in that case and the driver app keeps the inspection on the phone and retries automatically.
