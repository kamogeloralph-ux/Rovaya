-- Store one optional GPS snapshot for each inspection.
-- The driver app captures this once, never continuously tracks location.
ALTER TABLE daily_inspections ADD COLUMN location_latitude REAL;
ALTER TABLE daily_inspections ADD COLUMN location_longitude REAL;
ALTER TABLE daily_inspections ADD COLUMN location_accuracy REAL;
ALTER TABLE daily_inspections ADD COLUMN location_captured_at TEXT;

CREATE INDEX IF NOT EXISTS idx_insp_location ON daily_inspections(location_latitude, location_longitude);
