-- =============================================================================
-- 0010 — Scouting control: the active event, and a scouting time window.
--
-- Two levers leadership (lead / mentor / admin) controls and scouts follow:
--
--   1. ACTIVE EVENT. One event is "the one we are scouting". Scouts record
--      against it and cannot pick another; leads set it. Choosing an event is a
--      coordination decision — forty scouts each picking their own is how a data
--      set ends up split across three events and useful for none.
--
--   2. SCOUTING WINDOW. Optionally, entries may only be recorded during a
--      time-of-day window (e.g. 08:00–18:00). Set by leadership, off by default.
--
-- Both are ENFORCED IN THE DATABASE, not just hidden in the UI. A time lock a
-- determined student can defeat by editing the page is theatre; this one holds
-- against the API, a second tab, and a stale client. The check is on
-- `recorded_at` — WHEN THE SCOUT PRESSED SAVE — not on now(): an entry recorded
-- at 5pm and synced from a bag at 8pm is legitimately inside the window, and
-- punishing the sync would defeat the whole offline-first design.
-- =============================================================================

create table public.scout_settings (
  -- Singleton. There is one set of settings for the team, so the row is pinned
  -- to id = 1 and the check makes a second row impossible rather than merely
  -- unlikely.
  id                integer primary key default 1 check (id = 1),

  active_event_key  text references public.events (key) on delete set null,

  -- The window. Enabled off by default — a team that has not thought about it
  -- should not discover scouting mysteriously blocked.
  lock_enabled      boolean not null default false,
  window_start      time not null default '08:00',
  window_end        time not null default '18:00',
  -- IANA zone. Santa Margarita is Pacific; stored so the window means wall-clock
  -- time at the venue, not UTC, and survives daylight saving without arithmetic.
  timezone          text not null default 'America/Los_Angeles',

  updated_by        uuid references public.profiles (id) on delete set null,
  updated_at        timestamptz not null default now()
);

insert into public.scout_settings (id) values (1) on conflict (id) do nothing;

create trigger scout_settings_touch before update on public.scout_settings
  for each row execute function public.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Enforcement.
--
-- Runs BEFORE INSERT on scout_entries, in addition to the daily-pass limit from
-- 0007. SECURITY DEFINER so it can read scout_settings regardless of the
-- caller's grants; search_path pinned per the project's rule for definer
-- functions.
-- -----------------------------------------------------------------------------
create or replace function public.enforce_scout_control()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  cfg   public.scout_settings;
  local_t time;
  inside  boolean;
begin
  -- The service role (imports, the dummy-data seed, admin SQL) has no uid and is
  -- not a scout at a competition — it is exempt from both levers.
  if auth.uid() is null then
    return new;
  end if;

  select * into cfg from public.scout_settings where id = 1;
  if not found then
    return new; -- no settings row yet: nothing to enforce
  end if;

  -- Active-event restriction. Leadership may scout any event (scouting a
  -- practice field, back-filling another event); a scout is held to the active
  -- one so the pooled data stays coherent.
  if cfg.active_event_key is not null
     and not public.is_at_least('lead')
     and new.event_key is distinct from cfg.active_event_key then
    raise exception 'scouting is set to event %, not %',
      cfg.active_event_key, coalesce(new.event_key, '(none)')
      using hint = 'A lead controls which event is being scouted. Switch to it, or ask them to change it.';
  end if;

  -- Time window. Compared against recorded_at in the configured zone, so an
  -- offline entry syncs on the day it was actually taken.
  if cfg.lock_enabled then
    local_t := (new.recorded_at at time zone cfg.timezone)::time;
    if cfg.window_start <= cfg.window_end then
      inside := local_t >= cfg.window_start and local_t <= cfg.window_end;
    else
      -- An overnight window (e.g. 20:00–02:00) wraps midnight.
      inside := local_t >= cfg.window_start or local_t <= cfg.window_end;
    end if;

    if not inside then
      raise exception 'scouting is closed right now (open % to %, % time)',
        cfg.window_start, cfg.window_end, cfg.timezone
        using hint = 'Entries can only be recorded inside the scouting window a lead has set.';
    end if;
  end if;

  return new;
end;
$$;

create trigger scout_entries_control
  before insert on public.scout_entries
  for each row execute function public.enforce_scout_control();

-- -----------------------------------------------------------------------------
-- A view the client can read to know the CURRENT state without doing timezone
-- arithmetic in the browser — "is scouting open right now, and until when?"
-- -----------------------------------------------------------------------------
create view public.scout_control_status as
select
  s.active_event_key,
  s.lock_enabled,
  s.window_start,
  s.window_end,
  s.timezone,
  (now() at time zone s.timezone)::time as local_now,
  case
    when not s.lock_enabled then true
    when s.window_start <= s.window_end
      then (now() at time zone s.timezone)::time between s.window_start and s.window_end
    else (now() at time zone s.timezone)::time >= s.window_start
      or (now() at time zone s.timezone)::time <= s.window_end
  end as open_now
from public.scout_settings s
where s.id = 1;

alter view public.scout_control_status set (security_invoker = on);

-- =============================================================================
-- RLS — everyone signed-in reads (scouts must know the active event + window);
-- only leadership writes.
-- =============================================================================
alter table public.scout_settings enable row level security;

create policy "settings: members read" on public.scout_settings for select to authenticated
  using (public.is_at_least('member'));

create policy "settings: leads write" on public.scout_settings for all to authenticated
  using (public.is_at_least('lead')) with check (public.is_at_least('lead'));
