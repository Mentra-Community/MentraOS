#!/usr/bin/env bash
set -euo pipefail

CORE_NAME="${CORE_NAME:-Mentra Core}"
MOBILE_NAME="${MOBILE_NAME:-Mentra Mobile}"
CORE_CLIENT_ID="${CORE_CLIENT_ID:-}"
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
    "  --core-name NAME          Display name when creating/finding Core (default: $CORE_NAME)" \
    "  --mobile-name NAME           Display name when creating/finding Mobile (default: $MOBILE_NAME)" \
    "  --core-client-id UUID     Reconcile this existing Core registration" \
    "  --mobile-client-id UUID      Reconcile this existing Mobile registration" \
    "  --grant-admin-consent        Grant tenant-wide consent after configuring permissions" \
    "  --help                       Show this help" \
    "" \
    "Run while signed into the customer's tenant as an Application/Cloud Application or Global Administrator."
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --core-name) CORE_NAME="$2"; shift 2 ;;
    --mobile-name) MOBILE_NAME="$2"; shift 2 ;;
    --core-client-id) CORE_CLIENT_ID="$2"; shift 2 ;;
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
  # Newly created apps request AzureADMyOrg above; an existing app must already
  # be single-tenant so this helper never reconciles a multi-tenant registration.
  [[ "$(az ad app show --id "$object_id" --query signInAudience -o tsv)" == "AzureADMyOrg" ]] || {
    printf 'App %s must be single-tenant (AzureADMyOrg).\n' "$display_name" >&2
    exit 1
  }
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

CORE_OBJECT_ID="$(find_or_create_app "$CORE_CLIENT_ID" "$CORE_NAME")"
CORE_CLIENT_ID="$(az ad app show --id "$CORE_OBJECT_ID" --query appId -o tsv)"
CORE_SCOPE_ID="$(az ad app show --id "$CORE_OBJECT_ID" --query "api.oauth2PermissionScopes[?value=='mentra.session'].id | [0]" -o tsv)"
if [[ -z "$CORE_SCOPE_ID" ]]; then
  CORE_SCOPE_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
fi

core_app="$(az ad app show --id "$CORE_OBJECT_ID" -o json)"
core_body="$(jq -cn \
  --arg uri "api://$CORE_CLIENT_ID" \
  --arg scope_id "$CORE_SCOPE_ID" \
  --argjson existing "$core_app" \
  '{identifierUris: (($existing.identifierUris // []) + [$uri] | unique), api:(($existing.api // {}) + {requestedAccessTokenVersion:2, oauth2PermissionScopes: ((($existing.api.oauth2PermissionScopes // []) | map(select(.value != "mentra.session"))) + [{adminConsentDescription:"Allow the Mentra App to access this organization Core on behalf of the signed-in user.",adminConsentDisplayName:"Access Mentra Core",id:$scope_id,isEnabled:true,type:"User",userConsentDescription:"Allow the Mentra App to access your organization Core.",userConsentDisplayName:"Access Mentra Core",value:"mentra.session"}])})}')"
az rest --method PATCH --uri "https://graph.microsoft.com/v1.0/applications/$CORE_OBJECT_ID" \
  --headers 'Content-Type=application/json' --body "$core_body" --output none

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
  --arg core_app "$CORE_CLIENT_ID" --arg session_scope "$CORE_SCOPE_ID" \
  --arg acs_app "$ACS_APP_ID" --arg calls "$ACS_CALLS_SCOPE_ID" --arg chats "$ACS_CHATS_SCOPE_ID" \
  --argjson existing "$mobile_app" \
  '{isFallbackPublicClient:true, publicClient:{redirectUris: (($existing.publicClient.redirectUris // []) + [$ios,$apk,$play] | unique)}, requiredResourceAccess: (((($existing.requiredResourceAccess // []) | map(select(.resourceAppId != $core_app and .resourceAppId != $acs_app)))) + [{resourceAppId:$core_app,resourceAccess:[{id:$session_scope,type:"Scope"}]},{resourceAppId:$acs_app,resourceAccess:[{id:$calls,type:"Scope"},{id:$chats,type:"Scope"}]}])}')"
az rest --method PATCH --uri "https://graph.microsoft.com/v1.0/applications/$MOBILE_OBJECT_ID" \
  --headers 'Content-Type=application/json' --body "$mobile_body" --output none

# Graph will not delete a delegated scope while any client still references it.
# Migrate the Mobile registration first, then leave the legacy scope disabled so
# this helper remains safe when another administrator-owned client still uses it.
core_app="$(az ad app show --id "$CORE_OBJECT_ID" -o json)"
if jq -e '.api.oauth2PermissionScopes // [] | any(.value == "mentra.runtime" and .isEnabled == true)' <<<"$core_app" >/dev/null; then
  disable_legacy_body="$(jq -cn --argjson existing "$core_app" \
    '{api:(($existing.api // {}) + {oauth2PermissionScopes:(($existing.api.oauth2PermissionScopes // []) | map(if .value == "mentra.runtime" then . + {isEnabled:false} else . end))})}')"
  az rest --method PATCH --uri "https://graph.microsoft.com/v1.0/applications/$CORE_OBJECT_ID" \
    --headers 'Content-Type=application/json' --body "$disable_legacy_body" --output none
fi

CORE_SP_ID="$(ensure_service_principal "$CORE_CLIENT_ID")"
MOBILE_SP_ID="$(ensure_service_principal "$MOBILE_CLIENT_ID")"
tag_service_principal "$CORE_SP_ID" false
tag_service_principal "$MOBILE_SP_ID" true

if [[ "$GRANT_ADMIN_CONSENT" == "true" ]]; then
  az ad app permission admin-consent --id "$MOBILE_CLIENT_ID"
fi

jq -n \
  --arg tenantId "$TENANT_ID" \
  --arg coreApiClientId "$CORE_CLIENT_ID" \
  --arg mobileClientId "$MOBILE_CLIENT_ID" \
  --arg sessionScope "api://$CORE_CLIENT_ID/mentra.session" \
  --arg mobileServicePrincipalId "$MOBILE_SP_ID" \
  '{tenantId:$tenantId,coreApiClientId:$coreApiClientId,mobileClientId:$mobileClientId,sessionScope:$sessionScope,mobileServicePrincipalId:$mobileServicePrincipalId}'

if [[ "$GRANT_ADMIN_CONSENT" != "true" ]]; then
  printf '%s\n' 'Admin consent was not granted. Review the permissions, then rerun with --grant-admin-consent.' >&2
fi
printf '%s\n' 'Assign approved pilot users/groups to the Mobile Enterprise Application before testing.' >&2
