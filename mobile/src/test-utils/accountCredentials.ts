import {ACCOUNT_CREDENTIAL_KEYS, accountCredentials} from "@/utils/auth/accountCredentials"

/** Signs this test process out: deletes every account credential from the secure store. */
export async function resetAccountCredentials(): Promise<void> {
  await Promise.all(Object.values(ACCOUNT_CREDENTIAL_KEYS).map((key) => accountCredentials.delete(key)))
}

/** The stored value of one account credential, or null. */
export function storedCredential(key: string): Promise<string | null> {
  return accountCredentials.get(key)
}
