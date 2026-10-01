import { getStoredCompany } from "./supabase";
import { api, uploadDriverPhoto } from "./api";

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
function localDateString(date = new Date()) { const year = date.getFullYear(); const month = String(date.getMonth() + 1).padStart(2, "0"); const day = String(date.getDate()).padStart(2, "0"); return `${year}-${month}-${day}`; }
function readableError(error) { if (error instanceof Error) return error.message; if (error && typeof error === "object") { const message = error.message || error.details || error.hint; if (message) return String(message); } return "Unable to submit this inspection."; }
function retryableError(error) { if (typeof navigator !== "undefined" && !navigator.onLine) return true; const status = Number(error?.status || error?.statusCode || 0); if ([408, 429].includes(status) || status >= 500) return true; return error instanceof TypeError || /fetch|network|failed to fetch|timeout|temporar/i.test(readableError(error)); }
export function buildInspectionDraft({ inspectionId = null, inspectionDate = localDateString(), step, fullName, employeeNumber = "", selectedFleet, openingKilometers, shift, checks, itemNotes, notes, selfieFile, photoFiles, queued = false, syncStatus = null, syncAttempts = 0, lastSyncError = null, companyId = null, companyCode = null }) { return { inspectionId, inspectionDate, companyId, companyCode, step, fullName, employeeNumber, selectedFleet, openingKilometers, shift, checks, itemNotes, notes, selfieFile, photoFiles, queued, syncStatus: syncStatus || (queued ? SYNC_STATES.savedOnDevice : SYNC_STATES.draft), syncAttempts, lastSyncError, savedAt: new Date().toISOString() }; }
export async function getInspectionSyncState() { const draft = await loadInspectionDraft(); const meta = readSyncMeta(); return { state: draft?.syncStatus || meta.state || SYNC_STATES.draft, pending: Boolean(draft?.queued), attempts: draft?.syncAttempts || 0, lastError: draft?.lastSyncError || meta.lastError || null, lastSyncAt: meta.lastSyncAt || null }; }
async function updateQueuedDraft(patch) { const draft = await loadInspectionDraft(); if (!draft?.queued) return; await saveInspectionDraft({ ...draft, ...patch, savedAt: new Date().toISOString() }); }

async function submitOnline({ inspectionId: existingId, inspectionDate = localDateString(), fullName, employeeNumber = "", selectedFleet, openingKilometers, shift, checks, itemNotes, notes, selfieFile, photoFiles, companyId, companyCode }) {
  if (!fullName?.trim()) throw new Error("Full names and surnames are required.");
  if (!companyId || !companyCode) throw new Error("No company selected. Please enter your company access code again.");
  if (!(selfieFile instanceof File) || selfieFile.size === 0) throw new Error("The selfie image is missing. Please capture the selfie again.");
  // The inspection id is created once per draft and reused on every retry. The Worker's upload and submit
  // endpoints are both idempotent on it, so an interrupted attempt can never produce a duplicate record
  // or a second copy of the same photo.
  const inspectionId = existingId || crypto.randomUUID();
  // Upload every photo BEFORE submitting the inspection. A failed or interrupted upload throws here, before
  // any record exists, so a retry starts clean instead of leaving a "completed" inspection with missing evidence.
  const photos = [];
  const selfie = await uploadDriverPhoto(selfieFile, inspectionId, "selfie", companyCode);
  photos.push({ photoType: "selfie", objectKey: selfie.objectKey });
  for (const [photoType, file] of Object.entries(photoFiles ?? {})) {
    const upload = await uploadDriverPhoto(file, inspectionId, photoType, companyCode);
    photos.push({ photoType, objectKey: upload.objectKey });
  }
  // One request writes the inspection, answers, defects and photo records atomically (Cloudflare D1).
  await api("/driver/inspections", { method: "POST", body: { inspectionId, inspectionDate, code: companyCode, fullName: fullName.trim(), employeeNumber: employeeNumber?.trim() || "", fleetNumber: selectedFleet, openingKilometers: openingKilometers === "" || openingKilometers == null ? null : Number(openingKilometers), shift, checks, itemNotes, notes: notes?.trim() || "", photos } });
  return { queued: false, inspectionId };
}
export async function submitInspection({ allowQueue = true, ...input }) { const draft = { ...input, inspectionId: input.inspectionId || crypto.randomUUID(), inspectionDate: input.inspectionDate || localDateString() }; const queuedDraft = buildInspectionDraft({ ...draft, queued: true, syncStatus: SYNC_STATES.savedOnDevice }); const offline = typeof navigator !== "undefined" && !navigator.onLine; if (offline) { if (!allowQueue) throw new Error("The connection is still offline."); await saveInspectionDraft(queuedDraft); await registerBackgroundSync(); writeSyncMeta({ state: SYNC_STATES.savedOnDevice, pending: true, lastError: "Waiting for an internet connection." }); return { queued: true }; } try { writeSyncMeta({ state: SYNC_STATES.uploading, pending: true, lastError: null }); const result = await submitOnline(draft); writeSyncMeta({ state: SYNC_STATES.submitted, pending: false, lastSyncAt: new Date().toISOString(), lastError: null }); return result; } catch (error) { if (allowQueue && retryableError(error)) { const attempts = (draft.syncAttempts || 0) + 1; await saveInspectionDraft({ ...queuedDraft, syncAttempts: attempts, lastSyncError: readableError(error) }); await registerBackgroundSync(); writeSyncMeta({ state: SYNC_STATES.savedOnDevice, pending: true, lastError: readableError(error) }); return { queued: true }; } throw new Error(readableError(error)); } }
export async function syncQueuedInspection({ checklistSections }) { if (typeof navigator !== "undefined" && !navigator.onLine) return null; const draft = await loadInspectionDraft(); if (!draft?.queued) return null; const attempts = (draft.syncAttempts || 0) + 1; await updateQueuedDraft({ syncStatus: SYNC_STATES.uploading, syncAttempts: attempts, lastSyncError: null }); writeSyncMeta({ state: SYNC_STATES.uploading, pending: true, lastError: null }); try { await updateQueuedDraft({ syncStatus: SYNC_STATES.syncing }); writeSyncMeta({ state: SYNC_STATES.syncing, pending: true }); const storedCompany = getStoredCompany(); const result = await submitOnline({ ...draft, companyId: storedCompany?.companyId || draft.companyId, companyCode: storedCompany?.code || draft.companyCode, checklistSections }); writeSyncMeta({ state: SYNC_STATES.submitted, pending: false, lastSyncAt: new Date().toISOString(), lastError: null }); return { ...result, syncStatus: SYNC_STATES.submitted }; } catch (error) { const message = readableError(error); await updateQueuedDraft({ syncStatus: SYNC_STATES.failed, lastSyncError: message }); writeSyncMeta({ state: SYNC_STATES.failed, pending: true, lastError: message }); throw new Error(message); } }
