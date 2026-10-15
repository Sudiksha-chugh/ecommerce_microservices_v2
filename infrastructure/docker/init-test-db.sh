#!/bin/sh
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname catalog_db \
  --set=catalog_test_password="$CATALOG_TEST_PASSWORD" \
  --set=auth_user="$AUTH_PGUSER" --set=auth_password="$AUTH_PGPASSWORD" \
  --set=auth_test_password="$AUTH_TEST_PASSWORD" \
  --set=orders_user="$ORDERS_PGUSER" --set=orders_password="$ORDERS_PGPASSWORD" \
  --set=orders_test_password="$ORDERS_TEST_PASSWORD" \
  --set=inventory_user="$INVENTORY_PGUSER" --set=inventory_password="$INVENTORY_PGPASSWORD" \
  --set=inventory_test_password="$INVENTORY_TEST_PASSWORD" \
  --set=payments_user="$PAYMENTS_PGUSER" --set=payments_password="$PAYMENTS_PGPASSWORD" \
  --set=payments_test_password="$PAYMENTS_TEST_PASSWORD" \
  --set=mock_user="$MOCK_PGUSER" --set=mock_password="$MOCK_PGPASSWORD" \
  --set=mock_test_password="$MOCK_TEST_PASSWORD" <<'SQL'
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
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'inventory_user', :'inventory_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'inventory_user') \gexec
SELECT format('CREATE DATABASE inventory_db OWNER %I', :'inventory_user')
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'inventory_db') \gexec
SELECT format('CREATE ROLE inventory_test_user LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'inventory_test_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'inventory_test_user') \gexec
SELECT 'CREATE DATABASE inventory_test_db OWNER inventory_test_user'
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'inventory_test_db') \gexec
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'payments_user', :'payments_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'payments_user') \gexec
SELECT format('CREATE DATABASE payments_db OWNER %I', :'payments_user')
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'payments_db') \gexec
SELECT format('CREATE ROLE payments_test_user LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'payments_test_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'payments_test_user') \gexec
SELECT 'CREATE DATABASE payments_test_db OWNER payments_test_user'
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'payments_test_db') \gexec
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'mock_user', :'mock_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'mock_user') \gexec
SELECT format('CREATE DATABASE mock_provider_db OWNER %I', :'mock_user')
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'mock_provider_db') \gexec
SELECT format('CREATE ROLE mock_provider_test_user LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'mock_test_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mock_provider_test_user') \gexec
SELECT 'CREATE DATABASE mock_provider_test_db OWNER mock_provider_test_user'
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'mock_provider_test_db') \gexec
REVOKE CONNECT ON DATABASE catalog_db, catalog_test_db, auth_db, auth_test_db, orders_db, orders_test_db, inventory_db, inventory_test_db, payments_db, payments_test_db, mock_provider_db, mock_provider_test_db FROM PUBLIC;
GRANT CONNECT ON DATABASE catalog_db TO CURRENT_USER;
GRANT CONNECT ON DATABASE catalog_test_db TO catalog_test_user;
SELECT format('GRANT CONNECT ON DATABASE auth_db TO %I', :'auth_user') \gexec
GRANT CONNECT ON DATABASE auth_test_db TO auth_test_user;
SELECT format('GRANT CONNECT ON DATABASE orders_db TO %I', :'orders_user') \gexec
GRANT CONNECT ON DATABASE orders_test_db TO orders_test_user;
SELECT format('GRANT CONNECT ON DATABASE inventory_db TO %I', :'inventory_user') \gexec
GRANT CONNECT ON DATABASE inventory_test_db TO inventory_test_user;
SELECT format('GRANT CONNECT ON DATABASE payments_db TO %I', :'payments_user') \gexec
GRANT CONNECT ON DATABASE payments_test_db TO payments_test_user;
SELECT format('GRANT CONNECT ON DATABASE mock_provider_db TO %I', :'mock_user') \gexec
GRANT CONNECT ON DATABASE mock_provider_test_db TO mock_provider_test_user;
SQL
