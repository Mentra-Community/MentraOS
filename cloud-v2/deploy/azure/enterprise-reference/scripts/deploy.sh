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

for command in az jq; do
  command -v "$command" >/dev/null || { printf '%s is required\n' "$command" >&2; exit 1; }
done
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

jq -e '
  def nonempty: type == "string" and length > 0;
  def guid: test("^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$");
  (.resourceGroup | nonempty) and
  (.location | nonempty) and
  (.registryName | test("^[a-zA-Z0-9]{5,50}$")) and
  (.sourceImage | test("^ghcr\\.io/mentra-community/mentra-cloud@sha256:[0-9a-f]{64}$")) and
  (.releaseTag | test("^[A-Za-z0-9._-]+$")) and
  (.tenantId | guid) and
  (.coreApiClientId | guid) and
  (.mobileClientId | guid) and
  (.deploymentId | nonempty) and
  (.displayName | nonempty) and
  (.environmentName | nonempty) and
  (.pullIdentityName | nonempty) and
  (.communicationName | nonempty) and
  (.runtimeName | nonempty and length <= 32) and
  (.coreName | nonempty and length <= 32)
' "$CONFIG" >/dev/null || { printf 'Deployment configuration is incomplete or invalid\n' >&2; exit 1; }

jq -e '
  [.refreshTokenPepper,.mentraJwtPrivateKey,.mentraJwtPublicKey,.miniappJwtPrivateKey,.miniappJwtPublicKey]
  | all(type == "string" and length > 0)
' "$SECRETS" >/dev/null || { printf 'Secret file is incomplete or invalid\n' >&2; exit 1; }

if [[ "$VALIDATE_ONLY" == true ]]; then
  printf 'Mentra Private Deployment configuration and secret file passed local validation.\n'
  exit 0
fi

RESOURCE_GROUP="$(jq -r .resourceGroup "$CONFIG")"
LOCATION="$(jq -r .location "$CONFIG")"
DEPLOYMENT_NAME="$(jq -r '.deploymentName // "mentra-private"' "$CONFIG")"
REGISTRY_NAME="$(jq -r .registryName "$CONFIG")"
SOURCE_IMAGE="$(jq -r .sourceImage "$CONFIG")"
RELEASE_TAG="$(jq -r .releaseTag "$CONFIG")"

az account show --output none
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --output none
az deployment group create \
  --name "$DEPLOYMENT_NAME-bootstrap" \
  --resource-group "$RESOURCE_GROUP" \
  --template-file "$TEMPLATE_DIR/bootstrap.bicep" \
  --parameters registryName="$REGISTRY_NAME" \
  --query properties.provisioningState \
  --output tsv | grep --fixed-strings --line-regexp Succeeded >/dev/null

IMPORTED_IMAGE="$("$SCRIPT_DIR/import-runtime-image.sh" "$REGISTRY_NAME" "$SOURCE_IMAGE" "$RELEASE_TAG")"

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
      tenantId:{value:$c.tenantId},
      coreApiClientId:{value:$c.coreApiClientId},
      mobileClientId:{value:$c.mobileClientId},
      refreshTokenPepper:{value:$s.refreshTokenPepper},
      mentraJwtPrivateKey:{value:$s.mentraJwtPrivateKey},
      mentraJwtPublicKey:{value:$s.mentraJwtPublicKey},
      miniappJwtPrivateKey:{value:$s.miniappJwtPrivateKey},
      miniappJwtPublicKey:{value:$s.miniappJwtPublicKey},
      workspaceHostname:{value:($c.workspaceHostname // "")},
      clientMinVersion:{value:($c.clientMinVersion // "0.0.0")},
      clientRecommendedVersion:{value:($c.clientRecommendedVersion // "0.0.0")},
      deploymentId:{value:$c.deploymentId},
      displayName:{value:$c.displayName},
      environmentName:{value:$c.environmentName},
      runtimeName:{value:$c.runtimeName},
      coreName:{value:$c.coreName},
      pullIdentityName:{value:$c.pullIdentityName},
      communicationName:{value:$c.communicationName},
      communicationDataLocation:{value:($c.communicationDataLocation // "United States")},
      approvedSystemMiniapps:{value:($c.approvedSystemMiniapps // ["com.mentra.settings"])},
      managedMiniapps:{value:($c.managedMiniapps // [])},
      miniappConfiguration:{value:($c.miniappConfiguration // {})},
      managedMiniappDirectory:{value:($c.managedMiniappDirectory // "")},
      allowedGlassesModels:{value:($c.allowedGlassesModels // ["mentra-live"])},
      telemetryEnabled:{value:($c.telemetryEnabled // false)},
      privacyPolicyUrl:{value:($c.privacyPolicyUrl // "")},
      termsOfServiceUrl:{value:($c.termsOfServiceUrl // "")},
      documentationUrl:{value:($c.documentationUrl // "")},
      supportUrl:{value:($c.supportUrl // "")}
    }
  }' > "$PARAMETERS"

az deployment group create \
  --name "$DEPLOYMENT_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --template-file "$TEMPLATE_DIR/main.bicep" \
  --parameters "@$PARAMETERS" \
  --query properties.provisioningState \
  --output tsv | grep --fixed-strings --line-regexp Succeeded >/dev/null

WORKSPACE="$(az deployment group show \
  --name "$DEPLOYMENT_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --query properties.outputs.workspaceOrigin.value \
  --output tsv)"
"$SCRIPT_DIR/smoke-test.sh" "$WORKSPACE"

az deployment group show \
  --name "$DEPLOYMENT_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --query properties.outputs \
  --output json
