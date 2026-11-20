# Deploy to the VPS (API + MongoDB on one server, auto-deploy on push)

```
git push (main) -> CI (tests) passes -> Deploy workflow -> SSH to VPS
  -> git reset to that commit -> deploy/deploy.sh (build, start Mongo, migrate, restart, health check)
Internet -> Caddy on the host (HTTPS, all projects) -> 127.0.0.1:3000 -> API container -> mongo container
```
MongoDB runs in Docker next to the API with **no port open to the internet**; data lives in the Docker volume
`restaurant-ai_mongo-data` and is dumped every night to `/opt/backups/restaurant-ai` (14 days kept).

## One-time setup
1. GoDaddy DNS: `A` record `api` -> VPS IP.
2. From your computer: `scp deploy/server-setup.sh USER@VPS_IP:`
3. On the VPS: `ssh USER@VPS_IP` then
   `sudo bash server-setup.sh https://github.com/OWNER/REPO api.yourdomain.com`
   It generates the MongoDB passwords, prints a deploy key (add it to the repo's *Deploy keys*) and 4 values for
   the repo's *Actions secrets*: `VPS_HOST`, `VPS_USER`, `VPS_APP_DIR`, `VPS_SSH_KEY`.
4. `sudo nano /opt/apps/restaurant-ai/deploy/.env.production` -> set `OPENAI_API_KEY` and `CORS_ALLOWED_ORIGINS`.
5. First deploy: `sudo -H -u deploy bash /opt/apps/restaurant-ai/deploy/deploy.sh`

From then on every push to `main` deploys automatically after CI passes (Actions tab shows it).
Manual redeploy: Actions -> Deploy -> *Run workflow*.

## Day to day (on the VPS)
```bash
sudo -iu deploy
cd /opt/apps/restaurant-ai/deploy
docker compose -f docker-compose.prod.yml ps                # status
docker compose -f docker-compose.prod.yml logs -f api       # logs
docker compose -f docker-compose.prod.yml restart api       # restart
docker compose -f docker-compose.prod.yml run --rm api node dist/scripts/provision.js restaurant ...
bash backup.sh                                              # backup now
```

## Move existing data from Atlas (optional, once)
Atlas -> Network Access: allow the VPS IP temporarily. Then, as `deploy` in `/opt/apps/restaurant-ai/deploy`:
```bash
set -a; . ./.env; set +a
docker compose -f docker-compose.prod.yml exec -T mongo mongodump --uri 'ATLAS_URI' --db restaurant_ai --archive \
 | docker compose -f docker-compose.prod.yml exec -T mongo mongorestore --archive --drop \
     -u root -p "$MONGO_ROOT_PASSWORD" --authenticationDatabase admin
```
Then restart the API and delete the Atlas cluster when you are happy.

## Another project on the same server
Run `server-setup.sh` again with a new app name and port, e.g.
`sudo bash server-setup.sh https://github.com/OWNER/OTHER api2.yourdomain.com other-app 3001`
Each project gets its own folder in `/opt/apps`, its own port on 127.0.0.1, its own `/etc/caddy/sites/<app>.caddy`
(and, if it uses this compose layout, its own MongoDB container and volume).
