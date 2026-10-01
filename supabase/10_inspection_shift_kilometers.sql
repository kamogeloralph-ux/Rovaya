-- Inspection metadata for fleet reports.
alter table public.daily_inspections add column if not exists opening_kilometers integer;
alter table public.daily_inspections add column if not exists shift text;
alter table public.daily_inspections add column if not exists location_latitude double precision;
alter table public.daily_inspections add column if not exists location_longitude double precision;
alter table public.daily_inspections add column if not exists location_accuracy double precision;
alter table public.daily_inspections add column if not exists location_captured_at timestamptz;
alter table public.daily_inspections drop constraint if exists daily_inspections_shift_check;
alter table public.daily_inspections add constraint daily_inspections_shift_check check (shift in ('morning', 'day', 'night'));
alter table public.daily_inspections drop constraint if exists daily_inspections_opening_kilometers_check;
alter table public.daily_inspections add constraint daily_inspections_opening_kilometers_check check (opening_kilometers is null or opening_kilometers >= 0);
