#!/bin/sh
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname catalog_db \
  --set=catalog_test_password="$CATALOG_TEST_PASSWORD" \
  --set=auth_user="$AUTH_PGUSER" --set=auth_password="$AUTH_PGPASSWORD" \
  --set=auth_test_password="$AUTH_TEST_PASSWORD" \
  --set=orders_user="$ORDERS_PGUSER" --set=orders_password="$ORDERS_PGPASSWORD" \
  --set=orders_test_password="$ORDERS_TEST_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE catalog_test_user LOGIN PASSWORD %L', :'catalog_test_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'catalog_test_user') \gexec
SELECT 'CREATE DATABASE catalog_test_db OWNER catalog_test_user'
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'catalog_test_db') \gexec
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'auth_user', :'auth_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'auth_user') \gexec
SELECT format('CREATE DATABASE auth_db OWNER %I', :'auth_user')
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'auth_db') \gexec
SELECT format('CREATE ROLE auth_test_user LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'auth_test_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auth_test_user') \gexec
SELECT 'CREATE DATABASE auth_test_db OWNER auth_test_user'
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'auth_test_db') \gexec
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'orders_user', :'orders_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'orders_user') \gexec
SELECT format('CREATE DATABASE orders_db OWNER %I', :'orders_user')
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'orders_db') \gexec
SELECT format('CREATE ROLE orders_test_user LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'orders_test_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'orders_test_user') \gexec
SELECT 'CREATE DATABASE orders_test_db OWNER orders_test_user'
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'orders_test_db') \gexec
REVOKE CONNECT ON DATABASE catalog_db, catalog_test_db, auth_db, auth_test_db, orders_db, orders_test_db FROM PUBLIC;
GRANT CONNECT ON DATABASE catalog_db TO CURRENT_USER;
GRANT CONNECT ON DATABASE catalog_test_db TO catalog_test_user;
SELECT format('GRANT CONNECT ON DATABASE auth_db TO %I', :'auth_user') \gexec
GRANT CONNECT ON DATABASE auth_test_db TO auth_test_user;
SELECT format('GRANT CONNECT ON DATABASE orders_db TO %I', :'orders_user') \gexec
GRANT CONNECT ON DATABASE orders_test_db TO orders_test_user;
SQL
