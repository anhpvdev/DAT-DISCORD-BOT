#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="dailybot"

cd "$APP_DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is not installed. Install it first."
  exit 1
fi

# Cần Docker Compose v2 (`docker compose`): v1 (`docker-compose`) không bỏ dấu nháy trong .env,
# làm sai các giá trị như SPRINT_KEYWORDS="[WG] Sprint*#*".
if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 is not installed (the 'docker compose' command). Install the docker-compose-plugin package."
  exit 1
fi

if [ ! -f ".env" ]; then
  echo "Missing .env file. Create it from .env.example before deploying."
  exit 1
fi

echo "Building image..."
docker compose build

# Kiểm tra .env bằng image mới trước khi thay container đang chạy,
# để .env sai không làm bot mới crash liên tục (restart: always) trong khi bot cũ đã bị dừng.
echo "Checking .env..."
if ! docker compose run --rm --no-deps "$SERVICE_NAME" node -e "require('./src/config').loadConfig()"; then
  echo ""
  echo "Invalid .env, deploy cancelled. The running bot was not changed."
  exit 1
fi

echo "Starting container..."
docker compose up -d

echo "Removing unused old images..."
docker image prune -f >/dev/null

echo ""
echo "Deploy completed. Container status:"
docker compose ps

# Chỉ theo dõi log khi chạy trong terminal, để CI / ssh không tương tác không bị treo.
# Đặt FOLLOW_LOGS=0 để bỏ qua.
if [ -t 1 ] && [ "${FOLLOW_LOGS:-1}" = "1" ]; then
  echo ""
  echo "Logs (Ctrl+C to exit, the bot keeps running):"
  docker compose logs -f --tail=20
else
  docker compose logs --tail=20
fi
