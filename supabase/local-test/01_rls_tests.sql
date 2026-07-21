-- =============================================================================
-- RLS behaviour tests.
--
-- Every claim the portal makes about who can see and do what is asserted here
-- against a real Postgres. Each test switches to the `authenticated` role and
-- sets a JWT claim, which is exactly how PostgREST executes a browser request —
-- so these exercise the same path production does, not an approximation.
--
-- Any failure raises and aborts. Silence is not success; each pass prints.
-- =============================================================================

\set ON_ERROR_STOP on
\timing off
set client_min_messages = notice;

-- --- seed ---------------------------------------------------------------------
-- Inserting into auth.users fires on_auth_user_created, which is itself part of
-- what is being tested: everyone must land at 'pending' regardless of metadata.

insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111', 'pending@t.test',  '{"full_name":"Pat Pending"}'),
  ('22222222-2222-2222-2222-222222222222', 'viewer@t.test',   '{"full_name":"Vic Viewer"}'),
  ('33333333-3333-3333-3333-333333333333', 'member@t.test',   '{"full_name":"Mel Member"}'),
  ('44444444-4444-4444-4444-444444444444', 'lead@t.test',     '{"full_name":"Lee Lead"}'),
  ('55555555-5555-5555-5555-555555555555', 'admin@t.test',    '{"full_name":"Adi Admin"}'),
  ('66666666-6666-6666-6666-666666666666', 'attacker@t.test', '{"full_name":"Eve","role":"admin"}');

do $$
declare n int;
begin
  select count(*) into n from public.profiles where role <> 'pending';
  if n <> 0 then
    raise exception 'FAIL: signup produced % non-pending profile(s) — signup must not grant access', n;
  end if;
  raise notice 'PASS  every new signup lands at pending (metadata role:admin ignored)';
end $$;

-- Promote out-of-band, the way the documented bootstrap does.
update public.profiles set role = 'viewer' where id = '22222222-2222-2222-2222-222222222222';
update public.profiles set role = 'member' where id = '33333333-3333-3333-3333-333333333333';
update public.profiles set role = 'lead'   where id = '44444444-4444-4444-4444-444444444444';
update public.profiles set role = 'admin'  where id = '55555555-5555-5555-5555-555555555555';

insert into public.knowledge_docs (slug, title, body_md, category)
  values ('build-process', 'Build process', 'How we build.', 'build');
insert into public.files (bucket, path, title, kind, uploaded_by)
  values ('media', '2026/photo.jpg', 'Pit photo', 'photo', '33333333-3333-3333-3333-333333333333'),
         ('code',  '2026/src.zip',   'Season code', 'code', '33333333-3333-3333-3333-333333333333');
insert into public.backup_runs (leg, status, object_count, byte_total)
  values ('supabase->server', 'ok', 2, 1024);
insert into storage.objects (bucket_id, name, owner)
  values ('media', '2026/photo.jpg', '33333333-3333-3333-3333-333333333333');

-- =============================================================================
-- anon
-- =============================================================================
begin;
  set local role anon;
  do $$
  declare p int; k int; f int; b int;
  begin
    select count(*) into p from public.profiles;
    select count(*) into k from public.knowledge_docs;
    select count(*) into f from public.files;
    select count(*) into b from public.backup_runs;
    if (p + k + f + b) <> 0 then
      raise exception 'FAIL: anon can read rows (profiles=%, kb=%, files=%, backups=%)', p, k, f, b;
    end if;
    raise notice 'PASS  anon (the public internet) reads nothing from any table';
  end $$;
rollback;

-- =============================================================================
-- pending — signed in, approved by nobody
-- =============================================================================
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
  do $$
  declare k int; f int; roster int; own int;
  begin
    select count(*) into k from public.knowledge_docs;
    select count(*) into f from public.files;
    select count(*) into roster from public.profiles;
    select count(*) into own from public.profiles where id = auth.uid();
    if k <> 0 then raise exception 'FAIL: pending reads % knowledge doc(s)', k; end if;
    if f <> 0 then raise exception 'FAIL: pending reads % file(s)', f; end if;
    if roster <> 1 then
      raise exception 'FAIL: pending sees % profile(s); must see only their own', roster;
    end if;
    if own <> 1 then raise exception 'FAIL: pending cannot see their own profile'; end if;
    raise notice 'PASS  pending reads no content and cannot enumerate the roster';
  end $$;
rollback;

