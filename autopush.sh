#!/bin/bash
cd "$(dirname "$0")" || exit 1

EXCL='(^|/)(\.git|node_modules|session)(/|$)|autopush\.log|/tmp_|\.swp$|\.save$|~$'
n=0

while inotifywait -r -q -e modify,create,delete,move --exclude "$EXCL" . >/dev/null; do
    sleep 15   # tunggu perubahan selesai
    git add -A
    if ! git diff --cached --quiet; then
        git commit -q --amend -m "Auto update: $(date +'%F %T')" 2>/dev/null \
            || git commit -q -m "Auto update: $(date +'%F %T')"
        git push -q --force origin main
        n=$((n+1))
        if [ $((n % 20)) -eq 0 ]; then
            git reflog expire --expire=now --all
            git gc -q --prune=now
        fi
    fi
done
