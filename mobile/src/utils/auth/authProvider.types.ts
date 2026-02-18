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
