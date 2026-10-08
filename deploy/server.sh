#!/bin/sh
# 从固定版本目录执行，current 只在验收通过后提升。
set -eu
task_release=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec docker compose --project-name geekdash \
  --env-file "$task_release/manifest.env" \
  -f "$task_release/deploy/compose.server.yml" "$@"
