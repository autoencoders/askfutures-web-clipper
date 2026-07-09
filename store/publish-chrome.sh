#!/usr/bin/env bash
# Publish askfutures-clipper.zip to the Chrome Web Store.
#
# Credentials come from the environment; in CI they are injected by `doppler run`
# (see .github/workflows/release.yml), and locally you can publish by hand with
#   npm run package && doppler run -- bash store/publish-chrome.sh
# after `doppler setup` points the CLI at the config that holds these:
#   CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN, CWS_EXTENSION_ID
set -euo pipefail

ACCESS_TOKEN=$(curl -sf -X POST https://oauth2.googleapis.com/token \
  -d client_id="$CWS_CLIENT_ID" \
  -d client_secret="$CWS_CLIENT_SECRET" \
  -d refresh_token="$CWS_REFRESH_TOKEN" \
  -d grant_type=refresh_token | jq -re .access_token)

UPLOAD=$(curl -sf -X PUT \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "x-goog-api-version: 2" \
  -T askfutures-clipper.zip \
  "https://www.googleapis.com/upload/chromewebstore/v1.1/items/$CWS_EXTENSION_ID")
echo "$UPLOAD"
echo "$UPLOAD" | jq -re 'select(.uploadState == "SUCCESS")' > /dev/null

PUBLISH=$(curl -sf -X POST \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "x-goog-api-version: 2" \
  -H "Content-Length: 0" \
  "https://www.googleapis.com/chromewebstore/v1.1/items/$CWS_EXTENSION_ID/publish")
echo "$PUBLISH"
echo "$PUBLISH" | jq -re '.status | index("OK")' > /dev/null
