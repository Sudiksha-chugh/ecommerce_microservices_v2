FROM postgres:17
COPY infrastructure/docker/search-init.sh /docker-entrypoint-initdb.d/search-init.sh
RUN chmod 0644 /docker-entrypoint-initdb.d/search-init.sh
