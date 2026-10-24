export type MentraAuthUser = {
  id: string
  email?: string
  name: string
  avatarUrl?: string
  createdAt?: string
  provider?: string
}

export type MentraAuthSession = {
  token?: string
  user?: MentraAuthUser
}

export type MentraSigninResponse = {
  session: MentraAuthSession | null
  user: MentraAuthUser | null
}

/**
 * An email link would sign this phone in to `email`. `current` is the account signed in now, or null when signed out.
 * The person confirms before a link changes which account the app uses.
 */
export type LinkSignInAccount = {email: string; current: {email?: string} | null}

/** Asks the person whether to sign in with the link. Resolves false when they decline or can't be asked. */
export type ConfirmLinkSignIn = (account: LinkSignInAccount) => Promise<boolean>

export type LinkSignInResult = "signed_in" | "declined"
