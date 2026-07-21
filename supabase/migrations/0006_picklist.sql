-- =============================================================================
-- 0006 — Pick lists.
--
-- A pick list is the artifact alliance selection actually runs on: an ordered,
-- tiered ranking of every team at an event, argued over by the whole strategy
-- group and then read out loud under time pressure on the field.
--
-- Two things follow from that, and they shape this table:
--
--   * The ORDER IS THE DATA. Not a derived view of the stats — a human decision
--     that deliberately overrides the stats sometimes ("their auto is worse but
--     they never break"). So positions are stored explicitly and survive a
--     recompute of the underlying numbers.
--   * It is edited live, by several people, minutes before it is used. Every
--     change is timestamped and attributed, and a snapshot can be frozen so the
--     list read on the field is recoverable afterwards even if someone keeps
--     dragging rows around during the match.
-- =============================================================================

create table public.picklists (
  id          uuid primary key default gen_random_uuid(),
  event_key   text not null references public.events (key) on delete cascade,
  name        text not null default 'Pick list',

  -- Tier definitions, ordered best-first:
  --   [{"key":"s","label":"S — first pick","color":"gold"}, …]
  -- Stored rather than hardcoded because every team names their tiers
  -- differently and renaming one must not orphan the entries pointing at it.
  tiers       jsonb not null default
    '[{"key":"s","label":"S"},{"key":"a","label":"A"},{"key":"b","label":"B"},
      {"key":"c","label":"C"},{"key":"unranked","label":"Unranked"}]'::jsonb,

  -- Frozen copies. Alliance selection takes minutes and the list keeps being
  -- edited during it; without a snapshot there is no way to answer "what did we
  -- actually have them at when we picked?" afterwards.
  is_locked   boolean not null default false,
  locked_at   timestamptz,
  locked_by   uuid references public.profiles (id) on delete set null,

  created_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index picklists_event_idx on public.picklists (event_key, updated_at desc);

create trigger picklists_touch before update on public.picklists
  for each row execute function public.touch_updated_at();

create table public.picklist_entries (
  id           uuid primary key default gen_random_uuid(),
  picklist_id  uuid not null references public.picklists (id) on delete cascade,
  team_number  int  not null check (team_number > 0),

  tier         text not null default 'unranked',
  -- Sparse ordering (10, 20, 30 …) so dragging a row between two others is a
  -- single-row update rather than renumbering everything below it. Fractional
  -- values are fine; the client re-spaces when gaps get tight.
  position     numeric not null default 0,

  -- Why this team sits here. The single most valuable field on the table during
  -- selection, and the one most likely to be skipped if it is made mandatory.
  note         text,
  -- Set when a human deliberately places a team against what the numbers say.
  -- Recorded so the disagreement is visible later rather than looking like a
  -- data error.
  overrides_ai boolean not null default false,

  updated_by   uuid references public.profiles (id) on delete set null,
  updated_at   timestamptz not null default now(),
  unique (picklist_id, team_number)
);

create index picklist_entries_order_idx
  on public.picklist_entries (picklist_id, tier, position);

create trigger picklist_entries_touch before update on public.picklist_entries
  for each row execute function public.touch_updated_at();

-- A locked list is a record of a decision. Blocking writes in the database
-- rather than hiding the drag handles means it holds against a second browser
-- tab, a stale client, and anyone poking at the API directly.
create or replace function public.reject_locked_picklist()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare locked boolean;
begin
  select p.is_locked into locked
    from public.picklists p
   where p.id = coalesce(new.picklist_id, old.picklist_id);

  if locked then
    raise exception 'this pick list is locked'
      using hint = 'Unlock it first — it was frozen to preserve what was read on the field.';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger picklist_entries_locked
  before insert or update or delete on public.picklist_entries
  for each row execute function public.reject_locked_picklist();

-- --- Coverage -----------------------------------------------------------------
-- "Every team scouted at least once" is the gate for building a pick list at
-- all, so it needs to be a question the UI can ask cheaply rather than pulling
-- every entry down and counting in the browser.
create view public.event_scout_coverage as
select
  t.event_key,
  count(*)                                              as teams_at_event,
  count(*) filter (where s.matches_scouted > 0)         as teams_scouted,
  count(*) filter (where coalesce(s.matches_scouted,0) = 0) as teams_unscouted,
  coalesce(min(s.matches_scouted), 0)                   as min_matches,
  round(avg(coalesce(s.matches_scouted, 0)), 1)         as avg_matches,
  bool_and(coalesce(s.matches_scouted, 0) > 0)          as fully_covered
from public.event_teams t
left join public.team_event_stats s
       on s.event_key = t.event_key and s.team_number = t.team_number
group by t.event_key;

alter view public.event_scout_coverage set (security_invoker = on);

-- =============================================================================
-- RLS — everyone on the team reads; leads and mentors edit.
--
-- Deliberately NOT member-writable. A pick list is a small, contested, ordered
-- artifact where one careless drag during selection is expensive and hard to
-- notice. Scouting data is collected by everyone; the ranking is decided by the
-- strategy group.
-- =============================================================================
alter table public.picklists        enable row level security;
alter table public.picklist_entries enable row level security;

create policy "picklists: members read" on public.picklists for select to authenticated
  using (public.is_at_least('member'));
create policy "picklists: leads manage" on public.picklists for all to authenticated
  using (public.is_at_least('lead')) with check (public.is_at_least('lead'));

create policy "picklist entries: members read" on public.picklist_entries for select to authenticated
  using (public.is_at_least('member'));
create policy "picklist entries: leads manage" on public.picklist_entries for all to authenticated
  using (public.is_at_least('lead')) with check (public.is_at_least('lead'));
