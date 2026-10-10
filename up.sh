#!/data/data/com.termux/files/usr/bin/bash
# One command to update everything: newest evo-update*.zip -> GitHub -> Cloudflare
set -e
cd ~/evo-company
Z=$(ls -t ~/storage/downloads/evo-update*.zip 2>/dev/null | head -1)
[ -z "$Z" ] && { echo "no evo-update zip in Downloads"; exit 1; }
echo "using: $Z"
(unzip -oq "$Z" -d . 2>/dev/null) || python -m zipfile -e "$Z" .
. ./.secrets
git add -A
git commit -qm "update" || true
git push -q "https://x-access-token:${GH_TOKEN}@github.com/${FACTORY_REPO}.git" HEAD:main
node deploy.mjs
echo "ALL DONE"
