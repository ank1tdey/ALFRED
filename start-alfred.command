#!/bin/bash
# Mac launcher: double-click this file to start ALFRED OS.
cd "$(dirname "$0")"
echo "Starting ALFRED OS..."
(sleep 2 && open "http://localhost:3000") &
node server.js
