import type { Env } from "../_core/worker-env";
import { edgeCached, HttpError, json, readJson, str, UUID_RE, type ApiContext } from "./http";

export const PHOTO_TYPES = ["selfie", "front", "rear", "left", "right", "cab", "dashboard"] as const;
const IMAGE_EXTENSIONS: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const MAX_OBJECTS_PER_INSPECTION = 16;
const SHIFTS = ["morning", "day", "night"];

type Company = { id: string; name: string };

export async function companyByCode(env: Env, code: string): Promise<Company | null> {
  if (!code) return null;
  return env.DB.prepare(
    `SELECT c.id, c.name FROM companies c JOIN company_access_codes cac ON cac.company_id = c.id
     WHERE cac.code = ? AND cac.active = 1 AND c.active = 1 LIMIT 1`
  )
    .bind(code)
    .first<Company>();
}

/**
 * One call gives a driver's device everything it needs: company, fleet list and checklist.
 * Cached at the Cloudflare edge for 5 minutes (and in the browser / service worker), so most
 * requests never reach D1 at all.
 */
export async function handleBootstrap({ request, env, ctx, url }: ApiContext): Promise<Response> {
  const code = str(url.searchParams.get("code"), 100);
  if (!code) throw new HttpError(400, "Enter your company access code.");
  return edgeCached(request, ctx, async () => {
    const company = await companyByCode(env, code);
    if (!company) return json(request, { error: "That access code was not recognized." }, 404);

    const [trucks, template] = await Promise.all([
      env.DB.prepare("SELECT fleet_number, registration FROM trucks WHERE company_id = ? ORDER BY fleet_number").bind(company.id).all<{ fleet_number: string; registration: string }>(),
      env.DB.prepare("SELECT id, version FROM checklist_templates WHERE company_id = ? AND active = 1 ORDER BY version DESC LIMIT 1").bind(company.id).first<{ id: string; version: number }>(),
    ]);
    const items = template
      ? await env.DB.prepare("SELECT id, section_number, section_title, prompt, sort_order, required FROM checklist_items WHERE template_id = ? ORDER BY sort_order")
          .bind(template.id)
          .all<{ id: string; section_number: string; section_title: string; prompt: string; sort_order: number; required: number }>()
      : { results: [] };

    const body = {
      company: { companyId: company.id, companyName: company.name, code },
      trucks: trucks.results,
      checklist: { templateId: template?.id ?? null, items: items.results.map((i) => ({ ...i, required: i.required === 1 })) },
    };
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json", "cache-control": "public, max-age=60, s-maxage=300, stale-while-revalidate=3600" },
    });
  });
}

/**
 * Raw image upload straight into R2 through the Worker binding (no presigned URLs, no Supabase function).
 * Idempotent: re-uploading the same photo slot for the same inspection returns the existing object.
 */
export async function handlePhotoUpload({ request, env, url }: ApiContext): Promise<Response> {
  const code = str(url.searchParams.get("code"), 100);
  const inspectionId = str(url.searchParams.get("inspectionId"), 64);
  const photoType = str(url.searchParams.get("photoType"), 32);
  if (!UUID_RE.test(inspectionId)) throw new HttpError(400, "inspectionId must be a valid UUID.");
  if (!(PHOTO_TYPES as readonly string[]).includes(photoType)) throw new HttpError(400, `photoType must be one of: ${PHOTO_TYPES.join(", ")}.`);
  const contentType = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const extension = IMAGE_EXTENSIONS[contentType];
  if (!extension) throw new HttpError(415, "Photos must be JPEG, PNG or WebP images.");
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_PHOTO_BYTES) throw new HttpError(413, "That photo is too large.");

  const company = await companyByCode(env, code);
  if (!company) throw new HttpError(403, "That access code was not recognized.");

  const existing = await env.R2_BUCKET.list({ prefix: `inspections/${inspectionId}/`, limit: 50 });
  const already = existing.objects.find((o) => o.key.startsWith(`inspections/${inspectionId}/${photoType}-`));
  if (already) return json(request, { objectKey: already.key, duplicate: true });
  if (existing.objects.length >= MAX_OBJECTS_PER_INSPECTION) throw new HttpError(429, "Too many photos for this inspection.");

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) throw new HttpError(400, "The photo was empty.");
  if (bytes.byteLength > MAX_PHOTO_BYTES) throw new HttpError(413, "That photo is too large.");

  const objectKey = `inspections/${inspectionId}/${photoType}-${crypto.randomUUID()}.${extension}`;
  await env.R2_BUCKET.put(objectKey, bytes, { httpMetadata: { contentType }, customMetadata: { companyId: company.id } });
  return json(request, { objectKey }, 201);
}

type SubmitBody = {
  inspectionId?: string;
  code?: string;
  fullName?: string;
  employeeNumber?: string;
  fleetNumber?: string;
  openingKilometers?: number | string | null;
  shift?: string;
  checks?: Record<string, boolean>;
  itemNotes?: Record<string, string>;
  notes?: string;
  photos?: { photoType?: string; objectKey?: string }[];
};

/**
 * Replaces six separate Supabase calls with one. Everything is written in a single atomic D1 batch,
 * and the call is idempotent on `inspectionId`, so the offline queue can retry safely.
 */
