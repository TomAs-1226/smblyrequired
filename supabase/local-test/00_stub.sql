-- =============================================================================
-- Local-only stub of the Supabase-managed schemas.
--
-- The migrations in supabase/migrations/ are written against a real Supabase
-- project, which supplies `auth`, `storage`, and the anon/authenticated/
-- service_role roles. A bare Postgres has none of that, so the migrations
-- cannot be applied — and therefore cannot be tested — without this.
--
-- The point is to catch syntax errors, ordering problems, and above all
-- REGRESSIONS IN THE RLS POLICIES before any of it touches the real project.
--
-- NOT for production. Never run this against a Supabase database: it would
-- attempt to redefine objects the platform owns.
-- =============================================================================

-- Supabase's three API roles. NOLOGIN — they are assumed via SET ROLE, exactly
-- as PostgREST does when it authenticates a request.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

create schema if not exists auth;
create schema if not exists storage;

grant usage on schema public  to anon, authenticated, service_role;
grant usage on schema auth    to anon, authenticated, service_role;
grant usage on schema storage to anon, authenticated, service_role;

-- Supabase grants ALL on public tables to anon/authenticated by default and
-- relies on RLS to restrict them. Reproducing that default matters: migration
-- 0001 REVOKEs UPDATE on profiles, and if the grant were never there in the
-- first place the revoke would be a no-op and the test would prove nothing.
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public
  grant execute on functions to anon, authenticated, service_role;

-- --- auth ---------------------------------------------------------------------

create table if not exists auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text unique,
  raw_user_meta_data jsonb default '{}'::jsonb,
  created_at         timestamptz not null default now()
);

-- Mirrors the real implementation: the uid comes from the request's JWT claims,
-- which PostgREST sets per transaction. Tests drive it with
--   set local request.jwt.claims = '{"sub":"<uuid>","role":"authenticated"}';
-- so they exercise the same code path production does.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.sub', true),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ),
    ''
  )::uuid;
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(
    current_setting('request.jwt.claim.role', true),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  );
$$;

grant execute on function auth.uid(), auth.role() to anon, authenticated, service_role;
grant select on auth.users to authenticated, service_role;

-- --- storage ------------------------------------------------------------------
-- Column shapes follow the real storage schema closely enough that the policies
-- in 0002 compile and behave the same way.

create table if not exists storage.buckets (
  id                 text primary key,
  name               text not null,
  public             boolean default false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  created_at         timestamptz default now()
);

create table if not exists storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text references storage.buckets (id),
  name       text,
  owner      uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  metadata   jsonb
);

-- Supabase ships storage.objects with RLS already enabled. Without this the
-- policies in 0002 would exist but never be enforced, and every storage test
-- would pass for the wrong reason.
alter table storage.objects enable row level security;
alter table storage.buckets enable row level security;

grant all on storage.objects, storage.buckets to authenticated, service_role;
grant select on storage.objects, storage.buckets to anon;
