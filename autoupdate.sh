#!/usr/bin/env bash
cd "$(dirname "$0")" || exit 1
BOT_NAME="${BOT_NAME:-smbot}"
INTERVAL="${INTERVAL:-300}"
BRANCH="${BRANCH:-main}"

while true; do
  if git fetch -q origin "$BRANCH" 2>/dev/null; then
    OLD=$(git rev-parse HEAD)
    NEW=$(git rev-parse "origin/$BRANCH")
    if [ "$OLD" != "$NEW" ]; then
      echo "[autoupdate] update ditemukan, memperbarui..."
      git reset -q --hard "origin/$BRANCH"
      git diff --name-only "$OLD" "$NEW" 2>/dev/null | grep -q '^package' && npm install
      pm2 describe "$BOT_NAME" >/dev/null 2>&1 && pm2 restart "$BOT_NAME"
    fi
  fi
  sleep "$INTERVAL"
done
