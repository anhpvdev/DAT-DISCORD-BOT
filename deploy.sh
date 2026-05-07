#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$APP_DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is not installed. Install it first."
  exit 1
fi

if [ ! -f ".env" ]; then
  echo "Missing .env file. Create it from .env.example before deploying."
  exit 1
fi

echo "Building and starting dailybot container..."
docker compose up -d --build

echo ""
echo "Deploy completed. Container status:"
docker compose ps

echo ""
echo "Logs (Ctrl+C to exit):"
docker compose logs -f --tail=20
