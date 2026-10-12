FROM postgres:17
COPY --chmod=0644 infrastructure/docker/init-test-db.sh /docker-entrypoint-initdb.d/init-test-db.sh
