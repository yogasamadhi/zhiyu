#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly SCRIPT_DIRECTORY="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly REPOSITORY_ROOT="$(cd -- "${SCRIPT_DIRECTORY}/.." && pwd -P)"
readonly PRODUCTION_COMPOSE="${REPOSITORY_ROOT}/deploy/compose.production.yml"
readonly SMOKE_COMPOSE="${REPOSITORY_ROOT}/deploy/compose.smoke.yml"
readonly ZHIYUN_IMAGE="${ZHIYUN_IMAGE:-zhiyun-headless:ci}"
readonly PRIMARY_PORT="${ZHIYUN_SMOKE_PORT:-43101}"
readonly RESTORE_PORT="${ZHIYUN_SMOKE_RESTORE_PORT:-43102}"
readonly POSTGRES_PASSWORD="${ZHIYUN_SMOKE_POSTGRES_PASSWORD:-compose-smoke-postgres-password}"
readonly BOOTSTRAP_TOKEN="${ZHIYUN_SMOKE_BOOTSTRAP_TOKEN:-compose-smoke-bootstrap-token-with-32-bytes}"
readonly CREDENTIAL_KEY="${ZHIYUN_SMOKE_CREDENTIAL_KEY:-compose-smoke-credential-key-with-32-bytes}"
readonly ADMIN_EMAIL='admin@compose-smoke.invalid'
readonly ADMIN_PASSWORD='admin compose smoke password'
readonly EDITOR_EMAIL='editor@compose-smoke.invalid'
readonly EDITOR_PASSWORD='editor compose smoke password'
readonly VIEWER_EMAIL='viewer@compose-smoke.invalid'
readonly VIEWER_PASSWORD='viewer compose smoke password'
readonly PROJECT_SUFFIX="$(printf '%s' "${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-${RANDOM}-$$" | tr '[:upper:]_' '[:lower:]-' | tr -cd 'a-z0-9-' | cut -c1-36)"
readonly PRIMARY_PROJECT="zhiyun-smoke-${PROJECT_SUFFIX}"
readonly RESTORE_PROJECT="${PRIMARY_PROJECT}-restore"
readonly TEMP_ROOT="${TMPDIR:-/tmp}"
readonly TEMP_DIRECTORY="$(mktemp -d "${TEMP_ROOT%/}/zhiyun-compose-smoke.XXXXXX")"
readonly BACKUP_DIRECTORY="${TEMP_DIRECTORY}/backup"

LAST_BODY=''
LAST_HEADERS=''
API_URL="http://127.0.0.1:${PRIMARY_PORT}"
LOGIN_COOKIE=''
LOGIN_CSRF=''
REQUEST_SEQUENCE=0

export ZHIYUN_IMAGE
export POSTGRES_PASSWORD
export ZHIYUN_BOOTSTRAP_TOKEN="${BOOTSTRAP_TOKEN}"
export ZHIYUN_CREDENTIAL_KEY="${CREDENTIAL_KEY}"
export ZHIYUN_DOMAIN='localhost'

log() {
  printf '[headless-compose-smoke] %s\n' "$*"
}

fail() {
  printf '[headless-compose-smoke] ERROR: %s\n' "$*" >&2
  return 1
}

validate_inputs() {
  [[ "${PRIMARY_PORT}" =~ ^[0-9]+$ ]] || fail 'ZHIYUN_SMOKE_PORT must be numeric'
  [[ "${RESTORE_PORT}" =~ ^[0-9]+$ ]] || fail 'ZHIYUN_SMOKE_RESTORE_PORT must be numeric'
  [[ "${PRIMARY_PORT}" != "${RESTORE_PORT}" ]] || fail 'Smoke and restore ports must differ'
  (( PRIMARY_PORT > 1024 && PRIMARY_PORT < 65536 )) || fail 'Smoke port is out of range'
  (( RESTORE_PORT > 1024 && RESTORE_PORT < 65536 )) || fail 'Restore port is out of range'
  (( ${#BOOTSTRAP_TOKEN} >= 32 )) || fail 'Smoke bootstrap token must contain at least 32 bytes'
  (( ${#CREDENTIAL_KEY} >= 32 )) || fail 'Smoke credential key must contain at least 32 bytes'
  docker image inspect "${ZHIYUN_IMAGE}" >/dev/null 2>&1 ||
    fail "Docker image ${ZHIYUN_IMAGE} does not exist locally"
}

primary_compose() {
  ZHIYUN_SMOKE_PORT="${PRIMARY_PORT}" \
    ZHIYUN_PUBLIC_URL="https://localhost:${PRIMARY_PORT}" \
    docker compose \
      --project-name "${PRIMARY_PROJECT}" \
      --file "${PRODUCTION_COMPOSE}" \
      --file "${SMOKE_COMPOSE}" \
      "$@"
}

restore_compose() {
  ZHIYUN_SMOKE_PORT="${RESTORE_PORT}" \
    ZHIYUN_PUBLIC_URL="https://localhost:${RESTORE_PORT}" \
    docker compose \
      --project-name "${RESTORE_PROJECT}" \
      --file "${PRODUCTION_COMPOSE}" \
      --file "${SMOKE_COMPOSE}" \
      "$@"
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  if (( status != 0 )); then
    printf '[headless-compose-smoke] Capturing container logs after failure\n' >&2
    restore_compose logs --no-color --tail 200 zhiyun postgres redis >&2
    primary_compose logs --no-color --tail 200 zhiyun postgres redis >&2
  fi
  restore_compose down --volumes --remove-orphans --timeout 10 >/dev/null 2>&1
  primary_compose down --volumes --remove-orphans --timeout 10 >/dev/null 2>&1
  if [[ -d "${TEMP_DIRECTORY}" && "${TEMP_DIRECTORY}" == "${TEMP_ROOT%/}/zhiyun-compose-smoke."* ]]; then
    rm -rf -- "${TEMP_DIRECTORY}"
  else
    printf '[headless-compose-smoke] Refusing to remove unexpected temporary path: %s\n' \
      "${TEMP_DIRECTORY}" >&2
  fi
  exit "${status}"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

wait_for_ready() {
  local compose_name=$1
  local base_url=$2
  local body="${TEMP_DIRECTORY}/${compose_name}-ready.json"
  local attempt
  for attempt in $(seq 1 90); do
    if curl --silent --show-error --fail --max-time 5 "${base_url}/ready" >"${body}" 2>/dev/null; then
      assert_json_equal "${body}" status ready
      assert_json_equal "${body}" checks.database.status ok
      assert_json_equal "${body}" checks.redis.status ok
      assert_json_equal "${body}" checks.queue.status ok
      return 0
    fi
    sleep 2
  done
  if [[ "${compose_name}" == 'primary' ]]; then
    primary_compose ps >&2 || true
    primary_compose logs --no-color --tail 200 zhiyun postgres redis >&2 || true
  else
    restore_compose ps >&2 || true
    restore_compose logs --no-color --tail 200 zhiyun postgres redis >&2 || true
  fi
  fail "${compose_name} did not become ready"
}

request() {
  local expected_status=$1
  local method=$2
  local path=$3
  local body=${4:-}
  local cookie=${5:-}
  local csrf=${6:-}
  local idempotency_key=${7:-}
  ((REQUEST_SEQUENCE += 1))
  local request_id="request-${REQUEST_SEQUENCE}"
  LAST_BODY="${TEMP_DIRECTORY}/${request_id}.json"
  LAST_HEADERS="${TEMP_DIRECTORY}/${request_id}.headers"
  local -a arguments=(
    --silent
    --show-error
    --max-time 20
    --request "${method}"
    --dump-header "${LAST_HEADERS}"
    --output "${LAST_BODY}"
    --write-out '%{http_code}'
  )
  if [[ -n "${body}" ]]; then
    arguments+=(--header 'content-type: application/json' --data "${body}")
  fi
  [[ -z "${cookie}" ]] || arguments+=(--header "cookie: ${cookie}")
  [[ -z "${csrf}" ]] || arguments+=(--header "x-csrf-token: ${csrf}")
  [[ -z "${idempotency_key}" ]] ||
    arguments+=(--header "idempotency-key: ${idempotency_key}")
  local status
  status="$(curl "${arguments[@]}" "${API_URL}${path}")"
  if [[ "${status}" != "${expected_status}" ]]; then
    printf 'Request %s %s returned %s, expected %s\n' \
      "${method}" "${path}" "${status}" "${expected_status}" >&2
    sed -n '1,200p' "${LAST_BODY}" >&2 || true
    return 1
  fi
}

json_value() {
  local path=$1
  local dotted_path=$2
  python3 - "${path}" "${dotted_path}" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as source:
    value = json.load(source)
for component in sys.argv[2].split("."):
    value = value[int(component)] if isinstance(value, list) else value[component]
if isinstance(value, bool):
    print("true" if value else "false")
elif value is None:
    print("null")
else:
    print(value)
PY
}

assert_json_equal() {
  local path=$1
  local dotted_path=$2
  local expected=$3
  local actual
  actual="$(json_value "${path}" "${dotted_path}")"
  [[ "${actual}" == "${expected}" ]] ||
    fail "Expected ${dotted_path}=${expected} in ${path}, received ${actual}"
}

assert_json_array_field_contains() {
  local path=$1
  local array_path=$2
  local field=$3
  local expected=$4
  python3 - "${path}" "${array_path}" "${field}" "${expected}" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as source:
    value = json.load(source)
for component in sys.argv[2].split("."):
    value = value[int(component)] if isinstance(value, list) else value[component]
if not isinstance(value, list) or not any(str(item.get(sys.argv[3])) == sys.argv[4] for item in value):
    raise SystemExit(
        f"No item with {sys.argv[3]}={sys.argv[4]} in {sys.argv[2]} from {sys.argv[1]}"
    )
PY
}

extract_cookie() {
  awk '
    tolower($0) ~ /^set-cookie:/ {
      sub(/^[^:]+:[[:space:]]*/, "")
      split($0, parts, ";")
      gsub(/\r/, "", parts[1])
      print parts[1]
      exit
    }
  ' "$1"
}

login_user() {
  local email=$1
  local password=$2
  local expected_role=$3
  request 200 POST /api/v2/auth/login \
    "{\"email\":\"${email}\",\"password\":\"${password}\"}"
  LOGIN_COOKIE="$(extract_cookie "${LAST_HEADERS}")"
  LOGIN_CSRF="$(json_value "${LAST_BODY}" csrfToken)"
  [[ -n "${LOGIN_COOKIE}" ]] || fail "Login for ${email} did not issue a session cookie"
  [[ -n "${LOGIN_CSRF}" ]] || fail "Login for ${email} did not issue a CSRF token"
  grep -qi 'set-cookie:.*HttpOnly' "${LAST_HEADERS}" || fail 'Session cookie is not HttpOnly'
  grep -qi 'set-cookie:.*SameSite=Strict' "${LAST_HEADERS}" ||
    fail 'Session cookie is not SameSite=Strict'
  grep -qi 'set-cookie:.*Secure' "${LAST_HEADERS}" || fail 'Production session cookie is not Secure'
  assert_json_equal "${LAST_BODY}" user.role "${expected_role}"
}

create_and_accept_invitation() {
  local email=$1
  local role=$2
  local display_name=$3
  local password=$4
  local admin_cookie=$5
  local admin_csrf=$6
  request 201 POST /api/v2/invitations \
    "{\"email\":\"${email}\",\"role\":\"${role}\"}" \
    "${admin_cookie}" "${admin_csrf}"
  local invitation_token
  invitation_token="$(json_value "${LAST_BODY}" token)"
  request 201 POST /api/v2/invitations/accept \
    "{\"token\":\"${invitation_token}\",\"displayName\":\"${display_name}\",\"password\":\"${password}\"}"
  assert_json_equal "${LAST_BODY}" role "${role}"
}

verify_workspace_data() {
  local admin_cookie=$1
  request 200 GET /api/v2/members '' "${admin_cookie}"
  assert_json_array_field_contains "${LAST_BODY}" items email "${ADMIN_EMAIL}"
  assert_json_array_field_contains "${LAST_BODY}" items email "${EDITOR_EMAIL}"
  assert_json_array_field_contains "${LAST_BODY}" items email "${VIEWER_EMAIL}"
  request 200 GET /api/v2/tasks '' "${admin_cookie}"
  assert_json_array_field_contains "${LAST_BODY}" items name 'Compose persisted task'
}

run_primary_smoke() {
  log "validating merged Compose configuration for ${ZHIYUN_IMAGE}"
  primary_compose config --quiet
  log 'starting PostgreSQL, Redis and ZhiYun'
  primary_compose up --detach --no-build postgres redis zhiyun
  wait_for_ready primary "${API_URL}"

  request 200 GET /api/v2/auth/status
  assert_json_equal "${LAST_BODY}" initialized false
  request 201 POST /api/v2/auth/setup \
    "{\"bootstrapToken\":\"${BOOTSTRAP_TOKEN}\",\"email\":\"${ADMIN_EMAIL}\",\"displayName\":\"Administrator\",\"password\":\"${ADMIN_PASSWORD}\"}"
  assert_json_equal "${LAST_BODY}" role admin
  request 409 POST /api/v2/auth/setup \
    "{\"bootstrapToken\":\"${BOOTSTRAP_TOKEN}\",\"email\":\"second@compose-smoke.invalid\",\"displayName\":\"Second administrator\",\"password\":\"${ADMIN_PASSWORD}\"}"
  assert_json_equal "${LAST_BODY}" code ALREADY_INITIALIZED

  login_user "${ADMIN_EMAIL}" "${ADMIN_PASSWORD}" admin
  local admin_cookie=${LOGIN_COOKIE}
  local admin_csrf=${LOGIN_CSRF}
  request 200 GET /api/v2/auth/me '' "${admin_cookie}"
  assert_json_equal "${LAST_BODY}" user.role admin

  request 403 POST /api/v2/invitations \
    '{"email":"missing-csrf@compose-smoke.invalid","role":"viewer"}' "${admin_cookie}"
  assert_json_equal "${LAST_BODY}" code CSRF_INVALID

  create_and_accept_invitation \
    "${EDITOR_EMAIL}" editor Editor "${EDITOR_PASSWORD}" "${admin_cookie}" "${admin_csrf}"
  create_and_accept_invitation \
    "${VIEWER_EMAIL}" viewer Viewer "${VIEWER_PASSWORD}" "${admin_cookie}" "${admin_csrf}"

  login_user "${EDITOR_EMAIL}" "${EDITOR_PASSWORD}" editor
  local editor_cookie=${LOGIN_COOKIE}
  local editor_csrf=${LOGIN_CSRF}
  request 403 GET /api/v2/members '' "${editor_cookie}"
  assert_json_equal "${LAST_BODY}" code FORBIDDEN
  request 201 POST /api/v2/tasks \
    '{"name":"Compose persisted task","startUrl":"https://www.wikipedia.org/","instruction":"Verify Compose persistence"}' \
    "${editor_cookie}" "${editor_csrf}" "compose-smoke-task-${PROJECT_SUFFIX}"
  local task_id
  task_id="$(json_value "${LAST_BODY}" id)"

  login_user "${VIEWER_EMAIL}" "${VIEWER_PASSWORD}" viewer
  local viewer_cookie=${LOGIN_COOKIE}
  local viewer_csrf=${LOGIN_CSRF}
  request 200 GET /api/v2/tasks '' "${viewer_cookie}"
  assert_json_array_field_contains "${LAST_BODY}" items id "${task_id}"
  request 403 POST /api/v2/tasks \
    '{"name":"Viewer forbidden task","startUrl":"https://www.wikipedia.org/","instruction":"This must not persist"}' \
    "${viewer_cookie}" "${viewer_csrf}" "compose-smoke-viewer-${PROJECT_SUFFIX}"
  assert_json_equal "${LAST_BODY}" code FORBIDDEN
  request 403 GET /api/v2/members '' "${viewer_cookie}"
  assert_json_equal "${LAST_BODY}" code FORBIDDEN

  login_user "${ADMIN_EMAIL}" "${ADMIN_PASSWORD}" admin
  admin_cookie=${LOGIN_COOKIE}
  verify_workspace_data "${admin_cookie}"
  request 200 GET /api/v2/audit-events '' "${admin_cookie}"

  log 'recreating ZhiYun without the bootstrap token and verifying persisted identity/task data'
  ZHIYUN_BOOTSTRAP_TOKEN='' primary_compose up --detach --no-build --force-recreate zhiyun
  wait_for_ready primary "${API_URL}"
  verify_workspace_data "${admin_cookie}"
  login_user "${ADMIN_EMAIL}" "${ADMIN_PASSWORD}" admin
  admin_cookie=${LOGIN_COOKIE}
  verify_workspace_data "${admin_cookie}"
}

backup_primary() {
  mkdir -p "${BACKUP_DIRECTORY}"
  log 'creating PostgreSQL and data-directory backups'
  primary_compose exec --no-tty zhiyun bash -ec \
    "printf '%s\\n' '${PROJECT_SUFFIX}' > /var/lib/zhiyun/compose-smoke-restore-marker"
  primary_compose exec --no-tty postgres pg_dump -U zhiyun -d zhiyun -Fc \
    >"${BACKUP_DIRECTORY}/zhiyun.dump"
  primary_compose exec --no-tty zhiyun tar -C /var/lib/zhiyun -czf - . \
    >"${BACKUP_DIRECTORY}/zhiyun-data.tar.gz"
  [[ -s "${BACKUP_DIRECTORY}/zhiyun.dump" ]] || fail 'PostgreSQL dump is empty'
  [[ -s "${BACKUP_DIRECTORY}/zhiyun-data.tar.gz" ]] || fail 'Data-directory backup is empty'
  tar -tzf "${BACKUP_DIRECTORY}/zhiyun-data.tar.gz" \
    >"${BACKUP_DIRECTORY}/zhiyun-data-files.txt"
  grep -q 'compose-smoke-restore-marker' "${BACKUP_DIRECTORY}/zhiyun-data-files.txt"
  primary_compose stop zhiyun
}

run_restore_smoke() {
  API_URL="http://127.0.0.1:${RESTORE_PORT}"
  log 'starting isolated restore PostgreSQL and Redis volumes'
  restore_compose config --quiet
  restore_compose up --detach postgres redis
  local attempt
  for attempt in $(seq 1 60); do
    if restore_compose exec --no-tty postgres pg_isready -U zhiyun -d zhiyun >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  restore_compose exec --no-tty postgres pg_isready -U zhiyun -d zhiyun >/dev/null
  restore_compose exec --no-tty postgres pg_restore \
    --clean --if-exists -U zhiyun -d zhiyun <"${BACKUP_DIRECTORY}/zhiyun.dump"
  restore_compose run --rm --no-deps --no-tty --entrypoint bash zhiyun \
    -ec 'tar -C /var/lib/zhiyun -xzf -' <"${BACKUP_DIRECTORY}/zhiyun-data.tar.gz"
  ZHIYUN_BOOTSTRAP_TOKEN='' restore_compose up --detach --no-build zhiyun
  wait_for_ready restore "${API_URL}"
  restore_compose exec --no-tty zhiyun bash -ec \
    "test \"\$(tr -d '\\r\\n' < /var/lib/zhiyun/compose-smoke-restore-marker)\" = '${PROJECT_SUFFIX}'"

  request 200 GET /api/v2/auth/status
  assert_json_equal "${LAST_BODY}" initialized true
  request 409 POST /api/v2/auth/setup \
    "{\"bootstrapToken\":\"${BOOTSTRAP_TOKEN}\",\"email\":\"restore@compose-smoke.invalid\",\"displayName\":\"Restore administrator\",\"password\":\"${ADMIN_PASSWORD}\"}"
  assert_json_equal "${LAST_BODY}" code ALREADY_INITIALIZED

  login_user "${ADMIN_EMAIL}" "${ADMIN_PASSWORD}" admin
  local admin_cookie=${LOGIN_COOKIE}
  verify_workspace_data "${admin_cookie}"
  login_user "${EDITOR_EMAIL}" "${EDITOR_PASSWORD}" editor
  request 200 GET /api/v2/tasks '' "${LOGIN_COOKIE}"
  assert_json_array_field_contains "${LAST_BODY}" items name 'Compose persisted task'
  login_user "${VIEWER_EMAIL}" "${VIEWER_PASSWORD}" viewer
  request 200 GET /api/v2/tasks '' "${LOGIN_COOKIE}"
  assert_json_array_field_contains "${LAST_BODY}" items name 'Compose persisted task'
  request 403 GET /api/v2/members '' "${LOGIN_COOKIE}"
  assert_json_equal "${LAST_BODY}" code FORBIDDEN
}

validate_inputs
run_primary_smoke
backup_primary
run_restore_smoke
log 'PASS: initialization, CSRF, three roles, restart, backup and isolated restore verified'
