#!/bin/sh
# Start Study Hub on Linux (or any system with a terminal): ./start.sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Study Hub needs Node.js 18 or newer: https://nodejs.org/en/download"
  exit 1
fi
if [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  echo "Study Hub needs Node.js 18 or newer: https://nodejs.org/en/download"
  exit 1
fi
echo "Starting Study Hub... your browser will open in a moment."
exec node server.js --open
