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
  (.releaseTag | test("^[A-Za-z0-9._-]+$")) and
  (.tenantId | guid) and
  (.coreApiClientId | guid) and
  (.mobileClientId | guid) and
  (.deploymentId | nonempty) and
  (.displayName | nonempty) and
  (.environmentName | nonempty) and
  (.pullIdentityName | nonempty) and
  (.communicationName | nonempty) and
  (.runtimeName | container_app_name) and
  (.coreName | container_app_name) and
  ((.miniappConfiguration // {}) | miniapp_configuration_map) and
  ($minVersion | semver) and
  ($recommendedVersion | semver) and
  (($recommendedVersion | semver_key) >= ($minVersion | semver_key))
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
      clientRecommendedVersion:{value:($c.clientRecommendedVersion // $c.clientMinVersion // "0.0.0")},
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
