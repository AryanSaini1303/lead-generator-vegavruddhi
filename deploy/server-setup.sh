#!/usr/bin/env bash
# One-time setup on a fresh Ubuntu 24.04 EC2 instance. Run as a normal sudo user:
#   bash deploy/server-setup.sh
set -euo pipefail

sudo apt-get update
sudo apt-get install -y nginx certbot python3-certbot-nginx rsync curl

# Node 22
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

# pm2
command -v pm2 >/dev/null || sudo npm install -g pm2

node -v
pm2 -v
nginx -v
echo "Setup done. Next: copy the project + .env + service-account.json, run 'npm ci --omit=dev', then 'pm2 start ecosystem.config.js'."
