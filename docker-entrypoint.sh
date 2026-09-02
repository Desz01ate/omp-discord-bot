#!/usr/bin/env bash
set -e

# Execute any user-mounted startup scripts from /docker-entrypoint-init.d/
if [ -d "/docker-entrypoint-init.d" ]; then
    for f in /docker-entrypoint-init.d/*.sh; do
        [ -f "$f" ] || continue
        echo "[docker-entrypoint] Executing init script: $f"
        if [ -x "$f" ]; then
            "$f"
        else
            # shellcheck source=/dev/null
            . "$f"
        fi
    done
fi

exec "$@"
