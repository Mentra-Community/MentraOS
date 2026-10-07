#!/usr/bin/env bash
# Read-only Azure diagnostics. Emit metadata and fixed codes; never raw console output.

startup_failure_codes() {
  local log="$1" matched=false
  local code operation phase index_name
  for code in 2 9 13 26 50 67 85 86 115 11000 16500 16501; do
    if grep -Eiq "code[^0-9]{0,12}${code}([^0-9]|$)" "$log"; then
      echo "Azure startup hint: mongo-code-$code" >&2
      matched=true
    fi
  done
  # Index names are public schema constants, not arbitrary application output.
  # Keep this finite so a database error cannot expose a private log message.
  for index_name in tenantId_1_tenantUserId_1 expiresAt_1 prevTokenHash_1 altTokenHash_1 \
    hostId_1 requestId_1 state_1_createdAt_1_requestId_1 hostId_1_state_1 \
    hostId_1_state_1_preparationCheckedAt_1_createdAt_1_requestId_1 \
    rerunId_1 claimKeys_1 routineId_1_platform_1_definitionRevision_1 \
    startedAt_-1_runId_-1 test_runs_native_history test_runs_terminal_request test_runs_completed_at; do
    if grep -Eq "(^|[^[:alnum:]_])${index_name}([^[:alnum:]_]|$)" "$log"; then
      echo "Azure startup hint: mongo-index-$index_name" >&2
      matched=true
    fi
  done
  for operation in createIndexes createIndex updateMany aggregate findAndModify; do
    if grep -Eiq "(^|[^[:alnum:]_])${operation}([^[:alnum:]_]|$)" "$log"; then
      echo "Azure startup hint: mongo-operation-$operation" >&2
      matched=true
    fi
  done
  for phase in runStartupMigrations backfillLegacyUserIdentityFields backfillLegacyRefreshTokenTenant dedupeUserIdentityRows backfillTestSuiteStartedAt reconcileTestRunIndexes; do
    if grep -Fq "$phase" "$log"; then
      echo "Azure startup hint: migration-$phase" >&2
      matched=true
    fi
  done
  if grep -Eiq '(unsupported|not supported|not implemented).*(index option|partialFilterExpression)|(index option|partialFilterExpression).*(unsupported|not supported|not implemented)' "$log"; then
    echo 'Azure startup hint: mongo-index-option-unsupported' >&2
    matched=true
  fi
  if grep -Eiq '(unsupported|not supported|not implemented).*(aggregation pipeline|update pipeline)|(aggregation pipeline|update pipeline).*(unsupported|not supported|not implemented)' "$log"; then
    echo 'Azure startup hint: mongo-pipeline-unsupported' >&2
    matched=true
  fi
  if grep -Eiq 'MongoServerError' "$log"; then
    echo 'Azure startup hint: mongo-server-error' >&2
    matched=true
  fi
  if grep -Eiq 'authorization failed|authentication failed|unauthorized' "$log"; then
    echo 'Azure startup hint: authorization-failed' >&2
    matched=true
  fi
  if grep -Eiq 'oomkilled|out of memory' "$log"; then
    echo 'Azure startup hint: out-of-memory' >&2
    matched=true
  fi
  if [[ "$matched" == false ]]; then
    echo 'Azure startup hint: unknown' >&2
  fi
}

diagnose_current_core() {
  local app="ca-mentra-ent-ref-core" data latest ready
  AZURE_RESOURCE_GROUP="rg-mentra-enterprise-reference"
  if data=$(timeout 8s az containerapp show --name "$app" --resource-group "$AZURE_RESOURCE_GROUP" \
    --query '{latest:properties.latestRevisionName,ready:properties.latestReadyRevisionName,image:properties.template.containers[0].image}' --output json 2>/dev/null); then
    latest=$(printf '%s' "$data" | jq -r '.latest // empty')
    ready=$(printf '%s' "$data" | jq -r '.ready // empty')
    expected_image=$(printf '%s' "$data" | jq -r '.image // empty')
    readiness_diagnostics "$app" "$latest" "$ready"
  else
    echo 'Azure current Core metadata unavailable within the diagnostic deadline.' >&2
    return 1
  fi
}

startup_failure_sample() (
  local app="$1" latest="$2" log
  umask 077
  log=$(mktemp "$RUNNER_TEMP/azure-startup-log.XXXXXX") || {
    echo 'Azure startup hint: sample-unavailable' >&2
    return
  }
  trap 'rm -f "$log"' EXIT
  if timeout 8s az containerapp logs show --name "$app" --revision "$latest" --resource-group "$AZURE_RESOURCE_GROUP" --type console --tail 30 --format json 2>/dev/null | head -c 65536 > "$log"; then
    startup_failure_codes "$log"
  else
    echo 'Azure startup hint: sample-unavailable' >&2
  fi
)
readiness_diagnostics() {
  local app="$1" latest="$2" ready="$3" selected data query
  echo "Azure readiness diagnostics for $app (expected image $expected_image)" >&2
  query='{latestRevision:properties.latestRevisionName,latestReadyRevision:properties.latestReadyRevisionName,provisioningState:properties.provisioningState}'
  if data=$(timeout 8s az containerapp show --name "$app" --resource-group "$AZURE_RESOURCE_GROUP" --query "$query" --output json 2>/dev/null); then
    printf '%s' "$data" | jq -c '{latestRevision,latestReadyRevision,provisioningState}' 2>/dev/null | head -c 8192 >&2 || true
    echo >&2
  else
    echo 'Azure app metadata unavailable within the diagnostic deadline.' >&2
  fi
  for selected in "$latest" "$ready"; do
    [[ -n "$selected" && "$selected" =~ ^[a-zA-Z0-9-]+$ ]] || continue
    query='{name:name,active:properties.active,provisioningState:properties.provisioningState,healthState:properties.healthState,runningState:properties.runningState,images:properties.template.containers[].image}'
    if data=$(timeout 8s az containerapp revision show --name "$app" --revision "$selected" --resource-group "$AZURE_RESOURCE_GROUP" --query "$query" --output json 2>/dev/null); then
      printf '%s' "$data" | jq -c '{name,active,provisioningState,healthState,runningState,images}' 2>/dev/null | head -c 8192 >&2 || true
      echo >&2
    else
      echo "Azure revision metadata unavailable for $selected." >&2
    fi
    query='[].{name:name,containers:properties.containers[].{name:name,ready:ready,restartCount:restartCount,runningState:runningState}}'
    if data=$(timeout 8s az containerapp replica list --name "$app" --revision "$selected" --resource-group "$AZURE_RESOURCE_GROUP" --query "$query" --output json 2>/dev/null); then
      printf '%s' "$data" | jq -c 'def state: if type == "string" then . else .state end; [.[:10][] | {name,containers:[.containers[:10][] | {name,ready,restartCount,runningState:(.runningState | state)}]}]' 2>/dev/null | head -c 8192 >&2 || true
      echo >&2
    else
      echo "Azure replica metadata unavailable for $selected." >&2
    fi
    [[ "$latest" != "$ready" ]] || break
  done
  # Classify only the failing latest revision. Raw application output
  # can contain credentials: keep a private, bounded sample temporary.
  if [[ -n "$latest" && "$latest" =~ ^[a-zA-Z0-9-]+$ ]]; then
    startup_failure_sample "$app" "$latest"
  fi
}
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  diagnose_current_core
fi
