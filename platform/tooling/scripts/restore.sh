#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
cloud_restore_path="${1:?Usage: CLOUD_RESTORE_CONFIRM=replace-database bash platform/tooling/scripts/restore.sh backup.dump}"
if [ "${CLOUD_RESTORE_CONFIRM:-}" != "replace-database" ]; then
  echo 'Restore replaces database objects. Stop API and worker, then set CLOUD_RESTORE_CONFIRM=replace-database.' >&2
  exit 1
fi
cloud_restore_database="${CLOUD_DATABASE_NAME:-zhiyun_cloud}"
docker compose -f platform/deploy/compose.yml exec -T postgres pg_restore -U zhiyun -d "$cloud_restore_database" --clean --if-exists --exit-on-error < "$cloud_restore_path"
