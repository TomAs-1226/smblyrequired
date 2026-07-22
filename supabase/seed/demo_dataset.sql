-- =============================================================================
-- Demo dataset — realistic REBUILT scouting to showcase the portal.
--
-- Generates match + pit + strategy entries, robot photos' metadata, and
-- collaboration observations across 5805's three 2026 events, attributed to a
-- handful of clearly-marked demo scouts. Every number is derived from a per-team
-- hidden "skill" plus noise, so Compare, Team Detail, the pick list and the
-- dashboard all show plausible spreads rather than uniform filler.
--
-- REMOVABLE IN ONE LINE — everything here is attributed to demo scouts whose
-- profiles carry subteam = '__demo'. To wipe it:
--   delete from public.scout_entries where scout_id in
--     (select id from public.profiles where subteam = '__demo');
--   delete from public.robot_photos  where taken_by in
--     (select id from public.profiles where subteam = '__demo');
--   delete from public.team_collaboration where observed_by in
--     (select id from public.profiles where subteam = '__demo');
--   delete from public.picklists where name like 'Demo %';
--   delete from public.profiles where subteam = '__demo';
--   delete from auth.users where id in (
--     '000d0000-0000-0000-0000-000000000001','000d0000-0000-0000-0000-000000000002',
--     '000d0000-0000-0000-0000-000000000003','000d0000-0000-0000-0000-000000000004');
--
-- Runs as postgres (Management API / SQL editor), so the scout-control and
-- daily-pass triggers — which exempt a null auth.uid() — do not block it.
-- =============================================================================

begin;

-- --- demo scouts --------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data, created_at)
values
  ('000d0000-0000-0000-0000-000000000001','demo.alex@example.invalid','{}','2026-03-01'),
  ('000d0000-0000-0000-0000-000000000002','demo.sam@example.invalid','{}','2026-03-01'),
  ('000d0000-0000-0000-0000-000000000003','demo.jordan@example.invalid','{}','2026-03-01'),
  ('000d0000-0000-0000-0000-000000000004','demo.riley@example.invalid','{}','2026-03-01')
on conflict (id) do nothing;

insert into public.profiles (id, full_name, role, subteam, grad_year)
values
  ('000d0000-0000-0000-0000-000000000001','Alex Rivera (demo)','member','__demo',2027),
  ('000d0000-0000-0000-0000-000000000002','Sam Chen (demo)','member','__demo',2026),
  ('000d0000-0000-0000-0000-000000000003','Jordan Lee (demo)','member','__demo',2028),
  ('000d0000-0000-0000-0000-000000000004','Riley Park (demo)','lead','__demo',2026)
on conflict (id) do update set subteam = '__demo';

-- Clear any previous demo run so this file is safe to re-run.
delete from public.scout_entries where scout_id in (select id from public.profiles where subteam = '__demo');
delete from public.robot_photos where taken_by in (select id from public.profiles where subteam = '__demo');
delete from public.team_collaboration where observed_by in (select id from public.profiles where subteam = '__demo');
delete from public.picklists where name like 'Demo %';

-- --- generator ----------------------------------------------------------------
do $$
declare
  demo_scouts uuid[] := array[
    '000d0000-0000-0000-0000-000000000001','000d0000-0000-0000-0000-000000000002',
    '000d0000-0000-0000-0000-000000000003','000d0000-0000-0000-0000-000000000004'
  ];
  ev record;
  tm record;
  skill numeric;         -- hidden per-team ability, 0..1
  consistency numeric;   -- how tight their match-to-match spread is
  n_matches int;
  m int;
  scout uuid;
  auto_fuel int; teleop_fuel int; teleop_missed int;
  auto_climb boolean; climb_choice int; climb_pts int; climb_label text;
  broke boolean; no_show boolean;
  total int;
  base_day date;
