#!/usr/bin/env bash
# One-shot VPS deploy for gutad.io (Ubuntu 22.04/24.04, Debian 12). Run as root or with sudo:
#   curl -fsSL https://raw.githubusercontent.com/<you>/gutad/main/deploy/deploy.sh | bash
# or, from a checkout:  ./deploy/deploy.sh
set -euo pipefail
APP_DIR=${APP_DIR:-/opt/gutad}
REPO_URL=${REPO_URL:-}

if ! command -v docker >/dev/null 2>&1; then
  echo "[deploy] installing docker"
  curl -fsSL https://get.docker.com | sh
fi
if ! docker compose version >/dev/null 2>&1; then
  apt-get update && apt-get install -y docker-compose-plugin
fi

if [ ! -d "$APP_DIR" ]; then
  if [ -n "$REPO_URL" ]; then git clone "$REPO_URL" "$APP_DIR"; else mkdir -p "$APP_DIR"; echo "[deploy] copy the project into $APP_DIR (or set REPO_URL) then re-run"; exit 1; fi
fi
cd "$APP_DIR"

if [ ! -f .env ]; then
  cp .env.example .env
  sed -i "s/^JWT_SECRET=.*/JWT_SECRET=$(openssl rand -hex 32)/" .env
  sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 16)/" .env
  sed -i "s/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=$(openssl rand -base64 12 | tr -d '/+=')/" .env
  PW=$(grep ^POSTGRES_PASSWORD= .env | cut -d= -f2)
  sed -i "s#^DATABASE_URL=.*#DATABASE_URL=postgresql://gutad:${PW}@postgres:5432/gutad#" .env
  echo "[deploy] generated .env — review DOMAIN/API_DOMAIN/ACME_EMAIL, then re-run. Admin password:"; grep ^ADMIN_PASSWORD= .env
  exit 0
fi

# firewall (optional, ufw present on Ubuntu)
if command -v ufw >/dev/null 2>&1; then ufw allow 22/tcp >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw allow 443/udp >/dev/null; ufw --force enable >/dev/null || true; fi

mkdir -p deploy/backups
echo "[deploy] building and starting"
docker compose -f docker-compose.prod.yml --env-file .env up -d --build --remove-orphans
docker image prune -f >/dev/null
echo "[deploy] waiting for API health"
for i in $(seq 1 30); do
  if docker compose -f docker-compose.prod.yml exec -T api curl -fsS http://localhost:4000/health >/dev/null 2>&1; then echo "[deploy] healthy"; break; fi
  sleep 5
done
docker compose -f docker-compose.prod.yml ps
echo "[deploy] done → https://$(grep ^DOMAIN= .env | cut -d= -f2)  (API docs: https://$(grep ^API_DOMAIN= .env | cut -d= -f2)/docs)"
