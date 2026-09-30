import { driverSupabase, getStoredCompany, uploadInspectionPhotoToR2 } from "./supabase";

const DRAFT_STORE = "field-ledger-inspection-drafts";
const DRAFT_KEY = "current";
const SYNC_META_KEY = "field-ledger-inspection-sync-meta";
export const SYNC_STATES = Object.freeze({ draft: "draft", savedOnDevice: "saved_on_device", uploading: "uploading", syncing: "syncing", submitted: "submitted", failed: "sync_failed" });

function browserStorage() { return typeof window !== "undefined" && window.localStorage ? window.localStorage : null; }
function readSyncMeta() { try { const raw = browserStorage()?.getItem(SYNC_META_KEY); return raw ? JSON.parse(raw) : {}; } catch { return {}; } }
function writeSyncMeta(meta) { browserStorage()?.setItem(SYNC_META_KEY, JSON.stringify({ ...readSyncMeta(), ...meta })); }
export async function registerBackgroundSync() { try { if (typeof navigator === "undefined" || !navigator.serviceWorker) return false; const registration = await navigator.serviceWorker.ready; if (!("sync" in registration)) return false; await registration.sync.register("rovaya-inspection-sync"); return true; } catch { return false; } }
function indexedDb() { return typeof window !== "undefined" && "indexedDB" in window ? window.indexedDB : null; }
function openDraftDb() { const factory = indexedDb(); if (!factory) return Promise.resolve(null); return new Promise((resolve, reject) => { const request = factory.open(DRAFT_STORE, 1); request.onupgradeneeded = () => request.result.createObjectStore("drafts"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error ?? new Error("Unable to open offline storage.")); }); }
// IndexedDB's structured-clone algorithm stores File/Blob objects natively — no base64 encoding
// needed. Re-encoding every already-captured photo to base64 on every autosave (the previous
// approach) got expensive fast as more photos were captured, which made the app prone to being
// killed by the OS for a busy main thread right as it returned from the camera — losing progress.
// Storing Files directly is both far cheaper and avoids the ~33% size bloat of base64.
async function putDraft(value) { const db = await openDraftDb().catch(() => null); if (db) { await new Promise((resolve, reject) => { const request = db.transaction("drafts", "readwrite").objectStore("drafts").put(value, DRAFT_KEY); request.onsuccess = resolve; request.onerror = () => reject(request.error ?? new Error("Unable to save offline inspection.")); }); db.close(); return true; } return false; }
// Only the localStorage fallback (used when IndexedDB is unavailable) needs base64, since
// localStorage can only hold strings.
function fileToDataUrl(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve({ name: file.name, type: file.type, lastModified: file.lastModified, dataUrl: reader.result }); reader.onerror = () => reject(reader.error ?? new Error("Unable to preserve captured image.")); reader.readAsDataURL(file); }); }
function dataUrlToFile(photo) { const [header, body] = String(photo.dataUrl).split(","); const mime = photo.type || header.match(/data:(.*?);/)?.[1] || "image/jpeg"; const binary = atob(body); const bytes = new Uint8Array(binary.length); for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i); return new File([bytes], photo.name || "inspection-photo.jpg", { type: mime, lastModified: photo.lastModified || Date.now() }); }
async function serializeForLocalStorage(draft) { const photos = await Promise.all(Object.entries(draft.photoFiles ?? {}).map(async ([id, file]) => [id, await fileToDataUrl(file)])); const selfieFile = draft.selfieFile ? await fileToDataUrl(draft.selfieFile) : null; return JSON.stringify({ ...draft, photoFiles: Object.fromEntries(photos), selfieFile }); }
function deserializeFromLocalStorage(raw) { if (!raw) return null; const parsed = JSON.parse(raw); return { ...parsed, selfieFile: parsed.selfieFile ? dataUrlToFile(parsed.selfieFile) : undefined, photoFiles: Object.fromEntries(Object.entries(parsed.photoFiles ?? {}).map(([id, photo]) => [id, dataUrlToFile(photo)])) }; }
export async function saveInspectionDraft(draft) {
  if (await putDraft(draft)) return;
  const storage = browserStorage();
  if (storage) storage.setItem(`${DRAFT_STORE}:${DRAFT_KEY}`, await serializeForLocalStorage(draft));
}
export async function loadInspectionDraft() {
  const db = await openDraftDb().catch(() => null);
  if (db) {
    const stored = await new Promise((resolve, reject) => { const request = db.transaction("drafts", "readonly").objectStore("drafts").get(DRAFT_KEY); request.onsuccess = () => resolve(request.result ?? null); request.onerror = () => reject(request.error); });
    db.close();
    // Older drafts saved before this change may still be base64 JSON strings — handle both.
    return typeof stored === "string" ? deserializeFromLocalStorage(stored) : stored;
  }
  return deserializeFromLocalStorage(browserStorage()?.getItem(`${DRAFT_STORE}:${DRAFT_KEY}`));
}
export async function clearInspectionDraft() { const db = await openDraftDb().catch(() => null); if (db) { await new Promise((resolve, reject) => { const request = db.transaction("drafts", "readwrite").objectStore("drafts").delete(DRAFT_KEY); request.onsuccess = resolve; request.onerror = () => reject(request.error); }); db.close(); } browserStorage()?.removeItem(`${DRAFT_STORE}:${DRAFT_KEY}`); }
export function flattenChecklistItems(sections) { return sections.flatMap((section) => section.items); }
function readableError(error) { if (error instanceof Error) return error.message; if (error && typeof error === "object") { const message = error.message || error.details || error.hint; if (message) return String(message); } return "Unable to submit this inspection."; }
function retryableError(error) { if (typeof navigator !== "undefined" && !navigator.onLine) return true; const status = Number(error?.status || error?.statusCode || 0); if ([408, 429].includes(status) || status >= 500) return true; return error instanceof TypeError || /fetch|network|failed to fetch|timeout|temporar/i.test(readableError(error)); }
export function buildInspectionDraft({ step, fullName, employeeNumber = "", selectedFleet, openingKilometers, shift, checks, itemNotes, notes, selfieFile, photoFiles, queued = false, syncStatus = null, syncAttempts = 0, lastSyncError = null, companyId = null, companyCode = null }) { return { companyId, companyCode, step, fullName, employeeNumber, selectedFleet, openingKilometers, shift, checks, itemNotes, notes, selfieFile, photoFiles, queued, syncStatus: syncStatus || (queued ? SYNC_STATES.savedOnDevice : SYNC_STATES.draft), syncAttempts, lastSyncError, savedAt: new Date().toISOString() }; }
export async function getInspectionSyncState() { const draft = await loadInspectionDraft(); const meta = readSyncMeta(); return { state: draft?.syncStatus || meta.state || SYNC_STATES.draft, pending: Boolean(draft?.queued), attempts: draft?.syncAttempts || 0, lastError: draft?.lastSyncError || meta.lastError || null, lastSyncAt: meta.lastSyncAt || null }; }
async function updateQueuedDraft(patch) { const draft = await loadInspectionDraft(); if (!draft?.queued) return; await saveInspectionDraft({ ...draft, ...patch, savedAt: new Date().toISOString() }); }

