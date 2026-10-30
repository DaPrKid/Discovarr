#!/bin/sh
# Runs Discovarr as PUID:PGID (Unraid defaults: 99 nobody / 100 users).
# The container starts as root only long enough to make /data writable, then
# drops privileges with su-exec before the app is started.
set -eu

PUID="${PUID:-99}"
PGID="${PGID:-100}"
DATA_DIR="${DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"

  current="$(stat -c '%u:%g' "$DATA_DIR" 2>/dev/null || echo unknown)"
  if [ "$current" != "$PUID:$PGID" ]; then
    echo "[entrypoint] setting ownership of $DATA_DIR to $PUID:$PGID"
    chown -R "$PUID:$PGID" "$DATA_DIR" 2>/dev/null \
      || echo "[entrypoint] warning: could not change ownership of $DATA_DIR (continuing)"
  fi

  # Unraid-style group-writable files.
  umask 002
  echo "[entrypoint] starting as $PUID:$PGID"
  exec su-exec "$PUID:$PGID" "$@"
fi

echo "[entrypoint] already running as uid $(id -u), gid $(id -g); nothing to drop"
exec "$@"
