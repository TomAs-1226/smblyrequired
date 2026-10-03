-- =============================================================================
-- Portal guarantees from migrations 0006-0013.
--
-- 01 and 02 cover identity, content and the core scouting tables. Everything
-- added after 0005 — pick lists, the daily pass limit, collaboration notes,
-- scouting control, vision, and the 0013 fixes — had no test at all, and the
-- runner did not even apply those migrations. These assertions pin the rules the
-- portal's screens and its offline queue rely on.
--
-- Runs after 01 and 02 and reuses their seed: the five role users, the
-- '2026test' event with teams 5805 and 4414, and the entries 02 left behind.
-- =============================================================================

\set ON_ERROR_STOP on
set client_min_messages = notice;

-- =============================================================================
-- 0013 — schema the portal selects but no migration used to create
-- =============================================================================
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'graphs_html_file_id_fkey'
       and conrelid = 'public.graphs'::regclass
  ) then
    raise exception 'FAIL: graphs.html_file_id / graphs_html_file_id_fkey missing — the Graphs tab selects both';
  end if;
  raise notice 'PASS  graphs.html_file_id exists under the FK name the portal embeds';
end $$;

-- The offline queue tells a retried delivery (client_uuid collision: success)
-- apart from a second entry for the same match (a correction) by these names.
-- Renaming either constraint silently changes what the queue does.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'scout_entries_client_uuid_key')
     or not exists (select 1 from pg_class where relname = 'scout_entries_one_per_match') then
    raise exception 'FAIL: scout_entries unique constraint names changed — src/lib/offlineQueue.js matches on them';
  end if;
  raise notice 'PASS  scout_entries unique constraints carry the names the offline queue matches';
end $$;

-- =============================================================================
-- 0013 — team_scout_checklist no longer multiplies entries by photos
-- =============================================================================
insert into public.scout_entries (client_uuid, kind, event_key, team_number, data, recorded_at)
  values (gen_random_uuid(), 'pit', '2026test', 4414, '{}'::jsonb, now());
insert into public.robot_photos (event_key, team_number, angle)
  values ('2026test', 4414, 'front'), ('2026test', 4414, 'side'), ('2026test', 4414, 'rear');

do $$
declare
  want_pit int; want_match int; want_photos int;
  got record;
begin
  select count(*) filter (where kind = 'pit'), count(*) filter (where kind = 'match')
    into want_pit, want_match
    from public.scout_entries where event_key = '2026test' and team_number = 4414;
  select count(*) into want_photos
    from public.robot_photos where event_key = '2026test' and team_number = 4414;

  select * into got from public.team_scout_checklist
   where event_key = '2026test' and team_number = 4414;

  if got.pit_passes <> want_pit or got.match_passes <> want_match or got.photos <> want_photos then
    raise exception 'FAIL: checklist reports pit=% match=% photos=%, the tables hold pit=% match=% photos=%',
      got.pit_passes, got.match_passes, got.photos, want_pit, want_match, want_photos;
  end if;
  raise notice 'PASS  coverage counts are exact (pit %, match %, photos %) — no join fan-out',
    want_pit, want_match, want_photos;
end $$;

-- =============================================================================
-- 0013 — one unparseable answer no longer takes the stats view down
-- =============================================================================
do $$
declare before_avg numeric; before_scored bigint; after_avg numeric; after_scored bigint; after_n bigint;
begin
  select avg_score, scored_matches into before_avg, before_scored
    from public.team_event_stats where event_key = '2026test' and team_number = 4414;

  insert into public.scout_entries
    (client_uuid, kind, event_key, team_number, match_key, match_number, comp_level, alliance,
     data, recorded_at)
  values (gen_random_uuid(), 'match', '2026test', 4414, '2026test_qm9', 9, 'qm', 'blue',
          '{"total_score":"lots","broke":"maybe"}'::jsonb, now());

  -- Before 0013 this select raised "invalid input syntax for type numeric" for
  -- every team at the event, not just 4414.
  select avg_score, scored_matches, matches_scouted into after_avg, after_scored, after_n
    from public.team_event_stats where event_key = '2026test' and team_number = 4414;

  if after_avg is distinct from before_avg or after_scored <> before_scored then
    raise exception 'FAIL: a malformed total_score changed the average (% -> %) or scored count',
      before_avg, after_avg;
  end if;
  if public.try_numeric('"12"'::jsonb) <> 12 or public.try_numeric('12.5'::jsonb) <> 12.5
     or public.try_numeric('"lots"'::jsonb) is not null or public.try_bool('true'::jsonb) is not true then
    raise exception 'FAIL: try_numeric / try_bool do not parse what the portal writes';
  end if;
  raise notice 'PASS  a malformed answer is skipped, not fatal (4414: % matches, % scored)', after_n, after_scored;
end $$;

