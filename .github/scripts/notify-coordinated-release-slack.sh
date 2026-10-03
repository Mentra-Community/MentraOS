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

bot_channel="${SLACK_DEV_BUILDS_CHANNEL_ID:-}"
[[ "${BRANCH:-}" != staging ]] || bot_channel="${SLACK_STAGING_BUILDS_CHANNEL_ID:-}"
use_bot=false
if [[ "${RELEASE_SCOPE:-core}" != examples && -n "${SLACK_BUILDS_BOT_TOKEN:-}" && "$bot_channel" =~ ^C[A-Z0-9]+$ ]]; then
  use_bot=true
fi
if [[ -z "$webhook_url" && "$use_bot" != true ]]; then
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
if [[ "${RELEASE_PAGE_RESULT:-}" == "failure" || "${RELEASE_PAGE_RESULT:-}" == "cancelled" ]]; then
  release_url="https://github.com/${REPOSITORY}/releases/tag/mentra-builds-v${release_identity%-*}"
fi
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
  local fallback_url="${3:-$run_url}"
  if [[ -n "$url" && -n "$name" ]] && curl --fail --silent --head --location --retry 2 "$url" >/dev/null; then
    printf '<%s|%s>' "$url" "$name"
  else
    printf '<%s|View run logs>' "$fallback_url"
  fi
}

# If the reusable mobile workflow failed before exporting platform conclusions,
# retain the useful combined conclusion instead of displaying "unknown".
android_result="${ANDROID_RESULT:-${MOBILE_RESULT:-unknown}}"
ios_result="${IOS_RESULT:-${MOBILE_RESULT:-unknown}}"

apk_url="${MOBILE_APK_URL:-}"
ipa_url="${MOBILE_IPA_URL:-}"
if [[ -n "${MOBILE_ASSET_BASE_URL:-}" ]]; then
  [[ -n "$apk_url" || -z "${APK_NAME:-}" ]] || apk_url="${MOBILE_ASSET_BASE_URL}/${APK_NAME}"
  [[ -n "$ipa_url" || -z "${IPA_NAME:-}" ]] || ipa_url="${MOBILE_ASSET_BASE_URL}/${IPA_NAME}"
fi

android_detail=$(artifact_link "$apk_url" "${APK_NAME:-Android APK}")
ios_detail=$(artifact_link "$ipa_url" "${IPA_NAME:-iOS IPA}")
asg_detail=$(artifact_link "${ASG_APK_URL:-}" "${ASG_APK_NAME:-ASG APK}")
starter_detail=$(artifact_link \
  "${STARTER_KIT_APK_URL:-}" \
  "${STARTER_KIT_APK_NAME:-React Native example APK}" \
  "${STARTER_KIT_RUN_URL:-$run_url}")
if [[ -n "${STARTER_KIT_RELEASE_URL:-}" ]]; then
  starter_detail+=" - <${STARTER_KIT_RELEASE_URL}|All example builds>"
fi
example_testflight_detail="${EXAMPLE_TESTFLIGHT_DISTRIBUTION_STATUS:-unknown}"
case "${EXAMPLE_TESTFLIGHT_DISTRIBUTION_STATUS:-}" in
  available) example_testflight_icon=":white_check_mark:" ;;
  submitted) example_testflight_icon=":hourglass_flowing_sand:" ;;
  skipped) example_testflight_icon=":fast_forward:" ;;
  *) example_testflight_icon="$(icon "${EXAMPLE_TESTFLIGHT_RESULT:-unknown}")" ;;
esac
if [[ -n "${EXAMPLE_TESTFLIGHT_MARKETING_VERSION:-}" && -n "${EXAMPLE_TESTFLIGHT_BUILD_NUMBER:-}" ]]; then
  example_testflight_detail+=" - ${EXAMPLE_TESTFLIGHT_MARKETING_VERSION} (${EXAMPLE_TESTFLIGHT_BUILD_NUMBER})"
fi
if [[ -n "${EXAMPLE_TESTFLIGHT_REVIEW_STATE:-}" ]]; then
  example_testflight_detail+=" (${EXAMPLE_TESTFLIGHT_REVIEW_STATE})"
fi
if [[ -n "${EXAMPLE_TESTFLIGHT_INSTALL_URL:-}" ]]; then
  example_testflight_detail+=" - <${EXAMPLE_TESTFLIGHT_INSTALL_URL}|Open TestFlight>"
