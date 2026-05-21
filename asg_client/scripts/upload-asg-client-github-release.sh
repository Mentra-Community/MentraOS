#!/usr/bin/env bash
#
# Upload the release APK to the GitHub release tagged "asg-client" as a fixed
# asset name. If asg-client-38-test.apk already exists on that release, it is
# deleted and re-uploaded.
#
# Uses the GitHub REST API (not "gh release upload") so the transfer can show
# percentage 0-100. Requires Python 3 and: gh auth login
#
# Usage: from repo root or anywhere:
#   ./asg_client/scripts/upload-asg-client-github-release.sh
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ASG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$ASG_DIR/.." && pwd)"

TAG="asg-client"
ASSET_NAME="asg-client-38-test.apk"
APK_PATH="$ASG_DIR/app/build/outputs/apk/release/app-release.apk"

cd "$REPO_ROOT"

if ! command -v python3 &>/dev/null; then
  echo "error: python3 is required" >&2
  exit 1
fi

if [[ ! -f "$APK_PATH" ]]; then
  echo "error: APK not found at $APK_PATH" >&2
  echo "Build first: (cd asg_client && ./gradlew assembleRelease)" >&2
  exit 1
fi

if ! gh auth status &>/dev/null; then
  echo "error: gh is not authenticated. Run: gh auth login" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cp "$APK_PATH" "$WORK/$ASSET_NAME"

REPO_SLUG="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
export GITHUB_TOKEN
GITHUB_TOKEN="$(gh auth token)"
export GITHUB_TOKEN
export UPLOAD_TAG="$TAG"
export UPLOAD_ASSET_NAME="$ASSET_NAME"
export UPLOAD_FILE_PATH="$WORK/$ASSET_NAME"
export UPLOAD_REPO_SLUG="$REPO_SLUG"

size_human="$(du -h "$WORK/$ASSET_NAME" | awk '{print $1}')"
echo "Uploading ${ASSET_NAME} (${size_human}) to release ${TAG}..."

start_time="$(date +%s)"
python3 - <<'PY'
import http.client
import json
import os
import ssl
import sys
import urllib.parse

# Percentage 0-100 on one line (\\r); requires Python 3.6+

def _api_headers(token: str) -> dict:
  return {
    "Authorization": f"Bearer {token}",
    "Accept": "application/vnd.github+json",
    "User-Agent": "Mentra-ASG-upload-asg-client-github-release.sh",
    "X-GitHub-Api-Version": "2022-11-28",
  }


def _delete_asset(token: str, owner: str, name: str, asset_id: int) -> None:
  ctx = ssl.create_default_context()
  c = http.client.HTTPSConnection("api.github.com", 443, context=ctx, timeout=120)
  p = f"/repos/{urllib.parse.quote(owner)}/{urllib.parse.quote(name)}/releases/assets/{asset_id}"
  c.request("DELETE", p, headers=_api_headers(token), body=None)
  r = c.getresponse()
  r.read()  # drain
  c.close()
  if r.status not in (204, 200, 404):
    print(f"error: delete asset: HTTP {r.status}", file=sys.stderr)
    sys.exit(1)


def _upload(
  upload_url: str, token: str, fpath: str, name: str
) -> None:
  if "{?name,label}" in upload_url:
    u = upload_url.replace("{?name,label}", f"?name={urllib.parse.quote(name)}", 1)
  else:
    print("error: unexpected upload_url format from API", file=sys.stderr)
    sys.exit(1)

  parsed = urllib.parse.urlparse(u)
  if not parsed.netloc or parsed.scheme not in ("https", "http"):
    print("error: could not parse upload_url", file=sys.stderr)
    sys.exit(1)

  pathq = parsed.path
  if parsed.query:
    pathq += "?" + parsed.query

  size = os.path.getsize(fpath)
  ctx = ssl.create_default_context()
  conn = http.client.HTTPSConnection(
    parsed.netloc, 443, context=ctx, timeout=600
  )
  h = {
    "Authorization": f"Bearer {token}",
    "Content-Type": "application/octet-stream",
    "Accept": "application/vnd.github+json",
    "User-Agent": "Mentra-ASG-upload-asg-client-github-release.sh",
    "Content-Length": str(size),
  }
  r = None
  resp_body = b""
  try:
    conn.putrequest("POST", pathq)
    for k, v in h.items():
      conn.putheader(k, v)
    conn.endheaders()

    if size == 0:
      print("100%")
    else:
      print(f"\r0%", end="", flush=True)
      done = 0
      last_pct = 0
      with open(fpath, "rb") as f:
        while True:
          block = f.read(256 * 1024)
          if not block:
            break
          conn.send(block)
          done += len(block)
          pct = min(100, (100 * done + size - 1) // size)
          if pct != last_pct:
            last_pct = pct
            print(f"\r{pct}%", end="", flush=True)
        if last_pct < 100:
          print(f"\r100%", end="", flush=True)
    print()  # newline after progress
    r = conn.getresponse()
    resp_body = r.read()
  finally:
    conn.close()

  if r is None or r.status not in (201, 200):
    st = r.status if r is not None else "?"
    t = resp_body.decode("utf-8", errors="replace") if resp_body else ""
    print(f"error: upload: HTTP {st}\n{t}", file=sys.stderr)
    sys.exit(1)


token = os.environ["GITHUB_TOKEN"]
repo_slug = os.environ["UPLOAD_REPO_SLUG"]
tag = os.environ["UPLOAD_TAG"]
asset_name = os.environ["UPLOAD_ASSET_NAME"]
fpath = os.environ["UPLOAD_FILE_PATH"]
owner, _slash, reponame = repo_slug.partition("/")
if not reponame:
  print("error: UPLOAD_REPO_SLUG must be owner/repo", file=sys.stderr)
  sys.exit(1)
headers = _api_headers(token)

ctx = ssl.create_default_context()
api = http.client.HTTPSConnection("api.github.com", 443, context=ctx, timeout=120)
api.request(
  "GET",
  f"/repos/{urllib.parse.quote(owner)}/{urllib.parse.quote(reponame)}/releases/tags/{urllib.parse.quote(tag)}",
  headers=headers,
  body=None,
)
r = api.getresponse()
data = r.read()
if r.status != 200:
  print(
    f"error: GET release (HTTP {r.status}): {data.decode('utf-8', errors='replace')}",
    file=sys.stderr,
  )
  api.close()
  sys.exit(1)
rel = json.loads(data.decode("utf-8"))
api.close()

for a in rel.get("assets") or []:
  if a.get("name") == asset_name and a.get("id") is not None:
    _delete_asset(token, owner, reponame, int(a["id"]))
    break

_upload(rel["upload_url"], token, fpath, asset_name)
PY
end_time="$(date +%s)"
elapsed="$((end_time - start_time))"

echo "Uploaded ${ASSET_NAME} to release ${TAG} (${REPO_SLUG}) in ${elapsed}s"
echo "https://github.com/${REPO_SLUG}/releases/download/${TAG}/${ASSET_NAME}"
