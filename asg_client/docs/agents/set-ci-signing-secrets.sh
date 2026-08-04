#!/usr/bin/env bash
#
# Create GitHub Actions secrets for CI release signing/upload, reading values
# from your local credential files. RUN THIS YOURSELF — keys never leave your
# terminal. It does NOT modify or delete any credential file.
#
# Prereqs: `gh auth status` is logged in with repo admin on Mentra-Community/MentraOS.
# Run from a machine that has ~/.mentra/credentials (e.g. bob, or your laptop if
# you have the folder). Passwords are pulled from ~/.gradle/gradle.properties if
# present, else you'll be prompted.
#
# Usage:
#   bash set-ci-signing-secrets.sh            # create all
#   DRY_RUN=1 bash set-ci-signing-secrets.sh  # print what it would do, set nothing
#
set -euo pipefail

REPO="Mentra-Community/MentraOS"
CRED="$HOME/.mentra/credentials"
GP="$HOME/.gradle/gradle.properties"
DRY_RUN="${DRY_RUN:-0}"

die() { echo "ERROR: $*" >&2; exit 1; }

command -v gh >/dev/null || die "gh CLI not found"
gh auth status >/dev/null 2>&1 || die "gh not authenticated (run: gh auth login)"
[ -d "$CRED" ] || die "missing $CRED — run this on a machine that has the credentials folder"

# Pull a property value from gradle.properties (KEY=VALUE), trimming whitespace.
prop() {
  local key="$1"
  [ -f "$GP" ] || { echo ""; return; }
  awk -F= -v k="$key" '$1==k {sub(/^[^=]*=/,""); gsub(/^[ \t]+|[ \t]+$/,""); print; exit}' "$GP"
}

# Set a secret from a gradle.properties key. If the prop is missing, optionally
# fall back to a default; if still empty, prompt (unless OPTIONAL=1 -> skip).
# Reads via prop() and pipes straight to gh with printf '%s' (never echo, never
# nested subshells / indirect expansion — those mangled values containing '!').
set_prop_secret() {
  local name="$1" key="$2" default="${3:-}" optional="${4:-0}"
  local val; val="$(prop "$key")"
  [ -n "$val" ] || val="$default"
  if [ -z "$val" ]; then
    if [ "$optional" = "1" ]; then echo "  SKIP $name (no $key in $GP)"; return; fi
    read -rsp "Enter $name: " val; echo
  fi
  [ -n "$val" ] || die "$name is required"
  set_secret "$name" "$val"
}

set_secret() {
  local name="$1" value="$2"
  if [ -z "$value" ]; then echo "  SKIP $name (empty)"; return; fi
  if [ "$DRY_RUN" = "1" ]; then echo "  [dry-run] would set $name (${#value} bytes)"; return; fi
  # NOTE: `gh secret set --body -` sets the literal value "-" (it does NOT mean
  # "read stdin"). gh reads stdin only when --body is omitted entirely. So pipe
  # the value and DON'T pass --body. (This bug set every secret to "-".)
  printf '%s' "$value" | gh secret set "$name" --repo "$REPO" >/dev/null
  echo "  set $name"
}

set_secret_b64() {
  local name="$1" file="$2"
  [ -f "$file" ] || { echo "  SKIP $name (missing $file)"; return; }
  set_secret "$name" "$(base64 -i "$file")"
}

echo "Repo: $REPO"
echo "Creds: $CRED"
echo "Gradle props: $GP $([ -f "$GP" ] || echo '(not found — will prompt)')"
echo

echo "== Keystores (base64) =="
set_secret_b64 ASG_KEYSTORE_B64    "$CRED/asg-keystore.jks"
set_secret_b64 UPLOAD_KEYSTORE_B64 "$CRED/upload-keystore.jks"
set_secret_b64 OTA_KEYSTORE_B64    "$CRED/ota-keystore.jks"

echo "== ASG signing passwords =="
set_prop_secret ASG_STORE_PASSWORD ASG_STORE_PASSWORD
set_prop_secret ASG_KEY_PASSWORD   ASG_KEY_PASSWORD
set_prop_secret ASG_KEY_ALIAS      ASG_KEY_ALIAS asg

echo "== Mobile (upload) signing passwords =="
set_prop_secret MENTRAOS_UPLOAD_STORE_PASSWORD MENTRAOS_UPLOAD_STORE_PASSWORD
set_prop_secret MENTRAOS_UPLOAD_KEY_PASSWORD   MENTRAOS_UPLOAD_KEY_PASSWORD
set_prop_secret MENTRAOS_UPLOAD_KEY_ALIAS      MENTRAOS_UPLOAD_KEY_ALIAS upload

echo "== OTA signing passwords (optional — skip if unused in CI) =="
set_prop_secret OTA_STORE_PASSWORD OTA_STORE_PASSWORD "" 1
set_prop_secret OTA_KEY_PASSWORD   OTA_KEY_PASSWORD   "" 1
set_prop_secret OTA_KEY_ALIAS      OTA_KEY_ALIAS      ota

echo "== Google Play service account (JSON contents) =="
if [ -f "$CRED/google-play-key.json" ]; then
  set_secret GOOGLE_PLAY_KEY_JSON "$(cat "$CRED/google-play-key.json")"
else
  echo "  SKIP GOOGLE_PLAY_KEY_JSON (missing)"
fi

echo "== App Store Connect API (iOS) =="
set_secret_b64 ASC_API_KEY_P8_B64 "$CRED/AuthKey_VKL3ALRUBR.p8"
# ASC_API_KEY_ID / ASC_API_ISSUER_ID live in appstore-connect.env (KEY=VALUE).
ASC_ENV="$CRED/appstore-connect.env"
asc_val() { [ -f "$ASC_ENV" ] && awk -F= -v k="$1" '$1==k{sub(/^[^=]*=/,"");gsub(/^[ \t]+|[ \t]+$/,"");print;exit}' "$ASC_ENV" || true; }
set_asc_secret() {
  local name="$1" key="$2" val; val="$(asc_val "$key")"
  if [ -z "$val" ]; then read -rp "Enter $name: " val; fi
  [ -n "$val" ] || die "$name is required"
  set_secret "$name" "$val"
}
set_asc_secret ASC_API_KEY_ID    ASC_API_KEY_ID
set_asc_secret ASC_API_ISSUER_ID ASC_API_ISSUER_ID

echo
echo "Done. Verify with: gh secret list --repo $REPO | grep -E 'KEYSTORE|ASG_|MENTRAOS_UPLOAD|OTA_|GOOGLE_PLAY|ASC_'"
