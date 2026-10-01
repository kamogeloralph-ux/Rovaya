import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  CheckCircle2,
  Cloud,
  Loader2,
  MapPin,
  RotateCcw,
  ShieldCheck,
  RefreshCw,
  Wifi,
  WifiOff,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  getStoredCompany,
  setStoredCompany,
  type StoredCompany,
} from "@/lib/supabase";
import {
  fetchBootstrap,
  resolveCompanyCode,
  type DriverBootstrap,
} from "@/lib/api";
import {
  buildInspectionDraft,
  clearInspectionDraft,
  getInspectionSyncState,
  loadInspectionDraft,
  saveInspectionDraft,
  submitInspection,
  syncQueuedInspection,
  SYNC_STATES,
} from "@/lib/inspection-sync.js";
import CameraCapture from "@/components/CameraCapture";
import { RovayaBrand } from "@/components/RovayaBrand";

const photoSlots = [
  { id: "front", label: "Front", helper: "Headlamps & plate" },
  { id: "left", label: "Left side", helper: "Body & tyres" },
  { id: "right", label: "Right side", helper: "Body & tyres" },
  { id: "cab", label: "Interior", helper: "Controls & seat" },
  { id: "dashboard", label: "Dashboard", helper: "Warning lights" },
  { id: "rear", label: "Rear", helper: "Doors & lights" },
] as const;

type ChecklistSection = {
  id: string;
  number: string;
  title: string;
  note: string;
  items: { id: string; label: string; required: boolean }[];
};

// The checklist now arrives inside the single cached bootstrap response (Cloudflare edge + D1).
function buildChecklistSections(
  items: DriverBootstrap["checklist"]["items"]
): ChecklistSection[] {
  const sections: ChecklistSection[] = [];
  for (const item of items) {
    const sectionKey = item.section_number || item.section_title || "general";
    let section = sections.find(candidate => candidate.id === sectionKey);
    if (!section) {
      section = {
        id: sectionKey,
        number:
          item.section_number || String(sections.length + 1).padStart(2, "0"),
        title: item.section_title || "Checklist",
        note: "",
        items: [],
      };
      sections.push(section);
    }
    section.items.push({
      id: item.id,
      label: item.prompt,
      required: item.required !== false,
    });
  }
  return sections;
}
type Step = "identity" | "checklist" | "evidence";
type PhotoMap = Record<string, string>;
type InspectionLocation = {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  capturedAt: string;
};

async function compressCapturedImage(
  file: File,
  maxDimension = 1280
): Promise<File> {
  if (!file.type.startsWith("image/") || file.size < 700_000) return file;
  try {
    const bitmap =
      typeof createImageBitmap === "function"
        ? await createImageBitmap(file)
        : null;
    if (!bitmap) return file;
    const scale = Math.min(
      1,
      maxDimension / Math.max(bitmap.width, bitmap.height)
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) {
      bitmap.close();
      return file;
    }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>(resolve =>
      canvas.toBlob(resolve, "image/jpeg", 0.78)
    );
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", {
      type: "image/jpeg",
      lastModified: file.lastModified,
    });
  } catch {
    return file;
  }
}

function AppLogo() {
  return (
    <RovayaBrand imageClassName="w-[7.5rem] sm:w-[9rem]" subtitle={null} />
  );
}

function syncLabel(state: string) {
  if (state === SYNC_STATES.savedOnDevice) return "Saved on device";
  if (state === SYNC_STATES.uploading) return "Uploading";
  if (state === SYNC_STATES.syncing) return "Syncing";
  if (state === SYNC_STATES.failed) return "Sync failed";
  if (state === SYNC_STATES.submitted) return "Submitted";
  return "Draft";
}

function StepBar({
  step,
  onStep,
}: {
  step: Step;
  onStep: (step: Step) => void;
}) {
  const steps: { id: Step; label: string }[] = [
    { id: "identity", label: "Identity" },
    { id: "checklist", label: "Checklist" },
    { id: "evidence", label: "Evidence" },
  ];
  return (
    <div className="mb-6 grid grid-cols-3 gap-2">
      {steps.map((item, index) => {
        const active = item.id === step;
        const completed =
          steps.findIndex(candidate => candidate.id === step) > index;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onStep(item.id)}
            className={`rounded-xl border px-3 py-3 text-left transition active:scale-[0.98] ${active ? "border-[#2f4638] bg-[#2f4638] text-white" : completed ? "border-[#a7c3a7] bg-[#e9f2e7] text-[#2f5b3f]" : "border-[#d8d3c5] bg-[#fbf8ef] text-[#869184]"}`}
          >
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs font-bold">0{index + 1}</span>
              {completed && <Check className="h-3.5 w-3.5" />}
            </div>
            <div className="mt-1 text-xs font-bold uppercase tracking-[0.1em]">
              {item.label}
            </div>
          </button>
        );
      })}
    </div>
  );
}

