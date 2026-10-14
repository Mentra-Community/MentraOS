#!/usr/bin/env bash
# Explicit attended commissioning. Does not click OS dialogs or open Settings.
set -euo pipefail
if [[ $# -ne 4 ]]; then
  echo "Usage: $0 REQUEST_ID READBACK_ID camera,microphone,location,bluetooth TIMEOUT_MS" >&2
  exit 2
fi
permission_url="$(node -e 'const [requestId,readbackId,features,timeoutMs]=process.argv.slice(1); const u=new URL("com.mentra://test/request-permissions"); for(const [k,v]of Object.entries({request_id:requestId,readback_id:readbackId,features,timeout_ms:timeoutMs}))u.searchParams.set(k,v); process.stdout.write(u.href)' "$1" "$2" "$3" "$4")"
open "$permission_url"
