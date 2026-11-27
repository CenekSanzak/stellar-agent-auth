#!/bin/sh
# Start the demo as an unprivileged user. A host mounts the state volume owned by root, so the directory is handed
# to that user first; that is the only thing done as root.
set -e
if [ "$(id -u)" = "0" ]; then
  chown -R node:node "${DEMO_STATE_DIRECTORY:-/data}"
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