async function submitOnline({ fullName, employeeNumber = "", selectedFleet, openingKilometers, shift, checks, itemNotes, notes, selfieFile, photoFiles, companyId, companyCode }) {
  if (!driverSupabase) throw new Error("Supabase is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.");
  if (!fullName?.trim()) throw new Error("Full names and surnames are required.");
  if (!companyId || !companyCode) throw new Error("No company selected. Please enter your company access code again.");
  const { data: truck, error: truckError } = await driverSupabase.from("trucks").select("id, fleet_number").eq("fleet_number", selectedFleet).eq("company_id", companyId).maybeSingle();
  if (truckError) throw truckError;
  if (!truck) throw new Error("The selected fleet number was not found for this company.");
  const { data: template, error: templateError } = await driverSupabase.from("checklist_templates").select("id, version").eq("company_id", companyId).eq("active", true).order("version", { ascending: false }).limit(1).maybeSingle();
  if (templateError) throw templateError;
  if (!template) throw new Error("No active checklist template exists for this company.");
  const { data: dbItems, error: itemError } = await driverSupabase.from("checklist_items").select("id, sort_order, prompt").eq("template_id", template.id).order("sort_order");
  if (itemError) throw itemError;
  if (!dbItems || dbItems.length === 0) throw new Error("This company's checklist has no items configured.");
  if (dbItems.some((item) => checks[item.id] === undefined)) throw new Error("The checklist has changed since you started. Please refresh and try again.");
  if (!(selfieFile instanceof File) || selfieFile.size === 0) throw new Error("The selfie image is missing. Please capture the selfie again.");
  const inspectionDate = new Date().toISOString().slice(0, 10);
  const inspectionId = crypto.randomUUID();
  // Upload every photo BEFORE writing anything to the database. Previously the
  // daily_inspections row was inserted (status: "completed") first and photos were
  // uploaded afterward — so a failed or interrupted upload left a permanent
  // "completed" inspection record with missing evidence, since there was nothing to
  // roll it back. Uploading first means a failure here throws before any row exists,
  // so a retry (via the offline queue) starts clean instead of producing a duplicate,
  // partially-evidenced record. The remaining, much smaller risk — an upload
  // succeeding but a later DB write failing — only leaves unreferenced files in R2,
  // which is far safer than a false "completed" compliance record.
  const uploadedPhotos = [];
  const selfieUpload = await uploadInspectionPhotoToR2(selfieFile, inspectionId, "selfie", driverSupabase);
  if (selfieUpload.error) throw selfieUpload.error;
  uploadedPhotos.push({ inspection_id: inspectionId, photo_type: "selfie", storage_path: selfieUpload.data.storagePath, storage_provider: "r2", captured_at: new Date().toISOString() });
  for (const [photoType, file] of Object.entries(photoFiles ?? {})) {
    const upload = await uploadInspectionPhotoToR2(file, inspectionId, photoType, driverSupabase);
    if (upload.error) throw upload.error;
    uploadedPhotos.push({ inspection_id: inspectionId, photo_type: photoType, storage_path: upload.data.storagePath, storage_provider: "r2", captured_at: new Date().toISOString() });
  }
  const payload = { id: inspectionId, driver_id: null, driver_name: fullName.trim(), employee_number: employeeNumber?.trim() || null, truck_id: truck.id, opening_kilometers: openingKilometers === "" || openingKilometers == null ? null : Number(openingKilometers), shift, checklist_template_id: template.id, inspection_date: inspectionDate, started_at: new Date().toISOString(), submitted_at: new Date().toISOString(), status: "completed", notes: notes?.trim() || null, signature_name: fullName.trim(), company_id: companyId, company_access_code: companyCode };
  const { error: inspectionError } = await driverSupabase.from("daily_inspections").insert(payload);
  if (inspectionError) throw inspectionError;
  const answers = dbItems.map((item) => ({ inspection_id: inspectionId, checklist_item_id: item.id, result: checks[item.id] ? "pass" : "fail" }));
  const { error: answerError } = await driverSupabase.from("inspection_answers").insert(answers);
  if (answerError) throw answerError;
  const failedItems = dbItems.filter((item) => !checks[item.id]);
  if (failedItems.length > 0) {
    const defectRows = failedItems.map((item) => ({ inspection_id: inspectionId, category: "checklist", severity: "medium", title: item.prompt || "Failed checklist item", description: itemNotes?.[item.id]?.trim() || null, status: "open", reported_by: null }));
    const { error: defectError } = await driverSupabase.from("defects").insert(defectRows);
    if (defectError) throw defectError;
  }
  const { error: photosError } = await driverSupabase.from("inspection_photos").insert(uploadedPhotos);
  if (photosError) throw photosError;
  return { queued: false, inspectionId };
}
export async function submitInspection({ allowQueue = true, ...draft }) { const queuedDraft = buildInspectionDraft({ ...draft, queued: true, syncStatus: SYNC_STATES.savedOnDevice }); const offline = !driverSupabase || (typeof navigator !== "undefined" && !navigator.onLine); if (offline) { if (!allowQueue) throw new Error("The connection is still offline."); await saveInspectionDraft(queuedDraft); await registerBackgroundSync(); writeSyncMeta({ state: SYNC_STATES.savedOnDevice, pending: true, lastError: "Waiting for an internet connection." }); return { queued: true }; } try { writeSyncMeta({ state: SYNC_STATES.uploading, pending: true, lastError: null }); const result = await submitOnline(draft); writeSyncMeta({ state: SYNC_STATES.submitted, pending: false, lastSyncAt: new Date().toISOString(), lastError: null }); return result; } catch (error) { if (allowQueue && retryableError(error)) { const attempts = (draft.syncAttempts || 0) + 1; await saveInspectionDraft({ ...queuedDraft, syncAttempts: attempts, lastSyncError: readableError(error) }); await registerBackgroundSync(); writeSyncMeta({ state: SYNC_STATES.savedOnDevice, pending: true, lastError: readableError(error) }); return { queued: true }; } throw new Error(readableError(error)); } }
export async function syncQueuedInspection({ checklistSections }) { if (!driverSupabase || (typeof navigator !== "undefined" && !navigator.onLine)) return null; const draft = await loadInspectionDraft(); if (!draft?.queued) return null; const attempts = (draft.syncAttempts || 0) + 1; await updateQueuedDraft({ syncStatus: SYNC_STATES.uploading, syncAttempts: attempts, lastSyncError: null }); writeSyncMeta({ state: SYNC_STATES.uploading, pending: true, lastError: null }); try { await updateQueuedDraft({ syncStatus: SYNC_STATES.syncing }); writeSyncMeta({ state: SYNC_STATES.syncing, pending: true }); const storedCompany = getStoredCompany(); const result = await submitOnline({ ...draft, companyId: storedCompany?.companyId || draft.companyId, companyCode: storedCompany?.code || draft.companyCode, checklistSections }); writeSyncMeta({ state: SYNC_STATES.submitted, pending: false, lastSyncAt: new Date().toISOString(), lastError: null }); return { ...result, syncStatus: SYNC_STATES.submitted }; } catch (error) { const message = readableError(error); await updateQueuedDraft({ syncStatus: SYNC_STATES.failed, lastSyncError: message }); writeSyncMeta({ state: SYNC_STATES.failed, pending: true, lastError: message }); throw new Error(message); } }
