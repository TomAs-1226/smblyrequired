-- =============================================================================
-- 0007 — Daily scouting pass limit.
--
-- A scout may record at most TWO passes on a given team per day, per event.
-- The allowance resets at midnight and keeps resetting for as long as the event
-- runs, so across a three-day competition one scout can log up to six passes on
-- the same team — just never six in one sitting.
--
-- The point is data quality, not rationing. Repeatedly re-scouting one team in
-- an afternoon skews that team's averages toward whatever one person happened
-- to see, and it is usually a sign of someone padding numbers or re-submitting
-- because they were not sure the first one saved. Two is enough to correct a
-- genuine mistake and few enough that nobody can quietly dominate a data set.
--
-- Enforced in the database rather than in the UI, because the UI is a phone
-- that is frequently offline: entries arrive in bulk hours after they were
-- recorded, and a client-side check cannot see what the rest of the queue is
-- about to insert.
-- =============================================================================

alter table public.scout_entries
  add column if not exists recorded_date date
    generated always as ((recorded_at at time zone 'UTC')::date) stored;

comment on column public.scout_entries.recorded_date is
  'UTC date the scout pressed save. Derived from recorded_at (the device clock), '
  'NOT created_at — an offline entry synced the next morning still belongs to the '
  'day it was actually observed.';

create index scout_entries_daily_idx
  on public.scout_entries (scout_id, event_key, team_number, recorded_date);

-- -----------------------------------------------------------------------------
-- The limit.
--
-- Match scouting is exempt: one entry per team per MATCH is already enforced by
-- the unique index in 0005, and a scout legitimately watches the same team in
-- more than two matches a day. This caps pit and strategy passes, which are the
-- ones with no natural per-match boundary.
-- -----------------------------------------------------------------------------
create or replace function public.enforce_daily_pass_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  used int;
  limit_per_day constant int := 2;
begin
  if new.kind = 'match' then
    return new;
  end if;
  -- Service-role writes (imports, backfills, the restore path) are not a scout
  -- standing in a pit and are not what this rule is about.
  if auth.uid() is null then
    return new;
  end if;

  select count(*) into used
    from public.scout_entries e
   where e.scout_id      = new.scout_id
     and e.team_number   = new.team_number
     and e.kind          = new.kind
     and e.recorded_date = (new.recorded_at at time zone 'UTC')::date
     and e.event_key is not distinct from new.event_key
     and (tg_op = 'INSERT' or e.id <> new.id);

  if used >= limit_per_day then
    raise exception
      'daily limit reached: % passes on team % today', limit_per_day, new.team_number
      using errcode = 'check_violation',
            hint = 'You get two per team per day. The allowance resets tomorrow — '
                   'edit one of today''s entries instead if you need to correct it.';
  end if;

  return new;
end;
$$;

create trigger scout_entries_daily_limit
  before insert on public.scout_entries
  for each row execute function public.enforce_daily_pass_limit();

-- -----------------------------------------------------------------------------
-- Remaining allowance, so the UI can show it BEFORE someone fills in a form.
-- Discovering the limit at submit time — on a phone, having just typed twenty
-- fields — is the worst possible moment to find out.
-- -----------------------------------------------------------------------------
create or replace function public.passes_remaining(
  p_team int,
  p_kind public.scout_kind,
  p_event text default null
)
returns int
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_kind = 'match' then 99  -- not limited; bounded per-match instead
    else greatest(0, 2 - (
      select count(*)
        from public.scout_entries e
       where e.scout_id      = auth.uid()
         and e.team_number   = p_team
         and e.kind          = p_kind
         and e.recorded_date = (now() at time zone 'UTC')::date
         and e.event_key is not distinct from p_event
    ))
  end;
$$;

revoke all on function public.passes_remaining(int, public.scout_kind, text) from public;
grant execute on function public.passes_remaining(int, public.scout_kind, text) to authenticated;

-- -----------------------------------------------------------------------------
-- Coverage checklist — "which teams have we actually scouted?"
--
-- A view rather than a client-side join: at a 60-team event this is the screen
-- a strategy lead refreshes constantly, and pulling every entry down to count
-- them in the browser is both slow and wrong the moment a phone syncs late.
-- -----------------------------------------------------------------------------
create view public.team_scout_checklist as
select
  t.event_key,
  t.team_number,
  t.nickname,
  count(e.id) filter (where e.kind = 'match')                     as match_passes,
  count(e.id) filter (where e.kind = 'pit')                       as pit_passes,
  count(e.id) filter (where e.kind = 'strategy')                  as note_passes,
  count(distinct e.scout_id)                                      as scouts,
  count(p.id)                                                     as photos,
  max(e.recorded_at)                                              as last_scouted,
  (count(e.id) filter (where e.kind = 'pit') > 0)                 as pit_done,
  (count(e.id) filter (where e.kind = 'match') > 0)               as match_done,
  (count(p.id) > 0)                                               as has_photos
from public.event_teams t
left join public.scout_entries e
       on e.event_key = t.event_key and e.team_number = t.team_number
left join public.robot_photos p
       on p.event_key = t.event_key and p.team_number = t.team_number
group by t.event_key, t.team_number, t.nickname;

alter view public.team_scout_checklist set (security_invoker = on);
