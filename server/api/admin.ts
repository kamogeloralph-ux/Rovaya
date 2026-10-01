import type { Env } from "../_core/worker-env";
import { requireAdmin, scopedCompanyId, type AdminProfile } from "./auth";
import {
  HttpError,
  json,
  readJson,
  str,
  UUID_RE,
  type ApiContext,
} from "./http";
import { evictPhoto, signPhotoPath } from "./photos";

const TRUCK_STATUSES = ["ready", "inspection_due", "out_of_service"];
const DEFECT_STATUSES = ["open", "in_progress", "resolved", "waived"];

const placeholders = (n: number) =>
  Array.from({ length: n }, () => "?").join(",");
const nullable = (v: unknown, max = 200) => str(v, max) || null;
const dateOrNull = (v: unknown) => {
  const s = str(v, 10);
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s))
    throw new HttpError(400, "Dates must look like YYYY-MM-DD.");
  return s;
};

/** Runs a write and turns constraint failures into readable messages. */
async function guarded<T>(
  fn: () => Promise<T>,
  messages: { unique?: string; foreign?: string }
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (/UNIQUE constraint/i.test(text) && messages.unique)
      throw new HttpError(409, messages.unique);
    if (/FOREIGN KEY constraint/i.test(text) && messages.foreign)
      throw new HttpError(409, messages.foreign);
    throw error;
  }
}

async function ownsCompanyRow(
  env: Env,
  profile: AdminProfile,
  table: "trucks" | "drivers",
  id: string
): Promise<string> {
  const row = await env.DB.prepare(
    `SELECT company_id FROM ${table} WHERE id = ?`
  )
    .bind(id)
    .first<{ company_id: string | null }>();
  if (!row) throw new HttpError(404, "Record not found.");
  if (profile.role !== "super_admin" && row.company_id !== profile.company_id)
    throw new HttpError(403, "That record is outside your company.");
  return row.company_id ?? "";
}

