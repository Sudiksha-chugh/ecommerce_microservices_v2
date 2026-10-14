#!/bin/sh
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
 --set=notifications_password="$NOTIFICATIONS_DATABASE_PASSWORD" --set=email_password="$MOCK_EMAIL_DATABASE_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE notifications_user LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'notifications_password')
 WHERE NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='notifications_user') \gexec
SELECT format('CREATE ROLE mock_email_user LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'email_password')
 WHERE NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='mock_email_user') \gexec
SELECT 'CREATE DATABASE notifications_db OWNER notifications_user'
 WHERE NOT EXISTS(SELECT 1 FROM pg_database WHERE datname='notifications_db') \gexec
SELECT 'CREATE DATABASE mock_email_provider_db OWNER mock_email_user'
 WHERE NOT EXISTS(SELECT 1 FROM pg_database WHERE datname='mock_email_provider_db') \gexec
REVOKE CONNECT ON DATABASE notifications_db,mock_email_provider_db FROM PUBLIC;
GRANT CONNECT ON DATABASE notifications_db TO notifications_user;
GRANT CONNECT ON DATABASE mock_email_provider_db TO mock_email_user;
SQL
