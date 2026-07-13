export const AR99_API_ENVS = {
  TEST: "TEST",
  RELEASE: "RELEASE",
  PRE_RELEASE: "PRE_RELEASE",
} as const

export type Ar99ApiEnv = (typeof AR99_API_ENVS)[keyof typeof AR99_API_ENVS]

export type Ar99ApiConfig = {
  baseUrl: string
  developerId: string
  secret: string
}

export const AR99_API_ENV = AR99_API_ENVS.TEST

const AR99_API_CONFIGS: Record<Ar99ApiEnv, Ar99ApiConfig> = {
  [AR99_API_ENVS.TEST]: {
    baseUrl: "https://ai.smartxy.com.cn/",
    developerId: "d54eggd4prh43a7skb30",
    secret: "4ab9e9c9-ab58-4dc7-b593-83e2917fc278",
  },
  [AR99_API_ENVS.RELEASE]: {
    baseUrl: "https://ai.xyaiglasses.com/",
    developerId: "d5afp25m5iuc73fdv3cg",
    secret: "a01afc69-b5c6-477a-88ca-5039cf795086",
  },
  [AR99_API_ENVS.PRE_RELEASE]: {
    baseUrl: "https://test.ai.smartxy.com.cn/",
    developerId: "d5afp25m5iuc73fdv3cg",
    secret: "a01afc69-b5c6-477a-88ca-5039cf795086",
  },
}

export function getAr99ApiConfig(): Ar99ApiConfig {
  return AR99_API_CONFIGS[AR99_API_ENV]
}

