#!/usr/bin/env bash
set -euo pipefail

VALIDATE_ONLY=false
if [[ "${1:-}" == "--validate-only" ]]; then
  VALIDATE_ONLY=true
  shift
fi

if [[ $# -ne 2 ]]; then
  printf 'Usage: %s [--validate-only] deployment.config.json /secure/path/mentra-private-secrets.json\n' "$0" >&2
  exit 2
fi

CONFIG="$1"
SECRETS="$2"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

command -v jq >/dev/null || { printf 'jq is required\n' >&2; exit 1; }
if [[ "$VALIDATE_ONLY" != true ]]; then
  command -v az >/dev/null || { printf 'az is required\n' >&2; exit 1; }
fi
[[ -f "$CONFIG" ]] || { printf 'Configuration file not found: %s\n' "$CONFIG" >&2; exit 1; }
[[ -f "$SECRETS" && ! -L "$SECRETS" ]] || {
  printf 'Secrets must be a regular, non-symlink file: %s\n' "$SECRETS" >&2
  exit 1
}
SECRET_MODE="$(stat -c '%a' "$SECRETS" 2>/dev/null || stat -f '%Lp' "$SECRETS")"
[[ "$SECRET_MODE" =~ ^[0-7]{3,4}$ ]] || { printf 'Could not determine secret-file permissions\n' >&2; exit 1; }
[[ "${SECRET_MODE: -2:1}" == "0" && "${SECRET_MODE: -1}" == "0" ]] || {
  printf 'Secret file must not be accessible by group or other users: %s (mode %s)\n' "$SECRETS" "$SECRET_MODE" >&2
  exit 1
}

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
  (.pullIdentityName | nonempty) and
  (.communicationName | nonempty) and
  (.runtimeName | container_app_name) and
  (.coreName | container_app_name) and
  ((.coreAdminEmails // "") | type == "string") and
  (.manageAcrPullRoleAssignment == null or (.manageAcrPullRoleAssignment | type == "boolean")) and
  ((.miniappConfiguration // {}) | miniapp_configuration_map) and
  ($minVersion | semver) and
  ($recommendedVersion | semver) and
  (($recommendedVersion | semver_key) >= ($minVersion | semver_key))
' "$CONFIG" >/dev/null || { printf 'Deployment configuration is incomplete or invalid\n' >&2; exit 1; }

jq -e '
  [.refreshTokenPepper,.mentraJwtPrivateKey,.mentraJwtPublicKey,.miniappJwtPrivateKey,.miniappJwtPublicKey]
  | all(type == "string" and length > 0)
' "$SECRETS" >/dev/null || { printf 'Secret file is incomplete or invalid\n' >&2; exit 1; }

# Graph creation is optional, but partially configured credentials cannot work.
jq -en --slurpfile config "$CONFIG" --slurpfile secrets "$SECRETS" '
  ($config[0].teamsGraphClientId // "") as $client |
  ($secrets[0].teamsGraphClientSecret // "") as $secret |
  ($config[0].teamsGraphOrganizerId // "") as $organizer |
  ($secret | type == "string") and
  (if $client == "" then $secret == "" and $organizer == "" else ($secret | length > 0) end)
' >/dev/null || { printf 'Graph creation requires both teamsGraphClientId and secret teamsGraphClientSecret; the fallback organizer also requires these credentials\n' >&2; exit 1; }

if [[ "$VALIDATE_ONLY" == true ]]; then
  printf 'Mentra Private Deployment configuration and secret file passed local validation.\n'
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

# Wizard calls are bound to an explicit subscription without changing az defaults.
if [[ -n "${MENTRA_SUBSCRIPTION_ID:-}" ]]; then
  az() { command az "$@" --subscription "$MENTRA_SUBSCRIPTION_ID"; }
fi
az account show --output none
# The wizard creates and checks its owned resource group before invoking this
# legacy wrapper. Keep the standalone deploy.sh interface for existing operators.
if [[ "${MENTRA_GROUP_PREPARED:-false}" != true ]]; then
  az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --output none
fi
az deployment group create \
  --name "$DEPLOYMENT_NAME-bootstrap" \
  --resource-group "$RESOURCE_GROUP" \
  --template-file "$TEMPLATE_DIR/bootstrap.bicep" \
  --parameters registryName="$REGISTRY_NAME" resourceTags="$(jq -c '.resourceTags // {}' "$CONFIG")" \
  --query properties.provisioningState \
  --output tsv | grep --fixed-strings --line-regexp Succeeded >/dev/null

# The helper reports progress on stderr and prints only the digest-pinned
# reference on stdout; tail keeps the last line in case az adds stdout noise.
IMPORTED_IMAGE="$("$SCRIPT_DIR/import-runtime-image.sh" "$REGISTRY_NAME" "$SOURCE_IMAGE" "$RELEASE_TAG" | tail -n 1)"
[[ "$IMPORTED_IMAGE" =~ ^[a-zA-Z0-9]+\.azurecr\.io/mentra-cloud-enterprise@sha256:[0-9a-f]{64}$ ]] || {
  printf 'Import helper returned an unexpected image reference: %s\n' "$IMPORTED_IMAGE" >&2
  exit 1
}

umask 077
PARAMETERS="$(mktemp "${TMPDIR:-/tmp}/mentra-private-parameters.XXXXXX")"
trap 'rm -f "$PARAMETERS"' EXIT

jq -n \
  --slurpfile config "$CONFIG" \
  --slurpfile secrets "$SECRETS" \
  --arg cloudImage "$IMPORTED_IMAGE" '
  ($config[0]) as $c |
  ($secrets[0]) as $s |
  {
    "$schema":"https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
    contentVersion:"1.0.0.0",
    parameters:{
      location:{value:$c.location},
      cloudImage:{value:$cloudImage},
      registryName:{value:$c.registryName},
      resourceTags:{value:($c.resourceTags // {})},
      manageAcrPullRoleAssignment:{value:(if $c.manageAcrPullRoleAssignment == null then true else $c.manageAcrPullRoleAssignment end)},
      tenantId:{value:$c.tenantId},
      coreApiClientId:{value:$c.coreApiClientId},
      mobileClientId:{value:$c.mobileClientId},
      refreshTokenPepper:{value:$s.refreshTokenPepper},
      mentraJwtPrivateKey:{value:$s.mentraJwtPrivateKey},
      mentraJwtPublicKey:{value:$s.mentraJwtPublicKey},
      miniappJwtPrivateKey:{value:$s.miniappJwtPrivateKey},
      miniappJwtPublicKey:{value:$s.miniappJwtPublicKey},
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
      pullIdentityName:{value:$c.pullIdentityName},
      communicationName:{value:$c.communicationName},
      communicationDataLocation:{value:($c.communicationDataLocation // "United States")},
      teamsGraphTenantId:{value:(if ($c.teamsGraphTenantId // "") == "" then $c.tenantId else $c.teamsGraphTenantId end)},
      teamsGraphClientId:{value:($c.teamsGraphClientId // "")},
      teamsGraphClientSecret:{value:($s.teamsGraphClientSecret // "")},
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

# Azure requires an unbound hostname on the app before issuing its managed
# certificate. A fresh custom-domain install first deploys on the generated
# hostname; add this DNS-verified binding before the certificate deployment.
# Existing bindings must remain intact on an unchanged rerun.
WORKSPACE_HOSTNAME="$(jq -r '.workspaceHostname // ""' "$CONFIG")"
if [[ -n "$WORKSPACE_HOSTNAME" ]]; then
  RUNTIME_NAME="$(jq -r .runtimeName "$CONFIG")"
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

# ARM completion precedes Container Apps readiness. Wait for the deployed Core
# revision before probing its report token or claiming the storage upgrade works.
CORE_NAME="$(jq -r .coreName "$CONFIG")"
CORE_READY=false
for attempt in $(seq 1 30); do
  if az containerapp show --name "$CORE_NAME" --resource-group "$RESOURCE_GROUP" --output json | jq -e '
    .properties | (.latestRevisionName != null and .latestRevisionName != "" and
    .latestRevisionName == .latestReadyRevisionName)
  ' >/dev/null; then
    CORE_READY=true
    break
  fi
  sleep 10
done
[[ "$CORE_READY" == true ]] || { printf 'Core revision did not become ready\n' >&2; exit 1; }

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