// Purely presentational now — capture is handled by the in-app camera (CameraCapture) in
// the parent, with a hidden <input capture> rendered alongside each tile only as a fallback
// for when the in-app camera can't start. See CameraCapture.tsx for why.
function PhotoCapture({
  id,
  label,
  helper,
  preview,
  onTap,
  inputRef,
  onFallbackCapture,
}: {
  id: string;
  label: string;
  helper: string;
  preview?: string;
  onTap: () => void;
  inputRef: (el: HTMLInputElement | null) => void;
  onFallbackCapture: (event: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <div
      className={`relative min-h-[150px] overflow-hidden rounded-2xl border-2 ${preview ? "border-[#79a47e] bg-[#e8f0e5]" : "border-dashed border-[#c8c5b8] bg-[#f5f1e7]"}`}
    >
      {preview && (
        <img
          src={preview}
          alt={`${label} preview`}
          className="pointer-events-none absolute inset-0 h-full w-full object-cover"
        />
      )}
      {preview && (
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/60 via-black/10 to-transparent" />
      )}
      <button
        type="button"
        onClick={onTap}
        className="absolute inset-0 flex w-full flex-col justify-between p-3 text-left"
      >
        <div
          className={`grid h-9 w-9 place-items-center rounded-xl ${preview ? "bg-[#2f8b5e] text-white" : "bg-[#e5e9df] text-[#617562]"}`}
        >
          {preview ? (
            <Check className="h-5 w-5" />
          ) : (
            <Camera className="h-5 w-5" />
          )}
        </div>
        <div className="relative">
          <div
            className={`text-sm font-bold ${preview ? "text-white" : "text-[#3c513f]"}`}
          >
            {label}
          </div>
          <div
            className={`mt-1 text-[11px] ${preview ? "text-white/85" : "text-[#829083]"}`}
          >
            {preview ? "Captured — tap to retake" : helper}
          </div>
        </div>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={onFallbackCapture}
        className="sr-only"
        data-photo-id={id}
      />
    </div>
  );
}

function CompanyGate({
  onResolved,
}: {
  onResolved: (company: StoredCompany) => void;
}) {
  const [code, setCode] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setChecking(true);
    setError(null);
    const { data, error: resolveError } = await resolveCompanyCode(code);
    setChecking(false);
    if (resolveError || !data)
      return setError(
        resolveError?.message || "That access code was not recognized."
      );
    setStoredCompany(data);
    onResolved(data);
  };

  return (
    <main className="grid min-h-[100dvh] place-items-center bg-[#FAF6EF] px-4 py-8 text-[#14532D] sm:px-6">
      <section className="w-full max-w-md rounded-[2rem] border border-[#E7DFD0] bg-white px-6 py-9 shadow-[0_24px_60px_-24px_rgba(20,83,45,0.25)] sm:px-10 sm:py-12">
        <RovayaBrand imageClassName="w-[min(18rem,82vw)]" />
        <p className="mt-10 text-[0.72rem] font-bold uppercase tracking-[0.14em] text-[#E8590C]">
          Company access
        </p>
        <h2 className="mt-2 font-slab text-3xl font-bold leading-[1.15] tracking-[-0.02em]">
          Enter your company code.
        </h2>
        <p className="mt-3 text-base leading-6 text-[#6B7264]">
          Your fleet manager gave you a company access code. It links this
          device to the right fleet, drivers, and checklist.
        </p>
        <form onSubmit={submit} className="mt-8 flex flex-col gap-4">
          <label className="block">
            <span className="text-[0.72rem] font-bold uppercase tracking-[0.14em] text-[#6B7264]">
              Access code
            </span>
            <Input
              value={code}
              onChange={event => setCode(event.target.value.toUpperCase())}
              autoComplete="off"
              autoCapitalize="characters"
              placeholder="e.g. ACME-7Q2P"
              className="mt-2 h-auto w-full rounded-2xl border-[#E7DFD0] bg-white px-5 py-4 text-center font-mono text-lg font-bold text-[#14532D] outline-none focus:border-[#E8590C] focus:ring-4 focus:ring-[#E8590C]/15"
            />
          </label>
          {error && (
            <div className="rounded-2xl border border-[#f0b7a5] bg-[#fff1ec] px-4 py-3 text-sm leading-5 text-[#a33f2a]">
              {error}
            </div>
          )}
          <Button
            type="submit"
            disabled={checking || !code.trim()}
            className="mt-1 flex h-auto w-full items-center justify-center gap-3 rounded-full bg-gradient-to-br from-[#E8590C] to-[#D9480F] px-6 py-4 text-base font-medium text-[#FFF8F0] shadow-[0_12px_28px_-10px_rgba(232,89,12,0.55)] hover:brightness-105 disabled:opacity-60"
          >
            {checking ? "Checking…" : "Continue"}
            <ArrowRight className="h-5 w-5" />
          </Button>
        </form>
      </section>
    </main>
  );
}

function DriverWelcome({
  onStart,
  companyName,
  onChangeCompany,
}: {
  onStart: () => void;
  companyName: string;
  onChangeCompany: () => void;
}) {
  return (
    <main className="grid min-h-[100dvh] place-items-center bg-[#FAF6EF] px-4 py-8 text-[#14532D] sm:px-6">
      <section className="w-full max-w-md rounded-[2rem] border border-[#E7DFD0] bg-white px-6 py-9 shadow-[0_24px_60px_-24px_rgba(20,83,45,0.25)] sm:px-10 sm:py-12">
        <RovayaBrand imageClassName="w-[min(18rem,82vw)]" />
        <div className="mt-8 flex items-center justify-between rounded-2xl bg-[#f4f0e5] px-4 py-3">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#889286]">
              Company
            </p>
            <p className="font-slab text-base font-bold text-[#2e4335]">
              {companyName}
            </p>
          </div>
          <button
            type="button"
            onClick={onChangeCompany}
            className="text-xs font-bold uppercase tracking-[0.08em] text-[#e9682a] hover:underline"
          >
            Change
          </button>
        </div>
        <p className="mt-8 text-[0.72rem] font-bold uppercase tracking-[0.14em] text-[#E8590C]">
          Driver portal
        </p>
        <h2 className="mt-2 font-slab text-4xl font-bold leading-[1.15] tracking-[-0.02em]">
          Start your inspection.
        </h2>
        <p className="mt-3 text-base leading-6 text-[#6B7264]">
          Complete today’s safety checklist and capture the six required
          evidence photos for your fleet vehicle.
        </p>
        <Button
          type="button"
          onClick={onStart}
          className="mt-8 flex h-auto w-full items-center justify-center gap-3 rounded-full bg-gradient-to-br from-[#E8590C] to-[#D9480F] px-6 py-4 text-base font-medium text-[#FFF8F0] shadow-[0_12px_28px_-10px_rgba(232,89,12,0.55)] hover:brightness-105"
        >
          Start inspections <ArrowRight className="h-5 w-5" />
        </Button>
        <p className="mt-8 text-center text-sm text-[#6B7264]">
          Fast, paperless fleet safety records.
        </p>
      </section>
    </main>
  );
}

