-- =============================================================================
-- 0009 — Fix team_event_stats mixing entry kinds, and understating spread.
--
-- TWO BUGS, both of which produce plausible-looking numbers that are wrong,
-- which is the worst kind.
--
-- 1. MIXED DENOMINATORS. The original view counted `matches_scouted` from
--    kind='match' rows, but averaged `total_score` across EVERY entry carrying
--    that key. The 2026 REBUILT pit and strategy forms both define
--    `total_score` (deliberately — a pit estimate is comparable data), so a
--    team's "average match score" silently blended:
--       * actual observed match performance
--       * a scout's guess from talking to them in the pit
--       * an impact estimate attached to a strategy note
--    Those are not the same measurement. A team with one great pit interview
--    and two mediocre matches came out ahead of a team with three solid
--    matches, and nothing in the output said why.
--
--    Scoring statistics now come from kind='match' ONLY. Pit estimates are
--    surfaced separately, because they are genuinely useful before a team has
--    played — just never as the same number.
--
-- 2. stddev_pop UNDERSTATES SPREAD. Population SD assumes the rows ARE the
--    population; these are a sample of the matches a team will play, and at
--    n=3 it understates by ~22%. Consistency drives alliance picks, and
--    overstating a team's consistency is the error that costs you a partner.
--
-- Also adds `scored_matches`: the count of match entries that actually carry a
-- total_score. avg() skips nulls, so a scout who left the field blank is inside
-- matches_scouted and outside the average. Exposing both means the UI can say
-- "8 matches, 6 scored" instead of quietly dividing by a number nobody can see.
-- =============================================================================

drop view if exists public.team_event_stats cascade;

create view public.team_event_stats as
select
  e.event_key,
  e.team_number,

  count(*) filter (where e.kind = 'match')                    as matches_scouted,
  count(*) filter (where e.kind = 'pit')                      as pit_visits,
  count(*) filter (where e.kind = 'strategy')                 as notes_logged,
  count(distinct e.scout_id) filter (where e.kind = 'match')  as scouts_contributing,
  max(e.recorded_at)                                          as last_seen,

  -- The denominator behind every scoring number below.
  count(*) filter (
    where e.kind = 'match' and (e.data ->> 'total_score') is not null
  )                                                           as scored_matches,

  -- MATCH PERFORMANCE — observed play only.
  avg((e.data ->> 'total_score')::numeric) filter (where e.kind = 'match') as avg_score,
  -- Sample SD, not population. Null at n=1, which is correct: one match tells
  -- you nothing about consistency and should not report 0 variance.
  stddev_samp((e.data ->> 'total_score')::numeric) filter (where e.kind = 'match')
                                                              as score_stddev,
  min((e.data ->> 'total_score')::numeric) filter (where e.kind = 'match') as min_score,
  max((e.data ->> 'total_score')::numeric) filter (where e.kind = 'match') as max_score,

  -- PIT ESTIMATE — kept apart on purpose. Valuable before a team has played,
  -- misleading the moment it is averaged in with matches actually watched.
  avg((e.data ->> 'total_score')::numeric) filter (where e.kind = 'pit') as pit_estimate,

  count(*) filter (where e.kind = 'match' and (e.data ->> 'broke')::boolean)   as breakdowns,
  count(*) filter (where e.kind = 'match' and (e.data ->> 'no_show')::boolean) as no_shows
from public.scout_entries e
where e.event_key is not null
group by e.event_key, e.team_number;

alter view public.team_event_stats set (security_invoker = on);

-- `cascade` above dropped anything depending on the view. event_scout_coverage
-- (0006) reads matches_scouted, so it is recreated here unchanged.
create or replace view public.event_scout_coverage as
select
  t.event_key,
  count(*)                                                 as teams_at_event,
  count(*) filter (where s.matches_scouted > 0)            as teams_scouted,
  count(*) filter (where coalesce(s.matches_scouted,0) = 0) as teams_unscouted,
  coalesce(min(s.matches_scouted), 0)                      as min_matches,
  round(avg(coalesce(s.matches_scouted, 0)), 1)            as avg_matches,
  bool_and(coalesce(s.matches_scouted, 0) > 0)             as fully_covered
from public.event_teams t
left join public.team_event_stats s
       on s.event_key = t.event_key and s.team_number = t.team_number
group by t.event_key;

alter view public.event_scout_coverage set (security_invoker = on);
