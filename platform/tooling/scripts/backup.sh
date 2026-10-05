#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
cloud_backup_path="${1:?Usage: bash platform/tooling/scripts/backup.sh /secure/path/cloud.dump}"
cloud_backup_database="${CLOUD_DATABASE_NAME:-zhiyun_cloud}"
umask 077
docker compose -f platform/deploy/compose.yml exec -T postgres pg_dump -U zhiyun -d "$cloud_backup_database" -Fc > "$cloud_backup_path"