-- =============================================================================
-- privilege escalation — the failure mode that matters most
-- =============================================================================
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
  do $$
  declare blocked boolean := false;
  begin
    begin
      update public.profiles set role = 'admin' where id = auth.uid();
    exception when others then blocked := true;
    end;
    if not blocked then
      -- No exception is still a failure if the value actually changed.
      if (select role from public.profiles where id = auth.uid()) = 'admin' then
        raise exception 'FAIL: a member escalated themselves to admin by direct UPDATE';
      end if;
    end if;
    raise notice 'PASS  member cannot raise their own role by direct UPDATE';
  end $$;
rollback;

begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
  do $$
  declare blocked boolean := false;
  begin
    begin
      perform public.set_member_role('33333333-3333-3333-3333-333333333333', 'admin');
    exception when others then blocked := true;
    end;
    if not blocked then raise exception 'FAIL: a member called set_member_role successfully'; end if;
    raise notice 'PASS  member cannot call set_member_role';
  end $$;
rollback;

begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}';
  do $$
  declare blocked boolean := false;
  begin
    begin
      perform public.set_member_role('33333333-3333-3333-3333-333333333333', 'admin');
    exception when others then blocked := true;
    end;
    if not blocked then raise exception 'FAIL: a LEAD granted a role — that is admin-only'; end if;
    raise notice 'PASS  lead cannot grant roles (admin-only)';
  end $$;
rollback;

-- =============================================================================
-- admin — can grant, cannot self-promote, cannot orphan the project
-- =============================================================================
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated"}';
  do $$
  declare r public.member_role; blocked boolean := false;
  begin
    perform public.set_member_role('33333333-3333-3333-3333-333333333333', 'lead');
    select role into r from public.profiles where id = '33333333-3333-3333-3333-333333333333';
    if r <> 'lead' then raise exception 'FAIL: admin could not grant a role (got %)', r; end if;
    raise notice 'PASS  admin can grant a role';

    begin
      perform public.set_member_role('55555555-5555-5555-5555-555555555555', 'member');
    exception when others then blocked := true;
    end;
    if not blocked then raise exception 'FAIL: admin changed their OWN role'; end if;
    raise notice 'PASS  admin cannot change their own role';
  end $$;
rollback;

-- The two lockout guards. Both were bugs found in review: the demotion guard
-- existed but the DELETE path bypassed it entirely, which is unrecoverable —
-- set_member_role needs an admin, so zero admins means never again.
do $$
declare blocked boolean := false;
begin
  begin
    update public.profiles set role = 'member' where id = '55555555-5555-5555-5555-555555555555';
  exception when others then blocked := true;
  end;
  if not blocked then raise exception 'FAIL: the last admin was demoted'; end if;
  raise notice 'PASS  the last admin cannot be demoted';

  blocked := false;
  begin
    delete from public.profiles where id = '55555555-5555-5555-5555-555555555555';
  exception when others then blocked := true;
  end;
  if not blocked then raise exception 'FAIL: the last admin was DELETED — project is now unadministrable'; end if;
  raise notice 'PASS  the last admin cannot be deleted';

  blocked := false;
  begin
    delete from auth.users where id = '55555555-5555-5555-5555-555555555555';
  exception when others then blocked := true;
  end;
  if not blocked then raise exception 'FAIL: last admin removed via auth.users cascade'; end if;
  raise notice 'PASS  the cascade from auth.users cannot orphan the project either';
end $$;

-- =============================================================================
-- read floors
-- =============================================================================
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
  do $$
  declare k int; media int; code int; bk int;
  begin
    select count(*) into k     from public.knowledge_docs;
    select count(*) into media from public.files where bucket = 'media';
    select count(*) into code  from public.files where bucket = 'code';
    select count(*) into bk    from public.backup_runs;
    if k    <> 0 then raise exception 'FAIL: viewer reads the knowledge base'; end if;
    if code <> 0 then raise exception 'FAIL: viewer reads internal code files'; end if;
    if media <> 1 then raise exception 'FAIL: viewer should see team media, saw %', media; end if;
    if bk   <> 0 then raise exception 'FAIL: viewer reads backup runs (member+)'; end if;
    raise notice 'PASS  viewer sees team media only — no kb, no code, no backups';
  end $$;
rollback;

begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
  do $$
  declare k int; f int; bk int; a int;
  begin
    select count(*) into k  from public.knowledge_docs;
    select count(*) into f  from public.files;
    select count(*) into bk from public.backup_runs;
    select count(*) into a  from public.audit_log;
    if k  <> 1 then raise exception 'FAIL: member cannot read the knowledge base'; end if;
    if f  <> 2 then raise exception 'FAIL: member sees % files, expected 2', f; end if;
    if bk <> 1 then raise exception 'FAIL: member cannot read backup health'; end if;
    if a  <> 0 then raise exception 'FAIL: member reads the audit log (lead+)'; end if;
    raise notice 'PASS  member reads content and backup health, but not the audit log';
  end $$;
rollback;

-- =============================================================================
-- storage — the WITH CHECK hole found in review
-- =============================================================================
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
  do $$
  declare blocked boolean := false; o uuid;
  begin
    begin
      update storage.objects
         set owner = '22222222-2222-2222-2222-222222222222'
       where bucket_id = 'media';
    exception when others then blocked := true;
    end;
    select owner into o from storage.objects where bucket_id = 'media';
    if not blocked and o <> '33333333-3333-3333-3333-333333333333' then
      raise exception 'FAIL: a member reassigned an object owner to another user';
    end if;
    raise notice 'PASS  member cannot reassign object ownership to someone else';
  end $$;
rollback;

-- =============================================================================
-- secret guard
-- =============================================================================
do $$
declare
  payloads text[] := array[
    -- Deliberately invented addresses. These are fixtures for the pattern
    -- matcher, and a test fixture that happens to be a REAL address on the
    -- author's network defeats the entire point of the guard being tested —
    -- it publishes the thing it exists to keep out, in a public repo, forever.
    'Server is at 100.99.99.99 on the tailnet',
    'Reach it on 192.168.222.222',
    'Internal host 10.99.99.99',
    'token: ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'AKIAIOSFODNN7EXAMPLE'
  ];
  p text; blocked boolean;
begin
  foreach p in array payloads loop
    blocked := false;
    begin
      insert into public.knowledge_docs (slug, title, body_md)
        values ('leak-' || md5(p), 'Leak test', p);
    exception when others then blocked := true;
    end;
    if not blocked then
      raise exception 'FAIL: secret guard accepted %', left(p, 40);
    end if;
  end loop;
  raise notice 'PASS  secret guard rejected all % secret patterns', array_length(payloads, 1);

  -- And must not block ordinary prose. A guard that cries wolf gets removed.
  insert into public.knowledge_docs (slug, title, body_md)
    values ('ok-doc', 'Normal doc', 'We met 10 times. Version 1.2.3.4 shipped. Score was 192.168 points.');
  raise notice 'PASS  secret guard allows ordinary text containing dotted numbers';
end $$;

-- =============================================================================
-- knowledge-base version history is append-only
-- =============================================================================
do $$
declare v int;
begin
  update public.knowledge_docs set body_md = 'Revised.' where slug = 'build-process';
  select count(*) into v from public.knowledge_doc_versions;
  if v <> 1 then raise exception 'FAIL: edit did not snapshot the previous body (% versions)', v; end if;
  raise notice 'PASS  editing a doc snapshots its previous body';
end $$;

begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated"}';
  do $$
  declare blocked boolean := false;
  begin
    begin
      delete from public.knowledge_doc_versions;
    exception when others then blocked := true;
    end;
    if not blocked and (select count(*) from public.knowledge_doc_versions) = 0 then
      raise exception 'FAIL: history was rewritten through the API';
    end if;
    raise notice 'PASS  version history cannot be deleted, even by an admin';
  end $$;
rollback;

-- =============================================================================
-- audit trail
-- =============================================================================
do $$
declare n int;
begin
  select count(*) into n from public.audit_log where action = 'role.change';
  if n < 4 then raise exception 'FAIL: role changes were not audited (% rows)', n; end if;
  raise notice 'PASS  every role change was written to the audit log (% rows)', n;
end $$;

-- =============================================================================
-- backup_health view respects RLS through security_invoker
-- =============================================================================
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
  do $$
  declare n int;
  begin
    select count(*) into n from public.backup_health;
    if n <> 0 then
      raise exception 'FAIL: viewer read backup_health — the view bypasses RLS (% rows)', n;
    end if;
    raise notice 'PASS  backup_health enforces RLS (security_invoker works)';
  end $$;
rollback;

\echo ''
\echo '  ALL RLS TESTS PASSED'
