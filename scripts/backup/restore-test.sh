#!/usr/bin/env bash
# =============================================================================
# Restore test.
#
# The portal shows every backup as "Unverified" until this has run against it,
# because a backup nobody has restored is a hypothesis. This turns the
# hypothesis into a fact: restore the newest dump into a scratch database,
# assert the restored tables actually contain the rows the source had, verify
# object bytes against the checksums recorded IN THAT RESTORED DATABASE, and
# only then stamp `restore_tested_at`.
#
# Every check fails loudly on an empty or absent result. A test that passes on
# a backup containing nothing is worse than no test, because it converts
# "unknown" into a green badge.
#
# Destroys and recreates $SCRATCH_DB. Point that at a throwaway database.
#
#   ./restore-test.sh              # newest local snapshot
#   ./restore-test.sh 2026-07-20T03-00-00Z
# =============================================================================
set -Eeuo pipefail

CONFIG="${BACKUP_ENV:-/etc/frc5805-backup.env}"
# shellcheck disable=SC1090
if [[ -f "$CONFIG" ]]; then set -a; source "$CONFIG"; set +a; fi

BACKUP_ROOT="${BACKUP_ROOT:-/srv/backup/frc5805}"
SCRATCH_DB="${SCRATCH_DB:-postgres://postgres@localhost/frc5805_restore_test}"
STAMP="${1:-$(cat "$BACKUP_ROOT/LATEST")}"
SNAPSHOT="$BACKUP_ROOT/$STAMP"

