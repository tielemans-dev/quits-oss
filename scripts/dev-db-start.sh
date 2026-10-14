#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE=""

if [[ -f .env ]]; then
  ENV_FILE=".env"
else
  COMMON_GIT_DIR="$(git rev-parse --git-common-dir 2>/dev/null || true)"
  if [[ -n "$COMMON_GIT_DIR" ]]; then
    COMMON_GIT_DIR_ABS="$(cd "$COMMON_GIT_DIR" && pwd)"
    COMMON_ENV_FILE="$(dirname "$COMMON_GIT_DIR_ABS")/.env"
    if [[ -f "$COMMON_ENV_FILE" ]]; then
      ENV_FILE="$COMMON_ENV_FILE"
    fi
  fi
fi

EXPLICIT_DATABASE_URL="${DATABASE_URL:-}"

if [[ -n "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ENV_FILE"
  set +a
fi

# An explicitly exported DATABASE_URL wins over the one in .env.
if [[ -n "$EXPLICIT_DATABASE_URL" ]]; then
  DATABASE_URL="$EXPLICIT_DATABASE_URL"
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is not set. Add it to .env first."
  exit 1
fi

db_parts=()
while IFS= read -r line; do
  db_parts+=("$line")
done < <(node <<'NODE'
const raw = process.env.DATABASE_URL
if (!raw) {
  console.error("DATABASE_URL is missing")
  process.exit(1)
}

const url = new URL(raw)
const username = decodeURIComponent(url.username || "")
const password = decodeURIComponent(url.password || "")
const host = url.hostname || "localhost"
const port = url.port || "5432"
const dbName = (url.pathname || "").replace(/^\//, "")

if (!username || !password || !dbName) {
  console.error("DATABASE_URL must include username, password, and database name")
  process.exit(1)
}

console.log(username)
console.log(password)
console.log(host)
console.log(port)
console.log(dbName)
NODE
)

DB_USER="${db_parts[0]}"
DB_PASSWORD="${db_parts[1]}"
DB_HOST="${db_parts[2]}"
DB_PORT="${db_parts[3]}"
DB_NAME="${db_parts[4]}"
CONTAINER_NAME="${QUITS_DB_CONTAINER_NAME:-${YAIP_DB_CONTAINER_NAME:-yaip-postgres}}"

if [[ "$DB_HOST" != "localhost" && "$DB_HOST" != "127.0.0.1" ]]; then
  echo "DATABASE_URL host is '$DB_HOST'. db:start only manages local Docker Postgres (localhost)."
  exit 1
fi

# Reuse a native Postgres that already accepts connections on the target port.
pg_isready_bin="$(command -v pg_isready || true)"
if [[ -z "$pg_isready_bin" ]]; then
  for candidate in /usr/lib/postgresql/*/bin/pg_isready; do
    if [[ -x "$candidate" ]]; then
      pg_isready_bin="$candidate"
    fi
  done
fi

if [[ -n "$pg_isready_bin" ]]; then
  if "$pg_isready_bin" -q -h "$DB_HOST" -p "$DB_PORT"; then
    echo "Postgres is already accepting connections on $DB_HOST:$DB_PORT; reusing it."
    exit 0
  fi
elif (exec 3<>"/dev/tcp/$DB_HOST/$DB_PORT") 2>/dev/null; then
  echo "Something is already listening on $DB_HOST:$DB_PORT; reusing it."
  exit 0
fi

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "No Postgres is accepting connections on $DB_HOST:$DB_PORT and Docker is not available." >&2
  echo "Start Postgres on that port, or start Docker and retry." >&2
  exit 1
fi

if docker ps -a --format '{{.Names}}' | grep -Fxq "$CONTAINER_NAME"; then
  docker start "$CONTAINER_NAME" >/dev/null
  echo "Started existing container '$CONTAINER_NAME' on localhost:$DB_PORT"
else
  docker run -d \
    --name "$CONTAINER_NAME" \
    -e POSTGRES_USER="$DB_USER" \
    -e POSTGRES_PASSWORD="$DB_PASSWORD" \
    -e POSTGRES_DB="$DB_NAME" \
    -p "$DB_PORT:5432" \
    postgres:16-alpine >/dev/null
  echo "Created and started '$CONTAINER_NAME' for database '$DB_NAME' on localhost:$DB_PORT"
fi
