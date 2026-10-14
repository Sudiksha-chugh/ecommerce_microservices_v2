# Sourced by the official PostgreSQL entrypoint only on a fresh, explicitly created volume.
set -eu
: "${SEARCH_DATABASE_PASSWORD:?Search database password required}"
psql --username "$POSTGRES_USER" --dbname postgres --set ON_ERROR_STOP=1 --set search_password="$SEARCH_DATABASE_PASSWORD" <<'SQL'
CREATE ROLE search_user LOGIN PASSWORD :'search_password';
CREATE DATABASE search_db OWNER search_user;
REVOKE CONNECT ON DATABASE search_db FROM PUBLIC;
SQL