export async function handleAdmin(
  { request, env, url }: ApiContext,
  segments: string[]
): Promise<Response> {
  const profile = await requireAdmin(request, env);
  const method = request.method;
  const [resource, id] = segments;
  const companyParam = url.searchParams.get("companyId");

  // ---- profile ----------------------------------------------------------------
  if (resource === "me" && method === "GET")
    return json(request, profile, 200, {
      "cache-control": "private, max-age=30",
    });

  // ---- companies --------------------------------------------------------------
  if (resource === "companies") {
    if (method === "GET" && !id) {
      const rows =
        profile.role === "super_admin"
          ? await env.DB.prepare(
              "SELECT id, name, active, photo_retention_days FROM companies ORDER BY name"
            ).all()
          : await env.DB.prepare(
              "SELECT id, name, active, photo_retention_days FROM companies WHERE id = ?"
            )
              .bind(profile.company_id)
              .all();
      return json(
        request,
        rows.results.map(r => ({ ...r, active: r.active === 1 }))
      );
    }
    if (method === "POST" && !id) {
      if (profile.role !== "super_admin")
        throw new HttpError(403, "Only a super admin can create companies.");
      const { name: rawName } = await readJson<{ name?: string }>(request);
      const name = str(rawName, 120);
      if (!name) throw new HttpError(400, "Company name is required.");
      const suffix = () => crypto.randomUUID().slice(0, 4);
      const slug = `${name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "")}-${suffix()}`;
      const code = `${name
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, "")
        .slice(0, 8)}-${suffix().toUpperCase()}`;
      const companyId = crypto.randomUUID();
      await guarded(
        () =>
          env.DB.batch([
            env.DB.prepare(
              "INSERT INTO companies (id, name, slug) VALUES (?, ?, ?)"
            ).bind(companyId, name, slug),
            env.DB.prepare(
              "INSERT INTO company_access_codes (id, company_id, code) VALUES (?, ?, ?)"
            ).bind(crypto.randomUUID(), companyId, code),
            env.DB.prepare(
              "INSERT INTO checklist_templates (id, company_id, version, title, active) VALUES (?, ?, 1, ?, 1)"
            ).bind(crypto.randomUUID(), companyId, `${name} checklist v1`),
          ]),
        { unique: "A company with that name already exists." }
      );
      return json(request, { id: companyId, name, code }, 201);
    }
    if (method === "PATCH" && id) {
      const companyId = scopedCompanyId(profile, id);
      const body = await readJson<{ photo_retention_days?: number | null }>(
        request
      );
      const days =
        body.photo_retention_days == null
          ? null
          : Math.round(Number(body.photo_retention_days));
      if (days !== null && (!Number.isFinite(days) || days < 1))
        throw new HttpError(
          400,
          "Enter a whole number of days, or leave blank to keep photos indefinitely."
        );
      await env.DB.prepare(
        "UPDATE companies SET photo_retention_days = ? WHERE id = ?"
      )
        .bind(days, companyId)
        .run();
      return json(request, { ok: true, photo_retention_days: days });
    }
  }

  // ---- trucks -----------------------------------------------------------------
  if (resource === "trucks") {
    if (method === "GET" && !id) {
      const companyId = scopedCompanyId(profile, companyParam);
      const rows = await env.DB.prepare(
        `SELECT id, fleet_number, registration, truck_type, model, size, status, license_disc_expiry, roadworthy_expiry, insurance_expiry, next_service_km
         FROM trucks WHERE company_id = ? ORDER BY fleet_number`
      )
        .bind(companyId)
        .all();
      return json(request, rows.results);
    }
    if (method === "POST" && !id) {
      const b = await readJson<Record<string, unknown>>(request);
      const companyId = scopedCompanyId(profile, str(b.companyId, 64) || null);
      const fleet = str(b.fleet_number, 20);
      const registration = str(b.registration, 20).toUpperCase();
      if (!fleet || !registration)
        throw new HttpError(400, "Fleet number and registration are required.");
      const status = str(b.status, 20) || "ready";
      if (!TRUCK_STATUSES.includes(status))
        throw new HttpError(400, "Invalid status.");
      const km =
        b.next_service_km === "" || b.next_service_km == null
          ? null
          : Number(b.next_service_km);
      if (km !== null && (!Number.isInteger(km) || km < 0))
        throw new HttpError(400, "Next service km must be a whole number.");
      const fields = [
        fleet,
        registration,
        nullable(b.truck_type),
        nullable(b.model),
        nullable(b.size),
        status,
        dateOrNull(b.license_disc_expiry),
        dateOrNull(b.roadworthy_expiry),
        dateOrNull(b.insurance_expiry),
        km,
      ];
      const existingId = str(b.id, 64);
      const unique = "That fleet number or registration already exists.";
      if (existingId) {
        await ownsCompanyRow(env, profile, "trucks", existingId);
        await guarded(
          () =>
            env.DB.prepare(
              `UPDATE trucks SET fleet_number=?, registration=?, truck_type=?, model=?, size=?, status=?, license_disc_expiry=?, roadworthy_expiry=?, insurance_expiry=?, next_service_km=?, updated_at=? WHERE id=?`
            )
              .bind(...fields, new Date().toISOString(), existingId)
              .run(),
          { unique }
        );
        return json(request, { ok: true, id: existingId });
      }
      const newId = crypto.randomUUID();
      await guarded(
        () =>
          env.DB.prepare(
            `INSERT INTO trucks (id, company_id, fleet_number, registration, truck_type, model, size, status, license_disc_expiry, roadworthy_expiry, insurance_expiry, next_service_km) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
            .bind(newId, companyId, ...fields)
            .run(),
        { unique }
      );
      return json(request, { ok: true, id: newId }, 201);
    }
    if (method === "DELETE" && id) {
      await ownsCompanyRow(env, profile, "trucks", id);
      await guarded(
        () => env.DB.prepare("DELETE FROM trucks WHERE id = ?").bind(id).run(),
        {
          foreign:
            "This vehicle has inspection history and can't be deleted. Set it to Out of service instead.",
        }
      );
      return json(request, { ok: true });
    }
  }

  // ---- admin accounts (public.drivers) ----------------------------------------
  if (resource === "drivers") {
    if (method === "GET" && !id) {
      const companyId = scopedCompanyId(profile, companyParam);
      const rows = await env.DB.prepare(
        "SELECT id, auth_user_id, employee_number, full_name, phone, role, company_id, active FROM drivers WHERE company_id = ? ORDER BY full_name"
      )
        .bind(companyId)
        .all();
      return json(
        request,
        rows.results.map(r => ({ ...r, active: r.active === 1 }))
      );
    }
    if (method === "POST" && !id) {
      const b = await readJson<Record<string, unknown>>(request);
      const companyId = scopedCompanyId(profile, str(b.companyId, 64) || null);
      const fullName = str(b.full_name, 200);
      if (!fullName) throw new HttpError(400, "Name is required.");
      const authUserId = nullable(b.auth_user_id, 64);
      if (authUserId && !UUID_RE.test(authUserId))
        throw new HttpError(
          400,
          "The auth user id must be a UUID from Supabase Authentication → Users."
        );
      const newId = crypto.randomUUID();
      await guarded(
        () =>
          env.DB.prepare(
            `INSERT INTO drivers (id, auth_user_id, employee_number, full_name, phone, role, active, company_id) VALUES (?, ?, ?, ?, ?, 'admin', 1, ?)`
          )
            .bind(
              newId,
              authUserId,
              nullable(b.employee_number, 50),
              fullName,
              nullable(b.phone, 40),
              companyId
            )
            .run(),
        {
          unique:
            "That login or employee number is already linked to an admin.",
        }
      );
      return json(request, { ok: true, id: newId }, 201);
    }
    if (method === "DELETE" && id) {
      await ownsCompanyRow(env, profile, "drivers", id);
      if (id === profile.id)
        throw new HttpError(400, "You can't remove your own admin access.");
      await guarded(
        () => env.DB.prepare("DELETE FROM drivers WHERE id = ?").bind(id).run(),
        {
          foreign:
            "This admin has activity on record and can't be deleted. Ask a super admin to deactivate it instead.",
        }
      );
      return json(request, { ok: true });
    }
  }

  // ---- daily report: inspections + answers + photos in one call --------------
  if (resource === "reports" && method === "GET") {
    const companyId = scopedCompanyId(profile, companyParam);
    const date = str(url.searchParams.get("date"), 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
      throw new HttpError(400, "date must look like YYYY-MM-DD.");
    const inspections = (
      await env.DB.prepare(
        `SELECT i.id, i.inspection_date, i.started_at, i.submitted_at, i.status, i.notes, i.driver_name, i.employee_number, i.opening_kilometers, i.shift,
              i.location_latitude, i.location_longitude, i.location_accuracy, i.location_captured_at,
              t.fleet_number AS t_fleet, t.registration AS t_reg, t.model AS t_model
       FROM daily_inspections i LEFT JOIN trucks t ON t.id = i.truck_id
       WHERE i.company_id = ? AND i.inspection_date = ? ORDER BY i.created_at DESC`
      )
        .bind(companyId, date)
        .all<Record<string, any>>()
    ).results;
    if (inspections.length === 0)
      return json(request, [], 200, { "cache-control": "no-store" });
    const ids = inspections.map(r => r.id);
    const [answers, photos] = await Promise.all([
      env.DB.prepare(
        `SELECT a.inspection_id, a.result, ci.prompt, ci.section_title, ci.sort_order
         FROM inspection_answers a LEFT JOIN checklist_items ci ON ci.id = a.checklist_item_id WHERE a.inspection_id IN (${placeholders(ids.length)})`
      )
        .bind(...ids)
        .all<Record<string, any>>(),
      env.DB.prepare(
        `SELECT id, inspection_id, photo_type, storage_path, captured_at FROM inspection_photos WHERE inspection_id IN (${placeholders(ids.length)}) ORDER BY captured_at`
      )
        .bind(...ids)
        .all<Record<string, any>>(),
    ]);
    const signedPhotos: Record<string, any>[] = await Promise.all(
      photos.results.map(async p => ({
        ...p,
        url: `${url.origin}${await signPhotoPath(env, p.storage_path)}`,
      }))
    );
    const rows = inspections.map(r => ({
      id: r.id,
      inspection_date: r.inspection_date,
      started_at: r.started_at,
      submitted_at: r.submitted_at,
      status: r.status,
      notes: r.notes,
      driver_name: r.driver_name,
      employee_number: r.employee_number,
      opening_kilometers: r.opening_kilometers,
      shift: r.shift,
      location:
        r.location_latitude != null && r.location_longitude != null
          ? {
              latitude: r.location_latitude,
              longitude: r.location_longitude,
              accuracy: r.location_accuracy,
              captured_at: r.location_captured_at,
            }
          : null,
      truck: r.t_fleet
        ? { fleet_number: r.t_fleet, registration: r.t_reg, model: r.t_model }
        : null,
      answers: answers.results
        .filter(a => a.inspection_id === r.id)
        .map(a => ({
          result: a.result,
          checklist_item: a.prompt
            ? {
                prompt: a.prompt,
                section_title: a.section_title,
                sort_order: a.sort_order,
              }
            : null,
        })),
      photos: signedPhotos
        .filter(p => p.inspection_id === r.id)
        .map(({ inspection_id: _omit, ...p }) => p),
    }));
    return json(request, rows, 200, { "cache-control": "no-store" });
  }

  // ---- defects ----------------------------------------------------------------
  if (resource === "defects") {
    if (method === "GET" && !id) {
      const companyId = scopedCompanyId(profile, companyParam);
      const rows = (
        await env.DB.prepare(
          `SELECT d.id, d.category, d.severity, d.title, d.description, d.status, d.created_at, d.resolved_at,
                i.inspection_date, i.driver_name, i.company_id, t.fleet_number, t.registration
         FROM defects d JOIN daily_inspections i ON i.id = d.inspection_id LEFT JOIN trucks t ON t.id = i.truck_id
         WHERE i.company_id = ? ORDER BY d.created_at DESC`
        )
          .bind(companyId)
          .all<Record<string, any>>()
      ).results;
      return json(
        request,
        rows.map(r => ({
          id: r.id,
          category: r.category,
          severity: r.severity,
          title: r.title,
          description: r.description,
          status: r.status,
          created_at: r.created_at,
          resolved_at: r.resolved_at,
          inspection: {
            inspection_date: r.inspection_date,
            driver_name: r.driver_name,
            company_id: r.company_id,
            truck: r.fleet_number
              ? { fleet_number: r.fleet_number, registration: r.registration }
              : null,
          },
        })),
        200,
        { "cache-control": "private, max-age=20" }
      );
    }
    if (method === "PATCH" && id) {
      const { status } = await readJson<{ status?: string }>(request);
      if (!status || !DEFECT_STATUSES.includes(status))
        throw new HttpError(400, "Invalid defect status.");
      const owner = await env.DB.prepare(
        "SELECT i.company_id FROM defects d JOIN daily_inspections i ON i.id = d.inspection_id WHERE d.id = ?"
      )
        .bind(id)
        .first<{ company_id: string }>();
      if (!owner) throw new HttpError(404, "Defect not found.");
      scopedCompanyId(profile, owner.company_id);
      const resolved = status === "resolved";
      await env.DB.prepare(
        "UPDATE defects SET status = ?, resolved_by = ?, resolved_at = ? WHERE id = ?"
      )
        .bind(
          status,
          resolved ? profile.id : null,
          resolved ? new Date().toISOString() : null,
          id
        )
        .run();
      return json(request, { ok: true });
    }
  }

  // ---- audit trail ------------------------------------------------------------
  if (resource === "audit") {
    if (method === "GET") {
      const companyId = scopedCompanyId(profile, companyParam);
      const rows = await env.DB.prepare(
        "SELECT id, entity_type, entity_id, action, metadata, created_at FROM audit_events WHERE company_id = ? ORDER BY created_at DESC LIMIT 100"
      )
        .bind(companyId)
        .all<Record<string, any>>();
      return json(
        request,
        rows.results.map(r => ({ ...r, metadata: safeParse(r.metadata) })),
        200,
        { "cache-control": "private, max-age=20" }
      );
    }
    if (method === "POST") {
      const b = await readJson<Record<string, unknown>>(request);
      const companyId = scopedCompanyId(profile, str(b.companyId, 64) || null);
      await env.DB.prepare(
        "INSERT INTO audit_events (id, company_id, actor_id, entity_type, entity_id, action, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
        .bind(
          crypto.randomUUID(),
          companyId,
          profile.id,
          str(b.entity_type, 40),
          str(b.entity_id, 500),
          str(b.action, 120),
          JSON.stringify(b.metadata ?? {}).slice(0, 4000)
        )
        .run();
      return json(request, { ok: true }, 201);
    }
  }

  // ---- evidence photo library -------------------------------------------------
  if (resource === "photos") {
    if (method === "GET") {
      const companyId = scopedCompanyId(profile, companyParam);
      const date = str(url.searchParams.get("date"), 10);
      const fleet = str(url.searchParams.get("fleet"), 20);
      const inspections = (
        await env.DB.prepare(
          `SELECT i.id, i.inspection_date, i.driver_name, t.fleet_number, t.registration FROM daily_inspections i LEFT JOIN trucks t ON t.id = i.truck_id
         WHERE i.company_id = ?1 AND (?2 = '' OR i.inspection_date = ?2) AND (?3 = '' OR t.fleet_number = ?3) ORDER BY i.inspection_date DESC LIMIT 300`
        )
          .bind(companyId, date, fleet)
          .all<Record<string, any>>()
      ).results;
      if (inspections.length === 0) return json(request, []);
      const ids = inspections.map(r => r.id);
      const photos = (
        await env.DB.prepare(
          `SELECT id, inspection_id, photo_type, storage_path, storage_provider, captured_at FROM inspection_photos WHERE inspection_id IN (${placeholders(ids.length)}) ORDER BY captured_at DESC`
        )
          .bind(...ids)
          .all<Record<string, any>>()
      ).results;
      const byId = new Map(inspections.map(r => [r.id, r]));
      return json(
        request,
        await Promise.all(
          photos.map(async p => {
            const insp = byId.get(p.inspection_id);
            return {
              ...p,
              url: `${url.origin}${await signPhotoPath(env, p.storage_path)}`,
              fleet_number: insp?.fleet_number || "Unknown",
              registration: insp?.registration || "",
              driver_name: insp?.driver_name || null,
              inspection_date: insp?.inspection_date || "",
            };
          })
        )
      );
    }
    if (method === "POST" && id === "delete") {
      const { ids } = await readJson<{ ids?: string[] }>(request);
      const list = (Array.isArray(ids) ? ids : [])
        .map(v => str(v, 64))
        .filter(Boolean)
        .slice(0, 100);
      if (list.length === 0) throw new HttpError(400, "No photos selected.");
      const rows = (
        await env.DB.prepare(
          `SELECT p.id, p.storage_path, i.company_id FROM inspection_photos p JOIN daily_inspections i ON i.id = p.inspection_id WHERE p.id IN (${placeholders(list.length)})`
        )
          .bind(...list)
          .all<{ id: string; storage_path: string; company_id: string }>()
      ).results;
      const allowed = rows.filter(
        r =>
          profile.role === "super_admin" || r.company_id === profile.company_id
      );
      if (allowed.length !== list.length)
        throw new HttpError(
          403,
          "Some of those photos are outside your company."
        );
      await env.R2_BUCKET.delete(allowed.map(r => r.storage_path));
      await env.DB.prepare(
        `DELETE FROM inspection_photos WHERE id IN (${placeholders(allowed.length)})`
      )
        .bind(...allowed.map(r => r.id))
        .run();
      await Promise.all(
        allowed.map(r => evictPhoto(url.origin, r.storage_path))
      );
      return json(request, { deleted: allowed.map(r => r.id) });
    }
  }

  throw new HttpError(404, "Not found.");
}

function safeParse(value: unknown): unknown {
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return {};
  }
}
