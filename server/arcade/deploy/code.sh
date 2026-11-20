#!/usr/bin/env bash
# This week's and next week's arcade code, for a mentor to share.
#   sudo bash /opt/arcade/code.sh
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run with sudo (the secret is readable by root only)"; exit 1; }
set -a
# shellcheck disable=SC1091
. /etc/arcade.env
set +a
exec node /opt/arcade/code.mjs
