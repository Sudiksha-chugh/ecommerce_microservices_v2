FROM postgres:17
COPY infrastructure/docker/notifications-init.sh /docker-entrypoint-initdb.d/notifications-init.sh
# PostgreSQL sources non-executable .sh files; no host bind-mount execution is required.
RUN chmod 0644 /docker-entrypoint-initdb.d/notifications-init.sh
