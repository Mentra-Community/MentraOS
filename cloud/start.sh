#!/bin/sh
set -e
cd packages/cloud && PORT=80 bun run start
