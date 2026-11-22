#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$RUNNER_TEMP/woek-news-unit-home"
sudo -n /usr/bin/unshare --net -- /bin/sh -c '
  set -eu
  /usr/sbin/ip link set lo up
  exec /usr/sbin/runuser -u "$1" -- /usr/bin/env -i \
    "PATH=$2" "HOME=$3" "TMPDIR=$4" "RUNNER_TEMP=$4" \
    "GITHUB_ACTIONS=true" "GITHUB_REPOSITORY=$5" "GITHUB_RUN_ID=$6" "GITHUB_RUN_ATTEMPT=$7" \
    "WIRKUNGSTICKER_PROCESSING_MODE=api" "VISUAL_GENERATION_PROVIDER=higgsfield" \
    "WOEK_NEWS_ONLY=" "WOEK_HIGGSFIELD_BIN=/usr/bin/false" \
    npm run news:test
' _ "$(id -un)" "$PATH" "$RUNNER_TEMP/woek-news-unit-home" "$RUNNER_TEMP" "$GITHUB_REPOSITORY" "$GITHUB_RUN_ID" "$GITHUB_RUN_ATTEMPT"