log()  { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
fail() { printf '\n  FAILED: %s\n' "$*" >&2; exit 1; }

[[ -d "$SNAPSHOT" ]] || fail "no snapshot at $SNAPSHOT"
log "testing $STAMP"

# --- 1. manifest -------------------------------------------------------------
log "1/5 verifying manifest"
[[ -s "$SNAPSHOT/SHA256SUMS" ]] || fail "SHA256SUMS is missing or empty"
(cd "$SNAPSHOT" && sha256sum -c --quiet SHA256SUMS) || fail "manifest mismatch"

# --- 2. restore --------------------------------------------------------------
log "2/5 restoring dump into scratch database"
[[ -s "$SNAPSHOT/db.sql.gz" ]] || fail "no db.sql.gz — this snapshot is objects only, NOT restorable"
[[ -s "$SNAPSHOT/auth_users.sql.gz" ]] \
  || fail "no auth_users.sql.gz — public.profiles has an FK onto auth.users, so this snapshot cannot restore"

SCRATCH_NAME="${SCRATCH_DB##*/}"
SCRATCH_NAME="${SCRATCH_NAME%%\?*}"   # tolerate a ?sslmode=… suffix on the DSN
BASE_URL="${SCRATCH_DB%/*}"

psql "$BASE_URL/postgres" -v ON_ERROR_STOP=1 -q \
  -c "DROP DATABASE IF EXISTS \"$SCRATCH_NAME\";" \
  -c "CREATE DATABASE \"$SCRATCH_NAME\";" || fail "could not recreate scratch database"

# The restore order below was established by running it against a real
# PostgreSQL 17, not by reasoning about it. Deviating from it fails:
#
#   1. stub the auth schema + the three Supabase API roles. The roles are
#      cluster-global, so they usually already exist on a box that has ever run
#      this — but on a fresh cluster every `CREATE POLICY ... TO authenticated`
#      in the dump fails without them.
#   2. load auth.users DATA first, so the profiles FK has something to point at.
#   3. load the public schema.
#   4. apply post-restore.sql, for the parts of the schema the dump omits.
HERE="$(dirname "$(readlink -f "$0")")"
psql "$SCRATCH_DB" -v ON_ERROR_STOP=1 -q -f "$HERE/restore-stub.sql" \
  || fail "could not stub the auth schema"

if ! gunzip -c "$SNAPSHOT/auth_users.sql.gz" | psql "$SCRATCH_DB" -v ON_ERROR_STOP=1 -q -f -; then
  fail "could not load auth.users — the identity map is unusable"
fi

if ! gunzip -c "$SNAPSHOT/db.sql.gz" | psql "$SCRATCH_DB" -v ON_ERROR_STOP=1 -q -f -; then
  fail "restore failed — THE DUMP IS NOT RESTORABLE"
fi

# What the public-only, --no-acl dump cannot carry: the signup trigger on
# auth.users and the grants that keep profiles.role unwritable. A restore that
# skips this looks complete and quietly stops onboarding anyone new, so the
# rehearsal runs it and checks it took — the real restore has to do the same.
POST_RESTORE="$HERE/post-restore.sql"
[[ -f "$POST_RESTORE" ]] || fail "post-restore.sql is missing next to this script"
psql "$SCRATCH_DB" -v ON_ERROR_STOP=1 -q -f "$POST_RESTORE" \
  || fail "post-restore.sql failed — a restored project would not onboard new members"
has_trigger="$(psql "$SCRATCH_DB" -tA -c \
  "select count(*) from pg_trigger where tgname = 'on_auth_user_created' and tgrelid = 'auth.users'::regclass;")"
[[ "$has_trigger" == "1" ]] || fail "the signup trigger is missing after post-restore.sql"

# --- 3. did the data actually arrive? ----------------------------------------
# A dump of an empty database restores perfectly. Structural success is not
# evidence of a usable backup, so every count is asserted, not just printed.
log "3/5 checking restored content"
read -r n_files n_docs n_profiles n_sums <<<"$(psql "$SCRATCH_DB" -tA -F' ' -c \
  "select
     (select count(*) from public.files),
     (select count(*) from public.knowledge_docs),
     (select count(*) from public.profiles),
     (select count(*) from public.files where sha256 is not null);")" \
  || fail "could not query the restored database — the schema did not survive"

log "    files=$n_files docs=$n_docs profiles=$n_profiles (with checksums: $n_sums)"
[[ "$n_profiles" -gt 0 ]] || fail "profiles is empty — restored, but with no roster in it"

# files and docs are warned rather than fatal: a brand-new team legitimately has
# none yet. Silence about them was the previous bug — they were read and then
# never looked at.
[[ "$n_files" -gt 0 ]] || log "    WARNING: the file index is empty"
[[ "$n_docs"  -gt 0 ]] || log "    WARNING: the knowledge base is empty"

# --- 4. object bytes vs. the RESTORED database -------------------------------
# This is the cross-check the manifest cannot provide. Step 1 only proves the
# snapshot agrees with itself; comparing against sha256 values read back out of
# the restored dump proves the bytes match what the uploader originally chose.
log "4/5 verifying object bytes against checksums in the restored database"
object_lines="$(grep -c '  objects/' "$SNAPSHOT/SHA256SUMS" || true)"

if [[ "$n_files" -eq 0 && "$object_lines" -eq 0 ]]; then
  log "    no objects and no file rows — nothing to cross-check (new/empty project)"
elif [[ "$object_lines" -eq 0 ]]; then
  fail "the database lists $n_files file(s) but the snapshot contains NO objects"
elif [[ "$n_sums" -eq 0 ]]; then
  log "    WARNING: no recorded checksums to compare against; falling back to manifest only"
else
  checked=0; mismatch=0; missing=0
  while IFS='|' read -r bucket objpath want; do
    [[ -n "$want" ]] || continue
    rel="objects/$bucket/$objpath"
    if [[ ! -f "$SNAPSHOT/$rel" ]]; then
      echo "  MISSING from snapshot: $rel"; missing=$((missing + 1)); continue
    fi
    actual="$(sha256sum "$SNAPSHOT/$rel" | cut -d' ' -f1)"
    if [[ "$actual" != "$want" ]]; then
      echo "  MISMATCH: $rel"; mismatch=$((mismatch + 1))
    fi
    checked=$((checked + 1))
  done < <(psql "$SCRATCH_DB" -tA -F'|' -c \
      "select bucket, path, sha256 from public.files
        where sha256 is not null order by random() limit 25;")

  log "    cross-checked $checked object(s)"
  [[ "$checked" -gt 0 ]] || fail "cross-check selected nothing despite $n_sums checksummed row(s)"
  [[ "$missing"  -eq 0 ]] || fail "$missing object(s) referenced by the database are absent from the backup"
  [[ "$mismatch" -eq 0 ]] || fail "$mismatch object(s) do not match their recorded checksum"
fi

# --- 5. stamp ----------------------------------------------------------------
log "5/5 recording the result"
MANIFEST_SHA="$(tr -d '\n' < "$SNAPSHOT/MANIFEST.sha256")"

if [[ -n "${SUPABASE_URL:-}" && -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ]]; then
  # Scoped to the leg actually tested. The previous version filtered on
  # manifest_sha alone, which also marked the server->optiplex rows verified —
  # copies this script never touched — and, because manifest_sha is stable while
  # nothing changes, every earlier night carrying the same manifest too.
  #
  # The key goes in a header file rather than on the command line, where `ps`
  # would expose it to every local user.
  hdr="$(mktemp)"; trap 'rm -f "$hdr"' EXIT
  printf 'apikey: %s\nAuthorization: Bearer %s\n' \
    "$SUPABASE_SERVICE_ROLE_KEY" "$SUPABASE_SERVICE_ROLE_KEY" > "$hdr"

  # return=representation, not minimal: a PATCH whose filter matches nothing is
  # still a 2xx, so success alone used to log "marked verified" for a stamp with
  # no supabase->server row (or a different manifest) and changed nothing. The
  # body is the list of rows actually updated; "[]" means none were.
  if patched="$(curl -fsS -X PATCH \
       "$SUPABASE_URL/rest/v1/backup_runs?manifest_sha=eq.$MANIFEST_SHA&leg=eq.supabase-%3Eserver" \
       -H @"$hdr" -H 'Content-Type: application/json' -H 'Prefer: return=representation' \
       -d "{\"restore_tested_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}")" \
     && [[ -n "$patched" && "$patched" != "[]" ]]
  then
    log "    marked verified in the portal"
  else
    # Not fatal — the restore genuinely passed. But the operator must not walk
    # away believing the badge flipped when it did not.
    log "    WARNING: the restore PASSED but the portal could not be updated;"
    log "             it will keep showing this backup as Unverified."
  fi
else
  log "    SUPABASE_URL / key unset — portal not updated, backup still shows Unverified"
fi

psql "$BASE_URL/postgres" -q -c "DROP DATABASE IF EXISTS \"$SCRATCH_NAME\";" || true

printf '\n  PASSED — %s is restorable (%s files, %s docs, %s profiles)\n' \
  "$STAMP" "$n_files" "$n_docs" "$n_profiles"