fi
docs_detail="<${run_url}|View run logs>"
example_play_detail="$(label "${EXAMPLE_GOOGLE_PLAY_RESULT:-unknown}") - ${EXAMPLE_GOOGLE_PLAY_TRACK:-unknown}"
if [[ "${EXAMPLE_GOOGLE_PLAY_RESULT:-}" == success ]]; then
  example_play_detail="submitted - ${EXAMPLE_GOOGLE_PLAY_TRACK:-unknown} (review and availability may be pending)"
  if [[ -n "${EXAMPLE_GOOGLE_PLAY_INSTALL_URL:-}" ]]; then
    example_play_detail+=" - <${EXAMPLE_GOOGLE_PLAY_INSTALL_URL}|Open Google Play>"
  fi
fi
if [[ -n "${DOCS_URL:-}" ]]; then
  docs_detail="<${DOCS_URL}|Open docs>"
fi

# The Mentra release (Cloud V2, Mentra App, Engine, Bluetooth SDK) is complete
# when finalize succeeds. The Bluetooth example is its own release notion and
# is reported separately below; it never makes the Mentra release incomplete.
if [[ "${FINALIZE_RESULT:-}" == "success" ]]; then
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
play_detail="${PLAY_TRACK:-unknown}"
if [[ "${UPLOAD_GOOGLE_PLAY:-true}" == "false" ]]; then
  play_detail="dev uploads paused; APK/AAB downloads remain available"
fi
android_line="*$(icon "$android_result") Android* - $(label "$android_result") - ${android_detail}${newline}Android: $(icon "$android_result") $(label "$android_result") · Google Play: ${play_detail}"
if [[ -n "${PLAY_INSTALL_URL:-}" ]]; then
  android_line+=" - <${PLAY_INSTALL_URL}|Install from Google Play>"
fi
ios_line="*$(icon "$ios_result") iOS* - $(label "$ios_result") - ${ios_detail}${newline}iOS: $(icon "$ios_result") $(label "$ios_result") · TestFlight: ${TESTFLIGHT_GROUP:-unknown}"
if [[ -n "${TESTFLIGHT_DISTRIBUTION_STATUS:-}" ]]; then
  ios_line+=" - ${TESTFLIGHT_DISTRIBUTION_STATUS}"
fi
if [[ -n "${TESTFLIGHT_REVIEW_STATE:-}" ]]; then
  ios_line+=" (${TESTFLIGHT_REVIEW_STATE})"
fi
if [[ -n "${TESTFLIGHT_INSTALL_URL:-}" ]]; then
  ios_line+=" - <${TESTFLIGHT_INSTALL_URL}|Join TestFlight>"
fi
asg_line="*$(icon "${OTA_RESULT:-unknown}") ASG + OTA* - $(label "${OTA_RESULT:-unknown}") - ${asg_detail}"
starter_line="*$(icon "${FINALIZE_EXAMPLE_RESULT:-unknown}") Bluetooth example* - $(label "${FINALIZE_EXAMPLE_RESULT:-unknown}") - Starter Kit build: $(icon "${STARTER_KIT_RESULT:-unknown}") $(label "${STARTER_KIT_RESULT:-unknown}") - ${starter_detail}${newline}React Native iOS TestFlight: ${example_testflight_icon} ${example_testflight_detail}"
starter_line+="${newline}React Native Android Google Play: $(icon "${EXAMPLE_GOOGLE_PLAY_RESULT:-unknown}") ${example_play_detail}"
docs_line="*$(icon "${DOCS_RESULT:-unknown}") Docs* - $(label "${DOCS_RESULT:-unknown}") - ${docs_detail}"
main_app_line="*Mentra App downloads*${newline}Android phone APK: ${android_detail}${newline}iOS IPA: ${ios_detail}"
scope="${RELEASE_SCOPE:-core}"
if [[ "$scope" == examples ]]; then
  if [[ "${FINALIZE_EXAMPLE_RESULT:-}" == success && "${DOCS_RESULT:-}" == success ]]; then
    header_icon=":white_check_mark:"
    header_text="$channel_label examples and docs complete"
  else
    header_icon=":warning:"
    header_text="$channel_label examples and docs incomplete"
  fi
  checks_line="*Example checks*${newline}Inputs: $(icon "${PLAN_RESULT:-unknown}") $(label "${PLAN_RESULT:-unknown}") | Starter Kit: $(icon "${STARTER_KIT_RESULT:-unknown}") $(label "${STARTER_KIT_RESULT:-unknown}") | TestFlight: $(icon "${EXAMPLE_TESTFLIGHT_RESULT:-unknown}") $(label "${EXAMPLE_TESTFLIGHT_RESULT:-unknown}")"
  checks_line+=" | Example Google Play: $(icon "${EXAMPLE_GOOGLE_PLAY_RESULT:-unknown}") $(label "${EXAMPLE_GOOGLE_PLAY_RESULT:-unknown}")"
  checks_line+=" | Example finalize: $(icon "${FINALIZE_EXAMPLE_RESULT:-unknown}") $(label "${FINALIZE_EXAMPLE_RESULT:-unknown}")"
