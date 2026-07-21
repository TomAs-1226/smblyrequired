#!/usr/bin/env bash
# =============================================================================
# Nightly backup, both legs.
#
#   leg 1  Supabase        -> the backup server   (mirror.mjs)
#   leg 2  the backup server    -> OptiPlex       (rsync over the tailnet)
#
# The two legs are reported to `backup_runs` separately and on purpose. A single
# combined status hides the case that actually bites: leg 1 succeeding for
# months while leg 2 has been quietly failing, leaving exactly one copy.
#
# Install: see docs/BACKUP.md. Runs as a systemd timer, not cron, so failures
# surface in `systemctl status` instead of in nobody's inbox.
# =============================================================================
set -Eeuo pipefail

CONFIG="${BACKUP_ENV:-/etc/frc5805-backup.env}"
if [[ -f "$CONFIG" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$CONFIG"; set +a
else
  echo "config not found: $CONFIG" >&2
  exit 1
fi

BACKUP_ROOT="${BACKUP_ROOT:-/srv/backup/frc5805}"
OPTIPLEX_HOST="${OPTIPLEX_HOST:-}"
OPTIPLEX_PATH="${OPTIPLEX_PATH:-/srv/backup/frc5805}"
RETAIN_DAYS="${RETAIN_DAYS:-30}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() { printf '[%s] FATAL: %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Validate anything that later reaches `rm -rf`. BACKUP_ROOT arrives from a
# sourced env file, so a typo or an empty value would otherwise be expanded
# straight into the retention sweep at the bottom of this script.
# ---------------------------------------------------------------------------
case "$BACKUP_ROOT" in
  /|/root|/home|/etc|/var|/usr|/srv|/tmp|"") die "BACKUP_ROOT=$BACKUP_ROOT is not a safe target" ;;
esac
[[ "$BACKUP_ROOT" = /* ]]    || die "BACKUP_ROOT must be an absolute path (got '$BACKUP_ROOT')"
[[ "$BACKUP_ROOT" != *..* ]] || die "BACKUP_ROOT must not contain '..'"
[[ -d "$BACKUP_ROOT" ]]      || die "BACKUP_ROOT does not exist: $BACKUP_ROOT"
[[ "$RETAIN_DAYS" =~ ^[0-9]+$ ]] || die "RETAIN_DAYS must be a whole number (got '$RETAIN_DAYS')"
(( RETAIN_DAYS >= 1 )) || die "RETAIN_DAYS must be at least 1 — 0 would prune tonight's own snapshot"

# ---------------------------------------------------------------------------
# Leg 1
# ---------------------------------------------------------------------------
log "leg 1: Supabase -> $(hostname)"
leg1_status=0
node "$SCRIPT_DIR/mirror.mjs" || leg1_status=$?

# exit 2 is "partial" — some objects failed but a usable snapshot exists, so the
# second leg should still copy what we got rather than skipping it entirely.
if [[ $leg1_status -ne 0 && $leg1_status -ne 2 ]]; then
  log "leg 1 FAILED (exit $leg1_status) — not running leg 2"
  exit $leg1_status
fi

STAMP="$(cat "$BACKUP_ROOT/LATEST")"
SNAPSHOT="$BACKUP_ROOT/$STAMP"

# ---------------------------------------------------------------------------
# Verify leg 1 before propagating it. Copying a corrupt snapshot onward just
# produces two corrupt copies.
# ---------------------------------------------------------------------------
log "verifying manifest"
if ! (cd "$SNAPSHOT" && sha256sum -c --quiet SHA256SUMS); then
  log "manifest verification FAILED — refusing to propagate"
  exit 1
fi
log "manifest ok"

# ---------------------------------------------------------------------------
# Leg 2
# ---------------------------------------------------------------------------
if [[ -z "$OPTIPLEX_HOST" ]]; then
  log "OPTIPLEX_HOST unset — skipping leg 2 (single copy only!)"
  exit $leg1_status
fi

log "leg 2: -> $OPTIPLEX_HOST"
leg2_start="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
leg2_status=ok
leg2_error=null

# --link-dest hard-links unchanged files against the previous snapshot, so thirty
# dated copies cost roughly one copy plus the deltas.
#
# The path MUST be the one that exists on the RECEIVER. rsync resolves
# --link-dest on the far side, so passing the local $BACKUP_ROOT path here would
# silently match nothing whenever OPTIPLEX_PATH differs — no error, no warning,
# just a full copy every night and a disk that fills up a month early.
PREV_STAMP="$(ls -1 "$BACKUP_ROOT" 2>/dev/null | grep -v '^LATEST$' | sort | tail -2 | head -1 || true)"
link_dest=()
if [[ -n "$PREV_STAMP" && "$PREV_STAMP" != "$STAMP" ]]; then
  link_dest=(--link-dest="$OPTIPLEX_PATH/$PREV_STAMP")
fi

if ! rsync -a --delete --partial "${link_dest[@]}" \
      "$SNAPSHOT/" "$OPTIPLEX_HOST:$OPTIPLEX_PATH/$STAMP/"; then
  leg2_status=failed
  leg2_error='"rsync failed"'
  log "leg 2 FAILED"
fi

# Re-verify on the far side. rsync exiting 0 says it transferred what it read;
# it does not say the bytes that landed are correct.
if [[ "$leg2_status" == "ok" ]]; then
  if ssh "$OPTIPLEX_HOST" "cd '$OPTIPLEX_PATH/$STAMP' && sha256sum -c --quiet SHA256SUMS"; then
    log "leg 2 verified"
  else
    leg2_status=failed
    leg2_error='"manifest verification failed on target"'
    log "leg 2 verification FAILED"
  fi
fi

# ---------------------------------------------------------------------------
# Report leg 2
# ---------------------------------------------------------------------------
# `grep -c` exits 1 on a zero count having ALREADY printed "0", so the obvious
# `|| echo 0` appends a second one and yields "0\n0" — which then interpolates
# into the JSON below as malformed garbage, in exactly the zero-object case
# where the record matters most. Count with wc instead.
OBJECTS="$(wc -l < "$SNAPSHOT/SHA256SUMS" | tr -d ' ')"
BYTES="$(du -sb "$SNAPSHOT" | cut -f1)"
MANIFEST_SHA="$(tr -d '\n' < "$SNAPSHOT/MANIFEST.sha256")"

# Headers via a mode-600 temp file: as command-line arguments they are visible
# in `ps` to every local user on the box.
HDR="$(mktemp)"; chmod 600 "$HDR"; trap 'rm -f "$HDR"' EXIT
printf 'apikey: %s\nAuthorization: Bearer %s\n' \
  "$SUPABASE_SERVICE_ROLE_KEY" "$SUPABASE_SERVICE_ROLE_KEY" > "$HDR"

curl -fsS -X POST "$SUPABASE_URL/rest/v1/backup_runs" \
  -H @"$HDR" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=minimal" \
  -d "{\"leg\":\"server->optiplex\",\"status\":\"$leg2_status\",
       \"started_at\":\"$leg2_start\",\"finished_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",
       \"object_count\":$OBJECTS,\"byte_total\":$BYTES,
       \"manifest_sha\":\"$MANIFEST_SHA\",\"error\":$leg2_error}" \
  >/dev/null || log "warning: could not record leg 2 status"

# ---------------------------------------------------------------------------
# Retention — local only. The OptiPlex keeps its own copies; pruning the remote
# from here would mean one bad variable expansion could wipe both sides at once.
# ---------------------------------------------------------------------------
#
# Skipped entirely when the offsite copy failed: on those nights the local
# snapshots are the ONLY copies, and pruning them is the one action guaranteed
# to make a bad situation unrecoverable.
if [[ "$leg2_status" != "ok" ]]; then
  log "leg 2 did not succeed — skipping retention, local copies are all we have"
else
  log "pruning local snapshots older than ${RETAIN_DAYS}d"
  # -name restricts deletion to directories that look like our own timestamps,
  # so nothing else living under BACKUP_ROOT can be caught by the sweep. Errors
  # are logged rather than discarded — a retention rule that has silently been
  # failing for months is how disks fill up at 3am.
  if ! find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d \
        -name '20*-*-*T*Z' -mtime "+$RETAIN_DAYS" -exec rm -rf {} +; then
    log "warning: retention sweep reported errors"
  fi
fi

[[ "$leg2_status" == "ok" ]] || exit 1

# A partial leg 1 must survive a successful leg 2. Returning 0 here would make
# `systemctl status` report a clean run while objects were actually missing from
# the snapshot — the exact class of silent failure this script exists to expose.
if [[ $leg1_status -eq 2 ]]; then
  log "done — but leg 1 was PARTIAL; check backup_runs for which objects failed"
  exit 2
fi

log "done"
