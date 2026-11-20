#!/usr/bin/env bash
# One-time VPS setup for this project (safe to re-run). Ubuntu 22.04 / 24.04, run as root:
#
#   bash server-setup.sh <github-repo-url> <api-domain> [app-name] [port]
#   e.g. bash server-setup.sh https://github.com/Gesille/Restaurant-Ai-Chat-Bot api.example.com
#
# What it does: installs Docker + Caddy (shared HTTPS reverse proxy for every project on the server),
# firewall, a "deploy" user, SSH keys for GitHub, clones the repo to /opt/apps/<app-name>,
# generates MongoDB passwords (MongoDB runs in Docker on this server), daily DB backups,
# and prints exactly what to paste into GitHub. Re-run it for another project with a new name/port.
set -euo pipefail

die() { echo "ERROR: $*" >&2; exit 1; }
step() { echo; echo "==== $* ===="; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo bash $0 ...)"
[ $# -ge 2 ] || die "usage: bash $0 <github-repo-url> <api-domain> [app-name] [port]"

REPO_URL="$1"; DOMAIN="$2"; APP="${3:-restaurant-ai}"; PORT="${4:-3000}"
DEPLOY_USER=deploy
APPS_DIR=/opt/apps
APP_DIR="$APPS_DIR/$APP"

# owner/repo from https://github.com/o/r(.git) or git@github.com:o/r.git
REPO_PATH="$(echo "$REPO_URL" | sed -E 's#^(https://github.com/|git@github.com:)##; s#\.git$##; s#/$##')"
[[ "$REPO_PATH" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "could not read owner/repo from: $REPO_URL"
[[ "$APP" =~ ^[a-z0-9-]+$ ]] || die "app-name must be lowercase letters, digits or -"
[[ "$PORT" =~ ^[0-9]+$ ]] || die "port must be a number"

step "System packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get -yq upgrade
apt-get -yq install git curl openssl cron ufw ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https

step "Swap (Docker builds need memory on small VPS plans)"
if [ "$(swapon --show | wc -l)" -eq 0 ] && [ "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" -lt 3000000 ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "2G swap added"
else
  echo "swap present or enough RAM, skipping"
fi

step "Docker"
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
systemctl enable --now docker

step "Caddy (HTTPS reverse proxy shared by all projects)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q && apt-get -yq install caddy
fi
mkdir -p /etc/caddy/sites
if ! grep -q 'import /etc/caddy/sites/\*.caddy' /etc/caddy/Caddyfile 2>/dev/null; then
  [ -f /etc/caddy/Caddyfile ] && cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak.$(date +%s)"
  printf '# One file per site in /etc/caddy/sites/ (managed by server-setup.sh)\nimport /etc/caddy/sites/*.caddy\n' > /etc/caddy/Caddyfile
fi
cat > "/etc/caddy/sites/$APP.caddy" <<EOF
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:$PORT
}
EOF
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl enable caddy >/dev/null
systemctl reload caddy || systemctl restart caddy

step "Firewall"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 2224/tcp >/dev/null   # GoDaddy Nydus agent (backups, password reset, panel access)
ufw --force enable

step "Deploy user"
id "$DEPLOY_USER" >/dev/null 2>&1 || adduser --disabled-password --gecos "" "$DEPLOY_USER"
usermod -aG docker "$DEPLOY_USER"
DHOME="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$DHOME/.ssh"
touch "$DHOME/.ssh/authorized_keys" "$DHOME/.ssh/config"
# Let whoever can log in as root also log in as deploy.
if [ -f /root/.ssh/authorized_keys ]; then
  while IFS= read -r k; do
    [ -n "$k" ] && ! grep -qxF "$k" "$DHOME/.ssh/authorized_keys" && echo "$k" >> "$DHOME/.ssh/authorized_keys"
  done < /root/.ssh/authorized_keys
fi

step "SSH keys"
# (1) Read-only deploy key for THIS repo (GitHub allows one repo per deploy key).
[ -f "$DHOME/.ssh/deploy_$APP" ] || ssh-keygen -q -t ed25519 -N "" -C "vps-deploy-$APP" -f "$DHOME/.ssh/deploy_$APP"
if ! grep -q "^Host github-$APP\$" "$DHOME/.ssh/config"; then
  printf '\nHost github-%s\n  HostName github.com\n  User git\n  IdentityFile ~/.ssh/deploy_%s\n  IdentitiesOnly yes\n' "$APP" "$APP" >> "$DHOME/.ssh/config"
fi
# (2) Key GitHub Actions uses to SSH into this server (one per server, reused by every repo).
if [ ! -f "$DHOME/.ssh/gh_actions" ]; then
  ssh-keygen -q -t ed25519 -N "" -C "github-actions" -f "$DHOME/.ssh/gh_actions"
fi
grep -qxF "$(cat "$DHOME/.ssh/gh_actions.pub")" "$DHOME/.ssh/authorized_keys" || cat "$DHOME/.ssh/gh_actions.pub" >> "$DHOME/.ssh/authorized_keys"
ssh-keyscan -t ed25519,rsa github.com 2>/dev/null >> "$DHOME/.ssh/known_hosts"
sort -u -o "$DHOME/.ssh/known_hosts" "$DHOME/.ssh/known_hosts"
chown -R "$DEPLOY_USER:$DEPLOY_USER" "$DHOME/.ssh"
chmod 600 "$DHOME/.ssh/"* ; chmod 644 "$DHOME/.ssh/"*.pub

install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APPS_DIR"

step "Add the deploy key to GitHub"
echo "Open:  https://github.com/$REPO_PATH/settings/keys/new"
echo "Title: vps-$APP     (leave 'Allow write access' UNCHECKED)"
echo "Key:"
echo
cat "$DHOME/.ssh/deploy_$APP.pub"
echo
github_ok() {
  local out
  out="$(sudo -H -u "$DEPLOY_USER" ssh -o BatchMode=yes -T "git@github-$APP" 2>&1 || true)"
  [[ "$out" == *"successfully authenticated"* ]]
}
until github_ok; do
  read -rp "Press Enter after you saved the key on GitHub... "
done
echo "GitHub access OK"

step "Clone"
if [ -d "$APP_DIR/.git" ]; then
  sudo -H -u "$DEPLOY_USER" git -C "$APP_DIR" fetch --prune origin
else
  sudo -H -u "$DEPLOY_USER" git clone "git@github-$APP:$REPO_PATH.git" "$APP_DIR"
fi
cd "$APP_DIR/deploy"
# deploy/.env: domain, port and random MongoDB passwords (hex only: safe in URIs and compose files)
if [ ! -f .env ]; then
  {
    echo "API_DOMAIN=$DOMAIN"
    echo "API_PORT=$PORT"
    echo "MONGO_ROOT_PASSWORD=$(openssl rand -hex 24)"
    echo "MONGO_APP_DB=restaurant_ai"
    echo "MONGO_APP_USER=restaurant_app"
    echo "MONGO_APP_PASSWORD=$(openssl rand -hex 24)"
  } > .env
fi
# deploy/.env.production: app settings; the Mongo URI is filled in automatically, you add the OpenAI key etc.
if [ ! -f .env.production ]; then
  APP_PW="$(grep '^MONGO_APP_PASSWORD=' .env | cut -d= -f2)"
  sed "s#restaurant_app:CHANGE_ME@#restaurant_app:${APP_PW}@#" .env.production.example > .env.production
fi
chown "$DEPLOY_USER:$DEPLOY_USER" .env .env.production
chmod 600 .env .env.production

step "Daily database backup (03:15, keeps 14 days in /opt/backups/$APP)"
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/opt/backups/$APP"
CRON_LINE="15 3 * * * BACKUP_DIR=/opt/backups/$APP bash $APP_DIR/deploy/backup.sh >> /opt/backups/$APP/backup.log 2>&1"
( crontab -u "$DEPLOY_USER" -l 2>/dev/null | grep -vF "$APP_DIR/deploy/backup.sh" || true; echo "$CRON_LINE" ) | crontab -u "$DEPLOY_USER" -

PUBLIC_IP="$(curl -fsS4 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"

step "DONE - now in GitHub: https://github.com/$REPO_PATH/settings/secrets/actions"
cat <<EOF
Add these 4 repository secrets ("New repository secret"):

  VPS_HOST      $PUBLIC_IP
  VPS_USER      $DEPLOY_USER
  VPS_APP_DIR   $APP_DIR
  VPS_SSH_KEY   (everything below, including the BEGIN/END lines - keep it private)

EOF
cat "$DHOME/.ssh/gh_actions"
cat <<EOF

Next:
  1. GoDaddy DNS   -> A record for $DOMAIN -> $PUBLIC_IP
  2. Add your OpenAI key (MongoDB is already configured, runs on this server):
       nano $APP_DIR/deploy/.env.production      -> OPENAI_API_KEY=sk-...  and CORS_ALLOWED_ORIGINS
  3. First deploy:            sudo -H -u $DEPLOY_USER bash $APP_DIR/deploy/deploy.sh
After that, every push to main deploys automatically once CI passes.
EOF
