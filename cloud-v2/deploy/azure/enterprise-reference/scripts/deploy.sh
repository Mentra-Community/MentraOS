#!/usr/bin/env bash
set -euo pipefail

# Deploys the stack, or previews it. Secrets never pass through this script:
# signing keys are created in Key Vault and the apps read them from there.
# --bootstrap-only runs just the ownership step, which also gives whoever runs
# it access to the deployment's Key Vault.
MODE=deploy
case "${1:-}" in
  --validate-only) MODE=validate; shift ;;
  --what-if) MODE=what-if; shift ;;
  --bootstrap-only) MODE=bootstrap; shift ;;
esac

if [[ $# -ne 1 ]]; then
  printf 'Usage: %s [--validate-only | --what-if | --bootstrap-only] deployment.config.json\n' "$0" >&2
  exit 2
fi

CONFIG="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

command -v jq >/dev/null || { printf 'jq is required\n' >&2; exit 1; }
if [[ "$MODE" != validate ]]; then
  command -v az >/dev/null || { printf 'az is required\n' >&2; exit 1; }
fi
[[ -f "$CONFIG" ]] || { printf 'Configuration file not found: %s\n' "$CONFIG" >&2; exit 1; }

# Container App names: lowercase alphanumeric/hyphen, 2-32 characters, start with
# a letter and end alphanumeric. Miniapp configuration limits mirror the Mentra
# App manifest schema (mobile/src/services/deployment/schema.ts). Version policy
# uses strict SemVer 2.0.0 precedence so the recommended floor never sits below
# the required minimum.
jq -e '
  def nonempty: type == "string" and length > 0;
  def guid: test("^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$");
  def container_app_name: type == "string" and test("^[a-z][a-z0-9-]{0,30}[a-z0-9]$");
  def package_name: type == "string" and test("^[a-zA-Z][a-zA-Z0-9_]*(\\.[a-zA-Z0-9_]+)+$");
  def miniapp_configuration:
    type == "object" and
    (keys | length <= 32 and all(test("^[A-Za-z][A-Za-z0-9._-]{0,63}$"))) and
    ([.[]] | all(type == "string" and utf8bytelength <= 2048)) and
    (tojson | utf8bytelength <= 16384);
  def miniapp_configuration_map:
    type == "object" and
    (keys | length <= 100 and all(package_name)) and
    ([.[]] | all(miniapp_configuration));
  def semver: type == "string" and test("^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$");
  def semver_key:
    capture("^(?<major>[0-9]+)\\.(?<minor>[0-9]+)\\.(?<patch>[0-9]+)(?:-(?<pre>[0-9A-Za-z.-]+))?") |
    [(.major | tonumber), (.minor | tonumber), (.patch | tonumber),
     (if .pre == null then [[2]]
      else (.pre | split(".") | map(if test("^[0-9]+$") then [0, tonumber] else [1, .] end)) end)];
  (.clientMinVersion // "0.0.0") as $minVersion |
  (.clientRecommendedVersion // $minVersion) as $recommendedVersion |
  (.resourceGroup | nonempty) and
  (.location | nonempty) and
  (.registryName | test("^[a-zA-Z0-9]{5,50}$")) and
  (.keyVaultName | type == "string" and test("^[a-zA-Z][a-zA-Z0-9-]{1,22}[a-zA-Z0-9]$")) and
  (.sourceImage | test("^ghcr\\.io/mentra-community/mentra-cloud@sha256:[0-9a-f]{64}$")) and
  (.sourceRegistryMirror == null or (.sourceRegistryMirror | type == "string")) and
  ((.sourceRegistryMirror // "") | . == "" or test("^[a-z0-9]+\\.azurecr\\.io/[a-z0-9]+([._/-][a-z0-9]+)*$")) and
  (.releaseTag | test("^[A-Za-z0-9._-]+$")) and
  (.tenantId | guid) and
  (.coreApiClientId | guid) and
  (.mobileClientId | guid) and
  ((.teamsGraphTenantId // "") | . == "" or guid) and
  ((.teamsGraphClientId // "") | . == "" or guid) and
  ((.teamsGraphOrganizerId // "") | . == "" or guid) and
  (.deploymentId | nonempty) and
  (.displayName | nonempty) and
  (.environmentName | nonempty) and
  (.coreIdentityName | nonempty) and
  (.runtimeIdentityName | nonempty) and
  (.communicationName | nonempty) and
  (.runtimeName | container_app_name) and
  (.coreName | container_app_name) and
  ((.coreAdminEmails // "") | type == "string") and
  ((.miniappConfiguration // {}) | miniapp_configuration_map) and
  ($minVersion | semver) and
  ($recommendedVersion | semver) and
  (($recommendedVersion | semver_key) >= ($minVersion | semver_key))
' "$CONFIG" >/dev/null || { printf 'Deployment configuration is incomplete or invalid\n' >&2; exit 1; }

# The fallback organizer only works through the Graph application.
jq -e '(.teamsGraphOrganizerId // "") == "" or (.teamsGraphClientId // "") != ""' "$CONFIG" >/dev/null || {
  printf 'teamsGraphOrganizerId requires teamsGraphClientId\n' >&2
  exit 1
}

if [[ "$MODE" == validate ]]; then
  printf 'Mentra Private Deployment configuration passed local validation.\n'
  exit 0
fi

RESOURCE_GROUP="$(jq -r .resourceGroup "$CONFIG")"
LOCATION="$(jq -r .location "$CONFIG")"
DEPLOYMENT_NAME="$(jq -r '.deploymentName // "mentra-private"' "$CONFIG")"
REGISTRY_NAME="$(jq -r .registryName "$CONFIG")"
SOURCE_IMAGE="$(jq -r .sourceImage "$CONFIG")"
SOURCE_MIRROR="$(jq -r '.sourceRegistryMirror // ""' "$CONFIG")"
if [[ -n "$SOURCE_MIRROR" ]]; then
  SOURCE_IMAGE="$SOURCE_MIRROR@${SOURCE_IMAGE##*@}"
fi
RELEASE_TAG="$(jq -r .releaseTag "$CONFIG")"
KEY_VAULT="$(jq -r .keyVaultName "$CONFIG")"
CORE_NAME="$(jq -r .coreName "$CONFIG")"
CORE_IDENTITY="$(jq -r .coreIdentityName "$CONFIG")"
RUNTIME_IDENTITY="$(jq -r .runtimeIdentityName "$CONFIG")"
TEAMS_SECRET="$(jq -r 'if (.teamsGraphClientId // "") == "" then "false" else "true" end' "$CONFIG")"

# Wizard calls are bound to an explicit subscription without changing az defaults.
if [[ -n "${MENTRA_SUBSCRIPTION_ID:-}" ]]; then
  az() { command az "$@" --subscription "$MENTRA_SUBSCRIPTION_ID"; }
fi
az account show --output none
# Whoever runs setup gets Key Vault Secrets Officer on this deployment's vault,
# so a later administrator can resume or upgrade without extra steps. The oid
# claim of a token for this subscription is the caller's object ID in the
# deployment tenant, for users, guests and service principals alike.
OPERATOR_ID="${MENTRA_OPERATOR_OBJECT_ID:-}"
OPERATOR_TYPE="${MENTRA_OPERATOR_TYPE:-User}"
if [[ -z "$OPERATOR_ID" ]]; then
  CLAIMS="$(az account get-access-token --query accessToken --output tsv | jq -R '
    split(".")[1] | gsub("-"; "+") | gsub("_"; "/") | . + ("=" * ((4 - length % 4) % 4)) | @base64d | fromjson')"
  OPERATOR_ID="$(jq -r '.oid // ""' <<<"$CLAIMS")"
  [[ "$(jq -r '.idtyp // ""' <<<"$CLAIMS")" == app ]] && OPERATOR_TYPE=ServicePrincipal
fi
[[ "$OPERATOR_ID" =~ ^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$ ]] || {
  printf 'Could not determine the signed-in Azure identity\n' >&2
  exit 1
}

BOOTSTRAP_PARAMETERS=(registryName="$REGISTRY_NAME" coreIdentityName="$CORE_IDENTITY" runtimeIdentityName="$RUNTIME_IDENTITY" keyVaultName="$KEY_VAULT"
  operatorPrincipalId="$OPERATOR_ID" operatorPrincipalType="$OPERATOR_TYPE" resourceTags="$(jq -c '.resourceTags // {}' "$CONFIG")")
ACCESS_PARAMETERS=(keyVaultName="$KEY_VAULT" coreIdentityName="$CORE_IDENTITY" runtimeIdentityName="$RUNTIME_IDENTITY"
  teamsSecret="$TEAMS_SECRET")

umask 077
PARAMETERS="$(mktemp "${TMPDIR:-/tmp}/mentra-private-parameters.XXXXXX")"
trap 'rm -f "$PARAMETERS"' EXIT

write_parameters() {
jq -n \
  --slurpfile config "$CONFIG" \
  --arg cloudImage "$1" '
  ($config[0]) as $c |
  {
    "$schema":"https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
    contentVersion:"1.0.0.0",
    parameters:{
      location:{value:$c.location},
      cloudImage:{value:$cloudImage},
      registryName:{value:$c.registryName},
      keyVaultName:{value:$c.keyVaultName},
      resourceTags:{value:($c.resourceTags // {})},
      tenantId:{value:$c.tenantId},
      coreApiClientId:{value:$c.coreApiClientId},
      mobileClientId:{value:$c.mobileClientId},
      coreAdminEmails:{value:($c.coreAdminEmails // "")},
      workspaceHostname:{value:($c.workspaceHostname // "")},
      workspaceCertificateName:{value:($c.workspaceCertificateName // (($c.runtimeName // "ca-mentra-enterprise-reference") + "-workspace"))},
      additionalWorkspaceDomains:{value:($c.additionalWorkspaceDomains // [])},
      clientMinVersion:{value:($c.clientMinVersion // "0.0.0")},
      clientRecommendedVersion:{value:($c.clientRecommendedVersion // $c.clientMinVersion // "0.0.0")},
      deploymentId:{value:$c.deploymentId},
      displayName:{value:$c.displayName},
      environmentName:{value:$c.environmentName},
      runtimeName:{value:$c.runtimeName},
      coreName:{value:$c.coreName},
      coreIdentityName:{value:$c.coreIdentityName},
      runtimeIdentityName:{value:$c.runtimeIdentityName},
      communicationName:{value:$c.communicationName},
      communicationDataLocation:{value:($c.communicationDataLocation // "United States")},
      teamsGraphTenantId:{value:(if ($c.teamsGraphTenantId // "") == "" then $c.tenantId else $c.teamsGraphTenantId end)},
      teamsGraphClientId:{value:($c.teamsGraphClientId // "")},
      teamsGraphOrganizerId:{value:($c.teamsGraphOrganizerId // "")},
      approvedSystemMiniapps:{value:($c.approvedSystemMiniapps // ["com.mentra.settings"])},
      managedMiniapps:{value:($c.managedMiniapps // [])},
      miniappConfiguration:{value:($c.miniappConfiguration // {})},
      managedMiniappDirectory:{value:($c.managedMiniappDirectory // "/app/cloud-v2/deploy/azure/enterprise-reference/miniapps")},
      allowedGlassesModels:{value:($c.allowedGlassesModels // ["mentra-live"])},
      telemetryEnabled:{value:($c.telemetryEnabled // false)},
      privacyPolicyUrl:{value:($c.privacyPolicyUrl // "")},
      termsOfServiceUrl:{value:($c.termsOfServiceUrl // "")},
      documentationUrl:{value:($c.documentationUrl // "")},
      supportUrl:{value:($c.supportUrl // "")}
    }
  } | if ($c.mongoAccountName // "") != "" then .parameters.mongoAccountName={value:$c.mongoAccountName} else . end
    | if ($c.reportStorageAccountName // "") != "" then .parameters.reportStorageAccountName={value:$c.reportStorageAccountName} else . end
  ' > "$PARAMETERS"
}

if [[ "$MODE" == what-if ]]; then
  # Azure's own preview of both templates. Nothing is created or changed; the
  # image reference is the one the import will produce for this digest.
  [[ "$(az group exists --name "$RESOURCE_GROUP")" == true ]] || {
    printf 'Resource group %s does not exist yet. Create it with "az group create --name %s --location %s", then preview again.\n' \
      "$RESOURCE_GROUP" "$RESOURCE_GROUP" "$LOCATION" >&2
    exit 1
  }
  write_parameters "$REGISTRY_NAME.azurecr.io/mentra-cloud-enterprise@${SOURCE_IMAGE##*@}"
  BOOTSTRAP_PREVIEW="$(az deployment group what-if --name "$DEPLOYMENT_NAME-bootstrap" --resource-group "$RESOURCE_GROUP" \
    --template-file "$TEMPLATE_DIR/bootstrap.bicep" --parameters "${BOOTSTRAP_PARAMETERS[@]}" --no-pretty-print --output json)"
  MAIN_PREVIEW="$(az deployment group what-if --name "$DEPLOYMENT_NAME" --resource-group "$RESOURCE_GROUP" \
    --template-file "$TEMPLATE_DIR/main.bicep" --parameters "@$PARAMETERS" --no-pretty-print --output json)"
  # Access grants need the secrets to exist; before the first install there is nothing to preview.
  ACCESS_PREVIEW="$(az deployment group what-if --name "$DEPLOYMENT_NAME-access" --resource-group "$RESOURCE_GROUP" \
    --template-file "$TEMPLATE_DIR/access.bicep" --parameters "${ACCESS_PARAMETERS[@]}" --no-pretty-print --output json 2>/dev/null)" ||
    ACCESS_PREVIEW=null
  jq -n --argjson bootstrap "$BOOTSTRAP_PREVIEW" --argjson main "$MAIN_PREVIEW" --argjson access "$ACCESS_PREVIEW" \
    '{bootstrap:$bootstrap,access:$access,main:$main}'
  exit 0
fi

# The wizard creates and checks its owned resource group before invoking this
# script. Keep the standalone deploy.sh interface for existing operators.
if [[ "${MENTRA_GROUP_PREPARED:-false}" != true ]]; then
  az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --output none
fi
az deployment group create \
  --name "$DEPLOYMENT_NAME-bootstrap" \
  --resource-group "$RESOURCE_GROUP" \
  --template-file "$TEMPLATE_DIR/bootstrap.bicep" \
  --parameters "${BOOTSTRAP_PARAMETERS[@]}" \
  --query properties.provisioningState \
  --output tsv | grep --fixed-strings --line-regexp Succeeded >/dev/null
if [[ "$MODE" == bootstrap ]]; then
  exit 0
fi

"$SCRIPT_DIR/ensure-vault-secrets.sh" "$KEY_VAULT" "$RESOURCE_GROUP" "$CORE_NAME"
if [[ -n "$(jq -r '.teamsGraphClientId // ""' "$CONFIG")" ]]; then
  az keyvault secret show --vault-name "$KEY_VAULT" --name teams-graph-client-secret --query id --output none 2>/dev/null || {
    printf 'Graph meeting creation is configured, but Key Vault %s has no teams-graph-client-secret. Run setup.sh configure-teams.\n' "$KEY_VAULT" >&2
    exit 1
  }
fi

# Grant each app read access to exactly its own secrets. New grants take a
# moment to reach Key Vault, and an app that cannot read a secret fails to start.
NEW_GRANTS="$(az deployment group what-if --name "$DEPLOYMENT_NAME-access" --resource-group "$RESOURCE_GROUP" \
  --template-file "$TEMPLATE_DIR/access.bicep" --parameters "${ACCESS_PARAMETERS[@]}" --no-pretty-print --output json |
  jq '[.changes[] | select(.changeType == "Create")] | length')"
az deployment group create --name "$DEPLOYMENT_NAME-access" --resource-group "$RESOURCE_GROUP" \
  --template-file "$TEMPLATE_DIR/access.bicep" --parameters "${ACCESS_PARAMETERS[@]}" \
  --query properties.provisioningState --output tsv | grep --fixed-strings --line-regexp Succeeded >/dev/null
if [[ "$NEW_GRANTS" != 0 ]]; then
  printf 'Waiting for new Key Vault access to apply...\n' >&2
  sleep "${MENTRA_RBAC_WAIT_SECONDS:-60}"
fi

# The helper reports progress on stderr and prints only the digest-pinned
# reference on stdout; tail keeps the last line in case az adds stdout noise.
IMPORTED_IMAGE="$("$SCRIPT_DIR/import-runtime-image.sh" "$REGISTRY_NAME" "$SOURCE_IMAGE" "$RELEASE_TAG" | tail -n 1)"
[[ "$IMPORTED_IMAGE" =~ ^[a-zA-Z0-9]+\.azurecr\.io/mentra-cloud-enterprise@sha256:[0-9a-f]{64}$ ]] || {
  printf 'Import helper returned an unexpected image reference: %s\n' "$IMPORTED_IMAGE" >&2
  exit 1
}
write_parameters "$IMPORTED_IMAGE"

# Azure requires an unbound hostname on the app before issuing its managed
# certificate. A fresh custom-domain install first deploys on the generated
# hostname; add this DNS-verified binding before the certificate deployment.
# Existing bindings must remain intact on an unchanged rerun.
WORKSPACE_HOSTNAME="$(jq -r '.workspaceHostname // ""' "$CONFIG")"
if [[ -n "$WORKSPACE_HOSTNAME" ]]; then
  RUNTIME_NAME="$(jq -r .runtimeName "$CONFIG")"
  APPS="$(az containerapp list --resource-group "$RESOURCE_GROUP" --output json)"
  if ! jq -e --arg app "$RUNTIME_NAME" 'any(.name == $app)' <<<"$APPS" >/dev/null; then
    # The standalone entry point needs the same two-phase DNS handoff as the
    # packaged installer. Azure cannot bind a hostname to an absent app.
    az deployment group validate --name "$DEPLOYMENT_NAME" --resource-group "$RESOURCE_GROUP" \
      --template-file "$TEMPLATE_DIR/main.bicep" --parameters "@$PARAMETERS" workspaceHostname="" --output none
    az deployment group create --name "$DEPLOYMENT_NAME" --resource-group "$RESOURCE_GROUP" \
      --template-file "$TEMPLATE_DIR/main.bicep" --parameters "@$PARAMETERS" workspaceHostname="" --output none
    az deployment group show --name "$DEPLOYMENT_NAME" --resource-group "$RESOURCE_GROUP" \
      --query properties.outputs --output json
    printf 'Initial app created. Configure DNS for %s using the generated hostname and custom-domain verification ID, then rerun this same command. Signing keys and image pins must remain unchanged.\n' "$WORKSPACE_HOSTNAME" >&2
    exit 3
  fi
  HOSTNAMES="$(az containerapp hostname list --name "$RUNTIME_NAME" --resource-group "$RESOURCE_GROUP" --output json)"
  if ! jq -e --arg host "$WORKSPACE_HOSTNAME" 'any(.name == $host)' <<<"$HOSTNAMES" >/dev/null; then
    az containerapp hostname add --name "$RUNTIME_NAME" --resource-group "$RESOURCE_GROUP" \
      --hostname "$WORKSPACE_HOSTNAME" --output none
  fi
fi

# Provider validation checks permissions, policy and parameters before the
# application deployment. Never print secure parameter/provider responses.
az deployment group validate \
  --name "$DEPLOYMENT_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --template-file "$TEMPLATE_DIR/main.bicep" \
  --parameters "@$PARAMETERS" \
  --output none

az deployment group create \
  --name "$DEPLOYMENT_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --template-file "$TEMPLATE_DIR/main.bicep" \
  --parameters "@$PARAMETERS" \
  --query properties.provisioningState \
  --output tsv | grep --fixed-strings --line-regexp Succeeded >/dev/null

# ARM completion precedes Container Apps readiness. Wait until both services run
# their new revisions; until then the previous Runtime still serves the old
# manifest (for example the Azure address instead of the custom one).
for app in "$CORE_NAME" "$(jq -r .runtimeName "$CONFIG")"; do
  READY=false
  for attempt in $(seq 1 "${MENTRA_READY_ATTEMPTS:-60}"); do
    if az containerapp show --name "$app" --resource-group "$RESOURCE_GROUP" --output json | jq -e '
      .properties | (.latestRevisionName != null and .latestRevisionName != "" and
      .latestRevisionName == .latestReadyRevisionName)
    ' >/dev/null; then
      READY=true
      break
    fi
    sleep 10
  done
  [[ "$READY" == true ]] || { printf '%s revision did not become ready. Check its revision logs in the Azure portal, then run setup again.\n' "$app" >&2; exit 1; }
done

WORKSPACE="$(az deployment group show \
  --name "$DEPLOYMENT_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --query properties.outputs.workspaceOrigin.value \
  --output tsv)"
if [[ "${MENTRA_SKIP_SMOKE:-false}" != true ]]; then
  "$SCRIPT_DIR/smoke-test.sh" "$WORKSPACE"
fi

CORE_ORIGIN="$(az deployment group show --name "$DEPLOYMENT_NAME" --resource-group "$RESOURCE_GROUP" \
  --query properties.outputs.coreOrigin.value --output tsv)"
if [[ -n "${MENTRA_ADMIN_TOKEN:-}" && "${MENTRA_SKIP_SMOKE:-false}" != true ]]; then
  AUTH_CONFIG="$(mktemp "${TMPDIR:-/tmp}/mentra-private-auth.XXXXXX")"
  trap 'rm -f "$PARAMETERS" "${AUTH_CONFIG:-}"' EXIT
  [[ "$MENTRA_ADMIN_TOKEN" != *$'\n'* && "$MENTRA_ADMIN_TOKEN" != *$'\r'* && "$MENTRA_ADMIN_TOKEN" != *'"'* && "$MENTRA_ADMIN_TOKEN" != *'\'* ]] || exit 1
  printf 'header = "Authorization: Bearer %s"\n' "$MENTRA_ADMIN_TOKEN" > "$AUTH_CONFIG"
  curl --connect-timeout 10 --max-time 30 --retry-max-time 300 --config "$AUTH_CONFIG" --fail --silent --show-error --retry 12 --retry-delay 10 --retry-all-errors \
    "$CORE_ORIGIN/api/admin/reports?limit=1" | jq -e '.reports | type == "array"' >/dev/null
fi

az deployment group show \
  --name "$DEPLOYMENT_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --query properties.outputs \
  --output json