export async function handleSubmitInspection({ request, env }: ApiContext): Promise<Response> {
  const body = await readJson<SubmitBody>(request);
  const inspectionId = str(body.inspectionId, 64);
  const fullName = str(body.fullName, 200);
  if (!UUID_RE.test(inspectionId)) throw new HttpError(400, "inspectionId must be a valid UUID.");
  if (!fullName) throw new HttpError(400, "Full names and surnames are required.");
  const shift = str(body.shift, 20).toLowerCase();
  if (!SHIFTS.includes(shift)) throw new HttpError(400, "Choose a shift.");
  const km = body.openingKilometers === "" || body.openingKilometers == null ? null : Number(body.openingKilometers);
  if (km !== null && (!Number.isInteger(km) || km < 0)) throw new HttpError(400, "Opening kilometres must be a whole number.");

  const company = await companyByCode(env, str(body.code, 100));
  if (!company) throw new HttpError(403, "No company selected. Please enter your company access code again.");

  const existing = await env.DB.prepare("SELECT company_id FROM daily_inspections WHERE id = ?").bind(inspectionId).first<{ company_id: string }>();
  if (existing) {
    if (existing.company_id !== company.id) throw new HttpError(409, "This inspection id is already in use.");
    return json(request, { ok: true, inspectionId, duplicate: true });
  }

  const truck = await env.DB.prepare("SELECT id FROM trucks WHERE company_id = ? AND fleet_number = ?").bind(company.id, str(body.fleetNumber, 50)).first<{ id: string }>();
  if (!truck) throw new HttpError(404, "The selected fleet number was not found for this company.");

  const template = await env.DB.prepare("SELECT id FROM checklist_templates WHERE company_id = ? AND active = 1 ORDER BY version DESC LIMIT 1").bind(company.id).first<{ id: string }>();
  if (!template) throw new HttpError(409, "No active checklist template exists for this company.");
  const items = (await env.DB.prepare("SELECT id, prompt FROM checklist_items WHERE template_id = ? ORDER BY sort_order").bind(template.id).all<{ id: string; prompt: string }>()).results;
  if (items.length === 0) throw new HttpError(409, "This company's checklist has no items configured.");
  const checks = body.checks ?? {};
  if (items.some((item) => typeof checks[item.id] !== "boolean")) throw new HttpError(409, "The checklist has changed since you started. Please refresh and try again.");

  // Photos must already be in R2 under this inspection's own folder.
  const submitted = Array.isArray(body.photos) ? body.photos : [];
  const byType = new Map<string, string>();
  for (const photo of submitted) {
    const type = str(photo.photoType, 32);
    const key = str(photo.objectKey, 300);
    if (!(PHOTO_TYPES as readonly string[]).includes(type) || !key.startsWith(`inspections/${inspectionId}/${type}-`)) throw new HttpError(400, "A photo reference was invalid.");
    byType.set(type, key);
  }
  if (!byType.has("selfie")) throw new HttpError(400, "The selfie image is missing. Please capture the selfie again.");
  const heads = await Promise.all(Array.from(byType.values()).map((key) => env.R2_BUCKET.head(key)));
  if (heads.some((head) => !head)) throw new HttpError(409, "A photo did not finish uploading. Please try again.");

  const now = new Date().toISOString();
  const notes = str(body.notes, 2000) || null;
  const itemNotes = body.itemNotes ?? {};
  const failed = items.filter((item) => !checks[item.id]);

  const statements = [
    env.DB.prepare(
      `INSERT INTO daily_inspections (id, company_id, truck_id, driver_id, checklist_template_id, inspection_date, started_at, submitted_at,
         status, notes, signature_name, driver_name, employee_number, opening_kilometers, shift, company_access_code, created_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(inspectionId, company.id, truck.id, template.id, now.slice(0, 10), now, now, notes, fullName, fullName, str(body.employeeNumber, 100) || null, km, shift, str(body.code, 100), now),
    env.DB.prepare(
      `INSERT INTO inspection_answers (id, inspection_id, checklist_item_id, result, created_at)
       SELECT json_extract(value,'$[0]'), ?1, json_extract(value,'$[1]'), json_extract(value,'$[2]'), ?2 FROM json_each(?3)`
    ).bind(inspectionId, now, JSON.stringify(items.map((item) => [crypto.randomUUID(), item.id, checks[item.id] ? "pass" : "fail"]))),
    env.DB.prepare(
      `INSERT INTO inspection_photos (id, inspection_id, photo_type, storage_path, storage_provider, captured_at, created_at)
       SELECT json_extract(value,'$[0]'), ?1, json_extract(value,'$[1]'), json_extract(value,'$[2]'), 'r2', ?2, ?2 FROM json_each(?3)`
    ).bind(inspectionId, now, JSON.stringify(Array.from(byType.entries()).map(([type, key]) => [crypto.randomUUID(), type, key]))),
  ];
  if (failed.length > 0) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO defects (id, inspection_id, category, severity, title, description, status, created_at)
         SELECT json_extract(value,'$[0]'), ?1, 'checklist', 'medium', json_extract(value,'$[1]'), json_extract(value,'$[2]'), 'open', ?2 FROM json_each(?3)`
      ).bind(inspectionId, now, JSON.stringify(failed.map((item) => [crypto.randomUUID(), item.prompt || "Failed checklist item", str(itemNotes[item.id], 1000) || null])))
    );
  }
  await env.DB.batch(statements);
  return json(request, { ok: true, inspectionId }, 201);
}

