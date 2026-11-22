#!/usr/bin/env sh
set -eu
root="$(git rev-parse --show-toplevel)"
exec python3 "$root/scripts/quality/check_public_push.py"
