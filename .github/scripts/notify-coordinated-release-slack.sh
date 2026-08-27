#!/usr/bin/env bash
set -euo pipefail

case "${BRANCH:-}" in
  dev)
    webhook_url="${DEV_SLACK_WEBHOOK_URL:-}"
    channel_label="Dev"
    webhook_secret="SLACK_WEBHOOK_DEV_BUILDS"
    ;;
  staging)
    webhook_url="${STAGING_SLACK_WEBHOOK_URL:-}"
    channel_label="Staging"
    webhook_secret="SLACK_WEBHOOK_NIGHTLY_BUILDS"
    ;;
  *)
    echo "::warning::No release Slack channel is configured for branch ${BRANCH:-<unknown>}."
    exit 0
    ;;
esac

if [[ -z "$webhook_url" ]]; then
  echo "::warning::$webhook_secret is not set; skipping the $channel_label release notification."
  exit 0
fi

run_url="https://github.com/${REPOSITORY}/actions/runs/${RUN_ID}"
commit_url="https://github.com/${REPOSITORY}/commit/${SHA}"
commit_short="${SHA:0:7}"
commit_subject="${COMMIT_MESSAGE:-Commit metadata unavailable}"
commit_subject="${commit_subject%%$'\n'*}"
commit_author="${COMMIT_AUTHOR:-unknown}"
release_identity="${RELEASE_IDENTITY:-unknown}"
release_url="https://github.com/${REPOSITORY}/releases/tag/mentra-v${release_identity}"
if [[ "$release_identity" == "unknown" ]]; then
  release_text="*Release:* identity allocation failed"
else
  release_text="*Release:* <${release_url}|${release_identity}>"
fi

icon() {
  case "$1" in
    success) echo ":white_check_mark:" ;;
    failure) echo ":x:" ;;
    cancelled) echo ":no_entry:" ;;
    skipped) echo ":fast_forward:" ;;
    *) echo ":grey_question:" ;;
  esac
}

label() {
  case "$1" in
    success) echo "passed" ;;
    failure) echo "failed" ;;
    cancelled) echo "cancelled" ;;
    skipped) echo "skipped" ;;
    *) echo "unknown" ;;
  esac
}

artifact_link() {
  local url="$1"
  local name="$2"
  if [[ -n "$url" && -n "$name" ]] && curl --fail --silent --head --location --retry 2 "$url" >/dev/null; then
    printf '<%s|%s>' "$url" "$name"
  else
    printf '<%s|View run logs>' "$run_url"
  fi
}

# If the reusable mobile workflow failed before exporting platform conclusions,
# retain the useful combined conclusion instead of displaying "unknown".
android_result="${ANDROID_RESULT:-${MOBILE_RESULT:-unknown}}"
ios_result="${IOS_RESULT:-${MOBILE_RESULT:-unknown}}"

apk_url=""
ipa_url=""
if [[ -n "${MOBILE_ASSET_BASE_URL:-}" ]]; then
  [[ -z "${APK_NAME:-}" ]] || apk_url="${MOBILE_ASSET_BASE_URL}/${APK_NAME}"
  [[ -z "${IPA_NAME:-}" ]] || ipa_url="${MOBILE_ASSET_BASE_URL}/${IPA_NAME}"
fi

android_detail=$(artifact_link "$apk_url" "${APK_NAME:-Android APK}")
ios_detail=$(artifact_link "$ipa_url" "${IPA_NAME:-iOS IPA}")
asg_detail=$(artifact_link "${ASG_APK_URL:-}" "${ASG_APK_NAME:-ASG APK}")
starter_detail=$(artifact_link "${STARTER_KIT_APK_URL:-}" "${STARTER_KIT_APK_NAME:-React Native example APK}")
if [[ -n "${STARTER_KIT_RELEASE_URL:-}" ]]; then
  starter_detail+=" - <${STARTER_KIT_RELEASE_URL}|All example builds>"
