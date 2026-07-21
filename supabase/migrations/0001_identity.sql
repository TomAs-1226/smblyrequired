-- =============================================================================
-- 0001 — Identity, roles, and the authorization primitives everything else uses.
--
-- Design rule for this whole schema: DEFAULT DENY. RLS is enabled on every
-- table, no policy grants anything to `anon`, and a brand-new signup lands in
-- the 'pending' role which can read nothing. Membership is granted by a human,
-- never by the act of signing up. The site is public — signup must not be.
-- =============================================================================

-- Roles are an enum, not text, so a typo is a hard error rather than a silent
-- permission hole. Declaration order IS the privilege order: Postgres compares
-- enums by ordinal, which is what makes `role >= 'member'` work below.
create type public.member_role as enum (
  'pending', -- signed up, approved by nobody, can see nothing
  'viewer',  -- alumni / parents: read-only on non-sensitive material
  'member',  -- current student on the team
  'lead',    -- subteam lead: can publish and delete
  'mentor',  -- adult mentor: same as lead
  'admin'    -- can grant roles; keep this set very small
);

create table public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  full_name  text,
  grad_year  int check (grad_year between 2000 and 2100),
  subteam    text,
  role       public.member_role not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is
  'One row per auth user. `role` is the single source of authorization truth; '
  'it is deliberately NOT user-writable — see the column grants below.';

-- -----------------------------------------------------------------------------
-- Authorization helpers.
--
-- SECURITY DEFINER so a caller can resolve their own role without needing read
-- access to profiles (which would otherwise be circular with the RLS policy).
-- `set search_path = ''` is mandatory on any SECURITY DEFINER function: without
-- it, a caller can prepend a schema they control and hijack the resolution of
-- an unqualified name. Every identifier below is therefore fully qualified.
-- -----------------------------------------------------------------------------
create or replace function public.auth_role()
returns public.member_role
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select p.role from public.profiles p where p.id = auth.uid()),
    'pending'::public.member_role
  );
$$;

create or replace function public.is_at_least(minimum public.member_role)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.auth_role() >= minimum;
$$;

comment on function public.is_at_least is
  'Privilege floor check. Relies on member_role ordinal ordering, so any new '
  'role MUST be added in the correct position via ALTER TYPE ... BEFORE/AFTER.';

-- -----------------------------------------------------------------------------
-- New signups get a profile automatically, but always at 'pending'.
-- The default on the column is belt; this trigger is braces — it hard-forces
-- the role so a crafted signup payload cannot seed a privileged row.
-- -----------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name, role)
  values (
    new.id,
    nullif(trim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), ''),
    'pending'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- -----------------------------------------------------------------------------
-- Privilege-escalation guard.
--
-- This is the failure mode that matters most: "user can edit own profile" plus
-- "role lives on the profile" equals "user can make themselves admin". Two
-- independent mechanisms stop it, because one of them being edited away later
-- should not be enough to open the hole.
-- -----------------------------------------------------------------------------

-- (1) Column-level privileges. `authenticated` simply has no UPDATE grant on
--     `role`, so an escalation attempt fails before RLS is even consulted.
--
--     Note this applies to admins too — they are `authenticated` like everyone
--     else. Role changes therefore do NOT go through a direct UPDATE; they go
--     through set_member_role() below. That is the intended design: there is
--     exactly one code path that can write this column, and it checks first.
revoke update on public.profiles from authenticated;
grant update (full_name, grad_year, subteam) on public.profiles to authenticated;

-- (2) A trigger, in case a future migration re-grants the column by accident.
create or replace function public.guard_role_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.role is distinct from old.role then
    -- auth.uid() is null for the service_role key and for SQL run in the
    -- dashboard; those paths are already trusted and are allowed through.
    if auth.uid() is not null and not public.is_at_least('admin') then
      raise exception 'insufficient privilege: only an admin may change a role';
    end if;
  end if;

  -- Nobody demotes or deletes themselves out of the last admin seat.
  if old.role = 'admin' and new.role <> 'admin' then
    if (select count(*) from public.profiles p where p.role = 'admin') <= 1 then
      raise exception 'refusing to remove the last remaining admin';
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_guard_role
  before update on public.profiles
  for each row execute function public.guard_role_change();

-- The UPDATE guard alone is not enough: `authenticated` keeps Supabase's default
-- DELETE grant (only UPDATE is revoked above), and the admin policy is FOR ALL.
-- So deleting the last admin's row is a demotion the trigger never sees. The
-- result is unrecoverable through the app — set_member_role() needs an admin,
-- and no admin can ever exist again without the SQL editor or a service key.
create or replace function public.guard_admin_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.role = 'admin'
     and (select count(*) from public.profiles p where p.role = 'admin') <= 1 then
    raise exception 'refusing to delete the last remaining admin'
      using hint = 'Promote another admin first, then remove this one.';
  end if;
  return old;
end;
$$;

create trigger profiles_guard_admin_delete
  before delete on public.profiles
  for each row execute function public.guard_admin_delete();

-- -----------------------------------------------------------------------------
-- The one sanctioned way to change a role.
--
-- SECURITY DEFINER so it can write a column no client has a grant on, and it
-- verifies the *caller* is an admin before doing so. auth.uid() still resolves
-- to the calling user inside a definer function, so the guard trigger above
-- also re-checks and the two agree.
--
-- Granted to `authenticated` rather than to a narrower role because the check
-- is inside the function — a non-admin calling it simply gets an exception.
-- -----------------------------------------------------------------------------
create or replace function public.set_member_role(
  target_id uuid,
  new_role  public.member_role
)
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  updated public.profiles;
begin
  if not public.is_at_least('admin') then
    raise exception 'only an admin may change a role'
      using errcode = 'insufficient_privilege';
  end if;

  -- Self-demotion is blocked outright. Combined with the last-admin check in
  -- the guard trigger, this makes it hard to lock the team out of its own
  -- portal by accident.
  if target_id = auth.uid() then
    raise exception 'you cannot change your own role'
      using errcode = 'insufficient_privilege';
  end if;

  update public.profiles
     set role = new_role
   where id = target_id
  returning * into updated;

  if not found then
    raise exception 'no such member';
  end if;

  return updated;
end;
$$;

revoke all on function public.set_member_role(uuid, public.member_role) from public;
grant execute on function public.set_member_role(uuid, public.member_role) to authenticated;

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
alter table public.profiles enable row level security;

-- Everyone on the team can see who else is on the team. `pending` cannot —
-- an unapproved signup should not be able to enumerate the student roster.
create policy "profiles: team may read the roster"
  on public.profiles for select
  to authenticated
  using (public.is_at_least('viewer'));

-- You can always read your own row, so a pending user can at least see that
-- they are pending rather than staring at an empty page.
create policy "profiles: read own row"
  on public.profiles for select
  to authenticated
  using (id = auth.uid());

create policy "profiles: update own row"
  on public.profiles for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

create policy "profiles: admins manage all"
  on public.profiles for all
  to authenticated
  using (public.is_at_least('admin'))
  with check (public.is_at_least('admin'));

-- No policy is defined for `anon`. With RLS on and no matching policy, the
-- public internet reads exactly zero rows from this table.
