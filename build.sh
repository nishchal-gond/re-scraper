#!/bin/bash
# Rebuilds content/content-script.bundle.js from content/content-script.js
# and its imports. Run this after editing anything under content/, parser/,
# or utils/ that content-script.js depends on.
#
# WHY THIS EXISTS: Manifest V3 content scripts declared in manifest.json
# are loaded as classic scripts, not ES modules — they can't use `import`.
# The background service worker CAN use `import` natively (type: module is
# set in manifest.json), and popup/options pages can too (they're regular
# extension pages with <script type="module">). Only the content script
# needs this bundling step.
set -e
cd "$(dirname "$0")"
npx esbuild content/content-script.js \
  --bundle \
  --outfile=content/content-script.bundle.js \
  --format=iife \
  --target=chrome100
echo "✓ content-script.bundle.js rebuilt"
