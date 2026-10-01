import React, { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Building2,
  Camera,
  Car,
  ChevronDown,
  Download,
  History,
  RefreshCw,
  Save,
  Share2,
  ShieldCheck,
  Trash2,
  UserPlus,
  X,
} from "lucide-react";
import { jsPDF } from "jspdf";
import {
  Bar,
  BarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { adminApi } from "@/lib/api";
import { type FleetRole, useFleetAuth } from "@/contexts/FleetAuthContext";
import Login from "@/pages/Login";
import AdminPhotoLibrary from "@/pages/AdminPhotoLibrary";

type AdminTruck = {
  id: string;
  fleet_number: string;
  registration: string;
  truck_type: string | null;
  model: string | null;
  size: string | null;
  status: "ready" | "inspection_due" | "out_of_service";
  license_disc_expiry: string | null;
  roadworthy_expiry: string | null;
  insurance_expiry: string | null;
  next_service_km: number | null;
};

// Fleet numbers are always displayed/stored as NNN-NNNN (e.g. 744-0771).
function formatFleetNumber(value: string) {
  const digits = value.replace(/\D/g, "").slice(0, 7);
  return digits.length > 3
    ? `${digits.slice(0, 3)}-${digits.slice(3)}`
    : digits;
}
type AdminAccount = {
  id: string;
  auth_user_id: string | null;
  employee_number: string | null;
  full_name: string;
  phone: string | null;
  role: FleetRole;
  company_id: string | null;
  active: boolean;
};
type AdminCompany = {
  id: string;
  name: string;
  active: boolean;
  photo_retention_days: number | null;
};
type ReportRow = {
  id: string;
  inspection_date: string;
  started_at: string | null;
  submitted_at: string | null;
  status: string;
  notes: string | null;
  driver_name: string | null;
  employee_number: string | null;
  opening_kilometers: number | null;
  shift: "morning" | "day" | "night" | null;
  location: {
    latitude: number;
    longitude: number;
    accuracy: number | null;
    captured_at: string | null;
  } | null;
  truck: {
    fleet_number: string;
    registration: string;
    model: string | null;
  } | null;
  answers: {
    result: string;
    checklist_item: {
      prompt: string;
      section_title: string | null;
      sort_order: number | null;
    } | null;
  }[];
  photos: {
    id: string;
    photo_type: string;
    storage_path: string;
    captured_at: string;
    url?: string;
  }[];
};
type SelectedPhoto = {
  url?: string;
  photo_type: string;
  truck: string;
  driver: string;
  captured_at: string;
};
type AdminDefect = {
  id: string;
  category: string;
  severity: "low" | "medium" | "high" | "critical";
  title: string;
  description: string | null;
  status: "open" | "in_progress" | "resolved" | "waived";
  created_at: string;
  resolved_at: string | null;
  inspection: {
    inspection_date: string;
    driver_name: string | null;
    truck: { fleet_number: string; registration: string } | null;
  } | null;
};
type AuditEvent = {
  id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  metadata: Record<string, unknown>;
  created_at: string;
};

// The selfie identifies the driver; the six vehicle evidence photos follow the capture order.
const PHOTO_ORDER = [
  "selfie",
  "front",
  "left",
  "right",
  "cab",
  "dashboard",
  "rear",
] as const;
const PHOTO_LABELS: Record<string, string> = {
  selfie: "Driver selfie",
  front: "Front",
  rear: "Rear",
  left: "Left side",
  right: "Right side",
  cab: "Interior",
  dashboard: "Dashboard",
};
function localDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
function sortedPhotos(photos: ReportRow["photos"]) {
  return [...photos].sort(
    (a, b) =>
      PHOTO_ORDER.indexOf(a.photo_type as (typeof PHOTO_ORDER)[number]) -
      PHOTO_ORDER.indexOf(b.photo_type as (typeof PHOTO_ORDER)[number])
  );
}
function shiftLabel(shift: ReportRow["shift"]) {
  if (shift === "morning") return "Morning shift";
  if (shift === "day") return "Day shift";
  if (shift === "night") return "Night shift";
  return "No shift recorded";
}
function sortedAnswers(answers: ReportRow["answers"]) {
  return [...answers].sort(
    (a, b) =>
      (a.checklist_item?.sort_order ?? 0) - (b.checklist_item?.sort_order ?? 0)
  );
}
function expiryStatus(
  dateStr: string | null
): "expired" | "soon" | "ok" | null {
  if (!dateStr) return null;
  const days = (new Date(dateStr).getTime() - Date.now()) / 86400000;
  if (days < 0) return "expired";
  if (days <= 30) return "soon";
  return "ok";
}
function ExpiryBadge({ label, date }: { label: string; date: string | null }) {
  const status = expiryStatus(date);
  if (!status) return null;
  const colors =
    status === "expired"
      ? "bg-[#fce8e3] text-[#b0402a]"
      : status === "soon"
        ? "bg-[#fff0dc] text-[#a54d1f]"
        : "bg-[#e6f3ea] text-[#2f8b5e]";
  return (
    <span
      className={cn("rounded-full px-2 py-0.5 text-[10px] font-bold", colors)}
    >
      {label} {new Date(date as string).toLocaleDateString()}
    </span>
  );
}
// Loads the same logo file used elsewhere in the app (client/public/rovaya-wordmark-transparent.png) so the
// PDF report can embed it. Resolves to null (rather than throwing) if the image can't be
// loaded, so a missing/broken logo file never blocks report generation — the PDF just
// falls back to the text-only header.
function loadLogoImage(): Promise<HTMLImageElement | null> {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = `${import.meta.env.BASE_URL}rovaya-wordmark-transparent.png`;
  });
}

export function AdminGate({ children }: { children: React.ReactNode }) {
  const { loading, profile, signOut } = useFleetAuth();
  if (loading)
    return (
      <div className="grid min-h-screen place-items-center bg-[#ede9dd] text-[#2e4335]">
        Loading secure admin area…
      </div>
    );
  if (!profile) return <Login onSuccess={() => window.location.reload()} />;
  if (profile.role !== "admin" && profile.role !== "super_admin")
    return (
      <main className="grid min-h-screen place-items-center bg-[#ede9dd] p-6">
        <div className="max-w-md rounded-2xl border border-[#e1c4b7] bg-[#fff5f0] p-8 text-center">
          <ShieldCheck className="mx-auto h-10 w-10 text-[#b65323]" />
          <h1 className="mt-4 font-slab text-3xl font-bold text-[#2e4335]">
            Management access required
          </h1>
          <p className="mt-3 text-sm leading-6 text-[#6d7a6d]">
            This page is restricted to the admin role.
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              void signOut().finally(() =>
                window.location.replace(import.meta.env.BASE_URL)
              );
            }}
            className="mt-6 h-10 rounded-lg bg-[#fbf8ef] text-xs font-bold"
          >
            <ArrowLeft className="mr-2 h-3.5 w-3.5" />
            Back to sign in
          </Button>
        </div>
      </main>
    );
  return <>{children}</>;
}
export default function Admin() {
  return (
    <AdminGate>
      <AdminWorkspace />
    </AdminGate>
  );
}
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-xs font-bold uppercase tracking-[0.12em] text-[#667466]">
      {label}
      <div className="mt-2">{children}</div>
    </label>
  );
}
function toastSuccess(message: string) {
  window.dispatchEvent(
    new CustomEvent("field-ledger-toast", {
      detail: { type: "success", message },
    })
  );
}
function toastError(message: string) {
  window.dispatchEvent(
    new CustomEvent("field-ledger-toast", {
      detail: { type: "error", message },
    })
  );
}

