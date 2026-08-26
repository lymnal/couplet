#!/usr/bin/env bash
# Bump the asset version in every place it must match, then deploy.
# The version lives in three files; drifting them means the service worker
# caches one build while the page asks for another.
#   ./bump.sh          -> bump to next version
#   ./bump.sh 21       -> set an explicit version
set -euo pipefail
cd "$(dirname "$0")"

cur=$(grep -o 'style.css?v=[0-9]*' index.html | head -1 | grep -o '[0-9]*$')
next="${1:-$((cur + 1))}"

sed -i '' "s/?v=${cur}/?v=${next}/g" index.html app.js
sed -i '' "s/^const ASSET_V = \"[0-9]*\";/const ASSET_V = \"${next}\";/" sw.js
sed -i '' "s/^const ASSET_VERSION = \"[0-9]*\";/const ASSET_VERSION = \"${next}\";/" app.js

echo "bumped v${cur} -> v${next}"
grep -o 'style.css?v=[0-9]*' index.html | head -1
grep '^const ASSET_V = ' sw.js
grep '^const ASSET_VERSION = ' app.js

node --check app.js && node --check sw.js && echo "syntax ok"
