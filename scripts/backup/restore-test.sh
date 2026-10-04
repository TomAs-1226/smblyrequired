#!/usr/bin/env bash
# =============================================================================
# Restore test.
#
# The portal shows every backup as "Unverified" until this has run against it,
# because a backup nobody has restored is a hypothesis. This turns the
# hypothesis into a fact: restore the newest snapshot into the local Firebase
# emulators, read everything back out, compare it with the snapshot document by
# document, verify object bytes against the checksums recorded IN THAT RESTORED
# DATABASE, and only then stamp `restore_tested_at`.
#
# Every check fails loudly on an empty or absent result. A test that passes on
# a backup containing nothing is worse than no test, because it converts
# "unknown" into a green badge.
#
# The target is the emulators, started for this run and gone when it ends. The
# live project is touched once, at the very end, to write one timestamp.
#
#   ./restore-test.sh              # newest local snapshot
#   ./restore-test.sh 2026-07-20T03-00-00Z
# =============================================================================
set -Eeuo pipefail

CONFIG="${BACKUP_ENV:-/etc/frc5805-backup.env}"
# shellcheck disable=SC1090
if [[ -f "$CONFIG" ]]; then set -a; source "$CONFIG"; set +a; fi

BACKUP_ROOT="${BACKUP_ROOT:-/srv/backup/frc5805}"
HERE="$(dirname "$(readlink -f "$0")")"

# How many objects are uploaded into the emulator and read back. The checksum
# cross-check always covers every object; this only bounds how much is copied
# into a scratch emulator to prove the upload path. `all` copies everything.
RESTORE_TEST_OBJECTS="${RESTORE_TEST_OBJECTS:-25}"
# A project id starting with `demo-` cannot reach a real project, by Firebase's
# own rule. restore.mjs refuses an emulator target named anything else.
RESTORE_TEST_PROJECT="${RESTORE_TEST_PROJECT:-demo-frc5805-restore}"
# Which emulators, on which ports: the file at the repo root.
RESTORE_TEST_CONFIG="${RESTORE_TEST_CONFIG:-$HERE/../../firebase.backup-test.json}"
FIREBASE_BIN="${FIREBASE_BIN:-firebase}"

log()  { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
fail() { printf '\n  FAILED: %s\n' "$*" >&2; exit 1; }

[[ -f "$BACKUP_ROOT/LATEST" || -n "${1:-}" ]] || fail "no LATEST in $BACKUP_ROOT — has the backup ever run?"
STAMP="${1:-$(cat "$BACKUP_ROOT/LATEST")}"
SNAPSHOT="$BACKUP_ROOT/$STAMP"

[[ -d "$SNAPSHOT" ]] || fail "no snapshot at $SNAPSHOT"
[[ -s "$SNAPSHOT/SHA256SUMS" ]] || fail "SHA256SUMS is missing or empty"
[[ -s "$SNAPSHOT/MANIFEST.sha256" ]] || fail "MANIFEST.sha256 is missing or empty"
[[ "$RESTORE_TEST_PROJECT" == demo-* ]] || fail "RESTORE_TEST_PROJECT must start with demo- (got '$RESTORE_TEST_PROJECT')"
[[ "$RESTORE_TEST_OBJECTS" =~ ^(all|none|[0-9]+)$ ]] || fail "RESTORE_TEST_OBJECTS must be all, none or a number"
[[ -f "$RESTORE_TEST_CONFIG" ]] || fail "no emulator config at $RESTORE_TEST_CONFIG"
command -v "$FIREBASE_BIN" >/dev/null || fail "firebase-tools is not installed (npm install -g firebase-tools), or set FIREBASE_BIN"
command -v java >/dev/null || fail "the emulators need a Java runtime, and there is no java on PATH"

log "testing $STAMP"

# --- 1 to 5: restore.mjs, inside the emulators ---------------------------------
# restore.mjs prints its own five steps: verify the manifest, empty the target,
# restore accounts / documents / objects, read everything back and compare, and
# check object bytes against the restored file index.
#
# The live key is taken OUT of this process's environment, and the project id
# is replaced with the demo one. Nothing inside the emulators has any way to
# reach the real project, even by mistake.
#
# %q, because emulators:exec hands this string to a shell.
printf -v inner 'node %q %q --target=emulator --wipe --objects=%q' \
  "$HERE/restore.mjs" "$SNAPSHOT" "$RESTORE_TEST_OBJECTS"

# The emulators write their debug logs into the working directory. The checkout
# is not this user's to write to, so they get a scratch directory instead.
RESTORE_TEST_CONFIG="$(readlink -f "$RESTORE_TEST_CONFIG")"
WORK="$(mktemp -d)"
trap '[[ -n "$WORK" && -d "$WORK" ]] && rm -rf "$WORK"' EXIT
cd "$WORK"

status=0
env -u GOOGLE_APPLICATION_CREDENTIALS \
    FIREBASE_PROJECT_ID="$RESTORE_TEST_PROJECT" \
    FIREBASE_STORAGE_BUCKET="$RESTORE_TEST_PROJECT.appspot.com" \
  "$FIREBASE_BIN" --config "$RESTORE_TEST_CONFIG" emulators:exec \
    --only auth,firestore,storage --project "$RESTORE_TEST_PROJECT" "$inner" || status=$?

if [[ $status -ne 0 ]]; then
  fail "$STAMP did not restore cleanly (exit $status) — the lines above say what differed"
fi

# --- stamp ---------------------------------------------------------------------
log "recording the result"
MANIFEST_SHA="$(tr -d '\n' < "$SNAPSHOT/MANIFEST.sha256")"

if [[ -n "${FIREBASE_PROJECT_ID:-}" && -n "${GOOGLE_APPLICATION_CREDENTIALS:-}" ]]; then
  # report.mjs stamps only the firebase->server run that produced this manifest
  # — not the server->optiplex rows, which are copies this script never touched —
  # and exits 3 when no run matched. A write that changed nothing used to be
  # logged as "marked verified"; it must not be.
  stamped=0
  node "$HERE/report.mjs" restore-tested "--manifest=$MANIFEST_SHA" || stamped=$?
  case $stamped in
    0) log "    marked verified in the portal" ;;
    3) # Not fatal — the restore genuinely passed. But the operator must not walk
       # away believing the badge flipped when it did not.
       log "    WARNING: the restore PASSED, but no backup_runs row has this manifest;"
       log "             the portal will keep showing this backup as Unverified." ;;
    *) log "    WARNING: the restore PASSED but the portal could not be updated;"
       log "             it will keep showing this backup as Unverified." ;;
  esac
else
  log "    FIREBASE_PROJECT_ID / key unset — portal not updated, backup still shows Unverified"
fi

printf '\n  PASSED — %s is restorable\n' "$STAMP"
