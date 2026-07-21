-- =============================================================================
-- 0004 — Audit trail and backup bookkeeping.
--
-- A backup you have never restored is a hypothesis, not a backup. `backup_runs`
-- exists so the nightly mirror produces evidence — object counts, byte totals,
-- and a checksum manifest digest — rather than a green tick. The portal reads
-- this table to show when the last verified copy actually landed.
-- =============================================================================

create table public.audit_log (
  id         bigint generated always as identity primary key,
  actor      uuid references public.profiles (id) on delete set null,
  action     text not null,
  entity     text not null,
  entity_id  text,
  detail     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index audit_log_created_idx on public.audit_log (created_at desc);
create index audit_log_entity_idx  on public.audit_log (entity, entity_id);

comment on table public.audit_log is
  'Append-only. No client-facing policy grants insert/update/delete; rows are '
  'written by SECURITY DEFINER triggers only.';

-- Role grants are the highest-consequence action in the system, so they are
-- recorded unconditionally rather than left to the caller to remember.
create or replace function public.audit_role_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.role is distinct from old.role then
    insert into public.audit_log (actor, action, entity, entity_id, detail)
    values (
      auth.uid(),
      'role.change',
      'profiles',
      new.id::text,
      jsonb_build_object('from', old.role, 'to', new.role)
    );
  end if;
  return new;
end;
$$;

create trigger profiles_audit_role
  after update on public.profiles
  for each row execute function public.audit_role_change();

-- -----------------------------------------------------------------------------
-- backup_runs
-- -----------------------------------------------------------------------------
create type public.backup_status as enum ('running', 'ok', 'failed', 'partial');

create table public.backup_runs (
  id             uuid primary key default gen_random_uuid(),
  -- Which hop this row describes. The mirror is two-legged: Supabase down to
  -- the backup server, then the backup server out to the OptiPlex. Recording them
  -- separately means a silent failure on the second leg is visible, instead of
  -- being hidden behind a successful first leg.
  leg            text not null check (leg in ('supabase->server', 'server->optiplex')),
  status         public.backup_status not null default 'running',
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  object_count   int    check (object_count >= 0),
  byte_total     bigint check (byte_total >= 0),
  db_dump_bytes  bigint check (db_dump_bytes >= 0),
  -- sha256 of the SHA256SUMS manifest — one value that changes if any file in
  -- the set changed. Comparing two runs is then a single string comparison.
  manifest_sha   text check (manifest_sha ~ '^[a-f0-9]{64}$'),
  -- Set only by an actual restore test. Left null, the UI reports the backup as
  -- unverified, because that is what it is.
  restore_tested_at timestamptz,
  error          text,
  created_at     timestamptz not null default now()
);

create index backup_runs_recent_idx on public.backup_runs (leg, started_at desc);

-- Convenience view for the portal's backup panel: latest run per leg, plus how
-- stale it is. Kept as a view so the staleness rule lives in one place.
create view public.backup_health as
select distinct on (leg)
  leg,
  status,
  started_at,
  finished_at,
  object_count,
  byte_total,
  db_dump_bytes,
  manifest_sha,
  restore_tested_at,
  -- Both scripts write a reason on failure. Omitting it here made it
  -- unreachable: the portal reads only this view, so "why did it fail" was
  -- recorded and then hidden. A failure you cannot diagnose is barely better
  -- than one you were never told about.
  error,
  now() - started_at as age,
  (status = 'ok' and started_at > now() - interval '36 hours') as healthy
from public.backup_runs
order by leg, started_at desc;

alter table public.audit_log   enable row level security;
alter table public.backup_runs enable row level security;

-- The audit trail is readable by leads and above only: it records who granted
-- whom what, which is not general-membership information.
create policy "audit: leads read" on public.audit_log for select to authenticated
  using (public.is_at_least('lead'));

-- Backup health is readable by any member — knowing whether the team's work is
-- safely copied is not privileged information, and hiding it discourages
-- anyone from noticing that it has been failing for a fortnight.
create policy "backups: members read" on public.backup_runs for select to authenticated
  using (public.is_at_least('member'));

-- No insert/update policy for `authenticated`. The backup job authenticates
-- with the service-role key, which bypasses RLS by design; browser clients
-- therefore cannot fabricate a successful backup record.

-- `security_invoker` makes the view run with the querying user's permissions,
-- so backup_runs' RLS still applies through it. Without this the view would be
-- a hole around the policy above.
alter view public.backup_health set (security_invoker = on);