else
  checks_line="*Release checks*${newline}Plan: $(icon "${PLAN_RESULT:-unknown}") $(label "${PLAN_RESULT:-unknown}") | Cloud V2: $(icon "${CLOUD_V2_RESULT:-unknown}") $(label "${CLOUD_V2_RESULT:-unknown}") | Mentra Cloud image: $(icon "${RUNTIME_IMAGE_RESULT:-unknown}") $(label "${RUNTIME_IMAGE_RESULT:-unknown}") | Private deployment: $(icon "${PRIVATE_DEPLOYMENT_RESULT:-skipped}") $(label "${PRIVATE_DEPLOYMENT_RESULT:-skipped}") | Packages: $(icon "${NPM_RESULT:-unknown}") $(label "${NPM_RESULT:-unknown}") | Native SDK: $(icon "${SDK_NATIVE_RESULT:-unknown}") $(label "${SDK_NATIVE_RESULT:-unknown}") | Engine consumer: $(icon "${ENGINE_RESULT:-unknown}") $(label "${ENGINE_RESULT:-unknown}") | Finalize: $(icon "${FINALIZE_RESULT:-unknown}") $(label "${FINALIZE_RESULT:-unknown}")"
  examples_url="https://github.com/${REPOSITORY}/actions/workflows/coordinated-example-release.yml?query=branch%3A${BRANCH}"
  if [[ -n "${RELEASE_PAGE_RESULT:-}" ]]; then
    checks_line+=" | Download page: $(icon "$RELEASE_PAGE_RESULT") $(label "$RELEASE_PAGE_RESULT")"
  fi
  checks_line+="${newline}Examples and docs dispatch: $(icon "${EXAMPLES_DISPATCH_RESULT:-unknown}") $(label "${EXAMPLES_DISPATCH_RESULT:-unknown}") - <${examples_url}|View separate workflow>"
fi

platforms='[]'
routines='[]'
if [[ "$scope" != examples ]]; then
  platforms=$(node "$(dirname -- "$0")/coordinated-downloads-slack.mjs" platforms)
  routines=$(node "$(dirname -- "$0")/coordinated-downloads-slack.mjs" routines)
  if [[ -n "${OTA_MANIFEST_URL:-}" ]]; then
    targets=$(node "$(dirname -- "$0")/coordinated-downloads-slack.mjs" ota)
    asg_line+="${newline}${targets}${newline}<${OTA_MANIFEST_URL}|OTA manifest>"
    asg_line+="${newline}Install the Mentra App, connect your glasses, and follow the update prompt to reach these versions."
  fi
fi

payload=$(jq -n \
  --argjson platforms "$platforms" \
  --argjson routines "$routines" \
  --arg scope "$scope" \
  --arg header "$header_icon $header_text" \
  --arg commit "$commit_subject" \
  --arg release "$release_text" \
  --arg android "$android_line" \
  --arg ios "$ios_line" \
  --arg asg "$asg_line" \
  --arg starter "$starter_line" \
  --arg docs "$docs_line" \
  --arg main_app "$main_app_line" \
  --arg checks "$checks_line" \
  --arg context "Commit <${commit_url}|\`${commit_short}\`> by ${commit_author} - <${run_url}|View workflow>" \
  '{
    blocks: [
      {type: "header", text: {type: "plain_text", text: $header, emoji: true}},
      {type: "section", text: {type: "mrkdwn", text: $commit}},
      {type: "section", text: {type: "mrkdwn", text: $release}},
      {type: "divider"},
      (if $scope == "examples" then
        {type: "section", text: {type: "mrkdwn", text: $main_app}},
        {type: "section", text: {type: "mrkdwn", text: $starter}},
        {type: "section", text: {type: "mrkdwn", text: $docs}}
      else
        $platforms[],
        {type: "section", text: {type: "mrkdwn", text: (($android | split("\n")[1]) + "\n" + ($ios | split("\n")[1]))}},
        {type: "section", text: {type: "mrkdwn", text: $asg}},
        $routines[]
      end),
      {type: "section", text: {type: "mrkdwn", text: $checks}},
      {type: "context", elements: [{type: "mrkdwn", text: $context}]}
    ]
  }')

if [[ "${SLACK_NOTIFY_DRY_RUN:-}" == "true" ]]; then
  printf '%s\n' "$payload"
  exit 0
fi

if [[ "$use_bot" == true ]]; then
  printf '%s\n' "$payload" | node "$(dirname -- "$0")/release-slack-message.mjs"
else
  curl --fail --silent --show-error --retry 3 \
    --header "Content-Type: application/json" \
    --data "$payload" \
    "$webhook_url"
fi
echo
