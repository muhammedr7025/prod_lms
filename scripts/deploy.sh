#!/usr/bin/env bash
# Deploy the committed code (git HEAD) to the production server.
#
#   DEPLOY_HOST=root@129.121.168.86 scripts/deploy.sh
#   DEPLOY_SSH="ssh -i ~/.ssh/key" DEPLOY_HOST=root@host scripts/deploy.sh   # custom ssh command
#
# What it does: ships `git archive HEAD` (tracked files only — never .env files or client data),
# installs + builds beside the running copy (app.new), applies database migrations, then swaps
# directories and restarts the three services. The previous copy stays in /srv/exatech/app.prev;
# roll back with:  ssh host 'cd /srv/exatech && mv app app.bad && mv app.prev app && systemctl restart exatech-api exatech-worker exatech-web'
# (a rollback after a migration needs the old code to tolerate the new columns — migrations here only add).
set -euo pipefail

HOST="${DEPLOY_HOST:?set DEPLOY_HOST, e.g. root@129.121.168.86}"
SSH="${DEPLOY_SSH:-ssh}"
PUBLIC_FILES_ORIGIN="${PUBLIC_FILES_ORIGIN:-https://files.learner.exatechlearninghub.com}"
cd "$(git rev-parse --show-toplevel)"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Uncommitted changes — commit first (only committed code is deployed)." >&2
  exit 1
fi
rev=$(git rev-parse --short HEAD)
echo "→ deploying $rev to $HOST"

echo "→ shipping source"
git archive --format=tar HEAD | $SSH "$HOST" 'rm -rf /srv/exatech/app.new && mkdir -p /srv/exatech/app.new && tar -x -C /srv/exatech/app.new && chown -R exatech:exatech /srv/exatech/app.new'

echo "→ installing and building on the server (a few minutes; the live site keeps running)"
$SSH "$HOST" "su -s /bin/bash exatech -c '
set -euo pipefail
cd /srv/exatech/app.new
export CI=true
pnpm install --frozen-lockfile
pnpm --filter @exatech/domain --filter @exatech/contracts --filter @exatech/db build
pnpm --filter @exatech/api build
cd apps/web
export NODE_ENV=production API_URL=http://127.0.0.1:4300 S3_PUBLIC_ORIGIN=$PUBLIC_FILES_ORIGIN NODE_OPTIONS=--max-old-space-size=3072
npx next build >/dev/null
echo build ok
'"

echo "→ database backup + migrations"
$SSH "$HOST" '/usr/local/bin/exatech-backup && set -a && . /srv/exatech/api.env && set +a && cd /srv/exatech/app.new/packages/db && su -s /bin/bash exatech -c "DATABASE_URL=$DATABASE_URL node dist/migrate.js"'

echo "→ swapping in $rev and restarting"
$SSH "$HOST" 'set -e; cd /srv/exatech; rm -rf app.prev; mv app app.prev; mv app.new app
systemctl restart exatech-api exatech-worker exatech-web
for i in $(seq 1 40); do curl -fsS http://127.0.0.1:4300/api/health >/dev/null 2>&1 && curl -fsS -o /dev/null http://127.0.0.1:3300/sign-in && break; sleep 1; done
curl -fsS http://127.0.0.1:4300/api/health && echo && systemctl is-active exatech-api exatech-worker exatech-web'
echo "✓ deployed $rev"
