-- =============================================================================
-- 0005 — Scouting: TBA cache, form definitions, entries, robot photos,
--        strategy notes, and the repo auto-pull config.
--
-- The design constraint that shapes this whole file is OFFLINE. A scout records
-- matches on a phone in a arena with 4000 people and no usable wifi, and the
-- data has to survive that. Two consequences appear throughout:
--
--   * `client_uuid` is generated ON THE PHONE before a row ever reaches the
--     server, and is UNIQUE. A retried upload collides instead of duplicating.
--     Without it, "sync failed, try again" silently doubles your dataset.
--   * `recorded_at` (when the scout pressed save) is stored separately from
--     `created_at` (when the server heard about it). They can differ by hours,
--     and every ordering that matters to humans uses the former.
-- =============================================================================

-- --- TBA cache ---------------------------------------------------------------
-- Mirrored from The Blue Alliance rather than queried live: the API key must
-- stay server-side, and a pit full of scouts should not each be hitting an
-- upstream API over a saturated network.

create table public.events (
  key         text primary key,            -- e.g. '2026casd'
  year        int  not null,
  name        text not null,
  short_name  text,
  event_type  text,
  city        text,
  state_prov  text,
  country     text,
  start_date  date,
  end_date    date,
  week        int,
  synced_at   timestamptz not null default now()
);

create index events_year_idx on public.events (year desc, start_date);

create table public.event_teams (
  event_key   text not null references public.events (key) on delete cascade,
  team_number int  not null check (team_number > 0),
  nickname    text,
  name        text,
  city        text,
  state_prov  text,
  country     text,
  rookie_year int,
  synced_at   timestamptz not null default now(),
  primary key (event_key, team_number)
);

create index event_teams_number_idx on public.event_teams (team_number);

-- --- Form definitions ---------------------------------------------------------

create type public.scout_kind as enum ('match', 'pit', 'strategy');

