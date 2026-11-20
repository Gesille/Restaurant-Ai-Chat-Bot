#!/usr/bin/env bash
# Daily MongoDB backup (installed as a cron job by server-setup.sh). Keeps the last 14 days.
#   Manual run:   bash deploy/backup.sh
#   Restore:      gunzip -c FILE.archive.gz | docker compose -f deploy/docker-compose.prod.yml exec -T mongo \
#                   mongorestore --archive --drop -u root -p "$MONGO_ROOT_PASSWORD" --authenticationDatabase admin
set -euo pipefail
cd "$(dirname "$0")"
set -a; . ./.env; set +a
DIR="${BACKUP_DIR:-/opt/backups/restaurant-ai}"
mkdir -p "$DIR"
FILE="$DIR/mongo-$(date +%Y%m%d-%H%M%S).archive.gz"
docker compose -f docker-compose.prod.yml exec -T mongo \
  mongodump --archive --gzip -u root -p "$MONGO_ROOT_PASSWORD" --authenticationDatabase admin > "$FILE.tmp"
mv "$FILE.tmp" "$FILE"
find "$DIR" -name 'mongo-*.archive.gz' -mtime +14 -delete
echo "backup: $FILE ($(du -h "$FILE" | cut -f1))"
