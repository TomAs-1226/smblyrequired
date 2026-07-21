-- =============================================================================
-- 0003 — Content: the file index, graphify graphs, code archives, and the
--        team knowledge base.
--
-- `files` is a metadata index sitting over storage.objects. Storage can hold
-- bytes and a path; it cannot hold a title, a season, tags, or a checksum you
-- can verify a backup against. Those live here, and the portal reads this table
-- rather than listing buckets — which is also what makes search possible.
-- =============================================================================

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- files
-- -----------------------------------------------------------------------------
create table public.files (
  id          uuid primary key default gen_random_uuid(),
  bucket      text not null check (
                bucket in ('graphs', 'code', 'knowledge', 'media', 'public-media')),
  path        text not null,
  title       text not null check (length(trim(title)) > 0),
  description text,
  kind        text check (kind in ('graph', 'code', 'cad', 'doc', 'photo', 'video', 'other')),
  season      int  check (season between 2000 and 2100),
  tags        text[] not null default '{}',
  byte_size   bigint check (byte_size >= 0),
  -- Recorded at upload so the nightly mirror can prove the copy it pulled is
  -- byte-identical, instead of just proving a file of that name exists.
  sha256      text check (sha256 ~ '^[a-f0-9]{64}$'),
  uploaded_by uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (bucket, path)
);

create index files_kind_season_idx on public.files (kind, season desc);
create index files_tags_idx        on public.files using gin (tags);
create index files_created_idx     on public.files (created_at desc);

create trigger files_touch before update on public.files
  for each row execute function public.touch_updated_at();