export default function Home() {
  const [company, setCompany] = useState<StoredCompany | null>(() =>
    getStoredCompany()
  );
  const [sections, setSections] = useState<ChecklistSection[]>([]);
  const [checklistLoading, setChecklistLoading] = useState(false);
  const [checklistError, setChecklistError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [step, setStep] = useState<Step>("identity");
  const [fullName, setFullName] = useState("");
  const [employeeNumber, setEmployeeNumber] = useState("");
  const [fleetNumber, setFleetNumber] = useState("");
  const [fleetOptions, setFleetOptions] = useState<
    { fleet_number: string; registration: string }[]
  >([]);
  const [fleetMenuOpen, setFleetMenuOpen] = useState(false);
  const [fleetLoading, setFleetLoading] = useState(false);
  const [fleetLoadError, setFleetLoadError] = useState<string | null>(null);
  const [openingKilometers, setOpeningKilometers] = useState("");
  const [shift, setShift] = useState<"morning" | "day" | "night" | "">("");
  const [inspectionLocation, setInspectionLocation] =
    useState<InspectionLocation | null>(null);
  const [locationState, setLocationState] = useState<
    "idle" | "capturing" | "captured" | "denied" | "unavailable"
  >("idle");
  const [selfieFile, setSelfieFile] = useState<File | undefined>();
  const selfieInputRef = useRef<HTMLInputElement>(null);
  const evidenceInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  // Which tile the in-app camera modal is currently open for, if any.
  const [cameraTarget, setCameraTarget] = useState<
    { kind: "selfie" } | { kind: "evidence"; id: string } | null
  >(null);
  // Once getUserMedia fails once (unsupported browser, denied permission, no camera),
  // stop retrying it for the rest of this session and go straight to the native camera
  // app fallback — retrying just adds a doomed loading spinner in front of the driver.
  const cameraAvailableRef = useRef(true);
  const [selfiePreview, setSelfiePreview] = useState<string>();
  const [photoFiles, setPhotoFiles] = useState<Record<string, File>>({});
  const [photos, setPhotos] = useState<PhotoMap>({});
  const [checks, setChecks] = useState<Record<string, boolean | undefined>>({});
  const [itemNotes, setItemNotes] = useState<Record<string, string>>({});
  const setItemNote = (id: string, value: string) =>
    setItemNotes(current => ({ ...current, [id]: value }));
  const [notes, setNotes] = useState("");
  const [online, setOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine
  );
  const [saving, setSaving] = useState(false);
  const [restored, setRestored] = useState(false);
  const [syncState, setSyncState] = useState<string>(SYNC_STATES.draft);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [backgroundSyncSupported, setBackgroundSyncSupported] = useState(false);
  const syncInFlight = useRef(false);

  const allItems = useMemo(
    () => sections.flatMap(section => section.items),
    [sections]
  );
  const answeredCount = useMemo(
    () => allItems.filter(item => checks[item.id] !== undefined).length,
    [checks, allItems]
  );
  const matchingFleets = useMemo(
    () =>
      fleetOptions
        .filter(fleet =>
          `${fleet.fleet_number} ${fleet.registration}`
            .toLowerCase()
            .includes(fleetNumber.toLowerCase())
        )
        .slice(0, 8),
    [fleetNumber, fleetOptions]
  );
  const photoCount = Object.keys(photoFiles).length;
  const identityReady =
    fullName.trim().split(/\s+/).length >= 2 &&
    Boolean(selfieFile) &&
    fleetNumber.trim().length > 0 &&
    openingKilometers !== "" &&
    Number(openingKilometers) >= 0 &&
    Boolean(shift);
  const checklistReady =
    allItems.length > 0 && answeredCount === allItems.length;
  const evidenceReady = photoCount === photoSlots.length;

  const changeCompany = () => {
    setStoredCompany(null);
    setCompany(null);
    setStarted(false);
    setStep("identity");
    setSections([]);
    setFleetOptions([]);
  };

  useEffect(() => {
    if (!company) return;
    let cancelled = false;
    setFleetLoading(true);
    setChecklistLoading(true);
    setChecklistError(null);
    fetchBootstrap(company.code)
      .then(data => {
        if (cancelled) return;
        setFleetOptions(data.trucks);
        setFleetLoadError(null);
        const loaded = buildChecklistSections(data.checklist.items);
        if (loaded.length === 0)
          setChecklistError(
            "This company has no active checklist configured yet. Contact your fleet admin."
          );
        setSections(loaded);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message =
          error instanceof Error
            ? error.message
            : "Unable to load your fleet list.";
        setFleetLoadError(message);
        setChecklistError(message);
        setSections([]);
      })
      .finally(() => {
        if (!cancelled) {
          setFleetLoading(false);
          setChecklistLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [company]);

  useEffect(() => {
    const setNetwork = () => setOnline(navigator.onLine);
    window.addEventListener("online", setNetwork);
    window.addEventListener("offline", setNetwork);
    void loadInspectionDraft()
      .then(async (draft: any) => {
        const savedStep =
          draft?.step ??
          window.sessionStorage.getItem("field-ledger-active-step");
        if (
          savedStep === "identity" ||
          savedStep === "checklist" ||
          savedStep === "evidence"
        ) {
          setStep(savedStep);
        }
        if (draft) {
          setFullName(draft.fullName ?? "");
          setEmployeeNumber(draft.employeeNumber ?? "");
          setFleetNumber(draft.selectedFleet ?? "");
          setOpeningKilometers(
            draft.openingKilometers == null
              ? ""
              : String(draft.openingKilometers)
          );
          setShift(draft.shift ?? "");
          if (
            draft.location?.latitude != null &&
            draft.location?.longitude != null
          ) {
            setInspectionLocation(draft.location);
            setLocationState("captured");
          }
          setChecks(draft.checks ?? {});
          setItemNotes(draft.itemNotes ?? {});
          setNotes(draft.notes ?? "");
          setHasQueuedDraft(Boolean(draft.queued));
          if (draft.selfieFile) {
            setSelfieFile(draft.selfieFile);
            setSelfiePreview(URL.createObjectURL(draft.selfieFile));
          }
          const nextFiles: Record<string, File> = {};
          const nextPreviews: PhotoMap = {};
          Object.entries(draft.photoFiles ?? {}).forEach(([id, file]) => {
            nextFiles[id] = file as File;
            nextPreviews[id] = URL.createObjectURL(file as File);
          });
          setPhotoFiles(nextFiles);
          setPhotos(nextPreviews);
        }
        const meta = await getInspectionSyncState();
        setSyncState(meta.state);
        setSyncError(meta.lastError);
        setLastSyncAt(meta.lastSyncAt);
        setRestored(true);
      })
      .catch(() => setRestored(true));
    return () => {
      window.removeEventListener("online", setNetwork);
      window.removeEventListener("offline", setNetwork);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const trySync = async () => {
      if (typeof navigator !== "undefined" && !navigator.onLine) return;
      try {
        const result = await syncQueuedInspection({
          checklistSections: sections,
        });
        if (!cancelled && result && !result.queued) {
          setHasQueuedDraft(false);
          setSyncState(SYNC_STATES.submitted);
          setSyncError(null);
          setLastSyncAt(new Date().toISOString());
          await clearInspectionDraft();
          toast.success(
            "A previously saved offline inspection has been uploaded."
          );
        }
      } catch (error) {
        if (!cancelled) {
          setSyncState(SYNC_STATES.failed);
          setSyncError(
            error instanceof Error
              ? error.message
              : "Sync failed. Your inspection remains on this device."
          );
        }
      }
    };
    void trySync();
    window.addEventListener("online", trySync);
    return () => {
      cancelled = true;
      window.removeEventListener("online", trySync);
    };
  }, [sections]);

  const draftRef = useRef({
    step,
    fullName,
    employeeNumber,
    fleetNumber,
    openingKilometers,
    shift,
    inspectionLocation,
    checks,
    itemNotes,
    notes,
    selfieFile,
    photoFiles,
  });
  draftRef.current = {
    step,
    fullName,
    employeeNumber,
    fleetNumber,
    openingKilometers,
    shift,
    inspectionLocation,
    checks,
    itemNotes,
    notes,
    selfieFile,
    photoFiles,
  };
  const saveDraftObject = (d: typeof draftRef.current) => {
    window.sessionStorage.setItem("field-ledger-active-step", d.step);
    void saveInspectionDraft(
      buildInspectionDraft({
        step: d.step,
        fullName: d.fullName,
        employeeNumber: d.employeeNumber,
        selectedFleet: d.fleetNumber,
        openingKilometers: d.openingKilometers,
        shift: d.shift,
        location: d.inspectionLocation as any,
        checks: d.checks,
        itemNotes: d.itemNotes,
        notes: d.notes,
        selfieFile: d.selfieFile,
        photoFiles: d.photoFiles,
        queued: false,
      })
    );
  };
  const flushDraft = () => saveDraftObject(draftRef.current);
  // Step changes are rare but high-stakes: right after moving to "evidence" the driver
  // immediately opens the camera, which can background (and on low-memory phones, kill)
  // the tab before the regular 250ms-debounced autosave below ever fires. Persisting the
  // step the instant it changes — not on a debounce — means a restored session always
  // lands back on the right screen instead of bouncing to the start.
  const goToStep = (nextStep: Step) => {
    setStep(nextStep);
    window.scrollTo({ top: 0, behavior: "smooth" });
    saveDraftObject({ ...draftRef.current, step: nextStep });
  };
  // React state updates aren't visible in draftRef until the next render, but a photo capture
  // needs to be persisted the instant it happens (that's the whole point — the tab may background
  // for the camera a moment later). This merges the just-captured file into the latest known draft
  // and writes it immediately, without waiting for a re-render.
  const flushDraftWith = (overrides: Partial<typeof draftRef.current>) =>
    saveDraftObject({ ...draftRef.current, ...overrides });
  const captureLocation = () => {
    if (!navigator.geolocation) {
      setLocationState("unavailable");
      return toast.info(
        "This device does not provide GPS. You can still submit the inspection."
      );
    }
    setLocationState("capturing");
    navigator.geolocation.getCurrentPosition(
      position => {
        const location: InspectionLocation = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: Number.isFinite(position.coords.accuracy)
            ? position.coords.accuracy
            : null,
          capturedAt: new Date(position.timestamp || Date.now()).toISOString(),
        };
        setInspectionLocation(location);
        setLocationState("captured");
        flushDraftWith({ inspectionLocation: location });
      },
      error => {
        setLocationState(
          error.code === error.PERMISSION_DENIED ? "denied" : "unavailable"
        );
        toast.info(
          error.code === error.PERMISSION_DENIED
            ? "Location permission was denied. The inspection can still be submitted without GPS."
            : "GPS is unavailable right now. You can retry before submitting."
        );
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  };

  useEffect(() => {
    if (!restored) return;
    const timer = window.setTimeout(flushDraft, 250);
    return () => window.clearTimeout(timer);
  }, [
    checks,
    fleetNumber,
    fullName,
    inspectionLocation,
    notes,
    openingKilometers,
    photoFiles,
    restored,
    selfieFile,
    shift,
    step,
  ]);

  // A camera capture hands the whole tab to the OS; on lower-memory phones the tab can be
  // reclaimed while it's away and reload from scratch on return. Flushing the draft immediately
  // whenever the tab backgrounds (rather than relying only on the debounced save above) makes
  // sure whatever was just captured is safely persisted before that handoff happens.
  useEffect(() => {
    if (!restored) return;
    const onHide = () => {
      if (document.visibilityState === "hidden") flushDraft();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flushDraft);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flushDraft);
    };
  }, [restored]);

  useEffect(
    () => () => {
      if (selfiePreview?.startsWith("blob:"))
        URL.revokeObjectURL(selfiePreview);
    },
    [selfiePreview]
  );
  const applySelfieFile = (file?: File) => {
    if (!file) return;
    // Show the raw photo immediately for instant feedback, but don't persist it to the
    // draft yet — a full-size camera photo (often several MB) can take long enough to
    // write to IndexedDB that a low-memory phone kills the tab mid-write when the driver
    // moves straight on to the checklist or the next photo. Compressing first means the
    // draft only ever has to persist a small file, which finishes fast enough to survive.
    setSelfiePreview(current => {
      if (current?.startsWith("blob:")) URL.revokeObjectURL(current);
      return URL.createObjectURL(file);
    });
    void compressCapturedImage(file).then(compactFile => {
      setSelfieFile(compactFile);
      setSelfiePreview(current => {
        if (current?.startsWith("blob:")) URL.revokeObjectURL(current);
        return URL.createObjectURL(compactFile);
      });
      flushDraftWith({ selfieFile: compactFile });
    });
  };
  // Fallback path only: fires from the hidden <input capture> if the in-app camera can't start.
  const captureSelfie = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    applySelfieFile(file);
  };
  const capturePhoto = (id: string, file?: File) => {
    if (!file) return;
    const scrollY = window.scrollY;
    // Same reasoning as applySelfieFile: show the photo instantly, but only persist the
    // compressed (small) version to the draft. Writing a raw multi-megabyte camera photo
    // to IndexedDB right as the driver backgrounds the tab for the next photo is the
    // biggest single cause of a lost draft — the write simply doesn't finish in time.
    setPhotos(current => {
      if (current[id]?.startsWith("blob:")) URL.revokeObjectURL(current[id]);
      return { ...current, [id]: URL.createObjectURL(file) };
    });
    requestAnimationFrame(() => window.scrollTo({ top: scrollY }));
    window.setTimeout(() => window.scrollTo({ top: scrollY }), 250);
    void compressCapturedImage(file).then(compactFile => {
      setPhotoFiles(current => {
        const next = { ...current, [id]: compactFile };
        flushDraftWith({ photoFiles: next });
        return next;
      });
      setPhotos(current => {
        if (current[id]?.startsWith("blob:")) URL.revokeObjectURL(current[id]);
        return { ...current, [id]: URL.createObjectURL(compactFile) };
      });
    });
  };
  // Tapping a photo tile opens the in-app camera (CameraCapture) rather than handing off to
  // the OS camera app, so the tab never backgrounds and can't be killed mid-capture. Only if
  // the in-app camera can't start at all do we fall back to the old <input capture> handoff.
  const openCameraFor = (
    target: { kind: "selfie" } | { kind: "evidence"; id: string }
  ) => {
    if (!cameraAvailableRef.current) {
      if (target.kind === "selfie") selfieInputRef.current?.click();
      else evidenceInputRefs.current[target.id]?.click();
      return;
    }
    setCameraTarget(target);
  };
  const handleCameraCapture = (file: File) => {
    const target = cameraTarget;
    setCameraTarget(null);
    if (!target) return;
    if (target.kind === "selfie") applySelfieFile(file);
    else capturePhoto(target.id, file);
  };
  const handleCameraUnavailable = () => {
    cameraAvailableRef.current = false;
    const target = cameraTarget;
    setCameraTarget(null);
    if (target?.kind === "selfie") selfieInputRef.current?.click();
    else if (target?.kind === "evidence")
      evidenceInputRefs.current[target.id]?.click();
  };
  const setCheck = (id: string, value: boolean) =>
    setChecks(current => ({ ...current, [id]: value }));
  const next = () => {
    if (step === "identity") {
      if (!fullName.trim() || fullName.trim().split(/\s+/).length < 2)
        return toast.error("Enter your full names and surnames.");
      if (!fleetNumber.trim()) return toast.error("Choose a fleet number.");
      if (
        fleetOptions.length > 0 &&
        !fleetOptions.some(fleet => fleet.fleet_number === fleetNumber.trim())
      )
        return toast.error("Choose a fleet number from the list.");
      if (openingKilometers === "" || Number(openingKilometers) < 0)
        return toast.error("Enter valid opening kilometers.");
      if (!shift) return toast.error("Select a shift.");
      if (!selfieFile) return toast.error("Take a selfie before continuing.");
      goToStep("checklist");
    } else if (step === "checklist") {
      if (!checklistReady)
        return toast.error(
          `${allItems.length - answeredCount} checklist answers still need a response.`
        );
      goToStep("evidence");
    }
  };
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [hasQueuedDraft, setHasQueuedDraft] = useState(false);
  const [showSignOff, setShowSignOff] = useState(false);
  const [signOffInput, setSignOffInput] = useState("");
  const resetInspection = () => {
    setFullName("");
    setEmployeeNumber("");
    setFleetNumber("");
    setOpeningKilometers("");
    setShift("");
    setInspectionLocation(null);
    setLocationState("idle");
    window.sessionStorage.removeItem("field-ledger-active-step");
    setSelfieFile(undefined);
    setSelfiePreview(undefined);
    setPhotoFiles({});
    setPhotos({});
    setChecks({});
    setItemNotes({});
    setNotes("");
    setStep("identity");
    setHasQueuedDraft(false);
    void clearInspectionDraft();
    setConfirmingReset(false);
    toast.success("Started a fresh inspection.");
  };
  const syncNow = async () => {
    if (syncInFlight.current) return;
    if (!online)
      return toast.info(
        "You are offline. The inspection will sync when internet returns."
      );
    const draft: any = await loadInspectionDraft().catch(() => null);
    if (!draft?.queued) {
      setSyncState(SYNC_STATES.submitted);
      return toast.success("There are no pending inspections to sync.");
    }
    if (!company) return toast.error("No company selected.");
    syncInFlight.current = true;
    setSyncState(SYNC_STATES.syncing);
    setSyncError(null);
    try {
      await syncQueuedInspection({ checklistSections: sections });
      await clearInspectionDraft();
      setHasQueuedDraft(false);
      setSyncState(SYNC_STATES.submitted);
      setLastSyncAt(new Date().toISOString());
      toast.success("Inspection synced successfully.");
    } catch (error) {
      setSyncState(SYNC_STATES.failed);
      setSyncError(
        error instanceof Error
          ? error.message
          : "Sync failed. Your inspection is still stored on this device."
      );
      toast.error(
        "Sync failed. Your inspection is still safely stored on this device."
      );
    } finally {
      syncInFlight.current = false;
    }
  };
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "rovaya-background-sync") void syncNow();
    };
    navigator.serviceWorker?.addEventListener("message", onMessage);
    void navigator.serviceWorker?.ready.then(registration => {
      if ("sync" in registration) setBackgroundSyncSupported(true);
    });
    return () =>
      navigator.serviceWorker?.removeEventListener("message", onMessage);
  }, [online, company, sections, hasQueuedDraft]);
  const submit = async () => {
    if (syncInFlight.current || saving) return;
    if (!company) return toast.error("No company selected.");
    if (!identityReady)
      return toast.error("Full names, surnames, and selfie are required.");
    if (!checklistReady)
      return toast.error("Answer every checklist item before submitting.");
    if (!evidenceReady)
      return toast.error(
        `Capture all ${photoSlots.length} evidence photos before submitting.`
      );
    syncInFlight.current = true;
    setSaving(true);
    setSyncState(online ? SYNC_STATES.uploading : SYNC_STATES.savedOnDevice);
    try {
      const result: any = await submitInspection({
        fullName: fullName.trim(),
        employeeNumber: employeeNumber.trim(),
        selectedFleet: fleetNumber.trim(),
        openingKilometers,
        shift,
        checks,
        itemNotes,
        notes,
        selfieFile,
        photoFiles,
        companyId: company.companyId,
        companyCode: company.code,
      });
      if (result.queued) {
        setHasQueuedDraft(true);
        setSyncState(SYNC_STATES.savedOnDevice);
        toast.success(
          "Inspection saved on this device. It will upload automatically when internet returns."
        );
      } else {
        setSyncState(SYNC_STATES.submitted);
        setLastSyncAt(new Date().toISOString());
        toast.success("Inspection submitted successfully.");
        await clearInspectionDraft();
      }
      setFullName("");
      setEmployeeNumber("");
      setFleetNumber("");
      setOpeningKilometers("");
      setShift("");
      setInspectionLocation(null);
      setLocationState("idle");
      window.sessionStorage.removeItem("field-ledger-active-step");
      setSelfieFile(undefined);
      setSelfiePreview(undefined);
      setPhotoFiles({});
      setPhotos({});
      setChecks({});
      setItemNotes({});
      setNotes("");
      setStep("identity");
    } catch (error) {
      setSyncState(SYNC_STATES.failed);
      setSyncError(
        error instanceof Error
          ? error.message
          : "Unable to submit. Your draft is still saved safely."
      );
      toast.error(
        error instanceof Error
          ? error.message
          : "Unable to submit. Your draft is still saved safely."
      );
    } finally {
      syncInFlight.current = false;
      setSaving(false);
    }
  };

  if (!company) return <CompanyGate onResolved={setCompany} />;
  if (!started)
    return (
      <DriverWelcome
        onStart={() => {
          setStarted(true);
          captureLocation();
        }}
        companyName={company.companyName}
        onChangeCompany={changeCompany}
      />
    );
  return (
    <div className="min-h-screen bg-[#ede9dd] text-[#2e4335]">
      <header className="sticky top-0 z-20 border-b border-[#d8d3c5] bg-[#f7f3e9]/95 px-4 py-4 backdrop-blur sm:px-8">
        <div className="mx-auto flex max-w-5xl items-center justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={() => setStarted(false)}
              aria-label="Back to welcome screen"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-[#d8d3c5] bg-[#fbf8ef] text-[#14532D] hover:bg-white"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <AppLogo />
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setConfirmingReset(true)}
              className="flex items-center gap-1.5 rounded-full border border-[#d8d3c5] bg-[#fbf8ef] px-3 py-2 text-xs font-bold text-[#6a7769] hover:bg-white"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Reset
            </button>
            <div
              className={`flex items-center gap-2 rounded-full px-3 py-2 text-xs font-bold ${syncState === SYNC_STATES.failed ? "bg-[#fff0dc] text-[#a54d1f]" : syncState === SYNC_STATES.submitted ? "bg-[#e5efe5] text-[#2f5b3f]" : "bg-[#eef0e8] text-[#617562]"}`}
            >
              <Cloud className="h-3.5 w-3.5" />
              {syncLabel(syncState)}
            </div>
            {(hasQueuedDraft || syncState === SYNC_STATES.failed) && (
              <button
                type="button"
                onClick={() => void syncNow()}
                disabled={syncState === SYNC_STATES.syncing || !online}
                className="flex items-center gap-1.5 rounded-full bg-[#2f4638] px-3 py-2 text-xs font-bold text-white disabled:opacity-50"
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${syncState === SYNC_STATES.syncing ? "animate-spin" : ""}`}
                />
                Sync now
              </button>
            )}
            <div
              className={`hidden items-center gap-2 rounded-full px-3 py-2 text-xs font-bold sm:flex ${online ? "bg-[#e5efe5] text-[#2f5b3f]" : "bg-[#fff0dc] text-[#a54d1f]"}`}
            >
              {online ? (
                <Wifi className="h-3.5 w-3.5" />
              ) : (
                <WifiOff className="h-3.5 w-3.5" />
              )}
              {online ? "Online" : "Offline"}
            </div>
          </div>
        </div>
      </header>
      {confirmingReset && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 px-4">
          <div className="w-full max-w-sm rounded-2xl border border-[#d8d3c5] bg-[#fbf8ef] p-6 shadow-[0_24px_60px_-24px_rgba(20,83,45,0.35)]">
            <h3 className="font-slab text-xl font-bold text-[#14532D]">
              Start a fresh inspection?
            </h3>
            <p className="mt-2 text-sm leading-5 text-[#6d7a6d]">
              This clears your identity, checklist answers, and captured photos
              on this device. This can't be undone.
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setConfirmingReset(false)}
                className="h-11 rounded-xl border border-[#d3cec0] bg-white px-4 text-sm font-bold text-[#2e4335]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={resetInspection}
                className="h-11 rounded-xl bg-[#b0402a] px-4 text-sm font-bold text-white"
              >
                Reset everything
              </button>
            </div>
          </div>
        </div>
      )}
      {showSignOff && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 px-4">
          <div className="w-full max-w-sm rounded-2xl border border-[#d8d3c5] bg-[#fbf8ef] p-6 shadow-[0_24px_60px_-24px_rgba(20,83,45,0.35)]">
            <h3 className="font-slab text-xl font-bold text-[#14532D]">
              Sign &amp; submit
            </h3>
            <p className="mt-2 text-sm leading-5 text-[#6d7a6d]">
              Type your full name exactly as entered in step 1 to confirm this
              inspection is accurate and complete.
            </p>
            <p className="mt-3 rounded-lg bg-white px-3 py-2 font-mono text-sm font-bold text-[#2e4335]">
              {fullName}
            </p>
            <Input
              value={signOffInput}
              onChange={event => setSignOffInput(event.target.value)}
              autoFocus
              placeholder="Type your full name"
              className="mt-3 h-11 rounded-xl border-[#d3cec0] bg-white text-sm font-semibold"
            />
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setShowSignOff(false)}
                className="h-11 rounded-xl border border-[#d3cec0] bg-white px-4 text-sm font-bold text-[#2e4335]"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={
                  signOffInput.trim().toLowerCase() !==
                    fullName.trim().toLowerCase() || saving
                }
                onClick={() => {
                  setShowSignOff(false);
                  void submit();
                }}
                className="h-11 rounded-xl bg-[#e9682a] px-4 text-sm font-bold text-white disabled:opacity-40"
              >
                Confirm &amp; submit
              </button>
            </div>
          </div>
        </div>
      )}
      <main className="mx-auto max-w-5xl px-4 py-6 pb-16 sm:px-8 sm:py-10">
        <section className="mb-6 rounded-2xl border border-[#d8d3c5] bg-[#f7f3e9] p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#788578]">
                Inspection Sync Center
              </p>
              <p className="mt-1 text-sm font-bold text-[#2e4335]">
                {syncLabel(syncState)}
                {lastSyncAt
                  ? ` · Last sync ${new Date(lastSyncAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                  : ""}
              </p>
              {syncError && (
                <p className="mt-1 max-w-xl text-xs text-[#a54d1f]">
                  {syncError}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span
                className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${hasQueuedDraft ? "bg-[#fff0dc] text-[#a54d1f]" : "bg-[#e5efe5] text-[#2f5b3f]"}`}
              >
                {hasQueuedDraft
                  ? "1 pending inspection"
                  : "No pending inspections"}
              </span>
              {hasQueuedDraft && (
                <button
                  type="button"
                  onClick={() => void syncNow()}
                  disabled={!online || syncState === SYNC_STATES.syncing}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-[#2f4638] px-3 py-2 text-xs font-bold text-white disabled:opacity-50"
                >
                  <RefreshCw
                    className={`h-3.5 w-3.5 ${syncState === SYNC_STATES.syncing ? "animate-spin" : ""}`}
                  />
                  Sync now
                </button>
              )}
            </div>
          </div>
          {backgroundSyncSupported && (
            <p className="mt-3 text-xs text-[#617562]">
              Automatic background sync is enabled on this device.
            </p>
          )}
          {!backgroundSyncSupported && (
            <p className="mt-3 text-xs text-[#617562]">
              This browser will retry automatically when the app is open or when
              you tap Sync now.
            </p>
          )}
          {!online && (
            <p className="mt-3 text-xs text-[#a54d1f]">
              Offline mode is active. Your work is stored securely on this
              device and will retry when connection returns.
            </p>
          )}
        </section>
        <div className="mb-6 flex items-end justify-between gap-4">
          <div>
            <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.18em] text-[#e9682a]">
              Daily safety record
            </div>
            <h1 className="font-slab text-3xl font-bold tracking-[-0.04em] sm:text-5xl">
              Start an inspection.
            </h1>
            <p className="mt-2 max-w-xl text-sm leading-6 text-[#6d7a6d]">
              Capture your identity, complete every check, and record all six
              evidence zones. Nothing can be submitted incomplete.
            </p>
          </div>
          <div className="hidden items-center gap-2 text-xs font-semibold text-[#708070] sm:flex">
            <Cloud className="h-4 w-4 text-[#e9682a]" />
            Autosaves every change
          </div>
        </div>
        <StepBar
          step={step}
          onStep={nextStep => {
            if (nextStep === "checklist" && !identityReady)
              return toast.error("Complete your name and selfie first.");
            if (nextStep === "evidence" && !checklistReady)
              return toast.error("Answer every checklist item first.");
            goToStep(nextStep);
          }}
        />
        {step === "identity" && (
          <section className="paper-panel rounded-2xl border border-[#d8d3c5] p-5 sm:p-8">
            <div className="grid gap-8 md:grid-cols-[1fr_280px]">
              <div>
                <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.16em] text-[#6a7769]">
                  01 / Your details
                </div>
                <h2 className="font-slab text-2xl font-bold">
                  Who is completing this record?
                </h2>
                <p className="mt-2 text-sm leading-6 text-[#758275]">
                  Enter your full names and surnames exactly as they should
                  appear on the safety record.
                </p>
                <label className="mt-6 block text-xs font-bold uppercase tracking-[0.12em] text-[#788578]">
                  Full names and surnames
                </label>
                <Input
                  value={fullName}
                  onChange={event => setFullName(event.target.value)}
                  autoComplete="name"
                  placeholder="e.g. Thabo Kabelo Mokoena"
                  className="mt-2 h-12 rounded-xl border-[#d3cec0] bg-[#fbf8ef] text-base font-semibold"
                />
                <label className="mt-5 block text-xs font-bold uppercase tracking-[0.12em] text-[#788578]">
                  Employee number{" "}
                  <span className="font-normal normal-case tracking-normal text-[#a2aa9f]">
                    (optional)
                  </span>
                  <Input
                    value={employeeNumber}
                    onChange={event => setEmployeeNumber(event.target.value)}
                    autoComplete="off"
                    placeholder="e.g. EMP-0231"
                    className="mt-2 h-12 rounded-xl border-[#d3cec0] bg-[#fbf8ef] text-base font-semibold"
                  />
                </label>
                <label className="relative mt-5 block text-xs font-bold uppercase tracking-[0.12em] text-[#788578]">
                  Fleet number
                  <div className="relative mt-2">
                    <Input
                      value={fleetNumber}
                      onFocus={() => {
                        setFleetMenuOpen(true);
                        if (fleetOptions.length === 0 && company)
                          void fetchBootstrap(company.code)
                            .then(data => {
                              setFleetOptions(data.trucks);
                              setFleetLoadError(null);
                            })
                            .catch(() => undefined);
                      }}
                      onChange={event => {
                        setFleetNumber(event.target.value);
                        setFleetMenuOpen(true);
                      }}
                      onBlur={() =>
                        window.setTimeout(() => setFleetMenuOpen(false), 150)
                      }
                      autoComplete="off"
                      inputMode="numeric"
                      placeholder="Type to search fleet numbers"
                      className="h-12 w-full rounded-xl border-[#d3cec0] bg-[#fbf8ef] font-mono text-base font-bold"
                    />
                    {fleetMenuOpen && fleetOptions.length > 0 && (
                      <div className="absolute left-0 right-0 top-[calc(100%+0.35rem)] z-30 max-h-56 overflow-y-auto rounded-xl border border-[#d8d3c5] bg-white p-1 shadow-[0_18px_35px_-18px_rgba(20,83,45,0.5)]">
                        {matchingFleets.length > 0 ? (
                          matchingFleets.map(fleet => (
                            <button
                              key={fleet.fleet_number}
                              type="button"
                              onMouseDown={event => event.preventDefault()}
                              onClick={() => {
                                setFleetNumber(fleet.fleet_number);
                                setFleetMenuOpen(false);
                              }}
                              className="flex w-full items-center justify-between rounded-lg px-3 py-3 text-left hover:bg-[#f2f7ef]"
                            >
                              <span className="font-mono text-sm font-bold text-[#14532D]">
                                {fleet.fleet_number}
                              </span>
                              <span className="text-xs text-[#6B7264]">
                                {fleet.registration}
                              </span>
                            </button>
                          ))
                        ) : (
                          <p className="px-3 py-3 text-xs text-[#6B7264]">
                            No matching fleet numbers.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </label>
                <div className="mt-5 grid gap-4 sm:grid-cols-2">
                  <label className="block text-xs font-bold uppercase tracking-[0.12em] text-[#788578]">
                    Opening kilometers
                    <Input
                      value={openingKilometers}
                      onChange={event =>
                        setOpeningKilometers(
                          event.target.value.replace(/[^0-9]/g, "")
                        )
                      }
                      inputMode="numeric"
                      placeholder="e.g. 184520"
                      className="mt-2 h-12 rounded-xl border-[#d3cec0] bg-[#fbf8ef] font-mono text-base font-bold"
                    />
                  </label>
                  <label className="block text-xs font-bold uppercase tracking-[0.12em] text-[#788578]">
                    Shift
                    <select
                      value={shift}
                      onChange={event =>
                        setShift(event.target.value as typeof shift)
                      }
                      className="mt-2 h-12 w-full rounded-xl border border-[#d3cec0] bg-[#fbf8ef] px-3 text-sm font-semibold text-[#2e4335]"
                    >
                      <option value="">Select shift</option>
                      <option value="morning">Morning shift</option>
                      <option value="day">Day shift</option>
                      <option value="night">Night shift</option>
                    </select>
                  </label>
                </div>
                <div className="rounded-2xl border border-[#d8e5d5] bg-[#f1f7ef] p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.12em] text-[#2f5b3f]">
                        <MapPin className="h-4 w-4" />
                        Inspection location
                      </div>
                      <p className="mt-1 text-[11px] leading-4 text-[#718070]">
                        Capture one GPS point for this inspection. We do not
                        track you continuously.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={captureLocation}
                      disabled={locationState === "capturing"}
                      className="shrink-0 rounded-lg border border-[#bfd2c2] bg-white px-2.5 py-2 text-[10px] font-bold uppercase tracking-[0.06em] text-[#2f5b3f] disabled:opacity-50"
                    >
                      {locationState === "capturing"
                        ? "Locating…"
                        : inspectionLocation
                          ? "Refresh"
                          : "Capture"}
                    </button>
                  </div>
                  {inspectionLocation ? (
                    <p className="mt-2 font-mono text-[11px] font-bold text-[#2f5b3f]">
                      {inspectionLocation.latitude.toFixed(6)},{" "}
                      {inspectionLocation.longitude.toFixed(6)}
                      {inspectionLocation.accuracy != null
                        ? ` · ±${Math.round(inspectionLocation.accuracy)} m`
                        : ""}
                    </p>
                  ) : (
                    <p className="mt-2 text-[11px] text-[#8a6a43]">
                      {locationState === "denied"
                        ? "Permission denied — submission remains available without GPS."
                        : locationState === "unavailable"
                          ? "GPS unavailable — retry or continue without it."
                          : "Not captured yet — optional."}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex flex-col items-center justify-center rounded-2xl bg-[#f4f0e5] p-4">
                <div className="relative grid h-44 w-44 place-items-center overflow-hidden rounded-full border-4 border-[#d6e4d3] bg-[#e9eee8]">
                  {selfiePreview ? (
                    <img
                      src={selfiePreview}
                      alt="Selfie preview"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <Camera className="h-10 w-10 text-[#6e876e]" />
                  )}
                </div>
                <label className="mt-4 w-full">
                  <Button
                    type="button"
                    onClick={() => openCameraFor({ kind: "selfie" })}
                    className="h-11 w-full rounded-xl bg-[#2f4638] font-bold text-white"
                  >
                    {selfiePreview ? "Retake selfie" : "Take selfie"}
                  </Button>
                  <input
                    ref={selfieInputRef}
                    id="selfie-input"
                    type="file"
                    accept="image/*"
                    capture="user"
                    onChange={captureSelfie}
                    className="sr-only"
                  />
                </label>
                <p className="mt-2 text-center text-[11px] leading-4 text-[#829083]">
                  A front-camera selfie is required.
                </p>
              </div>
            </div>
            <div className="mt-8 flex justify-end">
              <Button
                onClick={next}
                className="h-12 rounded-xl bg-[#2f4638] px-6 font-bold text-white"
              >
                Continue to checklist <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </div>
          </section>
        )}
        {step === "checklist" && (
          <section>
            <div className="mb-4 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <RovayaBrand imageClassName="w-[9rem]" subtitle={null} />
                <div>
                  <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#E8590C]">
                    02 / Safety checklist
                  </div>
                  <h2 className="mt-1 font-slab text-2xl font-bold text-[#14532D]">
                    Answer every item.
                  </h2>
                </div>
              </div>
              <div className="rounded-full bg-[#e9f5ea] px-3 py-2 font-mono text-xs font-bold text-[#14532D]">
                {answeredCount} / {allItems.length}
              </div>
            </div>
            <div className="space-y-4">
              {checklistLoading ? (
                <div className="paper-panel rounded-2xl border border-[#d8d3c5] p-8 text-center text-sm text-[#6d7a6d]">
                  Loading {company.companyName}'s checklist…
                </div>
              ) : checklistError ? (
                <div className="paper-panel rounded-2xl border border-[#f0b7a5] bg-[#fff1ec] p-8 text-center text-sm text-[#a33f2a]">
                  {checklistError}
                </div>
              ) : (
                sections.map(section => (
                  <div
                    key={section.id}
                    className="paper-panel rounded-2xl border border-[#d8d3c5] p-4 sm:p-6"
                  >
                    <div className="mb-4 flex items-center gap-3">
                      <div className="grid h-9 w-9 place-items-center rounded-xl bg-[#2f4638] font-mono text-xs font-bold text-white">
                        {section.number}
                      </div>
                      <div>
                        <h3 className="font-slab text-xl font-bold">
                          {section.title}
                        </h3>
                        <p className="text-xs text-[#849083]">{section.note}</p>
                      </div>
                    </div>
                    <div className="divide-y divide-[#e5dfd3] border-t border-[#e5dfd3]">
                      {section.items.map(item => (
                        <div key={item.id} className="flex flex-col gap-3 py-4">
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                            <div className="flex-1 text-sm font-semibold leading-5 text-[#445746]">
                              {item.label}
                            </div>
                            <div className="grid grid-cols-2 gap-2 sm:w-44">
                              <button
                                type="button"
                                onClick={() => setCheck(item.id, true)}
                                className={`rounded-xl border py-3 text-xs font-bold uppercase tracking-[0.1em] ${checks[item.id] === true ? "border-[#2f8b5e] bg-[#2f8b5e] text-white" : "border-[#b8c0b4] bg-[#fbf8ef] text-[#617562]"}`}
                              >
                                Yes
                              </button>
                              <button
                                type="button"
                                onClick={() => setCheck(item.id, false)}
                                className={`rounded-xl border py-3 text-xs font-bold uppercase tracking-[0.1em] ${checks[item.id] === false ? "border-[#b65323] bg-[#b65323] text-white" : "border-[#b8c0b4] bg-[#fbf8ef] text-[#617562]"}`}
                              >
                                No
                              </button>
                            </div>
                          </div>
                          {checks[item.id] === false && (
                            <div className="rounded-xl border border-[#f0b7a5] bg-[#fff6f3] p-3">
                              <label className="text-[11px] font-bold uppercase tracking-[0.1em] text-[#a33f2a]">
                                What's the issue?
                              </label>
                              <textarea
                                value={itemNotes[item.id] ?? ""}
                                onChange={event =>
                                  setItemNote(item.id, event.target.value)
                                }
                                rows={2}
                                autoFocus
                                placeholder="Describe the fault so it can be actioned…"
                                className="mt-1.5 w-full resize-none rounded-lg border border-[#f0b7a5] bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#f0b7a5]"
                              />
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
            <div className="mt-5 flex justify-between gap-3">
              <Button
                variant="outline"
                onClick={() => goToStep("identity")}
                className="h-11 rounded-xl border-[#d3cec0] bg-[#fbf8ef] font-bold"
              >
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back
              </Button>
              <Button
                onClick={next}
                className="h-11 rounded-xl bg-[#2f4638] px-5 font-bold text-white"
              >
                Continue to evidence <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </div>
          </section>
        )}
        {step === "evidence" && (
          <section>
            <div className="mb-4 flex items-end justify-between">
              <div>
                <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-[#6a7769]">
                  03 / Evidence photos
                </div>
                <h2 className="mt-1 font-slab text-2xl font-bold">
                  Capture all six zones.
                </h2>
                <p className="mt-2 text-sm text-[#758275]">
                  Stay on this page while moving around the vehicle. Each zone
                  saves immediately.
                </p>
              </div>
              <div className="rounded-full bg-[#e5efe5] px-3 py-2 font-mono text-xs font-bold text-[#2f5b3f]">
                {photoCount} / 6
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {photoSlots.map(slot => (
                <PhotoCapture
                  key={slot.id}
                  {...slot}
                  preview={photos[slot.id]}
                  onTap={() => openCameraFor({ kind: "evidence", id: slot.id })}
                  inputRef={el => {
                    evidenceInputRefs.current[slot.id] = el;
                  }}
                  onFallbackCapture={event => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    capturePhoto(slot.id, file);
                  }}
                />
              ))}
            </div>
            <div className="paper-panel mt-4 rounded-2xl border border-[#d8d3c5] p-4">
              <label className="text-xs font-bold uppercase tracking-[0.12em] text-[#788578]">
                Notes or deviations{" "}
                <span className="font-normal normal-case tracking-normal text-[#a2aa9f]">
                  (optional)
                </span>
              </label>
              <textarea
                value={notes}
                onChange={event => setNotes(event.target.value)}
                rows={3}
                className="mt-2 w-full resize-none rounded-xl border border-[#d3cec0] bg-[#fbf8ef] px-3 py-3 text-sm outline-none focus:ring-2 focus:ring-[#dfe9dc]"
                placeholder="Add context for any answer marked No…"
              />
            </div>
            <div className="mt-5 flex flex-col-reverse justify-between gap-3 sm:flex-row">
              <Button
                variant="outline"
                onClick={() => goToStep("checklist")}
                className="h-12 rounded-xl border-[#d3cec0] bg-[#fbf8ef] font-bold"
              >
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to checklist
              </Button>
              <Button
                disabled={saving}
                onClick={() => {
                  if (!fullName.trim())
                    return toast.error("Enter your full name in step 1 first.");
                  setSignOffInput("");
                  setShowSignOff(true);
                }}
                className="h-12 rounded-xl bg-[#e9682a] px-7 font-bold text-white shadow-[4px_4px_0_#c9a27e] hover:bg-[#d9571b]"
              >
                {saving ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Saving inspection…
                  </>
                ) : (
                  <>
                    <ShieldCheck className="mr-2 h-4 w-4" />
                    Submit complete inspection
                  </>
                )}
              </Button>
            </div>
          </section>
        )}
        <div className="mt-8 flex items-center justify-center gap-2 text-center text-xs text-[#879185]">
          {online ? (
            <Cloud className="h-4 w-4 text-[#6ba377]" />
          ) : (
            <WifiOff className="h-4 w-4 text-[#e9682a]" />
          )}{" "}
          {online
            ? "Your progress is saved and ready to sync."
            : "No internet required — photos and selfie are stored on this device."}
        </div>
      </main>
      <CameraCapture
        open={cameraTarget !== null}
        facingMode={cameraTarget?.kind === "selfie" ? "user" : "environment"}
        title={
          cameraTarget?.kind === "selfie"
            ? "Selfie"
            : (photoSlots.find(slot => slot.id === (cameraTarget as any)?.id)
                ?.label ?? "Photo")
        }
        onCapture={handleCameraCapture}
        onCancel={() => setCameraTarget(null)}
        onUnavailable={handleCameraUnavailable}
      />
    </div>
  );
}

void CheckCircle2;
void RotateCcw;

export { PhotoCapture };
