#!/bin/bash
# Migrate lorawan_gateway_sim from remote host into this repo
# Run from project root or simulator/ directory

set -e

# Override before running, e.g. REMOTE_HOST=your.lab.host REMOTE_USER=you ./migrate-from-remote.sh
REMOTE_HOST="${REMOTE_HOST:-192.0.2.10}"
REMOTE_USER="${REMOTE_USER:-your-user}"
REMOTE_PATH="/tmp/lorawan_gateway_sim"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="$SCRIPT_DIR"

echo "Migrating from ${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PATH}"
echo "Destination: $DEST_DIR"

# Use rsync if available, else scp
if command -v rsync &>/dev/null; then
  rsync -avz --progress \
    -e "ssh -o StrictHostKeyChecking=no" \
    "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PATH}/" \
    "$DEST_DIR/"
else
  mkdir -p "$DEST_DIR"
  scp -o StrictHostKeyChecking=no -r \
    "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PATH}/*" \
    "$DEST_DIR/"
fi

echo "Migration complete. Files in $DEST_DIR"
