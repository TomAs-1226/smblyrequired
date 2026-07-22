-- =============================================================================
-- 0011 — Vision pipeline: on-device detection as a scouting data stream.
--
-- A "master device" (a phone) points at the field and runs an object detector
-- ON THE DEVICE — no video ever leaves the phone, only the detections do. Each
-- capture is a `vision_session`; the detector emits periodic `vision_observations`
-- (a count and the boxes at a moment), timestamped so they can be lined up
-- against a match later.
--
-- HONEST SCOPE, encoded in the schema: `model` names WHAT produced the numbers,
-- and it is not optional. Today that is a generic detector (coco-ssd) that finds
-- objects, not fuel or robots specifically — so today this COLLECTS data and
-- proves the pipeline, it does not score a match. When a trained FRC model is
-- dropped in, its name goes in `model` and old observations stay honestly
-- labelled with the model that actually made them. A number whose provenance is
-- lost is a number you cannot trust, and analysis must always be able to ask
-- "which model said this?".
-- =============================================================================

create table public.vision_sessions (
  id           uuid primary key default gen_random_uuid(),
  event_key    text references public.events (key) on delete set null,
  -- Which match this capture was aimed at, if the operator set one. Null for a
  -- free-running "point at the field" session.
  match_key    text,
  device_label text,                    -- "Pit tablet", "Stands phone 2"
  model        text not null,           -- e.g. 'coco-ssd@2.2' — never blank
  model_note   text,                    -- honesty: "generic detector, not FRC-trained"
  started_by   uuid references public.profiles (id) on delete set null,
  started_at   timestamptz not null default now(),
  ended_at     timestamptz,
  frame_count  int not null default 0,
  created_at   timestamptz not null default now()
);

create index vision_sessions_event_idx on public.vision_sessions (event_key, started_at desc);

create table public.vision_observations (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null references public.vision_sessions (id) on delete cascade,
  -- ms since the session started; lets observations be ordered and aligned to a
  -- match clock without trusting each row's wall-clock stamp.
  offset_ms    int not null,
  recorded_at  timestamptz not null default now(),
  -- The headline number the pipeline produces at this instant. What it MEANS
  -- depends on the session's model — "objects in frame" for the generic
  -- detector, "fuel in flight" only once a model that can tell is loaded.
  object_count int not null default 0,
  -- The raw detections: [{class, score, bbox:[x,y,w,h]}]. Kept so a better model
  -- or a human can re-derive counts later from the same evidence, and so this
  -- doubles as labelled training data.
  detections   jsonb not null default '[]'::jsonb,
  team_number  int,                     -- if the operator tagged a robot
  created_at   timestamptz not null default now()
);

create index vision_obs_session_idx on public.vision_observations (session_id, offset_ms);
create index vision_obs_match_idx on public.vision_observations (created_at desc);

-- Per-session summary for the review UI, so it need not pull thousands of frames.
create view public.vision_session_summary as
select
  s.id,
  s.event_key,
  s.match_key,
  s.device_label,
  s.model,
  s.model_note,
  s.started_at,
  s.ended_at,
  s.frame_count,
  p.full_name as operator,
  count(o.id)            as observations,
  max(o.object_count)    as peak_count,
  round(avg(o.object_count), 1) as avg_count
from public.vision_sessions s
left join public.vision_observations o on o.session_id = s.id
left join public.profiles p on p.id = s.started_by
group by s.id, p.full_name;

alter view public.vision_session_summary set (security_invoker = on);

-- =============================================================================
-- RLS — member+ reads and runs a capture; lead+ can clean up.
-- =============================================================================
alter table public.vision_sessions     enable row level security;
alter table public.vision_observations enable row level security;

create policy "vision sessions: members read" on public.vision_sessions for select to authenticated
  using (public.is_at_least('member'));
create policy "vision sessions: members create own" on public.vision_sessions for insert to authenticated
  with check (public.is_at_least('member') and started_by = auth.uid());
create policy "vision sessions: owners update" on public.vision_sessions for update to authenticated
  using (started_by = auth.uid() and public.is_at_least('member'))
  with check (started_by = auth.uid());
create policy "vision sessions: leads manage" on public.vision_sessions for all to authenticated
  using (public.is_at_least('lead')) with check (public.is_at_least('lead'));

-- Observations may be written only into a session the caller owns — an operator
-- cannot inject frames into someone else's capture.
create policy "vision obs: members read" on public.vision_observations for select to authenticated
  using (public.is_at_least('member'));
create policy "vision obs: into own session" on public.vision_observations for insert to authenticated
  with check (
    public.is_at_least('member')
    and exists (
      select 1 from public.vision_sessions s
      where s.id = session_id and s.started_by = auth.uid()
    )
  );
create policy "vision obs: leads manage" on public.vision_observations for all to authenticated
  using (public.is_at_least('lead')) with check (public.is_at_least('lead'));
