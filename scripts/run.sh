#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

if [ -f "$PROJECT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$PROJECT_DIR/.env"
  set +a
fi

USER_SHELL="${SHELL:-$(command -v zsh || command -v bash)}"

if [ -n "$USER_SHELL" ] && [ -x "$USER_SHELL" ]; then
  exec "$USER_SHELL" -l -c "cd '$PROJECT_DIR' && exec bun run src/index.ts"
else
  exec bun run src/index.ts
fi
