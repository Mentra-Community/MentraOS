/**
 * @fileoverview The Mentra App's sign-in credentials, in the platform secure store (Keychain / Keystore-backed).
 *
 * Holds the Mentra account session (Cloud V2 access and refresh tokens), the PKCE state and verifier of an OAuth
 * sign-in in progress, and the Authing session of the China deployment. Earlier builds kept these in the default
 * MMKV instance with `storage.save`; the vault moves them out on first use. It also deletes the credentials of retired
 * sign-ins that older builds left there and nothing reads: the Supabase session of the pre-Cloud-V2 sign-in, and the
 * Cloud V1 `core_token` setting older builds persisted.
 *
 * The cached account profile (`mentra.account.userProfile`) is not a credential and stays in MMKV.
 */
import {createPlatformCredentialVault, mmkvLegacyCredentials} from "@mentra/engine-host-internal"

export const ACCOUNT_CREDENTIAL_KEYS = {
  accessToken: "mentra.account.accessToken",
  refreshToken: "mentra.account.refreshToken",
  oauthState: "mentra.account.oauth.state",
  oauthVerifier: "mentra.account.oauth.verifier",
  authingSession: "authing_session",
} as const

/**
 * The retired sign-ins' keys: the Supabase client's (`supabase.auth.*`, and supabase-js's `sb-<project>-auth-token`
 * with its `-code-verifier` and `-user` companions), and `core_token`, which the settings store keeps in memory only
 * now.
 */
function isRetiredKey(key: string): boolean {
  return key === "core_token" || key.startsWith("supabase.auth.") || /^sb-[a-z0-9]+-auth-token(-[a-z-]+)?$/.test(key)
}

export const accountCredentials = createPlatformCredentialVault(
  "account",
  mmkvLegacyCredentials({
    keys: Object.values(ACCOUNT_CREDENTIAL_KEYS),
    encoding: "json",
    isRetiredKey,
  }),
)

/** Whether this phone holds a Mentra account session (either token), without contacting Core. */
export async function hasStoredAccountSession(): Promise<boolean> {
  const [access, refresh] = await Promise.all([
    accountCredentials.get(ACCOUNT_CREDENTIAL_KEYS.accessToken),
    accountCredentials.get(ACCOUNT_CREDENTIAL_KEYS.refreshToken),
  ])
  return Boolean(access) || Boolean(refresh)
}
