#!/usr/bin/env bash
set -euo pipefail

RUNTIME_NAME="${RUNTIME_NAME:-Mentra Runtime}"
MOBILE_NAME="${MOBILE_NAME:-Mentra Mobile}"
RUNTIME_CLIENT_ID="${RUNTIME_CLIENT_ID:-}"
MOBILE_CLIENT_ID="${MOBILE_CLIENT_ID:-}"
GRANT_ADMIN_CONSENT=false
IOS_REDIRECT="msauth.com.mentra.mentra://auth"
APK_REDIRECT="msauth://com.mentra.mentra/q%2FZbvbReOLgD1T6V3o1PK%2Fzjwz0%3D"
PLAY_REDIRECT="msauth://com.mentra.mentra/Pwi%2FLvF9HHWTAMonaqwan%2BeIX6A%3D"
ACS_APP_ID="1fd5118e-2576-4263-8130-9503064c837a"
INTEGRATED_TAG="WindowsAzureActiveDirectoryIntegratedApp"

usage() {
  printf '%s\n' \
    "Usage: $0 [options]" \
    "" \
    "Creates or reconciles the two single-tenant Entra registrations used by a Mentra Private Deployment." \
    "" \
    "  --runtime-name NAME          Display name when creating/finding Runtime (default: $RUNTIME_NAME)" \
    "  --mobile-name NAME           Display name when creating/finding Mobile (default: $MOBILE_NAME)" \
    "  --runtime-client-id UUID     Reconcile this existing Runtime registration" \
    "  --mobile-client-id UUID      Reconcile this existing Mobile registration" \
    "  --grant-admin-consent        Grant tenant-wide consent after configuring permissions" \
    "  --help                       Show this help" \
    "" \
    "Run while signed into the customer's tenant as an Application/Cloud Application or Global Administrator."
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --runtime-name) RUNTIME_NAME="$2"; shift 2 ;;
    --mobile-name) MOBILE_NAME="$2"; shift 2 ;;
    --runtime-client-id) RUNTIME_CLIENT_ID="$2"; shift 2 ;;
    --mobile-client-id) MOBILE_CLIENT_ID="$2"; shift 2 ;;
    --grant-admin-consent) GRANT_ADMIN_CONSENT=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

for command in az jq uuidgen; do
  command -v "$command" >/dev/null || { printf '%s is required\n' "$command" >&2; exit 1; }
done

TENANT_ID="$(az account show --query tenantId -o tsv)"
[[ -n "$TENANT_ID" ]] || { printf 'Azure CLI is not signed in\n' >&2; exit 1; }

find_or_create_app() {
  local client_id="$1"
  local display_name="$2"
  local object_id
  if [[ -n "$client_id" ]]; then
    object_id="$(az ad app show --id "$client_id" --query id -o tsv)"
  else
    local matches
    matches="$(az ad app list --display-name "$display_name" --query 'length(@)' -o tsv)"
    if [[ "$matches" == "0" ]]; then
      object_id="$(az ad app create --display-name "$display_name" --sign-in-audience AzureADMyOrg --query id -o tsv)"
    elif [[ "$matches" == "1" ]]; then
      object_id="$(az ad app list --display-name "$display_name" --query '[0].id' -o tsv)"
    else
      printf 'More than one app registration is named %s; pass its client id explicitly.\n' "$display_name" >&2
      exit 1
    fi
  fi
  printf '%s' "$object_id"
}

ensure_service_principal() {
  local client_id="$1"
  local sp_id
  sp_id="$(az ad sp list --filter "appId eq '$client_id'" --query '[0].id' -o tsv)"
  if [[ -z "$sp_id" ]]; then
    sp_id="$(az ad sp create --id "$client_id" --query id -o tsv)"
  fi
  printf '%s' "$sp_id"
}

tag_service_principal() {
  local sp_id="$1"
  local require_assignment="$2"
  local tags body
  tags="$(az rest --method GET --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$sp_id" --query tags -o json)"
  body="$(jq -cn --arg tag "$INTEGRATED_TAG" --argjson tags "${tags:-[]}" --argjson required "$require_assignment" \
    '{tags: (($tags + [$tag]) | unique), appRoleAssignmentRequired: $required}')"
  az rest --method PATCH --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$sp_id" \
    --headers 'Content-Type=application/json' --body "$body" --output none
}

RUNTIME_OBJECT_ID="$(find_or_create_app "$RUNTIME_CLIENT_ID" "$RUNTIME_NAME")"
RUNTIME_CLIENT_ID="$(az ad app show --id "$RUNTIME_OBJECT_ID" --query appId -o tsv)"
RUNTIME_SCOPE_ID="$(az ad app show --id "$RUNTIME_OBJECT_ID" --query "api.oauth2PermissionScopes[?value=='mentra.runtime'].id | [0]" -o tsv)"
if [[ -z "$RUNTIME_SCOPE_ID" ]]; then
  RUNTIME_SCOPE_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
fi