function AdminWorkspace() {
  const { profile, signOut } = useFleetAuth();
  const isSuperAdmin = profile?.role === "super_admin";
  const [trucks, setTrucks] = useState<AdminTruck[]>([]);
  const [admins, setAdmins] = useState<AdminAccount[]>([]);
  const [reports, setReports] = useState<ReportRow[]>([]);
  const [companies, setCompanies] = useState<AdminCompany[]>([]);
  const [loading, setLoading] = useState(true);
  const [generatingPdf, setGeneratingPdf] = useState(false);
  const [generatingDefectsPdf, setGeneratingDefectsPdf] = useState(false);
  const [defects, setDefects] = useState<AdminDefect[]>([]);
  const [defectStatusFilter, setDefectStatusFilter] = useState<
    "open" | "in_progress" | "resolved" | "waived" | "all"
  >("open");
  const [openDefects, setOpenDefects] = useState(false);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [openAudit, setOpenAudit] = useState(false);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(
    () => (profile?.role === "admin" ? (profile.company_id ?? null) : null)
  );
  const [truckForm, setTruckForm] = useState({
    fleet_number: "",
    registration: "",
    truck_type: "",
    model: "",
    size: "",
    status: "ready" as AdminTruck["status"],
    license_disc_expiry: "",
    roadworthy_expiry: "",
    insurance_expiry: "",
    next_service_km: "",
  });
  const [adminForm, setAdminForm] = useState({
    auth_user_id: "",
    employee_number: "",
    full_name: "",
    phone: "",
  });
  const [companyForm, setCompanyForm] = useState({ name: "" });
  const [editingTruckId, setEditingTruckId] = useState<string | null>(null);
  const [fleetFilter, setFleetFilter] = useState("");
  const [openFleet, setOpenFleet] = useState(false);
  const [openAdmins, setOpenAdmins] = useState(false);
  const [openMissed, setOpenMissed] = useState(false);
  const [openCard, setOpenCard] = useState<
    "admin" | "truck" | "company" | null
  >(null);
  const [reportDate, setReportDate] = useState(() => localDateString());
  const [selectedPhoto, setSelectedPhoto] = useState<SelectedPhoto | null>(
    null
  );
  const [expandedReportIds, setExpandedReportIds] = useState<Set<string>>(
    new Set()
  );
  const initialReportLoadRef = useRef(true);
  const toggleReportRow = (id: string) =>
    setExpandedReportIds(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // All data comes from the Cloudflare Worker API (D1 + R2 behind the edge cache); Supabase is only used to sign in.
  const errMsg = (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback;
  const loadCompanies = async () => {
    try {
      const list = await adminApi.get<AdminCompany[]>("companies");
      setCompanies(list);
      setSelectedCompanyId(
        current =>
          current ??
          (isSuperAdmin ? (list[0]?.id ?? null) : (profile?.company_id ?? null))
      );
    } catch (error) {
      toastError(errMsg(error, "Unable to load companies."));
    }
  };

  const load = async () => {
    if (!selectedCompanyId) {
      setLoading(false);
      return;
    }
    // Keep the current report DOM mounted during background refreshes. Replacing it
    // with a loading row every 20 seconds made an open inspection appear to close.
    if (initialReportLoadRef.current) setLoading(true);
    const companyQuery = `companyId=${encodeURIComponent(selectedCompanyId)}`;
    const [truckResult, adminResult, reportResult] = await Promise.allSettled([
      adminApi.get<AdminTruck[]>(`trucks?${companyQuery}`),
      adminApi.get<AdminAccount[]>(`drivers?${companyQuery}`),
      adminApi.get<ReportRow[]>(`reports?${companyQuery}&date=${reportDate}`),
    ]);
    const failed = [truckResult, adminResult, reportResult].find(
      result => result.status === "rejected"
    ) as PromiseRejectedResult | undefined;
    if (failed) toastError(errMsg(failed.reason, "Unable to load admin data."));
    setTrucks(truckResult.status === "fulfilled" ? truckResult.value : []);
    setAdmins(adminResult.status === "fulfilled" ? adminResult.value : []);
    // Photo links arrive already signed by the Worker, so evidence sets stay grouped per inspection with no extra requests.
    if (reportResult.status === "fulfilled") {
      // Do not rewrite expandedReportIds here. The report list may refresh with
      // signed-photo or cache changes, but the user's open/closed choices are UI
      // state and must survive every background refresh.
      setReports(reportResult.value);
    }
    initialReportLoadRef.current = false;
    setLoading(false);
  };
  const logAudit = async (
    entityType: string,
    entityId: string,
    action: string,
    metadata: Record<string, unknown> = {}
  ) => {
    if (!profile?.id || !selectedCompanyId) return;
    try {
      await adminApi.post("audit", {
        companyId: selectedCompanyId,
        entity_type: entityType,
        entity_id: entityId,
        action,
        metadata,
      });
    } catch {
      /* the audit trail must never block the action itself */
    }
  };
  const loadDefects = async () => {
    if (!selectedCompanyId) return;
    try {
      setDefects(
        await adminApi.get<AdminDefect[]>(
          `defects?companyId=${encodeURIComponent(selectedCompanyId)}`
        )
      );
    } catch (error) {
      toastError(errMsg(error, "Unable to load defects."));
    }
  };
  const updateDefectStatus = async (
    defect: AdminDefect,
    status: AdminDefect["status"]
  ) => {
    try {
      await adminApi.patch(`defects/${defect.id}`, { status });
    } catch (error) {
      return toastError(errMsg(error, "Unable to update the defect."));
    }
    await logAudit("defect", defect.id, `status → ${status}`, {
      title: defect.title,
    });
    toastSuccess("Defect updated.");
    await loadDefects();
  };
  const loadAuditEvents = async () => {
    if (!selectedCompanyId) return;
    try {
      setAuditEvents(
        await adminApi.get<AuditEvent[]>(
          `audit?companyId=${encodeURIComponent(selectedCompanyId)}`
        )
      );
    } catch (error) {
      toastError(errMsg(error, "Unable to load the audit trail."));
    }
  };
  useEffect(() => {
    void loadCompanies();
  }, []);
  useEffect(() => {
    initialReportLoadRef.current = true;
    void load();
    void loadDefects();
    void loadAuditEvents();
    const refresh = window.setInterval(() => void load(), 20_000);
    return () => window.clearInterval(refresh);
  }, [reportDate, selectedCompanyId]);

  const createCompany = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = companyForm.name.trim();
    if (!name) return toastError("Company name is required.");
    try {
      const company = await adminApi.post<{
        id: string;
        name: string;
        code: string;
      }>("companies", { name });
      toastSuccess(`${name} created. Driver access code: ${company.code}`);
      setCompanyForm({ name: "" });
      setOpenCard(null);
      setSelectedCompanyId(company.id);
      await loadCompanies();
    } catch (error) {
      toastError(errMsg(error, "Unable to create company."));
    }
  };

  const saveTruck = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedCompanyId) return;
    const payload = {
      id: editingTruckId ?? undefined,
      companyId: selectedCompanyId,
      fleet_number: formatFleetNumber(truckForm.fleet_number),
      registration: truckForm.registration.trim().toUpperCase(),
      truck_type: truckForm.truck_type.trim() || null,
      model: truckForm.model.trim() || null,
      size: truckForm.size.trim() || null,
      status: truckForm.status,
      license_disc_expiry: truckForm.license_disc_expiry || null,
      roadworthy_expiry: truckForm.roadworthy_expiry || null,
      insurance_expiry: truckForm.insurance_expiry || null,
      next_service_km:
        truckForm.next_service_km === ""
          ? null
          : Number(truckForm.next_service_km),
    };
    if (!payload.fleet_number || !payload.registration)
      return toastError("Fleet number and registration are required.");
    try {
      await adminApi.post("trucks", payload);
    } catch (error) {
      return toastError(errMsg(error, "Unable to save the vehicle."));
    }
    await logAudit(
      "truck",
      editingTruckId ?? payload.fleet_number,
      editingTruckId ? "updated" : "created",
      { fleet_number: payload.fleet_number }
    );
    toastSuccess(editingTruckId ? "Vehicle updated." : "Vehicle added.");
    setTruckForm({
      fleet_number: "",
      registration: "",
      truck_type: "",
      model: "",
      size: "",
      status: "ready",
      license_disc_expiry: "",
      roadworthy_expiry: "",
      insurance_expiry: "",
      next_service_km: "",
    });
    setEditingTruckId(null);
    setOpenCard(null);
    await load();
  };
  const saveAdmin = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedCompanyId) return;
    const payload = {
      companyId: selectedCompanyId,
      auth_user_id: adminForm.auth_user_id.trim() || null,
      employee_number: adminForm.employee_number.trim() || null,
      full_name: adminForm.full_name.trim(),
      phone: adminForm.phone.trim() || null,
    };
    if (!payload.full_name) return toastError("Name is required.");
    try {
      await adminApi.post("drivers", payload);
    } catch (error) {
      return toastError(errMsg(error, "Unable to add the admin."));
    }
    toastSuccess("Company admin added.");
    setAdminForm({
      auth_user_id: "",
      employee_number: "",
      full_name: "",
      phone: "",
    });
    setOpenCard(null);
    await load();
  };
  const deleteTruck = async (truck: AdminTruck) => {
    if (
      !window.confirm(
        `Delete fleet ${truck.fleet_number}? This cannot be undone.`
      )
    )
      return;
    try {
      await adminApi.delete(`trucks/${truck.id}`);
    } catch (error) {
      return toastError(errMsg(error, "Unable to delete the vehicle."));
    }
    await logAudit("truck", truck.id, "deleted", {
      fleet_number: truck.fleet_number,
      registration: truck.registration,
    });
    toastSuccess("Vehicle deleted.");
    await load();
  };
  const deleteAdmin = async (admin: AdminAccount) => {
    if (!window.confirm(`Remove ${admin.full_name}'s admin access?`)) return;
    try {
      await adminApi.delete(`drivers/${admin.id}`);
    } catch (error) {
      return toastError(errMsg(error, "Unable to remove the admin."));
    }
    await logAudit("admin", admin.id, "removed", {
      full_name: admin.full_name,
    });
    toastSuccess("Admin access removed.");
    await load();
  };
  const exportFleet = () => {
    const rows = [
      [
        "Fleet number",
        "Registration",
        "Vehicle type",
        "Model",
        "Size",
        "Status",
      ],
      ...trucks.map(t => [
        t.fleet_number,
        t.registration,
        t.truck_type ?? "",
        t.model ?? "",
        t.size ?? "",
        t.status,
      ]),
    ];
    const csv = rows
      .map(row =>
        row.map(v => `"${String(v).replaceAll('"', '""')}"`).join(",")
      )
      .join("\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    link.download = `${(companies.find(c => c.id === selectedCompanyId)?.name || "rovaya").toLowerCase().replace(/[^a-z0-9]+/g, "-")}-fleet-${reportDate}.csv`;
    link.click();
  };
  const filteredReports = reports.filter(
    row =>
      !fleetFilter ||
      row.truck?.fleet_number?.toLowerCase().includes(fleetFilter.toLowerCase())
  );
  const selectedCompany =
    companies.find(c => c.id === selectedCompanyId) ?? null;
  const inspectedFleetNumbers = new Set(
    reports.map(r => r.truck?.fleet_number).filter(Boolean)
  );
  const missedTrucks = trucks.filter(
    t =>
      t.status !== "out_of_service" &&
      !inspectedFleetNumbers.has(t.fleet_number)
  );
  const failCountsByPrompt = new Map<string, number>();
  reports.forEach(row =>
    row.answers?.forEach(a => {
      if (a.result !== "pass") {
        const prompt = a.checklist_item?.prompt || "Unknown item";
        failCountsByPrompt.set(
          prompt,
          (failCountsByPrompt.get(prompt) ?? 0) + 1
        );
      }
    })
  );
  const topFailingItems = Array.from(failCountsByPrompt.entries())
    .map(([prompt, count]) => ({
      prompt: prompt.length > 28 ? `${prompt.slice(0, 26)}…` : prompt,
      count,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);
  const fullPhotoCount = reports.filter(
    r => (r.photos?.length ?? 0) >= 7
  ).length;
  const photoComplianceRate =
    reports.length > 0
      ? Math.round((fullPhotoCount / reports.length) * 100)
      : 0;
  const filteredDefects = defects.filter(
    d => defectStatusFilter === "all" || d.status === defectStatusFilter
  );
  const openDefectCount = defects.filter(
    d => d.status === "open" || d.status === "in_progress"
  ).length;
  const companyName = selectedCompany?.name || "Rovaya";
  const exportInspections = () => {
    const header = [
      "#",
      "Fleet number",
      "Registration",
      "Inspection date",
      "Shift",
      "Opening kilometers",
      "Inspection latitude",
      "Inspection longitude",
      "Location accuracy (m)",
      "Location captured at",
      "Driver name",
      "Employee number",
      "Status",
      "Checklist results",
      "Notes",
      "Evidence photos",
    ];
    const rows = [
      header,
      ...filteredReports.map((row, index) => [
        String(index + 1),
        row.truck?.fleet_number || "",
        row.truck?.registration || "",
        row.inspection_date,
        shiftLabel(row.shift),
        row.opening_kilometers != null
          ? `Opening Kilometers: ${row.opening_kilometers}`
          : "Opening Kilometers: —",
        row.location?.latitude ?? "",
        row.location?.longitude ?? "",
        row.location?.accuracy ?? "",
        row.location?.captured_at || "",
        row.driver_name || "",
        row.employee_number || "",
        row.status.replaceAll("_", " "),
        sortedAnswers(row.answers ?? [])
          .map(
            a =>
              `${a.checklist_item?.prompt ?? "Checklist item"}: ${a.result === "pass" ? "Y" : "N"}`
          )
          .join("; "),
        row.notes || "",
        `${row.photos?.length || 0}/7`,
      ]),
    ];
    const csv = rows
      .map(row =>
        row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(",")
      )
      .join("\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    link.download = `${companyName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-inspections-${reportDate}${fleetFilter ? `-${fleetFilter}` : ""}.csv`;
    link.click();
    toastSuccess("Inspection report CSV downloaded.");
  };
  const shareReport = async () => {
    if (filteredReports.length === 0)
      return toastError("No inspections to include in this report.");
    setGeneratingPdf(true);
    try {
      // Match the compact printed report used by operations: one A4 portrait page,
      // two inspection cards per row, with failed checks and driver notes visible.
      const pdf = new jsPDF({
        unit: "mm",
        format: "a4",
        orientation: "portrait",
      });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const marginX = 10;
      const contentWidth = pageWidth - marginX * 2;
      const gap = 3;
      const cardWidth = (contentWidth - gap) / 2;
      const headerHeight = 15;
      const cardHeight = 47;
      const rowGap = 2.5;
      const bodyTop = marginX + headerHeight + 9;
      const footerY = pageHeight - 7;
      const ink: [number, number, number] = [38, 43, 40];
      const muted: [number, number, number] = [105, 111, 103];
      const green: [number, number, number] = [35, 52, 42];
      const orange: [number, number, number] = [205, 91, 26];
      const red: [number, number, number] = [190, 54, 49];
      const paleRed: [number, number, number] = [255, 238, 235];
      const border: [number, number, number] = [211, 207, 197];
      const passGreen: [number, number, number] = [42, 104, 71];
      const pageDate = new Date(`${reportDate}T00:00:00`).toLocaleDateString(
        "en-GB"
      );
      const inspected = filteredReports.length;
      const passed = filteredReports.filter(row =>
        sortedAnswers(row.answers ?? []).every(
          answer => answer.result === "pass"
        )
      ).length;
      const failed = inspected - passed;
      const categoryOrder = Array.from(
        new Set(
          filteredReports.flatMap(row =>
            sortedAnswers(row.answers ?? []).map(
              answer => answer.checklist_item?.section_title || "Checklist"
            )
          )
        )
      );
      const checklistCategories = categoryOrder.slice(0, 4);
      const timeLabel = (row: ReportRow) => {
        const timestamp = row.started_at || row.submitted_at;
        return timestamp
          ? new Date(timestamp).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })
          : "—";
      };
      const shiftShort = (shift: ReportRow["shift"]) =>
        shift === "morning"
          ? "Morning Shift"
          : shift === "day"
            ? "Day Shift"
            : shift === "night"
              ? "Night Shift"
              : "—";
      const shortText = (value: string, width: number) =>
        (pdf.splitTextToSize(value || "—", width).at(0) as
          | string
          | undefined) || "—";
      const locationText = (row: ReportRow) =>
        row.location
          ? `GPS: ${row.location.latitude.toFixed(5)}, ${row.location.longitude.toFixed(5)}${row.location.accuracy != null ? ` ±${Math.round(row.location.accuracy)}m` : ""}`
          : "Location: Not captured";
      const logoImg = await loadLogoImage();

      pdf.setFillColor(...green);
      pdf.roundedRect(
        marginX,
        marginX,
        contentWidth,
        headerHeight,
        1.2,
        1.2,
        "F"
      );
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(11.5);
      pdf.setTextColor(255, 255, 255);
      pdf.text(
        `${companyName} — Fleet Inspection Detailed`,
        marginX + 3,
        marginX + 5.4
      );
      pdf.setFontSize(11.5);
      pdf.text("Summary", marginX + 3, marginX + 10.2);
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(5.8);
      pdf.setTextColor(215, 225, 216);
      pdf.text(
        `${inspected} fleets inspected · ${passed} passed · ${failed} issue${failed === 1 ? "" : "s"}`,
        marginX + 3,
        marginX + 13.2
      );
      if (logoImg) {
        const logoH = 6.5;
        const logoW =
          logoImg.naturalWidth && logoImg.naturalHeight
            ? logoH * (logoImg.naturalWidth / logoImg.naturalHeight)
            : 22;
        pdf.setFillColor(255, 255, 255);
        pdf.rect(
          pageWidth - marginX - logoW - 3.5,
          marginX + 2.5,
          logoW + 2.5,
          10,
          "F"
        );
        pdf.addImage(
          logoImg,
          "PNG",
          pageWidth - marginX - logoW - 2.5,
          marginX + 4.2,
          logoW,
          logoH
        );
      }
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(5.8);
      pdf.setTextColor(...ink);
      pdf.text(
        `Date: ${pageDate}  |  Inspected: ${inspected}  |  Passed: ${passed}`,
        pageWidth - marginX,
        marginX + headerHeight + 4.2,
        { align: "right" }
      );
      pdf.setFont("helvetica", "bold");
      pdf.setTextColor(...red);
      pdf.text(
        `Issues: ${failed} FAIL${failed === 1 ? "" : "S"}`,
        pageWidth - marginX,
        marginX + headerHeight + 7.3,
        { align: "right" }
      );

      const drawCard = (
        row: ReportRow,
        index: number,
        x: number,
        y: number
      ) => {
        const answers = sortedAnswers(row.answers ?? []);
        const failures = answers.filter(answer => answer.result !== "pass");
        const photos = sortedPhotos(row.photos ?? []);
        pdf.setDrawColor(...border);
        pdf.setFillColor(255, 255, 255);
        pdf.roundedRect(x, y, cardWidth, cardHeight, 1.5, 1.5, "FD");
        if (failures.length) {
          pdf.setDrawColor(232, 86, 77);
          pdf.setLineWidth(0.7);
          pdf.roundedRect(
            x + 0.3,
            y + 0.3,
            cardWidth - 0.6,
            cardHeight - 0.6,
            1.3,
            1.3,
            "S"
          );
          pdf.setLineWidth(0.2);
        }
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(6.9);
        pdf.setTextColor(...ink);
        pdf.text(
          `#${index + 1} Fleet ${formatFleetNumber(row.truck?.fleet_number || "—")}`,
          x + 2.5,
          y + 4.4
        );
        pdf.setFontSize(6.2);
        pdf.setTextColor(...orange);
        pdf.text(row.truck?.registration || "—", x + cardWidth - 2.5, y + 4.4, {
          align: "right",
        });
        pdf.setDrawColor(...border);
        pdf.line(x + 2.5, y + 6.2, x + cardWidth - 2.5, y + 6.2);
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(5.45);
        pdf.setTextColor(...muted);
        const employeeLabel = row.employee_number
          ? ` (Emp ID: #${row.employee_number})`
          : "";
        pdf.text(
          `Driver: ${shortText(`${row.driver_name || "Unknown"}${employeeLabel}`, cardWidth - 5)}`,
          x + 2.5,
          y + 9.2
        );
        pdf.text(
          `Odometer: ${row.opening_kilometers != null ? `${row.opening_kilometers.toLocaleString("en-ZA")} km` : "—"}  |  Time: ${timeLabel(row)}  |  Shift: ${shiftShort(row.shift)}`,
          x + 2.5,
          y + 12.4
        );
        pdf.setTextColor(...(row.location ? passGreen : muted));
        pdf.text(locationText(row), x + 2.5, y + 15.1);
        let lineY = y + 18.3;
        checklistCategories.forEach(category => {
          const categoryAnswers = answers.filter(
            answer =>
              (answer.checklist_item?.section_title || "Checklist") === category
          );
          const result =
            categoryAnswers.length > 0 &&
            categoryAnswers.every(answer => answer.result === "pass");
          const hasResult = categoryAnswers.length > 0;
          pdf.setFont("helvetica", "normal");
          pdf.setFontSize(5.25);
          pdf.setTextColor(...ink);
          pdf.text(shortText(category, cardWidth - 17), x + 2.5, lineY);
          pdf.setFont("helvetica", "bold");
          pdf.setTextColor(...(result ? passGreen : hasResult ? red : muted));
          pdf.text(
            hasResult ? (result ? "PASS" : "FAIL") : "—",
            x + cardWidth - 2.5,
            lineY,
            { align: "right" }
          );
          lineY += 3.15;
        });
        const vehiclePhotoCount = photos.filter(
          photo => photo.photo_type !== "selfie"
        ).length;
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(5.2);
        pdf.setTextColor(...passGreen);
        pdf.text(
          `✓ ${vehiclePhotoCount}/6 Photos Verified`,
          x + 2.5,
          y + cardHeight - (row.notes || failures.length ? 7.5 : 3.2)
        );
        if (row.notes || failures.length) {
          const note =
            row.notes ||
            failures
              .map(
                answer =>
                  answer.checklist_item?.prompt || "Failed checklist item"
              )
              .join("; ");
          pdf.setFillColor(...paleRed);
          pdf.setDrawColor(244, 157, 150);
          pdf.roundedRect(
            x + 2.5,
            y + cardHeight - 6.4,
            cardWidth - 5,
            4.6,
            0.7,
            0.7,
            "FD"
          );
          pdf.setFont("helvetica", "bold");
          pdf.setFontSize(4.55);
          pdf.setTextColor(...red);
          pdf.text(
            `⚠ Driver Note: ${shortText(note, cardWidth - 10)}`,
            x + 4,
            y + cardHeight - 3.45
          );
        }
      };

      filteredReports.forEach((row, index) => {
        const rowIndex = Math.floor(index / 2);
        const columnIndex = index % 2;
        drawCard(
          row,
          index,
          marginX + columnIndex * (cardWidth + gap),
          bodyTop + rowIndex * (cardHeight + rowGap)
        );
      });
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(5.1);
      pdf.setTextColor(145, 149, 141);
      pdf.text(
        "Generated via Rovaya Inspection Management System — Page 1 of 1",
        pageWidth - marginX,
        footerY,
        { align: "right" }
      );

      const blob = pdf.output("blob");
      const file = new File(
        [blob],
        `${companyName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-fleet-inspection-report-${reportDate}.pdf`,
        { type: "application/pdf" }
      );
      if (navigator.share && navigator.canShare?.({ files: [file] }))
        await navigator.share({
          title: `${companyName} Fleet Inspection Report`,
          text: `${companyName} fleet inspection report for ${reportDate}`,
          files: [file],
        });
      else {
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = file.name;
        link.click();
        toastSuccess("Inspection report PDF downloaded.");
      }
    } catch (error) {
      toastError(
        error instanceof Error
          ? error.message
          : "Unable to generate the report PDF."
      );
    } finally {
      setGeneratingPdf(false);
    }
  };
  const shareDefectsReport = async () => {
    if (filteredDefects.length === 0)
      return toastError("No defects to include in this report.");
    setGeneratingDefectsPdf(true);
    try {
      const pdf = new jsPDF({
        unit: "mm",
        format: "a4",
        orientation: "landscape",
      });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const marginX = 10;
      const bottomLimit = pageHeight - 12;
      const usableWidth = pageWidth - marginX * 2;

      const columns = [
        { key: "#", w: 8 },
        { key: "Fleet No.", w: 20 },
        { key: "Registration", w: 24 },
        { key: "Driver", w: 32 },
        { key: "Date", w: 22 },
        { key: "Category", w: 24 },
        { key: "Severity", w: 20 },
        { key: "Status", w: 24 },
        { key: "Description", w: 0 },
      ];
      const fixedWidth = columns.slice(0, -1).reduce((sum, c) => sum + c.w, 0);
      columns[columns.length - 1].w = Math.max(40, usableWidth - fixedWidth);

      const rowHeight = 9;
      const headerHeight = 8;
      let y = 0;

      const severityColor: Record<
        AdminDefect["severity"],
        [number, number, number]
      > = {
        critical: [176, 40, 42],
        high: [176, 64, 42],
        medium: [165, 77, 31],
        low: [90, 100, 90],
      };

      const drawHeader = () => {
        pdf.setFillColor(47, 70, 56);
        pdf.rect(marginX, y, usableWidth, headerHeight, "F");
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(7.5);
        pdf.setTextColor(255, 255, 255);
        let x = marginX;
        columns.forEach(col => {
          pdf.text(col.key, x + 1.5, y + headerHeight - 2.5);
          x += col.w;
        });
        pdf.setTextColor(20, 30, 25);
        y += headerHeight;
      };

      const ensureSpace = (needed: number) => {
        if (y + needed > bottomLimit) {
          pdf.addPage();
          y = 20;
          drawHeader();
        }
      };

      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(18);
      pdf.text(`${companyName} — Defects Report`, marginX, 16);
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(9);
      pdf.setTextColor(90, 100, 90);
      pdf.text(
        `Filter: ${defectStatusFilter.replaceAll("_", " ")}    Defects listed: ${filteredDefects.length}    Generated: ${new Date().toLocaleString()}`,
        marginX,
        22
      );
      pdf.setTextColor(20, 30, 25);
      y = 28;
      drawHeader();

      filteredDefects.forEach((defect, index) => {
        const description = defect.description
          ? `${defect.title} — ${defect.description}`
          : defect.title;
        const descLines = pdf.splitTextToSize(
          description,
          columns[columns.length - 1].w - 2
        );
        const linesNeeded = Math.max(1, Math.min(descLines.length, 3));
        const thisRowHeight = Math.max(rowHeight, linesNeeded * 4 + 3);
        ensureSpace(thisRowHeight);
        if (index % 2 === 1) {
          pdf.setFillColor(245, 242, 234);
          pdf.rect(marginX, y, usableWidth, thisRowHeight, "F");
        }

        let x = marginX;
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(7.5);
        pdf.setTextColor(20, 30, 25);
        const cell = (
          text: string,
          width: number,
          opts?: { bold?: boolean; color?: [number, number, number] }
        ) => {
          pdf.setFont("helvetica", opts?.bold ? "bold" : "normal");
          if (opts?.color) pdf.setTextColor(...opts.color);
          else pdf.setTextColor(20, 30, 25);
          const clipped = pdf.splitTextToSize(text, width - 2)[0] ?? "";
          pdf.text(clipped, x + 1.5, y + 5.5);
          x += width;
        };

        cell(String(index + 1), columns[0].w);
        cell(
          formatFleetNumber(defect.inspection?.truck?.fleet_number || ""),
          columns[1].w,
          { bold: true }
        );
        cell(defect.inspection?.truck?.registration || "—", columns[2].w);
        cell(defect.inspection?.driver_name || "Unknown", columns[3].w);
        cell(defect.inspection?.inspection_date || "—", columns[4].w);
        cell(defect.category || "—", columns[5].w);
        cell(defect.severity.toUpperCase(), columns[6].w, {
          bold: true,
          color: severityColor[defect.severity],
        });
        cell(defect.status.replaceAll("_", " "), columns[7].w);

        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(7.5);
        pdf.setTextColor(20, 30, 25);
        descLines
          .slice(0, 3)
          .forEach((line: string, i: number) =>
            pdf.text(line, x + 1.5, y + 5.5 + i * 4)
          );

        pdf.setDrawColor(225, 220, 205);
        pdf.line(
          marginX,
          y + thisRowHeight,
          marginX + usableWidth,
          y + thisRowHeight
        );
        y += thisRowHeight;
      });

      const blob = pdf.output("blob");
      const file = new File(
        [blob],
        `${companyName.toLowerCase().replace(/\s+/g, "-")}-defects-${defectStatusFilter}.pdf`,
        { type: "application/pdf" }
      );
      if (navigator.share && navigator.canShare?.({ files: [file] }))
        await navigator.share({
          title: `${companyName} defects report`,
          text: `Defects report (${defectStatusFilter})`,
          files: [file],
        });
      else {
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = file.name;
        link.click();
        toastSuccess("Defects report downloaded.");
      }
    } catch (error) {
      toastError(
        error instanceof Error
          ? error.message
          : "Unable to generate the defects report."
      );
    } finally {
      setGeneratingDefectsPdf(false);
    }
  };
  const startEdit = (truck: AdminTruck) => {
    setEditingTruckId(truck.id);
    setTruckForm({
      fleet_number: truck.fleet_number,
      registration: truck.registration,
      truck_type: truck.truck_type ?? "",
      model: truck.model ?? "",
      size: truck.size ?? "",
      status: truck.status,
      license_disc_expiry: truck.license_disc_expiry ?? "",
      roadworthy_expiry: truck.roadworthy_expiry ?? "",
      insurance_expiry: truck.insurance_expiry ?? "",
      next_service_km:
        truck.next_service_km == null ? "" : String(truck.next_service_km),
    });
    setOpenCard("truck");
  };

  return (
    <main className="min-h-screen bg-[#ede9dd] text-[#2e4335]">
      <header className="relative flex flex-wrap items-center justify-between gap-4 border-b border-[#d8d3c5] bg-[#f7f3e9] px-4 py-4 sm:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <img
            src={`${import.meta.env.BASE_URL}rovaya-wordmark-transparent.png`}
            alt="Rovaya"
            className="h-auto w-[7.5rem] shrink-0 object-contain sm:w-[9rem]"
          />
          <div className="min-w-0">
            <p className="font-slab text-xl font-bold">Admin control</p>
            <p className="truncate text-[10px] font-bold uppercase tracking-[0.18em] text-[#7b8775]">
              Rovaya · {profile?.full_name}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 sm:gap-2">
          <Button
            variant="outline"
            onClick={exportFleet}
            className="h-8 rounded-lg bg-[#fbf8ef] px-2.5 text-[10px] font-bold sm:h-9 sm:px-3 sm:text-xs"
          >
            <Download className="mr-1 h-3 w-3 sm:mr-2 sm:h-3.5 sm:w-3.5" />
            Export
          </Button>
          <Button
            variant="outline"
            onClick={() => void load()}
            className="h-8 rounded-lg bg-[#fbf8ef] px-2.5 text-[10px] font-bold sm:h-9 sm:px-3 sm:text-xs"
          >
            <RefreshCw className="mr-1 h-3 w-3 sm:mr-2 sm:h-3.5 sm:w-3.5" />
            Refresh
          </Button>
          <Button
            variant="outline"
            onClick={() => void signOut()}
            className="h-8 rounded-lg bg-[#fbf8ef] px-2.5 text-[10px] font-bold sm:h-9 sm:px-3 sm:text-xs"
          >
            <X className="mr-1 h-3 w-3 sm:mr-2 sm:h-3.5 sm:w-3.5" />
            Sign out
          </Button>
        </div>
      </header>
      <div className="mx-auto max-w-7xl space-y-6 p-4 pb-16 sm:p-8">
        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-[#7c887b]">
          <button
            type="button"
            onClick={() => {
              void signOut().finally(() =>
                window.location.replace(import.meta.env.BASE_URL)
              );
            }}
            className="inline-flex items-center gap-2 hover:text-[#e9682a]"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Return to workspace
          </button>
          <span>/</span>
          <span className="text-[#e9682a]">Admin only</span>
        </div>
        {isSuperAdmin && (
          <section className="paper-panel flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#d8d3c5] p-4">
            <div className="flex items-center gap-3">
              <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#6a7769]">
                Viewing company
              </p>
              <select
                value={selectedCompanyId ?? ""}
                onChange={e => setSelectedCompanyId(e.target.value)}
                className="h-10 rounded-xl border border-[#d4cfc1] bg-[#fffdf6] px-3 text-sm font-bold"
              >
                {companies.map(c => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <ActionCard
              icon={Building2}
              title="Add company"
              detail={`${companies.length} companies managed`}
              open={openCard === "company"}
              onClick={() =>
                setOpenCard(openCard === "company" ? null : "company")
              }
            />
          </section>
        )}
        {openCard === "company" && (
          <form
            onSubmit={createCompany}
            className="paper-panel rounded-2xl border border-[#d8d3c5] p-5"
          >
            <div className="mb-5 flex items-center justify-between">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#6a7769]">
                  Platform control
                </p>
                <h2 className="font-slab text-2xl font-bold">
                  Onboard a new company
                </h2>
                <p className="mt-1 text-xs text-[#718070]">
                  Creates the company, a driver access code, and an empty
                  checklist ready for items.
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setOpenCard(null)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <Field label="Company name">
              <Input
                required
                value={companyForm.name}
                onChange={e => setCompanyForm({ name: e.target.value })}
                placeholder="e.g. Clover"
              />
            </Field>
            <Button
              type="submit"
              className="mt-5 h-11 w-full rounded-xl bg-[#e9682a] text-sm font-bold text-white"
            >
              <Building2 className="mr-2 h-4 w-4" />
              Create company
            </Button>
          </form>
        )}
        <section className="grid gap-3 md:grid-cols-2">
          <ActionCard
            icon={UserPlus}
            title="Add admin"
            detail={`${admins.length} admins for this company`}
            open={openCard === "admin"}
            onClick={() => setOpenCard(openCard === "admin" ? null : "admin")}
          />
          <ActionCard
            icon={Car}
            title={editingTruckId ? "Edit vehicle" : "Add vehicle"}
            detail={`${trucks.length} fleet records`}
            open={openCard === "truck"}
            onClick={() => setOpenCard(openCard === "truck" ? null : "truck")}
          />
        </section>
        {openCard === "admin" && (
          <form
            onSubmit={saveAdmin}
            className="paper-panel rounded-2xl border border-[#d8d3c5] p-5"
          >
            <div className="mb-5 flex items-center justify-between">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#6a7769]">
                  Access control
                </p>
                <h2 className="font-slab text-2xl font-bold">
                  Add company admin
                </h2>
              </div>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setOpenCard(null)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Auth user UID">
                <Input
                  value={adminForm.auth_user_id}
                  onChange={e =>
                    setAdminForm({ ...adminForm, auth_user_id: e.target.value })
                  }
                />
              </Field>
              <Field label="Full name">
                <Input
                  required
                  value={adminForm.full_name}
                  onChange={e =>
                    setAdminForm({ ...adminForm, full_name: e.target.value })
                  }
                />
              </Field>
              <Field label="Employee number">
                <Input
                  value={adminForm.employee_number}
                  onChange={e =>
                    setAdminForm({
                      ...adminForm,
                      employee_number: e.target.value,
                    })
                  }
                />
              </Field>
              <Field label="Phone">
                <Input
                  value={adminForm.phone}
                  onChange={e =>
                    setAdminForm({ ...adminForm, phone: e.target.value })
                  }
                />
              </Field>
            </div>
            <Button
              type="submit"
              className="mt-5 h-11 w-full rounded-xl bg-[#e9682a] text-sm font-bold text-white"
            >
              <UserPlus className="mr-2 h-4 w-4" />
              Add admin
            </Button>
          </form>
        )}
        {openCard === "truck" && (
          <form
            onSubmit={saveTruck}
            className={cn(
              "paper-panel w-full rounded-2xl border border-[#d8d3c5] p-5",
              editingTruckId &&
                "fixed inset-0 z-50 mx-auto flex max-w-2xl items-start justify-center overflow-y-auto rounded-none border-0 bg-[#1f3529]/45 p-4 sm:items-center sm:p-8"
            )}
          >
            <div
              className={cn(
                "w-full",
                editingTruckId &&
                  "max-w-xl rounded-2xl border border-[#d8d3c5] bg-[#fbf8ef] p-5 shadow-2xl sm:p-6"
              )}
            >
              <div className="mb-5 flex items-center justify-between">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#6a7769]">
                    Fleet control
                  </p>
                  <h2 className="font-slab text-2xl font-bold">
                    {editingTruckId ? "Edit vehicle" : "Add vehicle"}
                  </h2>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setOpenCard(null);
                    setEditingTruckId(null);
                  }}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Fleet number">
                  <Input
                    required
                    value={truckForm.fleet_number}
                    onChange={e =>
                      setTruckForm({
                        ...truckForm,
                        fleet_number: formatFleetNumber(e.target.value),
                      })
                    }
                    placeholder="e.g. 744-0771"
                    maxLength={8}
                  />
                </Field>
                <Field label="Registration">
                  <Input
                    required
                    value={truckForm.registration}
                    onChange={e =>
                      setTruckForm({
                        ...truckForm,
                        registration: e.target.value,
                      })
                    }
                  />
                </Field>
                <Field label="Vehicle type">
                  <Input
                    value={truckForm.truck_type}
                    onChange={e =>
                      setTruckForm({ ...truckForm, truck_type: e.target.value })
                    }
                  />
                </Field>
                <Field label="Model">
                  <Input
                    value={truckForm.model}
                    onChange={e =>
                      setTruckForm({ ...truckForm, model: e.target.value })
                    }
                  />
                </Field>
                <Field label="Size">
                  <Input
                    value={truckForm.size}
                    onChange={e =>
                      setTruckForm({ ...truckForm, size: e.target.value })
                    }
                  />
                </Field>
                <Field label="Status">
                  <select
                    value={truckForm.status}
                    onChange={e =>
                      setTruckForm({
                        ...truckForm,
                        status: e.target.value as AdminTruck["status"],
                      })
                    }
                    className="h-10 w-full rounded-xl border border-[#d4cfc1] bg-[#fffdf6] px-3 text-sm"
                  >
                    <option value="ready">Ready</option>
                    <option value="inspection_due">Inspection due</option>
                    <option value="out_of_service">Out of service</option>
                  </select>
                </Field>
                <Field label="License disc expiry">
                  <Input
                    type="date"
                    value={truckForm.license_disc_expiry}
                    onChange={e =>
                      setTruckForm({
                        ...truckForm,
                        license_disc_expiry: e.target.value,
                      })
                    }
                  />
                </Field>
                <Field label="Roadworthy / COF expiry">
                  <Input
                    type="date"
                    value={truckForm.roadworthy_expiry}
                    onChange={e =>
                      setTruckForm({
                        ...truckForm,
                        roadworthy_expiry: e.target.value,
                      })
                    }
                  />
                </Field>
                <Field label="Insurance expiry">
                  <Input
                    type="date"
                    value={truckForm.insurance_expiry}
                    onChange={e =>
                      setTruckForm({
                        ...truckForm,
                        insurance_expiry: e.target.value,
                      })
                    }
                  />
                </Field>
                <Field label="Next service (km)">
                  <Input
                    inputMode="numeric"
                    value={truckForm.next_service_km}
                    onChange={e =>
                      setTruckForm({
                        ...truckForm,
                        next_service_km: e.target.value.replace(/[^0-9]/g, ""),
                      })
                    }
                    placeholder="e.g. 195000"
                  />
                </Field>
              </div>
              <Button
                type="submit"
                className="mt-5 h-11 w-full rounded-xl bg-[#2f4638] text-sm font-bold text-white"
              >
                <Save className="mr-2 h-4 w-4" />
                {editingTruckId ? "Save vehicle" : "Add vehicle"}
              </Button>
            </div>
          </form>
        )}

        <section className="paper-panel overflow-hidden rounded-2xl border border-[#d8d3c5]">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#dfd9ca] px-5 py-5">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#6a7769]">
                Manager report
              </p>
              <h2 className="font-slab text-2xl font-bold">
                {companyName} — Complete inspection report
              </h2>
              <p className="mt-1 text-xs text-[#718070]">
                Full checklist, driver, shift, opening kilometers, notes, and
                six vehicle photos plus the driver selfie per fleet.
              </p>
            </div>
            <div className="flex gap-2">
              <Input
                type="date"
                value={reportDate}
                onChange={e => setReportDate(e.target.value)}
                className="h-9 w-[145px]"
              />
              <Input
                value={fleetFilter}
                onChange={e => setFleetFilter(e.target.value)}
                placeholder="Filter fleet"
                className="h-9 w-[120px]"
              />
              <Button
                variant="outline"
                onClick={exportInspections}
                className="h-9 bg-[#fbf8ef] text-xs font-bold"
              >
                <Download className="mr-2 h-3.5 w-3.5" />
                CSV
              </Button>
              <Button
                onClick={() => void shareReport()}
                disabled={generatingPdf}
                className="h-9 bg-[#e9682a] text-xs font-bold text-white disabled:opacity-60"
              >
                <Share2 className="mr-2 h-3.5 w-3.5" />
                {generatingPdf ? "Building report…" : "Share PDF"}
              </Button>
            </div>
          </div>
          <div className="divide-y divide-[#e5dfd3]">
            {loading ? (
              <div className="p-6 text-sm">Loading report…</div>
            ) : filteredReports.length === 0 ? (
              <div className="p-6 text-sm text-[#7c887b]">
                No inspections recorded for {reportDate}
                {fleetFilter ? ` matching ${fleetFilter}` : ""}.
              </div>
            ) : (
              filteredReports.map((row, index) => {
                const driverName = row.driver_name || "Unknown driver";
                const employeeNumber = row.employee_number || null;
                const photos = sortedPhotos(row.photos ?? []);
                const answers = sortedAnswers(row.answers ?? []);
                const isOpen = expandedReportIds.has(row.id);
                const failCount = answers.filter(
                  a => a.result !== "pass"
                ).length;
                let lastSection = "";
                return (
                  <div key={row.id}>
                    <button
                      type="button"
                      onClick={() => toggleReportRow(row.id)}
                      className="flex w-full flex-wrap items-start justify-between gap-3 px-5 py-6 text-left hover:bg-[#f5f1e7]"
                    >
                      <div className="flex items-center gap-3">
                        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#2f4638] text-sm font-bold text-[#f4a36f]">
                          {index + 1}
                        </span>
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-base font-bold">
                              Fleet {row.truck?.fleet_number || "Unknown"}
                            </span>
                            <span className="font-mono text-xs font-bold text-[#e9682a]">
                              {row.truck?.registration}
                            </span>
                          </div>
                          <div className="text-sm font-semibold text-[#2e4335]">
                            {driverName}
                            {employeeNumber && (
                              <span className="ml-1.5 font-mono text-xs font-normal text-[#849083]">
                                #{employeeNumber}
                              </span>
                            )}
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#6a7769]">
                            <span>{shiftLabel(row.shift)}</span>
                            <span
                              className={cn(
                                "font-bold",
                                photos.length === 7
                                  ? "text-[#2f8b5e]"
                                  : "text-[#b65323]"
                              )}
                            >
                              {photos.length}/7 photos
                            </span>
                            {failCount > 0 && (
                              <span className="font-bold text-[#b0402a]">
                                {failCount} fail{failCount === 1 ? "" : "s"}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="rounded-full bg-[#e8eee5] px-2.5 py-1 text-[10px] font-bold uppercase">
                          {row.status.replaceAll("_", " ")}
                        </span>
                        <ChevronDown
                          className={cn(
                            "h-4 w-4 text-[#6a7769] transition-transform",
                            isOpen && "rotate-180"
                          )}
                        />
                      </div>
                    </button>
                    {isOpen && (
                      <div className="px-5 pb-6">
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs text-[#4c5a4c] sm:grid-cols-4">
                          <span>
                            <span className="font-bold text-[#2e4335]">
                              Shift:
                            </span>{" "}
                            {shiftLabel(row.shift)}
                          </span>
                          <span>
                            <span className="font-bold text-[#2e4335]">
                              Employee number:
                            </span>{" "}
                            {employeeNumber || "—"}
                          </span>
                          <span>
                            <span className="font-bold text-[#2e4335]">
                              Opening Kilometers:
                            </span>{" "}
                            {row.opening_kilometers != null
                              ? row.opening_kilometers
                              : "—"}
                          </span>
                          <span className="col-span-2 sm:col-span-1">
                            <span className="font-bold text-[#2e4335]">
                              Location:
                            </span>{" "}
                            {row.location ? (
                              <a
                                className="text-[#2f5b3f] underline"
                                href={`https://www.google.com/maps?q=${row.location.latitude},${row.location.longitude}`}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {row.location.latitude.toFixed(5)},{" "}
                                {row.location.longitude.toFixed(5)}
                                {row.location.accuracy != null
                                  ? ` (±${Math.round(row.location.accuracy)} m)`
                                  : ""}
                              </a>
                            ) : (
                              "Not captured"
                            )}
                          </span>
                          <span>
                            <span className="font-bold text-[#2e4335]">
                              Submitted:
                            </span>{" "}
                            {row.submitted_at
                              ? new Date(row.submitted_at).toLocaleString()
                              : "Not submitted"}
                          </span>
                          <span
                            className={cn(
                              "font-bold",
                              photos.length === 7
                                ? "text-[#2f8b5e]"
                                : "text-[#b65323]"
                            )}
                          >
                            {photos.length}/7 evidence photos
                          </span>
                        </div>
                        {row.notes && (
                          <p className="mt-3 rounded-lg bg-[#fff6eb] px-3 py-2 text-xs text-[#6d4a2b]">
                            <span className="font-bold">Notes: </span>
                            {row.notes}
                          </p>
                        )}
                        <div className="mt-4">
                          <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#6a7769]">
                            Checklist
                          </p>
                          <div className="mt-2 divide-y divide-[#eee9dc] rounded-xl border border-[#e5dfd3]">
                            {answers.length === 0 ? (
                              <div className="px-3 py-2 text-xs text-[#7c887b]">
                                No checklist answers recorded.
                              </div>
                            ) : (
                              answers.map((answer, answerIndex) => {
                                const section =
                                  answer.checklist_item?.section_title || "";
                                const showSection =
                                  section && section !== lastSection;
                                lastSection = section || lastSection;
                                const pass = answer.result === "pass";
                                return (
                                  <React.Fragment key={answerIndex}>
                                    {showSection && (
                                      <div className="bg-[#f5f1e7] px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-[#6a7769]">
                                        {section}
                                      </div>
                                    )}
                                    <div className="flex items-center justify-between gap-3 px-3 py-2">
                                      <span className="text-xs text-[#2e4335]">
                                        {answer.checklist_item?.prompt ||
                                          "Checklist item"}
                                      </span>
                                      <span
                                        className={cn(
                                          "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase",
                                          pass
                                            ? "bg-[#e6f3ea] text-[#2f8b5e]"
                                            : "bg-[#fce8e3] text-[#b0402a]"
                                        )}
                                      >
                                        {pass ? "Pass" : "Fail"}
                                      </span>
                                    </div>
                                  </React.Fragment>
                                );
                              })
                            )}
                          </div>
                        </div>
                        <div className="mt-4">
                          <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#6a7769]">
                            Evidence photos ({photos.length}/7)
                          </p>
                          <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-7">
                            {PHOTO_ORDER.map(type => {
                              const photo = photos.find(
                                p => p.photo_type === type
                              );
                              return (
                                <button
                                  key={type}
                                  type="button"
                                  disabled={!photo}
                                  onClick={() =>
                                    photo &&
                                    setSelectedPhoto({
                                      url: photo.url,
                                      photo_type: type,
                                      truck:
                                        row.truck?.fleet_number ||
                                        "Unknown truck",
                                      driver: driverName,
                                      captured_at: photo.captured_at,
                                    })
                                  }
                                  className="group overflow-hidden rounded-xl border border-[#d8d3c5] bg-[#f5f1e7] text-left disabled:opacity-50"
                                >
                                  <div className="aspect-square bg-[#e5e1d5]">
                                    {photo?.url ? (
                                      <img
                                        src={photo.url}
                                        alt={`${row.truck?.fleet_number || "truck"} ${type}`}
                                        className="h-full w-full object-cover transition group-hover:scale-105"
                                      />
                                    ) : (
                                      <div className="grid h-full place-items-center">
                                        <Camera className="h-4 w-4 text-[#889286]" />
                                      </div>
                                    )}
                                  </div>
                                  <div className="px-1.5 py-1">
                                    <div className="truncate text-[9px] font-bold uppercase tracking-[0.06em] text-[#718070]">
                                      {PHOTO_LABELS[type]}
                                    </div>
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </section>
        <AdminPhotoLibrary
          selectedCompanyId={selectedCompanyId}
          company={selectedCompany}
          fleetOptions={trucks.map(t => ({
            fleet_number: t.fleet_number,
            registration: t.registration,
          }))}
          onRetentionSaved={loadCompanies}
          onAudit={logAudit}
        />
        <section className="paper-panel overflow-hidden rounded-2xl border border-[#d8d3c5]">
          <button
            type="button"
            onClick={() => setOpenFleet(current => !current)}
            className="flex w-full items-center justify-between border-b border-[#dfd9ca] px-5 py-5 text-left"
          >
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#6a7769]">
                Master fleet
              </p>
              <h2 className="font-slab text-2xl font-bold">Fleet records</h2>
            </div>
            <span className="rounded-full bg-[#e8eee5] px-3 py-1 text-xs font-bold">
              {trucks.length} vehicles
            </span>
            <span className="text-xs font-bold uppercase tracking-[0.12em] text-[#e9682a]">
              {openFleet ? "Close" : "Open"}
            </span>
          </button>
          {openFleet && (
            <div className="divide-y divide-[#e5dfd3]">
              {loading ? (
                <div className="p-6 text-sm">Loading fleet records…</div>
              ) : (
                trucks.map(truck => (
                  <div
                    key={truck.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => startEdit(truck)}
                    onKeyDown={e => {
                      if (e.key === "Enter" || e.key === " ") startEdit(truck);
                    }}
                    className="flex cursor-pointer flex-wrap items-center gap-3 px-5 py-4 hover:bg-[#f5f1e7]"
                  >
                    <div className="grid h-9 w-9 place-items-center rounded-lg bg-[#e8eee5]">
                      <Car className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-sm font-bold">
                        {truck.fleet_number}
                      </div>
                      <div className="font-mono text-xs font-bold text-[#e9682a]">
                        {truck.registration}
                      </div>
                    </div>
                    <span className="text-xs font-semibold">
                      {truck.status.replaceAll("_", " ")}
                    </span>
                    <div className="flex flex-wrap gap-1.5">
                      {[
                        ["Disc", truck.license_disc_expiry],
                        ["COF", truck.roadworthy_expiry],
                        ["Insurance", truck.insurance_expiry],
                      ].map(([label, date]) => (
                        <ExpiryBadge
                          key={label}
                          label={label as string}
                          date={date as string | null}
                        />
                      ))}
                    </div>
                    <Button
                      variant="outline"
                      onClick={e => {
                        e.stopPropagation();
                        startEdit(truck);
                      }}
                      className="h-8 text-xs font-bold"
                    >
                      Edit
                    </Button>
                    <Button
                      variant="outline"
                      onClick={e => {
                        e.stopPropagation();
                        void deleteTruck(truck);
                      }}
                      className="h-8 text-xs text-[#a44b2d]"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))
              )}
            </div>
          )}
        </section>
        <section className="paper-panel overflow-hidden rounded-2xl border border-[#d8d3c5]">
          <button
            type="button"
            onClick={() => setOpenMissed(c => !c)}
            className="flex w-full items-center justify-between border-b border-[#dfd9ca] px-5 py-5 text-left"
          >
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#6a7769]">
                Compliance
              </p>
              <h2 className="font-slab text-2xl font-bold">
                Missed inspections — {reportDate}
              </h2>
            </div>
            <span
              className={cn(
                "rounded-full px-3 py-1 text-xs font-bold",
                missedTrucks.length > 0
                  ? "bg-[#fff0dc] text-[#a54d1f]"
                  : "bg-[#e6f3ea] text-[#2f8b5e]"
              )}
            >
              {missedTrucks.length} vehicle
              {missedTrucks.length === 1 ? "" : "s"}
            </span>
            <span className="text-xs font-bold uppercase tracking-[0.12em] text-[#e9682a]">
              {openMissed ? "Close" : "Open"}
            </span>
          </button>
          {openMissed && (
            <div className="divide-y divide-[#e5dfd3]">
              {missedTrucks.length === 0 ? (
                <div className="p-6 text-sm text-[#6a7769]">
                  Every active vehicle has a report for this date.
                </div>
              ) : (
                missedTrucks.map(truck => (
                  <div
                    key={truck.id}
                    className="flex items-center gap-3 px-5 py-4"
                  >
                    <AlertTriangle className="h-4 w-4 text-[#a54d1f]" />
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-sm font-bold">
                        {truck.fleet_number}
                      </div>
                      <div className="font-mono text-xs font-bold text-[#e9682a]">
                        {truck.registration}
                      </div>
                    </div>
                    <span className="text-xs font-semibold text-[#a54d1f]">
                      No report on {reportDate}
                    </span>
                  </div>
                ))
              )}
            </div>
          )}
        </section>
        <section className="paper-panel overflow-hidden rounded-2xl border border-[#d8d3c5] p-5">
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#6a7769]">
            Insights
          </p>
          <h2 className="font-slab text-2xl font-bold">
            Analytics — {reportDate}
          </h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.1em] text-[#6a7769]">
                Top failing checklist items
              </p>
              {topFailingItems.length === 0 ? (
                <p className="mt-3 text-sm text-[#7c887b]">
                  No failures recorded for this date.
                </p>
              ) : (
                <div className="mt-2 h-52">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={topFailingItems}
                      layout="vertical"
                      margin={{ left: 8, right: 8, top: 4, bottom: 4 }}
                    >
                      <XAxis type="number" allowDecimals={false} hide />
                      <YAxis
                        type="category"
                        dataKey="prompt"
                        width={140}
                        tick={{ fontSize: 11 }}
                      />
                      <Tooltip />
                      <Bar dataKey="count" fill="#b0402a" radius={4} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
            <div className="flex flex-col justify-center rounded-xl bg-[#f5f1e7] p-5">
              <p className="text-xs font-bold uppercase tracking-[0.1em] text-[#6a7769]">
                Photo compliance
              </p>
              <p className="mt-1 font-slab text-4xl font-bold text-[#14532D]">
                {photoComplianceRate}%
              </p>
              <p className="mt-1 text-xs text-[#6a7769]">
                {fullPhotoCount} of {reports.length} report
                {reports.length === 1 ? "" : "s"} have all six vehicle photos
                plus the driver selfie.
              </p>
            </div>
          </div>
        </section>
        <section className="paper-panel overflow-hidden rounded-2xl border border-[#d8d3c5]">
          <button
            type="button"
            onClick={() => setOpenDefects(c => !c)}
            className="flex w-full items-center justify-between border-b border-[#dfd9ca] px-5 py-5 text-left"
          >
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#6a7769]">
                Follow-up
              </p>
              <h2 className="font-slab text-2xl font-bold">Defects</h2>
            </div>
            <span
              className={cn(
                "rounded-full px-3 py-1 text-xs font-bold",
                openDefectCount > 0
                  ? "bg-[#fce8e3] text-[#b0402a]"
                  : "bg-[#e6f3ea] text-[#2f8b5e]"
              )}
            >
              {openDefectCount} open
            </span>
            <span className="text-xs font-bold uppercase tracking-[0.12em] text-[#e9682a]">
              {openDefects ? "Close" : "Open"}
            </span>
          </button>
          {openDefects && (
            <div>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#e5dfd3] px-5 py-3">
                <div className="flex flex-wrap gap-2">
                  {(
                    [
                      "open",
                      "in_progress",
                      "resolved",
                      "waived",
                      "all",
                    ] as const
                  ).map(status => (
                    <button
                      key={status}
                      type="button"
                      onClick={() => setDefectStatusFilter(status)}
                      className={cn(
                        "rounded-full px-3 py-1.5 text-xs font-bold",
                        defectStatusFilter === status
                          ? "bg-[#14532D] text-white"
                          : "bg-[#f5f1e7] text-[#6a7769]"
                      )}
                    >
                      {status.replaceAll("_", " ")}
                    </button>
                  ))}
                </div>
                <Button
                  onClick={() => void shareDefectsReport()}
                  disabled={generatingDefectsPdf}
                  className="h-9 bg-[#e9682a] text-xs font-bold text-white disabled:opacity-60"
                >
                  <Share2 className="mr-2 h-3.5 w-3.5" />
                  {generatingDefectsPdf
                    ? "Building report…"
                    : "Share defects PDF"}
                </Button>
              </div>
              <div className="divide-y divide-[#e5dfd3]">
                {filteredDefects.length === 0 ? (
                  <div className="p-6 text-sm text-[#6a7769]">
                    No defects in this view.
                  </div>
                ) : (
                  filteredDefects.map(defect => (
                    <div
                      key={defect.id}
                      className="flex flex-wrap items-center gap-3 px-5 py-4"
                    >
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 text-[10px] font-bold uppercase",
                          defect.severity === "critical" ||
                            defect.severity === "high"
                            ? "bg-[#fce8e3] text-[#b0402a]"
                            : "bg-[#fff0dc] text-[#a54d1f]"
                        )}
                      >
                        {defect.severity}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-bold">{defect.title}</div>
                        <div className="text-xs text-[#6a7769]">
                          {defect.inspection?.truck?.fleet_number ??
                            "Unknown fleet"}{" "}
                          · {defect.inspection?.driver_name ?? "Unknown driver"}{" "}
                          · {defect.inspection?.inspection_date}
                        </div>
                        {defect.description && (
                          <div className="mt-1 rounded-lg bg-[#f5f1e7] px-2.5 py-1.5 text-xs italic text-[#4c5a4c]">
                            "{defect.description}"
                          </div>
                        )}
                      </div>
                      <select
                        value={defect.status}
                        onChange={e =>
                          void updateDefectStatus(
                            defect,
                            e.target.value as AdminDefect["status"]
                          )
                        }
                        className="h-9 rounded-lg border border-[#d4cfc1] bg-white px-2 text-xs font-bold"
                      >
                        <option value="open">Open</option>
                        <option value="in_progress">In progress</option>
                        <option value="resolved">Resolved</option>
                        <option value="waived">Waived</option>
                      </select>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </section>
        <section className="paper-panel overflow-hidden rounded-2xl border border-[#d8d3c5]">
          <button
            type="button"
            onClick={() => setOpenAudit(c => !c)}
            className="flex w-full items-center justify-between border-b border-[#dfd9ca] px-5 py-5 text-left"
          >
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#6a7769]">
                Accountability
              </p>
              <h2 className="font-slab text-2xl font-bold">Audit log</h2>
            </div>
            <span className="rounded-full bg-[#e8eee5] px-3 py-1 text-xs font-bold">
              {auditEvents.length} events
            </span>
            <span className="text-xs font-bold uppercase tracking-[0.12em] text-[#e9682a]">
              {openAudit ? "Close" : "Open"}
            </span>
          </button>
          {openAudit && (
            <div className="divide-y divide-[#e5dfd3]">
              {auditEvents.length === 0 ? (
                <div className="p-6 text-sm text-[#6a7769]">
                  No recorded admin actions yet.
                </div>
              ) : (
                auditEvents.map(event => (
                  <div
                    key={event.id}
                    className="flex items-center gap-3 px-5 py-3"
                  >
                    <History className="h-4 w-4 text-[#6a7769]" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold">
                        {event.entity_type} · {event.action}
                      </div>
                      <div className="text-xs text-[#7c887b]">
                        {new Date(event.created_at).toLocaleString()}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </section>
        {selectedPhoto && (
          <div
            className="fixed inset-0 z-50 grid place-items-center bg-[#1f3529]/75 p-4"
            onClick={() => setSelectedPhoto(null)}
          >
            <div
              className="max-h-[90vh] max-w-3xl overflow-hidden rounded-2xl bg-[#fbf8ef] shadow-2xl"
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-center justify-between p-3">
                <div className="text-xs font-bold">
                  {selectedPhoto.truck} · {selectedPhoto.photo_type}
                </div>
                <Button variant="ghost" onClick={() => setSelectedPhoto(null)}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
              {selectedPhoto.url && (
                <img
                  src={selectedPhoto.url}
                  alt="Inspection evidence"
                  className="max-h-[78vh] w-full object-contain"
                />
              )}
              <div className="px-4 py-3 text-xs text-[#718070]">
                Captured by {selectedPhoto.driver} on{" "}
                {new Date(selectedPhoto.captured_at).toLocaleString()}
              </div>
            </div>
          </div>
        )}
        <section className="paper-panel overflow-hidden rounded-2xl border border-[#d8d3c5]">
          <button
            type="button"
            onClick={() => setOpenAdmins(current => !current)}
            className="flex w-full items-center justify-between border-b border-[#dfd9ca] px-5 py-5 text-left"
          >
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#6a7769]">
                Access control
              </p>
              <h2 className="font-slab text-2xl font-bold">Company admins</h2>
            </div>
            <span className="text-xs font-bold">{admins.length} admins</span>
            <span className="text-xs font-bold uppercase tracking-[0.12em] text-[#e9682a]">
              {openAdmins ? "Close" : "Open"}
            </span>
          </button>
          {openAdmins && (
            <div className="divide-y divide-[#e5dfd3]">
              {admins.length === 0 ? (
                <div className="px-5 py-4 text-sm text-[#7c887b]">
                  No admins added for this company yet.
                </div>
              ) : (
                admins.map(admin => (
                  <div
                    key={admin.id}
                    className="flex items-center gap-3 px-5 py-4"
                  >
                    <div className="grid h-9 w-9 place-items-center rounded-full bg-[#e9eee7] text-xs font-bold">
                      {admin.full_name
                        .split(" ")
                        .map(part => part[0])
                        .join("")
                        .slice(0, 2)
                        .toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-bold">
                        {admin.full_name}
                      </div>
                      <div className="text-xs text-[#849083]">
                        {admin.employee_number || "No employee number"}
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      onClick={() => void deleteAdmin(admin)}
                      className="h-8 text-xs text-[#a44b2d]"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))
              )}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
function ActionCard({
  icon: Icon,
  title,
  detail,
  open,
  onClick,
}: {
  icon: React.ElementType;
  title: string;
  detail: string;
  open: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "paper-panel flex items-center gap-4 rounded-2xl border border-[#d8d3c5] p-5 text-left transition hover:border-[#e9682a]",
        open && "border-[#e9682a] bg-[#fff6eb]"
      )}
    >
      <span className="grid h-11 w-11 place-items-center rounded-xl bg-[#e8eee5] text-[#45664e]">
        <Icon className="h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-slab text-xl font-bold">{title}</span>
        <span className="text-xs text-[#718070]">{detail}</span>
      </span>
      <span className="text-xs font-bold uppercase tracking-[0.12em] text-[#e9682a]">
        {open ? "Close" : "Open"}
      </span>
    </button>
  );
}
