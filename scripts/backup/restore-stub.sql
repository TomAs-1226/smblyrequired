-- =============================================================================
-- Stand-in for what a Supabase project supplies, for restoring a snapshot into
-- a PLAIN PostgreSQL: the restore test's scratch database, or a rehearsal.
-- Skip it when the target is a real Supabase project, where both already exist.
--
-- Load order, established by restoring for real:
--   restore-stub.sql -> auth_users.sql.gz -> db.sql.gz -> post-restore.sql
--
-- A file rather than a block pasted into docs/BACKUP.md, because the copy that
-- lived there had drifted to a four-column auth.users that the data-only dump's
-- COPY (which names every column) cannot load into.
-- =============================================================================

\set ON_ERROR_STOP on

-- The roles are cluster-global, so they usually already exist on a box that has
-- ever run this — but on a fresh cluster every `CREATE POLICY ... TO
-- authenticated` in the dump fails without them.
do $stub$
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
$stub$;

create schema if not exists auth;
-- The FULL Supabase auth.users column set. A minimal stub fails because the
-- --data-only dump emits `COPY auth.users (instance_id, aud, role, …)` naming
-- every column, and a COPY into a table missing any of them errors out. This
-- list was taken from an actual Supabase dump; it is stable across projects.
create table if not exists auth.users (
  instance_id uuid, id uuid primary key, aud varchar(255), role varchar(255),
  email varchar(255), encrypted_password varchar(255), email_confirmed_at timestamptz,
  invited_at timestamptz, confirmation_token varchar(255), confirmation_sent_at timestamptz,
  recovery_token varchar(255), recovery_sent_at timestamptz, email_change_token_new varchar(255),
  email_change varchar(255), email_change_sent_at timestamptz, last_sign_in_at timestamptz,
  raw_app_meta_data jsonb, raw_user_meta_data jsonb, is_super_admin boolean,
  created_at timestamptz, updated_at timestamptz, phone text, phone_confirmed_at timestamptz,
  phone_change text, phone_change_token varchar(255), phone_change_sent_at timestamptz,
  email_change_token_current varchar(255), email_change_confirm_status smallint,
  banned_until timestamptz, reauthentication_token varchar(255), reauthentication_sent_at timestamptz,
  is_sso_user boolean, deleted_at timestamptz, is_anonymous boolean
);
create or replace function auth.uid() returns uuid language sql stable
  as $fn$ select null::uuid $fn$;
grant usage on schema auth to anon, authenticated, service_role;
