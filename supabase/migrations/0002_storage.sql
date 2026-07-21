-- =============================================================================
-- 0002 — Storage buckets and their access policies.
--
-- Five buckets. Four are private and one is deliberately public; that asymmetry
-- is the whole point, so it is stated explicitly rather than left to a default.
-- Per-bucket size and MIME limits are set here because Supabase enforces them
-- server-side — a limit only in the upload UI is not a limit.
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  -- Graphify knowledge-graph output: JSON payloads plus their rendered HTML.
  ('graphs', 'graphs', false, 104857600, -- 100 MB
   array['application/json', 'text/html', 'image/svg+xml', 'application/gzip',
         'application/x-tar', 'application/zip']),

  -- Season code snapshots, CAD exports, build artifacts. The largest bucket;
  -- CAD is what drives the ceiling here.
  ('code', 'code', false, 524288000, -- 500 MB
   array['application/zip', 'application/gzip', 'application/x-tar',
         'application/octet-stream', 'text/plain', 'application/json']),

  -- Attachments belonging to knowledge-base docs. The doc bodies themselves
  -- live in Postgres (0003) so they are searchable; only binaries land here.
  ('knowledge', 'knowledge', false, 52428800, -- 50 MB
   array['application/pdf', 'image/png', 'image/jpeg', 'image/webp',
         'text/markdown', 'text/plain']),

  -- Internal team media: outreach records, meeting notes, award submissions,
  -- unreleased photos. Contains material about minors — private, no exceptions.
  ('media', 'media', false, 524288000, -- 500 MB
   array['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'video/mp4',
         'video/quicktime', 'application/pdf', 'text/markdown']),

  -- The ONLY public bucket. Anything written here is world-readable forever;
  -- assume it will be indexed. Write access is restricted to lead+ for exactly
  -- that reason. Use it for sponsor logos and cleared photography.
  ('public-media', 'public-media', true, 26214400, -- 25 MB
   array['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/svg+xml'])
on conflict (id) do update
  set file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types,
      public             = excluded.public;

-- -----------------------------------------------------------------------------
-- Policies on storage.objects.
--
-- Read floors differ by bucket sensitivity:
--   media            -> viewer  (alumni and parents may look at team photos)
--   graphs/code/kb   -> member  (internal engineering work)
-- Write is member+ everywhere private. Delete is deliberately split: you may
-- always remove your own upload, but removing someone else's needs lead+.
-- That keeps mistakes self-serviceable without making history destructible.
-- -----------------------------------------------------------------------------

-- ---------- read ----------
create policy "storage: members read internal buckets"
  on storage.objects for select
  to authenticated
  using (
    bucket_id in ('graphs', 'code', 'knowledge')
    and public.is_at_least('member')
  );

create policy "storage: viewers read team media"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'media'
    and public.is_at_least('viewer')
  );

-- Downloading from a public bucket needs no policy — the bucket's `public` flag
-- covers that. LISTING it through the Storage API still goes through RLS on
-- storage.objects, so without this a signed-in user could fetch a known URL but
-- could not enumerate what is there. Read-only, and the bucket is public by
-- definition, so this grants nothing that a URL would not.
create policy "storage: signed-in users may list the public bucket"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'public-media');

-- ---------- write ----------
-- `owner` is stamped by Supabase from the JWT. Pinning it to auth.uid() here
-- stops a client from attributing an upload to somebody else.
create policy "storage: members upload to internal buckets"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id in ('graphs', 'code', 'knowledge', 'media')
    and public.is_at_least('member')
    and owner = auth.uid()
  );

create policy "storage: leads publish to the public bucket"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'public-media' and public.is_at_least('lead'))
  with check (bucket_id = 'public-media' and public.is_at_least('lead'));

create policy "storage: leads upload to the public bucket"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'public-media'
    and public.is_at_least('lead')
    and owner = auth.uid()
  );

-- ---------- update (replace an existing object) ----------
create policy "storage: owners replace their own uploads"
  on storage.objects for update
  to authenticated
  using (
    bucket_id in ('graphs', 'code', 'knowledge', 'media')
    and owner = auth.uid()
    and public.is_at_least('member')
  )
  with check (
    bucket_id in ('graphs', 'code', 'knowledge', 'media')
    and owner = auth.uid()
  );

-- The WITH CHECK must repeat the privilege test, not just the bucket test.
-- Permissive policies OR their WITH CHECK clauses together: a member passes
-- USING via the owners policy above, and would then pass a bucket-only WITH
-- CHECK here — without being a lead, and without owner still being themselves.
-- That is enough to rewrite `owner` to another student's uid and plant an
-- object attributed to them, in buckets holding material about minors.
create policy "storage: leads replace anything internal"
  on storage.objects for update
  to authenticated
  using (
    bucket_id in ('graphs', 'code', 'knowledge', 'media')
    and public.is_at_least('lead')
  )
  with check (
    bucket_id in ('graphs', 'code', 'knowledge', 'media')
    and public.is_at_least('lead')
  );

-- ---------- delete ----------
create policy "storage: owners delete their own uploads"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id in ('graphs', 'code', 'knowledge', 'media')
    and owner = auth.uid()
    and public.is_at_least('member')
  );

create policy "storage: leads delete anything"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id in ('graphs', 'code', 'knowledge', 'media', 'public-media')
    and public.is_at_least('lead')
  );

-- Public read of 'public-media' is granted by the bucket's own `public` flag,
-- so no SELECT policy for `anon` is written here. There is intentionally no
-- policy of any kind granting `anon` access to the four private buckets.