fi
docs_detail="<${run_url}|View run logs>"
if [[ -n "${DOCS_URL:-}" ]]; then
  docs_detail="<${DOCS_URL}|Open docs>"
fi

if [[ "${FINALIZE_RESULT:-}" == "success" && "${DOCS_RESULT:-}" == "success" ]]; then
  header_icon=":white_check_mark:"
  header_text="$channel_label release complete"
elif [[ "$android_result" == "success" || "$ios_result" == "success" || "${OTA_RESULT:-}" == "success" ]]; then
  header_icon=":warning:"
  header_text="$channel_label release incomplete"
else
  header_icon=":x:"
  header_text="$channel_label release failed"
fi

newline=$'\n'
android_line="*$(icon "$android_result") Android* - $(label "$android_result") - ${android_detail}${newline}Google Play: ${PLAY_TRACK:-unknown}"
ios_line="*$(icon "$ios_result") iOS* - $(label "$ios_result") - ${ios_detail}${newline}TestFlight: ${TESTFLIGHT_GROUP:-unknown}"
asg_line="*$(icon "${OTA_RESULT:-unknown}") ASG + OTA* - $(label "${OTA_RESULT:-unknown}") - ${asg_detail}"
starter_line="*$(icon "${STARTER_KIT_RESULT:-unknown}") Starter Kit* - $(label "${STARTER_KIT_RESULT:-unknown}") - ${starter_detail}"
docs_line="*$(icon "${DOCS_RESULT:-unknown}") Docs* - $(label "${DOCS_RESULT:-unknown}") - ${docs_detail}"
checks_line="*Release checks*${newline}Plan: $(icon "${PLAN_RESULT:-unknown}") $(label "${PLAN_RESULT:-unknown}") | Packages: $(icon "${NPM_RESULT:-unknown}") $(label "${NPM_RESULT:-unknown}") | Native SDK: $(icon "${SDK_NATIVE_RESULT:-unknown}") $(label "${SDK_NATIVE_RESULT:-unknown}") | Engine consumer: $(icon "${ENGINE_RESULT:-unknown}") $(label "${ENGINE_RESULT:-unknown}") | Examples: $(icon "${STARTER_KIT_RESULT:-unknown}") $(label "${STARTER_KIT_RESULT:-unknown}") | Finalize: $(icon "${FINALIZE_RESULT:-unknown}") $(label "${FINALIZE_RESULT:-unknown}")"

payload=$(jq -n \
  --arg header "$header_icon $header_text" \
  --arg commit "$commit_subject" \
  --arg release "$release_text" \
  --arg android "$android_line" \
  --arg ios "$ios_line" \
  --arg asg "$asg_line" \
  --arg starter "$starter_line" \
  --arg docs "$docs_line" \
  --arg checks "$checks_line" \
  --arg context "Commit <${commit_url}|\`${commit_short}\`> by ${commit_author} - <${run_url}|View workflow>" \
  '{
    blocks: [
      {type: "header", text: {type: "plain_text", text: $header, emoji: true}},
      {type: "section", text: {type: "mrkdwn", text: $commit}},
      {type: "section", text: {type: "mrkdwn", text: $release}},
      {type: "divider"},
      {type: "section", text: {type: "mrkdwn", text: $android}},
      {type: "section", text: {type: "mrkdwn", text: $ios}},
      {type: "section", text: {type: "mrkdwn", text: $asg}},
      {type: "section", text: {type: "mrkdwn", text: $starter}},
      {type: "section", text: {type: "mrkdwn", text: $docs}},
      {type: "section", text: {type: "mrkdwn", text: $checks}},
      {type: "context", elements: [{type: "mrkdwn", text: $context}]}
    ]
  }')

if [[ "${SLACK_NOTIFY_DRY_RUN:-}" == "true" ]]; then
  printf '%s\n' "$payload"
  exit 0
fi

curl --fail --silent --show-error --retry 3 \
  --header "Content-Type: application/json" \
  --data "$payload" \
  "$webhook_url"
echo