create table public.scout_forms (
  id          uuid primary key default gen_random_uuid(),
  season      int  not null check (season between 2000 and 2100),
  kind        public.scout_kind not null,
  name        text not null check (length(trim(name)) > 0),
  description text,

  -- Field definitions, ordered. Each element:
  --   {
  --     "key":      "auto_speaker",        -- stable; becomes the data key
  --     "label":    "Auto speaker notes",
  --     "type":     "counter",             -- see the check constraint below
  --     "section":  "Autonomous",          -- groups fields into screens
  --     "required": true,
  --     "min": 0, "max": 20,               -- number/counter/rating
  --     "options":  ["Ground","Source"],   -- select/multiselect
  --     "help":     "Count scored, not attempted"
  --   }
  --
  -- Kept as jsonb rather than as tables because a season's questions change
  -- weekly during build, and a mentor editing a form should not need a
  -- migration. The trade-off is that validation lives in the trigger below.
  fields      jsonb not null default '[]'::jsonb,

  -- Exactly one form per (season, kind) may be active. Enforced by the partial
  -- unique index below, so two mentors cannot both publish and silently split
  -- the season's data across two incompatible schemas.
  is_active   boolean not null default false,

  created_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index scout_forms_one_active
  on public.scout_forms (season, kind)
  where is_active;

create trigger scout_forms_touch before update on public.scout_forms
  for each row execute function public.touch_updated_at();

-- Structural validation for `fields`. A malformed form is not a cosmetic
-- problem: it is discovered by a student standing in front of a robot with a
-- form that will not submit.
create or replace function public.validate_scout_fields()
returns trigger
language plpgsql
as $$
declare
  f      jsonb;
  seen   text[] := '{}';
  k      text;
  ftype  text;
  allowed text[] := array['counter','number','text','textarea','select','multiselect',
                          'boolean','rating','timer','heading'];
begin
  if jsonb_typeof(new.fields) <> 'array' then
    raise exception 'fields must be a JSON array';
  end if;

  for f in select * from jsonb_array_elements(new.fields) loop
    k     := f ->> 'key';
    ftype := f ->> 'type';

    if k is null or k !~ '^[a-z][a-z0-9_]*$' then
      raise exception 'field key % must be lower_snake_case', coalesce(k, '(null)');
    end if;
    if k = any(seen) then
      raise exception 'duplicate field key: %', k;
    end if;
    seen := seen || k;

    if ftype is null or not (ftype = any(allowed)) then
      raise exception 'field %: type % is not one of %', k, coalesce(ftype,'(null)'), allowed;
    end if;
    if (f ->> 'label') is null and ftype <> 'heading' then
      raise exception 'field % has no label', k;
    end if;
    if ftype in ('select','multiselect')
       and (f -> 'options' is null or jsonb_array_length(f -> 'options') = 0) then
      raise exception 'field % is a %, so it needs a non-empty options array', k, ftype;
    end if;
  end loop;

  return new;
end;
$$;

create trigger scout_forms_validate
  before insert or update on public.scout_forms
  for each row execute function public.validate_scout_fields();

-- --- Entries ------------------------------------------------------------------

create table public.scout_entries (
  id           uuid primary key default gen_random_uuid(),

  -- Generated on the device before the row exists anywhere else. The unique
  -- constraint is what makes an offline sync retry idempotent.
  client_uuid  uuid not null unique,

  form_id      uuid references public.scout_forms (id) on delete set null,
  kind         public.scout_kind not null,

  event_key    text references public.events (key) on delete set null,
  team_number  int  not null check (team_number > 0),

  -- Match identity. Null for pit scouting.
  match_key    text,
  match_number int,
  comp_level   text check (comp_level in ('qm','ef','qf','sf','f')),
  alliance     text check (alliance in ('red','blue')),

  -- Answers, keyed by scout_forms.fields[].key.
  data         jsonb not null default '{}'::jsonb,
  notes        text,

  scout_id     uuid references public.profiles (id) on delete set null,

  -- When the scout pressed save on the phone. NOT when the server received it.
  recorded_at  timestamptz not null,
  created_at   timestamptz not null default now()
);

create index scout_entries_team_idx  on public.scout_entries (event_key, team_number);
create index scout_entries_match_idx on public.scout_entries (match_key);
create index scout_entries_kind_idx  on public.scout_entries (kind, recorded_at desc);
create index scout_entries_scout_idx on public.scout_entries (scout_id, recorded_at desc);
create index scout_entries_data_idx  on public.scout_entries using gin (data);

-- A match entry must identify its match; a pit entry must not pretend to.
alter table public.scout_entries add constraint scout_entries_match_shape check (
  (kind = 'match' and match_number is not null and alliance is not null)
  or (kind <> 'match')
);

-- One scout, one team, one match — a second submission is a correction, not a
-- new data point, and averaging both would quietly skew the team's numbers.
create unique index scout_entries_one_per_match
  on public.scout_entries (event_key, team_number, match_key, scout_id)
  where kind = 'match' and match_key is not null and scout_id is not null;

-- --- Robot photos -------------------------------------------------------------

create table public.robot_photos (
  id          uuid primary key default gen_random_uuid(),
  client_uuid uuid unique,
  event_key   text references public.events (key) on delete set null,
  team_number int not null check (team_number > 0),

  -- Which angle this satisfies in the guided capture sequence.
  angle       text not null check (
                angle in ('front','side','rear','drivetrain','intake','scoring','other')),

  file_id     uuid references public.files (id) on delete cascade,

  -- On-device measurements taken before upload:
  --   {"sharpness": 142.3, "brightness": 0.61, "detected": true, "confidence": 0.82}
  -- Stored so the thresholds can be tuned later against real photos rather than
  -- guessed at forever — and so a rejected-then-accepted photo is explicable.
  quality     jsonb not null default '{}'::jsonb,

  taken_by    uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now()
);

create index robot_photos_team_idx on public.robot_photos (event_key, team_number, angle);

-- --- Repo auto-pull -----------------------------------------------------------

create table public.repo_sources (
  id             uuid primary key default gen_random_uuid(),
  label          text not null check (length(trim(label)) > 0),
  provider       text not null default 'github' check (provider in ('github','url')),
  owner          text,
  repo           text,
  git_ref        text default 'HEAD',
  url            text,
  enabled        boolean not null default true,
  interval_hours int not null default 24 check (interval_hours between 1 and 720),
  last_synced_at timestamptz,
  last_status    text check (last_status in ('ok','failed','running')),
  last_error     text,
  last_sha       text,
  created_by     uuid references public.profiles (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  -- A github source needs owner/repo; a bare url source needs a url. Enforcing
  -- it here means the sync job never has to guess what it was pointed at.
  constraint repo_sources_shape check (
    (provider = 'github' and owner is not null and repo is not null)
    or (provider = 'url' and url is not null)
  )
);

create trigger repo_sources_touch before update on public.repo_sources
  for each row execute function public.touch_updated_at();

-- --- Aggregates ---------------------------------------------------------------
-- One row per team per event. Deliberately a view, not a materialised table:
-- entries arrive in bursts as phones come back online, and a stale aggregate
-- during alliance selection is worse than a slightly slower query.

create view public.team_event_stats as
select
  e.event_key,
  e.team_number,
  count(*) filter (where e.kind = 'match')            as matches_scouted,
  count(distinct e.scout_id)                          as scouts_contributing,
  max(e.recorded_at)                                  as last_seen,
  -- Consistency matters as much as average in alliance selection: a team that
  -- always scores 5 is usually a better partner than one alternating 0 and 10.
  avg((e.data ->> 'total_score')::numeric)            as avg_score,
  stddev_pop((e.data ->> 'total_score')::numeric)     as score_stddev,
  min((e.data ->> 'total_score')::numeric)            as min_score,
  max((e.data ->> 'total_score')::numeric)            as max_score,
  count(*) filter (where (e.data ->> 'broke')::boolean) as breakdowns,
  count(*) filter (where (e.data ->> 'no_show')::boolean) as no_shows
from public.scout_entries e
where e.event_key is not null
group by e.event_key, e.team_number;

alter view public.team_event_stats set (security_invoker = on);

-- =============================================================================
-- RLS
-- =============================================================================
alter table public.events        enable row level security;
alter table public.event_teams   enable row level security;
alter table public.scout_forms   enable row level security;
alter table public.scout_entries enable row level security;
alter table public.robot_photos  enable row level security;
alter table public.repo_sources  enable row level security;

-- Event/team cache: readable by any member, written only by the sync job
-- (service_role, which bypasses RLS) or a lead doing a manual refresh.
create policy "events: members read" on public.events for select to authenticated
  using (public.is_at_least('member'));
create policy "events: leads write" on public.events for all to authenticated
  using (public.is_at_least('lead')) with check (public.is_at_least('lead'));

create policy "event_teams: members read" on public.event_teams for select to authenticated
  using (public.is_at_least('member'));
create policy "event_teams: leads write" on public.event_teams for all to authenticated
  using (public.is_at_least('lead')) with check (public.is_at_least('lead'));

-- Forms: everyone scouting needs to read them; only mentors and leads author
-- them. `mentor` sits above `lead` in the enum, so is_at_least('lead') covers
-- both — which matches "I or our mentor can set the questions".
create policy "forms: members read" on public.scout_forms for select to authenticated
  using (public.is_at_least('member'));
create policy "forms: leads author" on public.scout_forms for all to authenticated
  using (public.is_at_least('lead')) with check (public.is_at_least('lead'));

-- Entries: a member submits their own and reads everything. Reading all of it
-- is the point — scouting data is only useful pooled.
create policy "entries: members read" on public.scout_entries for select to authenticated
  using (public.is_at_least('member'));
create policy "entries: members insert own" on public.scout_entries for insert to authenticated
  with check (public.is_at_least('member') and scout_id = auth.uid());
-- Corrections are allowed on your own entry only. Someone mis-tapping a counter
-- and having no way to fix it is how scouting data quietly becomes fiction.
create policy "entries: owners correct" on public.scout_entries for update to authenticated
  using (scout_id = auth.uid() and public.is_at_least('member'))
  with check (scout_id = auth.uid());
create policy "entries: leads manage" on public.scout_entries for all to authenticated
  using (public.is_at_least('lead')) with check (public.is_at_least('lead'));

create policy "photos: members read" on public.robot_photos for select to authenticated
  using (public.is_at_least('member'));
create policy "photos: members insert own" on public.robot_photos for insert to authenticated
  with check (public.is_at_least('member') and taken_by = auth.uid());
create policy "photos: leads manage" on public.robot_photos for all to authenticated
  using (public.is_at_least('lead')) with check (public.is_at_least('lead'));

-- Repo sources: admin only. "make sure I can define which repositories it pulls
-- from" — this is the table that means, and it drives a job holding credentials.
create policy "repos: members read" on public.repo_sources for select to authenticated
  using (public.is_at_least('member'));
create policy "repos: admins manage" on public.repo_sources for all to authenticated
  using (public.is_at_least('admin')) with check (public.is_at_least('admin'));