-- -----------------------------------------------------------------------------
-- graphs — graphify output metadata
-- -----------------------------------------------------------------------------
create table public.graphs (
  id              uuid primary key default gen_random_uuid(),
  slug            text unique not null check (slug ~ '^[a-z0-9][a-z0-9-]*$'),
  title           text not null,
  summary         text,
  -- What was graphified: a repo name, a paper title, a directory.
  source          text,
  node_count      int check (node_count >= 0),
  edge_count      int check (edge_count >= 0),
  community_count int check (community_count >= 0),
  -- The god nodes graphify surfaces — kept inline so the portal can show the
  -- shape of a graph without downloading and parsing the whole payload.
  god_nodes       text[] not null default '{}',
  generated_at    timestamptz,
  file_id         uuid references public.files (id) on delete set null,
  created_by      uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create trigger graphs_touch before update on public.graphs
  for each row execute function public.touch_updated_at();

-- -----------------------------------------------------------------------------
-- code_archives — season snapshots, pinned to the commit they came from
-- -----------------------------------------------------------------------------
create table public.code_archives (
  id         uuid primary key default gen_random_uuid(),
  repo       text not null,
  ref        text,
  commit_sha text check (commit_sha ~ '^[a-f0-9]{7,40}$'),
  season     int check (season between 2000 and 2100),
  notes      text,
  file_id    uuid references public.files (id) on delete set null,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index code_archives_season_idx on public.code_archives (season desc, repo);

create trigger code_archives_touch before update on public.code_archives
  for each row execute function public.touch_updated_at();

-- =============================================================================
-- Knowledge base
--
-- Bodies live in Postgres rather than a bucket so they are searchable and
-- diffable. This is where CLAUDE.md-style project knowledge goes: conventions,
-- build process, season history, why decisions were made.
-- =============================================================================

create table public.knowledge_docs (
  id         uuid primary key default gen_random_uuid(),
  slug       text unique not null check (slug ~ '^[a-z0-9][a-z0-9-]*$'),
  title      text not null check (length(trim(title)) > 0),
  body_md    text not null default '',
  category   text,
  is_pinned  boolean not null default false,
  search     tsvector generated always as (
               setweight(to_tsvector('english', coalesce(title, '')),   'A') ||
               setweight(to_tsvector('english', coalesce(category, '')), 'B') ||
               setweight(to_tsvector('english', coalesce(body_md, '')),  'C')
             ) stored,
  created_by uuid references public.profiles (id) on delete set null,
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index knowledge_search_idx on public.knowledge_docs using gin (search);

-- Every edit is retained. A rotating roster means the person who can explain a
-- decision has often graduated; losing edit history loses the explanation.
create table public.knowledge_doc_versions (
  id         uuid primary key default gen_random_uuid(),
  doc_id     uuid not null references public.knowledge_docs (id) on delete cascade,
  title      text not null,
  body_md    text not null,
  edited_by  uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

create index knowledge_versions_doc_idx
  on public.knowledge_doc_versions (doc_id, created_at desc);

-- -----------------------------------------------------------------------------
-- Secret guard.
--
-- This table is explicitly intended to hold operational notes, which is exactly
-- the kind of document that accumulates an IP address or a token by accident.
-- The check runs in the database, so it applies to the portal, the CLI, a
-- migration, and anything else that ever writes here — a rule enforced only in
-- the upload form is not enforced.
--
-- It is a backstop for the obvious accident, NOT a guarantee. It cannot catch
-- a secret it has no pattern for. Do not treat a passing write as proof that a
-- document is safe to publish.
-- -----------------------------------------------------------------------------
create or replace function public.reject_obvious_secrets()
returns trigger
language plpgsql
as $$
declare
  body text := coalesce(new.body_md, '');
  hit  text;
begin
  -- Private + CGNAT/Tailscale IPv4. The 100.64/10 block is included because
  -- tailnet addresses are the ones most likely to end up in a runbook.
  if body ~ '(^|[^0-9.])(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})'
  then
    hit := 'a private or tailnet IP address';
  elsif body ~ '-----BEGIN [A-Z ]*PRIVATE KEY-----' then
    hit := 'a private key block';
  elsif body ~ '\m(gh[pousr]_[A-Za-z0-9]{20,})' then
    hit := 'a GitHub token';
  elsif body ~ '\m(sk-[A-Za-z0-9_-]{20,}|sk_live_[A-Za-z0-9]{20,})' then
    hit := 'an API secret key';
  elsif body ~ '\m(AKIA[0-9A-Z]{16})\M' then
    hit := 'an AWS access key id';
  elsif body ~* '\m(service_role|supabase_service_role_key)\M\s*[:=]' then
    hit := 'a Supabase service-role key';
  end if;

  if hit is not null then
    raise exception using
      errcode = 'check_violation',
      message = format('refusing to store this document: it looks like it contains %s', hit),
      hint    = 'Remove the secret, or put it in a password manager and reference it by name. '
                'This guard catches common patterns only — it is not a substitute for reading '
                'what you are about to publish.';
  end if;

  return new;
end;
$$;

create trigger knowledge_docs_secret_guard
  before insert or update on public.knowledge_docs
  for each row execute function public.reject_obvious_secrets();

-- Snapshot the previous body on every edit.
create or replace function public.snapshot_knowledge_doc()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.body_md is distinct from new.body_md or old.title is distinct from new.title then
    insert into public.knowledge_doc_versions (doc_id, title, body_md, edited_by)
    values (old.id, old.title, old.body_md, auth.uid());
  end if;
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end;
$$;

create trigger knowledge_docs_snapshot
  before update on public.knowledge_docs
  for each row execute function public.snapshot_knowledge_doc();

-- =============================================================================
-- RLS — read is member+, write is member+, destruction is lead+.
-- =============================================================================
alter table public.files                 enable row level security;
alter table public.graphs                enable row level security;
alter table public.code_archives         enable row level security;
alter table public.knowledge_docs        enable row level security;
alter table public.knowledge_doc_versions enable row level security;

-- files: media metadata follows the media bucket's viewer-level read floor.
create policy "files: read" on public.files for select to authenticated
  using (
    case
      when bucket in ('media', 'public-media') then public.is_at_least('viewer')
      else public.is_at_least('member')
    end
  );
create policy "files: members insert" on public.files for insert to authenticated
  with check (public.is_at_least('member') and uploaded_by = auth.uid());
create policy "files: owners update" on public.files for update to authenticated
  using (uploaded_by = auth.uid() and public.is_at_least('member'))
  with check (uploaded_by = auth.uid());
-- Mirrors the storage policy, which lets a member delete their own object.
-- Without this the object goes and the index row stays: the portal lists a file
-- that 404s on open, and the nightly manifest carries a checksum for something
-- that no longer exists. Permissions on the bytes and on the metadata have to
-- agree, or the two drift apart on the first mistake anyone makes.
create policy "files: owners delete" on public.files for delete to authenticated
  using (uploaded_by = auth.uid() and public.is_at_least('member'));
create policy "files: leads manage" on public.files for all to authenticated
  using (public.is_at_least('lead')) with check (public.is_at_least('lead'));

-- graphs
create policy "graphs: read" on public.graphs for select to authenticated
  using (public.is_at_least('member'));
create policy "graphs: members write" on public.graphs for insert to authenticated
  with check (public.is_at_least('member') and created_by = auth.uid());
-- Insert-without-update means the person who uploaded a graph cannot fix their
-- own typo in its title. Scoped to their own rows.
create policy "graphs: owners update" on public.graphs for update to authenticated
  using (created_by = auth.uid() and public.is_at_least('member'))
  with check (created_by = auth.uid());
create policy "graphs: leads manage" on public.graphs for all to authenticated
  using (public.is_at_least('lead')) with check (public.is_at_least('lead'));

-- code_archives
create policy "code: read" on public.code_archives for select to authenticated
  using (public.is_at_least('member'));
create policy "code: members write" on public.code_archives for insert to authenticated
  with check (public.is_at_least('member') and created_by = auth.uid());
create policy "code: owners update" on public.code_archives for update to authenticated
  using (created_by = auth.uid() and public.is_at_least('member'))
  with check (created_by = auth.uid());
create policy "code: leads manage" on public.code_archives for all to authenticated
  using (public.is_at_least('lead')) with check (public.is_at_least('lead'));

-- knowledge_docs
create policy "kb: read" on public.knowledge_docs for select to authenticated
  using (public.is_at_least('member'));
create policy "kb: members write" on public.knowledge_docs for insert to authenticated
  with check (public.is_at_least('member'));
create policy "kb: members edit" on public.knowledge_docs for update to authenticated
  using (public.is_at_least('member')) with check (public.is_at_least('member'));
create policy "kb: leads delete" on public.knowledge_docs for delete to authenticated
  using (public.is_at_least('lead'));

-- Version history is append-only from the application's point of view: it is
-- written by a SECURITY DEFINER trigger, and no policy grants insert, update,
-- or delete to any client. History cannot be rewritten through the API.
create policy "kb versions: read" on public.knowledge_doc_versions for select to authenticated
  using (public.is_at_least('member'));
