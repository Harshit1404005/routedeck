#!/usr/bin/env sh
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 || { echo "Node.js is not installed. Get it from https://nodejs.org"; exit 1; }
exec node server.mjs
