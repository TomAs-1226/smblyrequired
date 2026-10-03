-- =============================================================================
-- 0013 — Fixes found by walking the portal against the schema.
--
-- Three unrelated repairs, each of which made a portal screen wrong or blank
-- without any error that pointed at the cause.
--
--   1. graphs.html_file_id. The Graphs panel has selected this column (and
--      embedded files through `graphs_html_file_id_fkey`) since graphify's own
--      graph.html became the preferred viewer, and scripts/upload-graph-html.mjs
--      writes it — but no migration ever created it. Against a database built
--      from these migrations the whole Graphs tab fails with "column
--      graphs.html_file_id does not exist". `if not exists` keeps this a no-op on
--      a project where someone already added it by hand in the SQL editor; the
--      constraint name is spelled out because the portal's embed names it.
--
--   2. team_scout_checklist double counting. 0007 left-joins scout_entries AND
--      robot_photos onto event_teams in one pass, so every count is multiplied
--      by the row count of the other join: a team with 2 pit passes and 3 photos
--      reported 6 pit passes and 6 photos. The booleans (pit_done etc.) were
--      right, which is why it looked plausible. Counting distinct ids removes the
--      fan-out without changing a column name or type, so the view is replaced
--      in place and nothing depending on it has to be recreated.
--
--   3. team_event_stats casts. The view cast `data->>'total_score'` to numeric
--      and `data->>'broke'` to boolean directly. One entry carrying a value that
--      does not parse — a form edited so total_score became a select, an import
--      with "yes" in it — made the cast raise, and because it is a view, the
--      query failed for EVERY team at the event: Analytics, Compare, Team detail,
--      the pick list and the coverage view all went blank together. A bad answer
--      in one entry must cost that entry, not the event. The try_* helpers return
--      null for anything unparseable, which avg()/count() already skip.
-- =============================================================================

-- --- 1. graphs.html_file_id ---------------------------------------------------

alter table public.graphs
  add column if not exists html_file_id uuid
    constraint graphs_html_file_id_fkey references public.files (id) on delete set null;

comment on column public.graphs.html_file_id is
  'graphify''s own rendered graph.html, served in a sandboxed iframe. Preferred '
  'over file_id (the JSON payload) by the portal viewer when present.';

-- --- 2. team_scout_checklist ------------------------------------------------------

create or replace view public.team_scout_checklist as
select
  t.event_key,
  t.team_number,
  t.nickname,
  count(distinct e.id) filter (where e.kind = 'match')            as match_passes,
  count(distinct e.id) filter (where e.kind = 'pit')              as pit_passes,
  count(distinct e.id) filter (where e.kind = 'strategy')         as note_passes,
  count(distinct e.scout_id)                                      as scouts,
  count(distinct p.id)                                            as photos,
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

-- --- 3. tolerant casts for team_event_stats ---------------------------------------

-- A JSON number, or a string that is plainly a number, becomes numeric; anything
-- else is null. Not a general-purpose parser — just enough that the values the
-- portal and the seed actually write come through, and nothing else can raise.
create or replace function public.try_numeric(v jsonb)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case
    when jsonb_typeof(v) = 'number' then (v #>> '{}')::numeric
    when jsonb_typeof(v) = 'string'
         and (v #>> '{}') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' then trim(v #>> '{}')::numeric
    else null
  end;
$$;

create or replace function public.try_bool(v jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when jsonb_typeof(v) = 'boolean' then (v #>> '{}')::boolean
    when jsonb_typeof(v) = 'string' and lower(trim(v #>> '{}')) in ('true', 'yes')  then true
    when jsonb_typeof(v) = 'string' and lower(trim(v #>> '{}')) in ('false', 'no') then false
    else null
  end;
$$;

-- Same columns, names, types and order as 0009, so this replaces the view in
-- place and event_scout_coverage (which reads it) keeps working untouched.
create or replace view public.team_event_stats as
select
  e.event_key,
  e.team_number,

  count(*) filter (where e.kind = 'match')                    as matches_scouted,
  count(*) filter (where e.kind = 'pit')                      as pit_visits,
  count(*) filter (where e.kind = 'strategy')                 as notes_logged,
  count(distinct e.scout_id) filter (where e.kind = 'match')  as scouts_contributing,
  max(e.recorded_at)                                          as last_seen,

  -- Counts entries whose total_score actually parses, so it stays the true
  -- denominator of avg_score below.
  count(*) filter (
    where e.kind = 'match' and public.try_numeric(e.data -> 'total_score') is not null
  )                                                           as scored_matches,

  avg(public.try_numeric(e.data -> 'total_score')) filter (where e.kind = 'match') as avg_score,
  stddev_samp(public.try_numeric(e.data -> 'total_score')) filter (where e.kind = 'match')
                                                              as score_stddev,
  min(public.try_numeric(e.data -> 'total_score')) filter (where e.kind = 'match') as min_score,
  max(public.try_numeric(e.data -> 'total_score')) filter (where e.kind = 'match') as max_score,

  avg(public.try_numeric(e.data -> 'total_score')) filter (where e.kind = 'pit') as pit_estimate,

  count(*) filter (where e.kind = 'match' and public.try_bool(e.data -> 'broke'))   as breakdowns,
  count(*) filter (where e.kind = 'match' and public.try_bool(e.data -> 'no_show')) as no_shows
from public.scout_entries e
where e.event_key is not null
group by e.event_key, e.team_number;

alter view public.team_event_stats set (security_invoker = on);