begin
  for ev in select key, start_date from public.events where year = 2026 order by start_date loop
    base_day := coalesce(ev.start_date, date '2026-03-07');

    for tm in select team_number from public.event_teams where event_key = ev.key loop
      -- Deterministic-ish skill seeded from the team number so re-runs and the
      -- three events tell a consistent story about each team.
      skill := 0.15 + 0.8 * ((tm.team_number * 2654435761) % 1000) / 1000.0;
      consistency := 0.5 + 0.5 * random();
      n_matches := 6 + floor(random() * 6)::int;   -- 6..11 qual matches

      for m in 1..n_matches loop
        scout := demo_scouts[1 + floor(random() * array_length(demo_scouts, 1))::int];
        no_show := random() < 0.03;
        broke := (not no_show) and random() < 0.08 * (1.3 - skill);

        if no_show then
          auto_fuel := 0; teleop_fuel := 0; teleop_missed := 0;
          auto_climb := false; climb_choice := 0; climb_pts := 0; climb_label := 'None';
        else
          -- Fuel scales with skill; noise widens for inconsistent teams.
          auto_fuel := greatest(0, round((skill * 10) + (1 - consistency) * (random() * 8 - 4))::numeric)::int;
          teleop_fuel := greatest(0, round((skill * 45) + (1 - consistency) * (random() * 24 - 12))::numeric)::int;
          if broke then teleop_fuel := floor(teleop_fuel * random() * 0.5)::int; end if;
          teleop_missed := floor(teleop_fuel * (0.1 + (1 - skill) * 0.4) * random())::int;
          auto_climb := random() < skill * 0.5;
          -- Better teams reach higher tower levels more often.
          climb_choice := case
            when broke then 0
            when random() < skill * 0.6 then 3
            when random() < skill * 0.8 then 2
            when random() < 0.85 then 1
            else 0 end;
          climb_pts := case climb_choice when 1 then 10 when 2 then 20 when 3 then 30 else 0 end;
          climb_label := case climb_choice
            when 1 then 'Level 1 (10)' when 2 then 'Level 2 (20)' when 3 then 'Level 3 (30)'
            else 'None' end;
        end if;

        total := auto_fuel + teleop_fuel + climb_pts + (case when auto_climb then 15 else 0 end);

        insert into public.scout_entries
          (client_uuid, kind, event_key, team_number, match_key, match_number, comp_level,
           alliance, data, notes, scout_id, recorded_at)
        values (
          gen_random_uuid(), 'match', ev.key, tm.team_number,
          ev.key || '_qm' || m, m, 'qm',
          case when random() < 0.5 then 'red' else 'blue' end,
          jsonb_build_object(
            'auto_fuel', auto_fuel, 'teleop_fuel', teleop_fuel, 'teleop_missed', teleop_missed,
            'auto_tower_l1', auto_climb, 'climb_level', climb_label,
            'total_score', total, 'broke', broke, 'no_show', no_show,
            'driver_rating', least(5, greatest(1, round(skill * 5 + random())::int)),
            'defence_played', random() < 0.2
          ),
          case when broke then 'Died mid-match, tipped near the hub.'
               when climb_choice = 3 then 'Fast L3 climb, ~6s.'
               else null end,
          scout,
          (base_day + (m / 4) * interval '1 day' + (10 + random() * 7) * interval '1 hour')
        )
        on conflict (client_uuid) do nothing;
      end loop;

      -- One pit entry for most teams.
      if random() < 0.8 then
        insert into public.scout_entries
          (client_uuid, kind, event_key, team_number, data, notes, scout_id, recorded_at)
        values (
          gen_random_uuid(), 'pit', ev.key, tm.team_number,
          jsonb_build_object(
            'drivetrain', (array['Swerve','Swerve','Swerve','Tank / West Coast'])[1+floor(random()*4)::int],
            'swerve_module', (array['SDS MK4i','WCP SwerveX','REV MAXSwerve','SDS MK4n'])[1+floor(random()*4)::int],
            'drive_motor', (array['Kraken X60','Falcon 500','NEO Vortex'])[1+floor(random()*3)::int],
            'battery_count', 2 + floor(random()*4)::int,
            'total_score', round(skill * 55)::int,
            'broke', random() < 0.15, 'no_show', false
          ),
          'Talked to their drive team in the pit.',
          demo_scouts[1 + floor(random() * 4)::int],
          base_day + interval '9 hours'
        )
        on conflict (client_uuid) do nothing;
      end if;
    end loop;
  end loop;

  -- Collaboration: two independent observers on a subset of teams, so the
  -- workability signal actually crosses its corroboration threshold in the demo.
  insert into public.team_collaboration
    (client_uuid, event_key, team_number, answered_questions, shared_strategy,
     responsive_in_queue, communication_rating, coordination_rating, would_partner_again,
     note, observed_by, observed_at)
  select
    gen_random_uuid(), et.event_key, et.team_number,
    random() < 0.8, random() < 0.7, random() < 0.85,
    1 + floor(random()*5)::int, 1 + floor(random()*5)::int, random() < 0.7,
    case when random() < 0.3 then 'Great in the queue, shared their auto plan.' else null end,
    obs.id,
    (select start_date from public.events e where e.key = et.event_key) + interval '11 hours'
  from public.event_teams et
  cross join lateral (
    select id from public.profiles where subteam = '__demo' order by random() limit 2
  ) obs
  where et.team_number % 3 = 0                 -- roughly a third of teams
  on conflict do nothing;
end $$;

-- --- a demo pick list on the main event --------------------------------------
do $$
declare pl uuid; ev text := '2026capoh';
begin
  if exists (select 1 from public.events where key = ev) then
    insert into public.picklists (event_key, name, created_by)
    values (ev, 'Demo pick list', '000d0000-0000-0000-0000-000000000004')
    returning id into pl;

    -- Seed entries from the top scouted teams, spread across tiers by avg score.
    insert into public.picklist_entries (picklist_id, team_number, tier, position)
    select pl, s.team_number,
      case
        when row_number() over (order by s.avg_score desc nulls last) <= 3 then 's'
        when row_number() over (order by s.avg_score desc nulls last) <= 8 then 'a'
        when row_number() over (order by s.avg_score desc nulls last) <= 16 then 'b'
        else 'unranked' end,
      row_number() over (order by s.avg_score desc nulls last) * 10
    from public.team_event_stats s
    where s.event_key = ev
    order by s.avg_score desc nulls last
    limit 24;
  end if;
end $$;

commit;

select
  (select count(*) from public.scout_entries) as entries,
  (select count(*) from public.team_collaboration) as collab,
  (select count(*) from public.picklists) as picklists,
  (select round(avg(matches_scouted),1) from public.team_event_stats) as avg_matches_per_team;