runtime_app="$(az ad app show --id "$RUNTIME_OBJECT_ID" -o json)"
runtime_body="$(jq -cn \
  --arg uri "api://$RUNTIME_CLIENT_ID" \
  --arg scope_id "$RUNTIME_SCOPE_ID" \
  --argjson existing "$runtime_app" \
  '{identifierUris: (($existing.identifierUris // []) + [$uri] | unique), api:(($existing.api // {}) + {requestedAccessTokenVersion:2, oauth2PermissionScopes: ((($existing.api.oauth2PermissionScopes // []) | map(select(.value != "mentra.runtime"))) + [{adminConsentDescription:"Allow the Mentra App to access this organization Runtime on behalf of the signed-in user.",adminConsentDisplayName:"Access Mentra Runtime",id:$scope_id,isEnabled:true,type:"User",userConsentDescription:"Allow the Mentra App to access your organization Runtime.",userConsentDisplayName:"Access Mentra Runtime",value:"mentra.runtime"}])})}')"
az rest --method PATCH --uri "https://graph.microsoft.com/v1.0/applications/$RUNTIME_OBJECT_ID" \
  --headers 'Content-Type=application/json' --body "$runtime_body" --output none

MOBILE_OBJECT_ID="$(find_or_create_app "$MOBILE_CLIENT_ID" "$MOBILE_NAME")"
MOBILE_CLIENT_ID="$(az ad app show --id "$MOBILE_OBJECT_ID" --query appId -o tsv)"

ACS_SP_ID="$(ensure_service_principal "$ACS_APP_ID")"
ACS_SP="$(az ad sp show --id "$ACS_SP_ID" -o json)"
ACS_CALLS_SCOPE_ID="$(jq -r '.oauth2PermissionScopes[] | select(.value == "Teams.ManageCalls") | .id' <<<"$ACS_SP")"
ACS_CHATS_SCOPE_ID="$(jq -r '.oauth2PermissionScopes[] | select(.value == "Teams.ManageChats") | .id' <<<"$ACS_SP")"
[[ -n "$ACS_CALLS_SCOPE_ID" && -n "$ACS_CHATS_SCOPE_ID" ]] || { printf 'Required ACS delegated scopes were not found.\n' >&2; exit 1; }

mobile_app="$(az ad app show --id "$MOBILE_OBJECT_ID" -o json)"
mobile_body="$(jq -cn \
  --arg ios "$IOS_REDIRECT" --arg apk "$APK_REDIRECT" --arg play "$PLAY_REDIRECT" \
  --arg runtime_app "$RUNTIME_CLIENT_ID" --arg runtime_scope "$RUNTIME_SCOPE_ID" \
  --arg acs_app "$ACS_APP_ID" --arg calls "$ACS_CALLS_SCOPE_ID" --arg chats "$ACS_CHATS_SCOPE_ID" \
  --argjson existing "$mobile_app" \
  '{isFallbackPublicClient:true, publicClient:{redirectUris: (($existing.publicClient.redirectUris // []) + [$ios,$apk,$play] | unique)}, requiredResourceAccess: (((($existing.requiredResourceAccess // []) | map(select(.resourceAppId != $runtime_app and .resourceAppId != $acs_app)))) + [{resourceAppId:$runtime_app,resourceAccess: (((($existing.requiredResourceAccess // []) | map(select(.resourceAppId == $runtime_app)) | .[0].resourceAccess // []) + [{id:$runtime_scope,type:"Scope"}]) | unique_by(.id))},{resourceAppId:$acs_app,resourceAccess: (((($existing.requiredResourceAccess // []) | map(select(.resourceAppId == $acs_app)) | .[0].resourceAccess // []) + [{id:$calls,type:"Scope"},{id:$chats,type:"Scope"}]) | unique_by(.id))}])}')"
az rest --method PATCH --uri "https://graph.microsoft.com/v1.0/applications/$MOBILE_OBJECT_ID" \
  --headers 'Content-Type=application/json' --body "$mobile_body" --output none

RUNTIME_SP_ID="$(ensure_service_principal "$RUNTIME_CLIENT_ID")"
MOBILE_SP_ID="$(ensure_service_principal "$MOBILE_CLIENT_ID")"
tag_service_principal "$RUNTIME_SP_ID" false
tag_service_principal "$MOBILE_SP_ID" true

if [[ "$GRANT_ADMIN_CONSENT" == "true" ]]; then
  az ad app permission admin-consent --id "$MOBILE_CLIENT_ID"
fi

jq -n \
  --arg tenantId "$TENANT_ID" \
  --arg runtimeApiClientId "$RUNTIME_CLIENT_ID" \
  --arg mobileClientId "$MOBILE_CLIENT_ID" \
  --arg runtimeScope "api://$RUNTIME_CLIENT_ID/mentra.runtime" \
  --arg mobileServicePrincipalId "$MOBILE_SP_ID" \
  '{tenantId:$tenantId,runtimeApiClientId:$runtimeApiClientId,mobileClientId:$mobileClientId,runtimeScope:$runtimeScope,mobileServicePrincipalId:$mobileServicePrincipalId}'

if [[ "$GRANT_ADMIN_CONSENT" != "true" ]]; then
  printf '%s\n' 'Admin consent was not granted. Review the permissions, then rerun with --grant-admin-consent.' >&2
fi
printf '%s\n' 'Assign approved pilot users/groups to the Mobile Enterprise Application before testing.' >&2
