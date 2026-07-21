-- =============================================================================
-- Scouting guarantees.
--
-- These are the rules that, if broken, corrupt data silently rather than
-- loudly — a duplicated sync inflates a team's averages, two active forms split
-- a season across incompatible schemas, and neither shows up as an error until
-- somebody makes an alliance pick on bad numbers.
-- =============================================================================

\set ON_ERROR_STOP on
set client_min_messages = notice;

insert into public.events (key, year, name, start_date)
  values ('2026test', 2026, 'Test Regional', '2026-03-06');
insert into public.event_teams (event_key, team_number, nickname)
  values ('2026test', 5805, 'SMbly Required'), ('2026test', 4414, 'HighTide');

insert into public.scout_forms (season, kind, name, fields, is_active) values
  (2026, 'match', 'Match 2026',
   '[{"key":"total_score","label":"Total","type":"number","min":0},
     {"key":"broke","label":"Broke down","type":"boolean"}]'::jsonb, true);

-- --- field validation ---------------------------------------------------------
do $$
declare bad text[] := array[
    '[{"key":"Bad Key","label":"x","type":"number"}]',        -- not snake_case
    '[{"key":"a","label":"x","type":"nonsense"}]',            -- unknown type
    '[{"key":"a","type":"number"}]',                          -- no label
    '[{"key":"a","label":"x","type":"select"}]',              -- select with no options
    '[{"key":"a","label":"x","type":"number"},
      {"key":"a","label":"y","type":"number"}]'               -- duplicate key
  ];
  b text; blocked boolean;
begin
  foreach b in array bad loop
    blocked := false;
    begin
      insert into public.scout_forms (season, kind, name, fields)
        values (2026, 'pit', 'bad', b::jsonb);
    exception when others then blocked := true;
    end;
    if not blocked then
      raise exception 'FAIL: malformed form accepted: %', left(b, 50);
    end if;
  end loop;
  raise notice 'PASS  malformed form definitions are rejected (% cases)', array_length(bad,1);
end $$;

-- --- one active form per season+kind ------------------------------------------
do $$
declare blocked boolean := false;
begin
  begin
    insert into public.scout_forms (season, kind, name, fields, is_active)
      values (2026, 'match', 'Competing form', '[]'::jsonb, true);
  exception when others then blocked := true;
  end;
  if not blocked then
    raise exception 'FAIL: two active match forms for 2026 — the season would split across schemas';
  end if;
  raise notice 'PASS  only one form per season+kind can be active';

  -- An inactive draft alongside it is fine, and is how you build next week's form.
  insert into public.scout_forms (season, kind, name, fields, is_active)
    values (2026, 'match', 'Draft', '[]'::jsonb, false);
  raise notice 'PASS  inactive drafts can coexist with the active form';
end $$;

-- --- offline sync idempotency -------------------------------------------------
-- The single most important guarantee here. A phone that uploads, loses signal
-- before hearing the 200, and retries must not create a second entry.
do $$
declare
  cu uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  fid uuid; n int; blocked boolean := false;
begin
  select id into fid from public.scout_forms where is_active and kind = 'match';

  insert into public.scout_entries
    (client_uuid, form_id, kind, event_key, team_number, match_key, match_number,
     comp_level, alliance, data, recorded_at)
  values (cu, fid, 'match', '2026test', 4414, '2026test_qm1', 1, 'qm', 'red',
          '{"total_score": 12}'::jsonb, now());

  begin
    -- the retry
    insert into public.scout_entries
      (client_uuid, form_id, kind, event_key, team_number, match_key, match_number,
       comp_level, alliance, data, recorded_at)
    values (cu, fid, 'match', '2026test', 4414, '2026test_qm1', 1, 'qm', 'red',
            '{"total_score": 12}'::jsonb, now());
  exception when unique_violation then blocked := true;
  end;

  if not blocked then raise exception 'FAIL: a retried sync created a duplicate entry'; end if;

  select count(*) into n from public.scout_entries where client_uuid = cu;
  if n <> 1 then raise exception 'FAIL: expected exactly 1 row for the client_uuid, found %', n; end if;
  raise notice 'PASS  a retried offline sync is idempotent (no duplicate)';
end $$;

-- --- match entries must identify their match ----------------------------------
do $$
declare blocked boolean := false; fid uuid;
begin
  select id into fid from public.scout_forms where is_active and kind = 'match';
  begin
    insert into public.scout_entries
      (client_uuid, form_id, kind, event_key, team_number, data, recorded_at)
    values (gen_random_uuid(), fid, 'match', '2026test', 4414, '{}'::jsonb, now());
  exception when others then blocked := true;
  end;
  if not blocked then
    raise exception 'FAIL: a match entry was stored with no match number or alliance';
  end if;
  raise notice 'PASS  match entries must carry a match number and alliance';

  -- Pit entries legitimately have neither.
  insert into public.scout_entries
    (client_uuid, kind, event_key, team_number, data, recorded_at)
  values (gen_random_uuid(), 'pit', '2026test', 4414, '{"drivetrain":"swerve"}'::jsonb, now());
  raise notice 'PASS  pit entries need no match identity';
