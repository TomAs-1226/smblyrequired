-- =============================================================================
-- 0008 — Collaboration signal.
--
-- How workable a team is as a partner belongs in a pick list. An alliance is
-- three teams coordinating under time pressure, and a fast robot whose drive
-- team will not answer a radio can cost more than it scores.
--
-- The design decision that matters here: this records OBSERVED BEHAVIOUR, not
-- character labels. "Did not share their auto routine" is a fact, it is checkable,
-- and it tells the strategy lead what to plan around. "Arrogant" is a label — it
-- is unfalsifiable, it usually comes from one bad interaction, and it tells you
-- nothing you can act on. Behaviour also ages correctly: a team that was
-- unresponsive on Friday morning and great on Saturday shows up as exactly that.
--
-- These rows describe named teams of mostly minors. That is why:
--   * the read floor is `member` (never `viewer` — not alumni, not parents)
--   * `note` is free text and therefore the most likely thing to be regretted,
--     so it carries an explicit reminder in the UI
--   * every row is attributed and dated; anonymous reputational notes are how
--     this kind of data goes wrong
-- =============================================================================

create table public.team_collaboration (
  id           uuid primary key default gen_random_uuid(),
  client_uuid  uuid unique,
  event_key    text references public.events (key) on delete set null,
  team_number  int not null check (team_number > 0),

  -- Observable, answerable in the pit or after a match. Null means "did not
  -- observe", which is different from "no" and must stay different — absence of
  -- evidence quietly becoming a negative is exactly how this gets unfair.
  answered_questions   boolean,
  shared_strategy      boolean,
  showed_up_prepared   boolean,
  responsive_in_queue  boolean,

  -- 1–5. Deliberately about the interaction, not the people.
  communication_rating int check (communication_rating between 1 and 5),
  coordination_rating  int check (coordination_rating between 1 and 5),

  -- The question a pick list actually needs answered.
  would_partner_again  boolean,

  note         text,

  observed_by  uuid references public.profiles (id) on delete set null,
  observed_at  timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create index team_collab_team_idx on public.team_collaboration (event_key, team_number);
create index team_collab_observer_idx on public.team_collaboration (observed_by, observed_at desc);

-- One observation per scout per team per event. A second is a correction, not a
-- new data point — otherwise one person with a grudge can outvote everyone else
-- simply by submitting five times.
create unique index team_collab_one_per_scout
  on public.team_collaboration (event_key, team_number, observed_by)
  where observed_by is not null;

-- -----------------------------------------------------------------------------
-- Aggregate.
--
-- Requires at least TWO independent observers before reporting a summary score.
-- A single bad interaction is not a pattern, and a pick list that ranks a team
-- down because one scout had one awkward conversation is worse than no signal.
-- -----------------------------------------------------------------------------
create view public.team_collaboration_summary as
select
  c.event_key,
  c.team_number,
  count(*)                                        as observations,
  count(distinct c.observed_by)                   as observers,
  round(avg(c.communication_rating), 1)           as avg_communication,
  round(avg(c.coordination_rating), 1)            as avg_coordination,
  count(*) filter (where c.would_partner_again)   as would_partner,
  count(*) filter (where c.would_partner_again = false) as would_not_partner,
  count(*) filter (where c.answered_questions = false)  as unanswered_questions,
  count(*) filter (where c.shared_strategy = false)     as withheld_strategy,
  -- Null until corroborated. The UI must render null as "not enough data",
  -- never as a neutral or a zero.
  case
    when count(distinct c.observed_by) >= 2
      then round((coalesce(avg(c.communication_rating), 3)
                + coalesce(avg(c.coordination_rating), 3)) / 2, 1)
    else null
  end                                             as workability,
  max(c.observed_at)                              as last_observed
from public.team_collaboration c
group by c.event_key, c.team_number;

alter view public.team_collaboration_summary set (security_invoker = on);

-- =============================================================================
-- RLS
--
-- Read floor is `member`, deliberately one step above the `viewer` floor used
-- for team media. Alumni and parents have no reason to read subjective notes
-- about other schools' students.
-- =============================================================================
alter table public.team_collaboration enable row level security;

create policy "collab: members read" on public.team_collaboration for select to authenticated
  using (public.is_at_least('member'));

create policy "collab: members record own" on public.team_collaboration for insert to authenticated
  with check (public.is_at_least('member') and observed_by = auth.uid());

-- You may revise your own observation — impressions legitimately change over an
-- event, and someone who cannot correct a first-morning judgement will simply
-- leave it standing.
create policy "collab: owners revise" on public.team_collaboration for update to authenticated
  using (observed_by = auth.uid() and public.is_at_least('member'))
  with check (observed_by = auth.uid());

-- Leads can delete. There must be a way to remove something written in anger
-- that should not be in a database about other people's students.
create policy "collab: leads manage" on public.team_collaboration for all to authenticated
  using (public.is_at_least('lead')) with check (public.is_at_least('lead'));
