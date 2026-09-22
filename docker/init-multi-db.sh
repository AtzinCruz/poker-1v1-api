#!/bin/bash
set -e

for db in $(echo "$POSTGRES_MULTIPLE_DATABASES" | tr ',' ' '); do
  if [ "$db" != "$POSTGRES_DB" ]; then
    psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
      CREATE DATABASE $db;
EOSQL
  fi
done
