-- =============================================================================
-- Run AFTER db.sql.gz has been loaded. Puts back what the dump cannot carry.
--
-- The nightly dump is `pg_dump --schema=public --no-acl`, and two things the
-- portal depends on fall outside it. Both were confirmed by restoring a dump of
-- the migrated test database into a scratch database and inspecting the result:
--
--   1. The signup trigger. on_auth_user_created lives on auth.users, not in
--      public, so a public-only dump never contains it. Without it a restored
--      project still lets people sign up, but no profiles row is written for
--      them: they cannot see the "awaiting approval" screen, and an admin cannot
--      approve them — set_member_role() answers "no such member".
--
--   2. The privilege layer. --no-acl drops every GRANT and REVOKE, including the
--      one that keeps profiles.role out of reach of `authenticated`. On a real
--      Supabase project the default privileges then hand `authenticated` UPDATE
--      on every column, role included. guard_role_change() still refuses a
--      non-admin role change, so this is not an open door — but it is one of the
--      two independent locks 0001 deliberately put on that column, gone.
--
-- Mirrors the statements in 0001 and 0007; keep them in step if those change.
-- Idempotent, so running it twice is harmless.
--
-- Not covered here, because it is not in the dump either: storage buckets and
-- the storage.objects policies. Re-run supabase/migrations/0002_storage.sql when
-- restoring into a new project (see docs/BACKUP.md).
-- =============================================================================

\set ON_ERROR_STOP on
-- "trigger does not exist, skipping" is the expected first-run case; it is not
-- news to whoever is reading the restore log.
set client_min_messages = warning;

-- 1. signup -> pending profile
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 2. privilege layer
revoke update on public.profiles from authenticated;
grant update (full_name, grad_year, subteam) on public.profiles to authenticated;

revoke all on function public.set_member_role(uuid, public.member_role) from public;
grant execute on function public.set_member_role(uuid, public.member_role) to authenticated;

revoke all on function public.passes_remaining(int, public.scout_kind, text) from public;
grant execute on function public.passes_remaining(int, public.scout_kind, text) to authenticated;