end $$;

-- --- one entry per scout per match --------------------------------------------
do $$
declare
  s uuid := '33333333-3333-3333-3333-333333333333';  -- the member from 01_
  fid uuid; blocked boolean := false;
begin
  select id into fid from public.scout_forms where is_active and kind = 'match';

  insert into public.scout_entries
    (client_uuid, form_id, kind, event_key, team_number, match_key, match_number,
     comp_level, alliance, data, scout_id, recorded_at)
  values (gen_random_uuid(), fid, 'match', '2026test', 5805, '2026test_qm2', 2, 'qm', 'blue',
          '{"total_score": 8}'::jsonb, s, now());

  begin
    insert into public.scout_entries
      (client_uuid, form_id, kind, event_key, team_number, match_key, match_number,
       comp_level, alliance, data, scout_id, recorded_at)
    values (gen_random_uuid(), fid, 'match', '2026test', 5805, '2026test_qm2', 2, 'qm', 'blue',
            '{"total_score": 99}'::jsonb, s, now());
  exception when unique_violation then blocked := true;
  end;

  if not blocked then
    raise exception 'FAIL: the same scout logged one match twice — averages would be skewed';
  end if;
  raise notice 'PASS  one scout cannot double-log the same match';
end $$;

-- --- a member cannot submit under another scout's name -------------------------
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
  do $$
  declare blocked boolean := false;
  begin
    begin
      insert into public.scout_entries
        (client_uuid, kind, event_key, team_number, match_number, alliance,
         data, scout_id, recorded_at)
      values (gen_random_uuid(), 'match', '2026test', 4414, 5, 'red', '{}'::jsonb,
              '22222222-2222-2222-2222-222222222222', now());   -- somebody else
    exception when others then blocked := true;
    end;
    if not blocked then
      raise exception 'FAIL: a member attributed a scouting entry to another user';
    end if;
    raise notice 'PASS  entries cannot be attributed to another scout';
  end $$;
rollback;

-- --- a pending user cannot scout at all ---------------------------------------
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
  do $$
  declare n int; blocked boolean := false;
  begin
    select count(*) into n from public.scout_entries;
    if n <> 0 then raise exception 'FAIL: a pending user read % scouting entries', n; end if;

    begin
      insert into public.scout_entries
        (client_uuid, kind, event_key, team_number, match_number, alliance, data, scout_id, recorded_at)
      values (gen_random_uuid(), 'match', '2026test', 4414, 6, 'red', '{}'::jsonb, auth.uid(), now());
    exception when others then blocked := true;
    end;
    if not blocked then raise exception 'FAIL: a pending user submitted scouting data'; end if;
    raise notice 'PASS  pending users can neither read nor submit scouting data';
  end $$;
rollback;

-- --- only leads/mentors author forms ------------------------------------------
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
  do $$
  declare blocked boolean := false;
  begin
    begin
      insert into public.scout_forms (season, kind, name, fields)
        values (2027, 'match', 'Sneaky', '[]'::jsonb);
    exception when others then blocked := true;
    end;
    if not blocked then raise exception 'FAIL: a member authored a scouting form'; end if;
    raise notice 'PASS  members cannot author forms (mentor/lead only)';
  end $$;
rollback;

-- --- repo sources are admin-only ----------------------------------------------
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}';
  do $$
  declare blocked boolean := false;
  begin
    begin
      insert into public.repo_sources (label, owner, repo)
        values ('sneaky', 'someone', 'else');
    exception when others then blocked := true;
    end;
    if not blocked then raise exception 'FAIL: a lead added a repo source — that is admin-only'; end if;
    raise notice 'PASS  only an admin can define which repos are pulled';
  end $$;
rollback;

-- --- aggregates ----------------------------------------------------------------
do $$
declare m int; a numeric;
begin
  select matches_scouted, avg_score into m, a
    from public.team_event_stats where event_key = '2026test' and team_number = 4414;
  if m is null or m < 1 then raise exception 'FAIL: team_event_stats produced no row for 4414'; end if;
  raise notice 'PASS  team_event_stats aggregates entries (4414: % matches, avg %)', m, round(coalesce(a,0),1);
end $$;

\echo ''
\echo '  ALL SCOUTING TESTS PASSED'
