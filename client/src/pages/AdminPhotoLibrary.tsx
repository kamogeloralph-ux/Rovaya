import React, { useState } from "react";
import { Camera, CheckSquare, Clock, Loader2, Send, Square, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { adminApi } from "@/lib/api";

type FleetOption = { fleet_number: string; registration: string };
type CompanyInfo = { id: string; name: string; photo_retention_days: number | null };

type LibraryPhoto = {
  id: string;
  inspection_id: string;
  photo_type: string;
  storage_path: string;
  storage_provider?: string;
  captured_at: string;
  url?: string;
  fleet_number: string;
  registration: string;
  driver_name: string | null;
  inspection_date: string;
};

const PHOTO_LABELS: Record<string, string> = { selfie: "Driver selfie", front: "Front", rear: "Rear", left: "Left side", right: "Right side", cab: "Cab interior", dashboard: "Dashboard" };

export default function AdminPhotoLibrary({ selectedCompanyId, company, fleetOptions, onRetentionSaved, onAudit }: { selectedCompanyId: string | null; company: CompanyInfo | null; fleetOptions: FleetOption[]; onRetentionSaved: () => void | Promise<void>; onAudit?: (entityType: string, entityId: string, action: string, metadata?: Record<string, unknown>) => void | Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [fleet, setFleet] = useState("");
  const [date, setDate] = useState("");
  const [photos, setPhotos] = useState<LibraryPhoto[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [retentionInput, setRetentionInput] = useState(company?.photo_retention_days != null ? String(company.photo_retention_days) : "");
  const [savingRetention, setSavingRetention] = useState(false);

  // Keep the retention field in sync if the parent's company data refreshes (e.g. after save,
  // or after switching between companies as a super admin).
  React.useEffect(() => {
    setRetentionInput(company?.photo_retention_days != null ? String(company.photo_retention_days) : "");
  }, [company?.id, company?.photo_retention_days]);

  const search = async () => {
    if (!selectedCompanyId) return;
    setLoading(true); setSearched(true);
    try {
      // One request: the Worker finds matching inspections, their photos, and returns ready-to-use signed links
      // (served from R2 through the Cloudflare CDN cache, never from Supabase).
      const query = new URLSearchParams({ companyId: selectedCompanyId, date, fleet });
      const rows = await adminApi.get<LibraryPhoto[]>(`photos?${query.toString()}`);
      setPhotos(rows); setSelectedIds(new Set());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to load photos.");
    } finally {
      setLoading(false);
    }
  };

  const toggleSelected = (id: string) => setSelectedIds((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const allSelected = photos.length > 0 && selectedIds.size === photos.length;
  const toggleSelectAll = () => setSelectedIds(allSelected ? new Set() : new Set(photos.map((p) => p.id)));
  const selectedPhotos = photos.filter((p) => selectedIds.has(p.id));

  const deletePhotos = async (targets: LibraryPhoto[]) => {
    if (targets.length === 0) return;
    if (!window.confirm(`Delete ${targets.length} photo${targets.length === 1 ? "" : "s"}? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      await adminApi.post("photos/delete", { ids: targets.map((p) => p.id) });
      const deletedIds = new Set(targets.map((p) => p.id));
      await onAudit?.("photo", targets.map((p) => p.id).join(","), "deleted", { count: targets.length, fleet: targets[0]?.fleet_number });
      toast.success(`${targets.length} photo${targets.length === 1 ? "" : "s"} deleted.`);
      setPhotos((current) => current.filter((p) => !deletedIds.has(p.id)));
      setSelectedIds(new Set());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to delete selected photos.");
    } finally {
      setDeleting(false);
    }
  };

  // Tries the native share sheet first (WhatsApp, email, AirDrop, etc.) with the actual image
  // files attached — the closest thing to a one-tap "send to client". If the browser can't
  // share files (most desktop browsers), falls back to copying the signed links so the admin
  // can paste them into an email or message instead. Those links expire in 1 hour.
  const sendToClient = async (targets: LibraryPhoto[]) => {
    if (targets.length === 0) return toast.error("Select at least one photo to send.");
    setSending(true);
    try {
      const files = await Promise.all(targets.map(async (photo, index) => {
        if (!photo.url) throw new Error("missing-url");
        const response = await fetch(photo.url);
        const blob = await response.blob();
        const extension = photo.storage_path.split(".").pop() || "jpg";
        return new File([blob], `${photo.fleet_number}-${photo.photo_type}-${index + 1}.${extension}`, { type: blob.type || "image/jpeg" });
      }));
      if (navigator.share && navigator.canShare?.({ files })) {
        await navigator.share({ title: "Evidence photos", text: `${targets.length} evidence photo${targets.length === 1 ? "" : "s"} — fleet ${targets[0]?.fleet_number ?? ""}`, files });
        setSending(false);
        return;
      }
      throw new Error("share-unsupported");
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") { setSending(false); return; } // user cancelled the share sheet
      const links = targets.map((p) => p.url).filter(Boolean).join("\n");
      if (links && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(links);
        toast.success(`${targets.length} photo link${targets.length === 1 ? "" : "s"} copied — paste into an email or message. Links expire in 1 hour.`);
      } else if (links) {
        targets.forEach((p) => { if (p.url) window.open(p.url, "_blank"); });
      } else {
        toast.error("Unable to prepare these photos to send.");
      }
      setSending(false);
    }
  };

  const saveRetention = async () => {
    if (!selectedCompanyId) return;
    const trimmed = retentionInput.trim();
    let value: number | null = null;
    if (trimmed !== "") {
      const parsed = Math.round(Number(trimmed));
      if (!Number.isFinite(parsed) || parsed < 1) return toast.error("Enter a whole number of days, or leave blank to keep photos indefinitely.");
      value = parsed;
    }
    setSavingRetention(true);
    try { await adminApi.patch(`companies/${selectedCompanyId}`, { photo_retention_days: value }); }
    catch (error) { setSavingRetention(false); return toast.error(error instanceof Error ? error.message : "Unable to save the retention period."); }
    setSavingRetention(false);
    await onAudit?.("company", selectedCompanyId, "retention_changed", { photo_retention_days: value });
    toast.success(value ? `Evidence photos will auto-delete ${value} days after capture.` : "Automatic photo deletion turned off.");
    await onRetentionSaved();
  };

  return (
    <section className="paper-panel overflow-hidden rounded-2xl border border-[#d8d3c5]">
      <button type="button" onClick={() => setOpen((current) => !current)} className="flex w-full items-center justify-between gap-3 border-b border-[#dfd9ca] px-5 py-5 text-left">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#6a7769]">Storage</p>
          <h2 className="font-slab text-2xl font-bold">Evidence photos</h2>
          <p className="mt-1 text-xs text-[#718070]">Find photos by fleet and date, send them to a client, or delete old ones to free up space.</p>
        </div>
        <span className="shrink-0 text-xs font-bold uppercase tracking-[0.12em] text-[#e9682a]">{open ? "Close" : "Open"}</span>
      </button>

      {open && (
        <div className="p-5">
          <div className="flex flex-wrap items-end gap-2">
            <label className="block text-xs font-bold uppercase tracking-[0.12em] text-[#667466]">
              Fleet
              <select value={fleet} onChange={(e) => setFleet(e.target.value)} className="mt-2 h-10 w-[160px] rounded-xl border border-[#d4cfc1] bg-[#fffdf6] px-3 text-sm font-bold">
                <option value="">All fleets</option>
                {fleetOptions.map((f) => <option key={f.fleet_number} value={f.fleet_number}>{f.fleet_number} · {f.registration}</option>)}
              </select>
            </label>
            <label className="block text-xs font-bold uppercase tracking-[0.12em] text-[#667466]">
              Date
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="mt-2 h-10 w-[160px]" />
            </label>
            <Button type="button" onClick={() => void search()} disabled={loading} className="h-10 rounded-xl bg-[#2f4638] px-5 text-xs font-bold text-white disabled:opacity-60">
              {loading ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
              {loading ? "Searching…" : "Search photos"}
            </Button>
            {date === "" && fleet === "" && <span className="text-[11px] text-[#889286]">Leave both blank to browse everything (most recent 300 inspections).</span>}
          </div>

          {searched && !loading && (
            <div className="mt-5">
              {photos.length === 0 ? (
                <div className="rounded-xl border border-dashed border-[#d8d3c5] bg-[#f5f1e7] p-6 text-center text-sm text-[#7c887b]">No evidence photos match this fleet and date.</div>
              ) : (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-[#f4f0e5] px-3 py-2">
                    <button type="button" onClick={toggleSelectAll} className="inline-flex items-center gap-2 text-xs font-bold text-[#2e4335]">
                      {allSelected ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />}
                      {allSelected ? "Clear selection" : `Select all ${photos.length}`}
                    </button>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-[#4c5a4c]">{selectedIds.size} selected</span>
                      <Button type="button" variant="outline" disabled={selectedIds.size === 0 || sending} onClick={() => void sendToClient(selectedPhotos)} className="h-8 rounded-lg bg-[#fbf8ef] px-3 text-[11px] font-bold">
                        {sending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Send className="mr-1.5 h-3.5 w-3.5" />}
                        Send to client
                      </Button>
                      <Button type="button" variant="outline" disabled={selectedIds.size === 0 || deleting} onClick={() => void deletePhotos(selectedPhotos)} className="h-8 rounded-lg bg-[#fff1ec] px-3 text-[11px] font-bold text-[#a44b2d]">
                        {deleting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Trash2 className="mr-1.5 h-3.5 w-3.5" />}
                        Delete selected
                      </Button>
                    </div>
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                    {photos.map((photo) => {
                      const isSelected = selectedIds.has(photo.id);
                      return (
                        <div key={photo.id} className={cn("overflow-hidden rounded-xl border-2 bg-[#f5f1e7]", isSelected ? "border-[#e9682a]" : "border-[#d8d3c5]")}>
                          <button type="button" onClick={() => toggleSelected(photo.id)} className="relative block aspect-square w-full">
                            {photo.url ? <img src={photo.url} alt={`${photo.fleet_number} ${photo.photo_type}`} className="h-full w-full object-cover" /> : <div className="grid h-full place-items-center"><Camera className="h-5 w-5 text-[#889286]" /></div>}
                            <span className={cn("absolute right-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-md border text-white", isSelected ? "border-[#e9682a] bg-[#e9682a]" : "border-white/70 bg-black/30")}>{isSelected && <CheckSquare className="h-3.5 w-3.5" />}</span>
                          </button>
                          <div className="px-2 py-1.5">
                            <div className="truncate text-[10px] font-bold uppercase tracking-[0.06em] text-[#4c5a4c]">Fleet {photo.fleet_number} · {PHOTO_LABELS[photo.photo_type] ?? photo.photo_type}</div>
                            <div className="truncate text-[10px] text-[#889286]">{photo.inspection_date} {photo.driver_name ? `· ${photo.driver_name}` : ""}</div>
                            <button type="button" onClick={() => void deletePhotos([photo])} className="mt-1 text-[10px] font-bold uppercase tracking-[0.06em] text-[#a44b2d] hover:underline">Delete</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          )}

          <div className="mt-6 rounded-xl border border-[#d8d3c5] bg-[#f9f6ee] p-4">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-[#6a7769]"><Clock className="h-3.5 w-3.5" />Automatic cleanup</div>
            <p className="mt-1 text-xs leading-5 text-[#718070]">Automatically delete this company's evidence photos this many days after they're captured, to save storage space. Leave blank to keep photos indefinitely.</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Input type="number" min={1} value={retentionInput} onChange={(e) => setRetentionInput(e.target.value)} placeholder="e.g. 90" className="h-10 w-[140px]" />
              <span className="text-xs text-[#718070]">days</span>
              <Button type="button" onClick={() => void saveRetention()} disabled={savingRetention} className="h-10 rounded-xl bg-[#2f4638] px-5 text-xs font-bold text-white disabled:opacity-60">{savingRetention ? "Saving…" : "Save"}</Button>
            </div>
            <p className="mt-2 text-[11px] text-[#a2aa9f]">Enforced by a nightly Cloudflare job (03:00 SAST) that removes both the record and the stored file. Photos are kept 30 days when this is left blank.</p>
          </div>
        </div>
      )}
    </section>
  );
}
