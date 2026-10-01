-- Rovaya D1 schema (SQLite). Mirrors the Supabase public schema.
-- ids are UUID text, timestamps are ISO-8601 text (UTC), booleans are 0/1.
CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  photo_retention_days INTEGER CHECK (photo_retention_days IS NULL OR photo_retention_days > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS company_access_codes (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  code TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS drivers (
  id TEXT PRIMARY KEY,
  auth_user_id TEXT UNIQUE,
  employee_number TEXT UNIQUE,
  full_name TEXT NOT NULL,
  phone TEXT,
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin','super_admin')),
  active INTEGER NOT NULL DEFAULT 1,
  company_id TEXT REFERENCES companies(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS trucks (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  fleet_number TEXT NOT NULL,
  registration TEXT NOT NULL,
  truck_type TEXT,
  model TEXT,
  size TEXT,
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','inspection_due','out_of_service')),
  notes TEXT,
  license_disc_expiry TEXT,
  roadworthy_expiry TEXT,
  insurance_expiry TEXT,
  next_service_km INTEGER CHECK (next_service_km IS NULL OR next_service_km >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (fleet_number),
  UNIQUE (registration)
);
CREATE INDEX IF NOT EXISTS idx_trucks_company ON trucks(company_id, fleet_number);
CREATE TABLE IF NOT EXISTS checklist_templates (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_templates_company ON checklist_templates(company_id, active, version);
CREATE TABLE IF NOT EXISTS checklist_items (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES checklist_templates(id),
  section_number TEXT NOT NULL,
  section_title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  required INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_items_template ON checklist_items(template_id, sort_order);
CREATE TABLE IF NOT EXISTS daily_inspections (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  truck_id TEXT NOT NULL REFERENCES trucks(id),
  driver_id TEXT REFERENCES drivers(id),
  checklist_template_id TEXT NOT NULL REFERENCES checklist_templates(id),
  inspection_date TEXT NOT NULL,
  started_at TEXT,
  submitted_at TEXT,
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed','needs_review','rejected')),
  notes TEXT,
  signature_name TEXT,
  driver_name TEXT,
  employee_number TEXT,
  opening_kilometers INTEGER CHECK (opening_kilometers IS NULL OR opening_kilometers >= 0),
  shift TEXT CHECK (shift IS NULL OR lower(shift) IN ('morning','day','night')),
  company_access_code TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_insp_company_date ON daily_inspections(company_id, inspection_date);
CREATE INDEX IF NOT EXISTS idx_insp_truck ON daily_inspections(truck_id);
CREATE TABLE IF NOT EXISTS inspection_answers (
  id TEXT PRIMARY KEY,
  inspection_id TEXT NOT NULL REFERENCES daily_inspections(id) ON DELETE CASCADE,
  checklist_item_id TEXT NOT NULL REFERENCES checklist_items(id),
  result TEXT NOT NULL CHECK (result IN ('pass','fail','not_applicable')),
  comment TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_answers_inspection ON inspection_answers(inspection_id);
CREATE TABLE IF NOT EXISTS inspection_photos (
  id TEXT PRIMARY KEY,
  inspection_id TEXT NOT NULL REFERENCES daily_inspections(id) ON DELETE CASCADE,
  photo_type TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  storage_provider TEXT NOT NULL DEFAULT 'r2',
  captured_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_photos_inspection ON inspection_photos(inspection_id);
CREATE INDEX IF NOT EXISTS idx_photos_captured ON inspection_photos(captured_at);
CREATE TABLE IF NOT EXISTS defects (
  id TEXT PRIMARY KEY,
  inspection_id TEXT NOT NULL REFERENCES daily_inspections(id) ON DELETE CASCADE,
  category TEXT NOT NULL DEFAULT 'general',
  severity TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low','medium','high','critical')),
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','waived')),
  reported_by TEXT REFERENCES drivers(id),
  resolved_by TEXT REFERENCES drivers(id),
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_defects_inspection ON defects(inspection_id);
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  company_id TEXT REFERENCES companies(id),
  actor_id TEXT REFERENCES drivers(id),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_company ON audit_events(company_id, created_at);