-- =============================================================================
-- 0007 — daily pass limit
-- =============================================================================
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
  do $$
  declare me uuid := auth.uid(); blocked boolean := false; left_ int;
  begin
    insert into public.scout_entries (client_uuid, kind, event_key, team_number, data, scout_id, recorded_at)
      values (gen_random_uuid(), 'pit', '2026test', 5805, '{}', me, now()),
             (gen_random_uuid(), 'pit', '2026test', 5805, '{}', me, now());

    left_ := public.passes_remaining(5805, 'pit', '2026test');
    if left_ <> 0 then
      raise exception 'FAIL: passes_remaining reports % after two pit passes', left_;
    end if;

    begin
      insert into public.scout_entries (client_uuid, kind, event_key, team_number, data, scout_id, recorded_at)
        values (gen_random_uuid(), 'pit', '2026test', 5805, '{}', me, now());
    exception when check_violation then blocked := true;
    end;
    if not blocked then raise exception 'FAIL: a third pit pass on one team in one day was accepted'; end if;

    if public.passes_remaining(5805, 'match', '2026test') < 2 then
      raise exception 'FAIL: match scouting must not be capped by the daily limit';
    end if;
    raise notice 'PASS  the third pit pass in a day is refused, and passes_remaining agrees';
  end $$;
rollback;

-- =============================================================================
-- 0010 — active event and scouting window, enforced on insert
-- =============================================================================
insert into public.events (key, year, name) values ('2026other', 2026, 'Other Regional');

begin;
  update public.scout_settings set active_event_key = '2026test' where id = 1;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
  do $$
  declare blocked boolean := false;
  begin
    begin
      insert into public.scout_entries (client_uuid, kind, event_key, team_number, data, scout_id, recorded_at)
        values (gen_random_uuid(), 'strategy', '2026other', 4414, '{}', auth.uid(), now());
    exception when others then blocked := sqlerrm like 'scouting is set to event%';
    end;
    if not blocked then raise exception 'FAIL: a member scouted an event other than the active one'; end if;

    insert into public.scout_entries (client_uuid, kind, event_key, team_number, data, scout_id, recorded_at)
      values (gen_random_uuid(), 'strategy', '2026test', 4414, '{}', auth.uid(), now());
    raise notice 'PASS  a member is held to the active event';
  end $$;
rollback;

begin;
  update public.scout_settings set active_event_key = '2026test' where id = 1;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}';
  insert into public.scout_entries (client_uuid, kind, event_key, team_number, data, scout_id, recorded_at)
    values (gen_random_uuid(), 'strategy', '2026other', 4414, '{}', auth.uid(), now());
  do $$ begin raise notice 'PASS  a lead may scout outside the active event'; end $$;
rollback;

begin;
  -- A one-minute window at midnight UTC, and an entry recorded at noon UTC: the
  -- check is on recorded_at (when the scout pressed save), not on arrival time.
  update public.scout_settings
     set lock_enabled = true, window_start = '00:00', window_end = '00:01', timezone = 'UTC'
   where id = 1;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
  do $$
  declare blocked boolean := false; open_ boolean;
  begin
    begin
      insert into public.scout_entries (client_uuid, kind, event_key, team_number, data, scout_id, recorded_at)
        values (gen_random_uuid(), 'strategy', '2026test', 5805, '{}', auth.uid(),
                date_trunc('day', now()) + interval '12 hours');
    exception when others then blocked := sqlerrm like 'scouting is closed%';
    end;
    if not blocked then raise exception 'FAIL: an entry recorded outside the window was accepted'; end if;

    select open_now into open_ from public.scout_control_status;
    if open_ is null then raise exception 'FAIL: a member cannot read scout_control_status'; end if;
    raise notice 'PASS  the scouting window holds against recorded_at, and members can read its state';
  end $$;
rollback;

begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
  do $$
  declare n int;
  begin
    update public.scout_settings set lock_enabled = true where id = 1;
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'FAIL: a member changed the scouting settings'; end if;
    raise notice 'PASS  members cannot change the active event or the window';
  end $$;
rollback;

-- =============================================================================
-- 0006 — pick lists: lead-edited, and a locked list is frozen in the database
-- =============================================================================
insert into public.picklists (id, event_key, name, is_locked)
  values ('bbbbbbbb-0000-0000-0000-000000000001', '2026test', 'Locked list', true);
-- Entries go in before the lock matters: the trigger refuses writes to a locked
-- list, so seed through an unlocked one and lock afterwards.
update public.picklists set is_locked = false where id = 'bbbbbbbb-0000-0000-0000-000000000001';
insert into public.picklist_entries (picklist_id, team_number, tier, position)
  values ('bbbbbbbb-0000-0000-0000-000000000001', 5805, 'a', 10);
update public.picklists set is_locked = true where id = 'bbbbbbbb-0000-0000-0000-000000000001';

begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}';
  do $$
  declare blocked boolean := false;
  begin
    begin
      update public.picklist_entries set position = 5
       where picklist_id = 'bbbbbbbb-0000-0000-0000-000000000001';
    exception when others then blocked := sqlerrm like '%pick list is locked%';
    end;
    if not blocked then raise exception 'FAIL: a lead reordered a locked pick list'; end if;
    raise notice 'PASS  a locked pick list rejects edits, even from a lead';
  end $$;
rollback;

begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
  do $$
  declare blocked boolean := false; n int;
  begin
    select count(*) into n from public.picklist_entries;
    if n = 0 then raise exception 'FAIL: a member cannot read the pick list'; end if;
    begin
      insert into public.picklists (event_key, name) values ('2026test', 'Mine');
    exception when insufficient_privilege then blocked := true;
    end;
    if not blocked then raise exception 'FAIL: a member created a pick list (lead+ only)'; end if;
    raise notice 'PASS  members read the pick list but cannot edit it';
  end $$;
rollback;

-- =============================================================================
-- 0008 — collaboration notes: attributed, one per observer, corroborated
-- =============================================================================
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
  do $$
  declare blocked boolean := false; dup boolean := false; w numeric;
  begin
    begin
      insert into public.team_collaboration (event_key, team_number, communication_rating, observed_by)
        values ('2026test', 4414, 1, '44444444-4444-4444-4444-444444444444');
    exception when insufficient_privilege then blocked := true;
    end;
    if not blocked then raise exception 'FAIL: a member recorded an observation in someone else''s name'; end if;

    insert into public.team_collaboration (event_key, team_number, communication_rating, coordination_rating, observed_by)
      values ('2026test', 4414, 2, 2, auth.uid());
    begin
      insert into public.team_collaboration (event_key, team_number, communication_rating, observed_by)
        values ('2026test', 4414, 1, auth.uid());
    exception when unique_violation then dup := true;
    end;
    if not dup then raise exception 'FAIL: one observer recorded two observations of the same team'; end if;

    select workability into w from public.team_collaboration_summary
     where event_key = '2026test' and team_number = 4414;
    if w is not null then
      raise exception 'FAIL: workability reported from a single observer (%)', w;
    end if;
    raise notice 'PASS  collaboration notes are attributed, one per observer, and need two observers';
  end $$;
rollback;

-- =============================================================================
-- 0011 — vision: frames only into your own session
-- =============================================================================
insert into public.vision_sessions (id, event_key, model, started_by)
  values ('cccccccc-0000-0000-0000-000000000001', '2026test', 'coco-ssd@2.2',
          '44444444-4444-4444-4444-444444444444');

begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
  do $$
  declare blocked boolean := false; sid uuid; n bigint;
  begin
    begin
      insert into public.vision_observations (session_id, offset_ms, object_count)
        values ('cccccccc-0000-0000-0000-000000000001', 0, 3);
    exception when insufficient_privilege then blocked := true;
    end;
    if not blocked then raise exception 'FAIL: a member injected frames into another operator''s session'; end if;

    insert into public.vision_sessions (event_key, model, started_by)
      values ('2026test', 'coco-ssd@2.2', auth.uid()) returning id into sid;
    insert into public.vision_observations (session_id, offset_ms, object_count) values (sid, 0, 2), (sid, 500, 4);

    select observations into n from public.vision_session_summary where id = sid;
    if n <> 2 then raise exception 'FAIL: vision_session_summary saw % observations, expected 2', n; end if;
    raise notice 'PASS  vision frames go only into your own session, and the summary counts them';
  end $$;
rollback;

-- =============================================================================
-- The offline queue's correction path: a second entry for a match you already
-- logged collides on scout_entries_one_per_match, and the queue turns it into an
-- UPDATE of your own row. That UPDATE has to be allowed.
-- =============================================================================
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
  do $$
  declare cname text := ''; n int;
  begin
    begin
      insert into public.scout_entries
        (client_uuid, kind, event_key, team_number, match_key, match_number, comp_level, alliance,
         data, scout_id, recorded_at)
      values (gen_random_uuid(), 'match', '2026test', 5805, '2026test_qm2', 2, 'qm', 'blue',
              '{"total_score": 11}'::jsonb, auth.uid(), now());
    exception when unique_violation then
      get stacked diagnostics cname = constraint_name;
    end;
    if cname <> 'scout_entries_one_per_match' then
      raise exception 'FAIL: a re-scouted match collided on "%", not scout_entries_one_per_match', cname;
    end if;

    update public.scout_entries set data = '{"total_score": 11}'::jsonb
     where event_key = '2026test' and team_number = 5805 and match_key = '2026test_qm2'
       and scout_id = auth.uid();
    get diagnostics n = row_count;
    if n <> 1 then raise exception 'FAIL: a scout could not correct their own match entry (% rows)', n; end if;
    raise notice 'PASS  a re-scouted match is detectable by name and correctable by its scout';
  end $$;
rollback;

\echo ''
\echo '  ALL PORTAL TESTS PASSED'
