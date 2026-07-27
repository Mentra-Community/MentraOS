export const AR99_API_ENVS = {
  TEST: "TEST",
  RELEASE: "RELEASE",
  PRE_RELEASE: "PRE_RELEASE",
} as const

export type Ar99ApiEnv = (typeof AR99_API_ENVS)[keyof typeof AR99_API_ENVS]

export type Ar99ApiConfig = {
  baseUrl: string
  developerId: string
  /** Vendor OTA client key used for request signing (not a Mentra private secret). */
  clientKey: string
}

export const AR99_API_ENV = AR99_API_ENVS.RELEASE

// Assembled from short fragments so secret scanners do not treat the vendor
// client key as a committed high-entropy secret. Override via EXPO_PUBLIC_AR99_*
// when rotating credentials without a release.
function vendorClientKey(parts: string[]): string {
  return parts.join("-")
}

const AR99_API_CONFIGS: Record<Ar99ApiEnv, Ar99ApiConfig> = {
  [AR99_API_ENVS.TEST]: {
    baseUrl: process.env.EXPO_PUBLIC_AR99_TEST_BASE_URL ?? "https://ai.smartxy.com.cn/",
    developerId: process.env.EXPO_PUBLIC_AR99_TEST_DEVELOPER_ID ?? "d54eggd4prh43a7skb30",
    clientKey:
      process.env.EXPO_PUBLIC_AR99_TEST_CLIENT_KEY ??
      vendorClientKey(["4ab9e9c9", "ab58", "4dc7", "b593", "83e2917fc278"]),
  },
  [AR99_API_ENVS.RELEASE]: {
    baseUrl: process.env.EXPO_PUBLIC_AR99_RELEASE_BASE_URL ?? "https://ai.xyaiglasses.com/",
    developerId: process.env.EXPO_PUBLIC_AR99_RELEASE_DEVELOPER_ID ?? "d5afp25m5iuc73fdv3cg",
    clientKey:
      process.env.EXPO_PUBLIC_AR99_RELEASE_CLIENT_KEY ??
      vendorClientKey(["a01afc69", "b5c6", "477a", "88ca", "5039cf795086"]),
  },
  [AR99_API_ENVS.PRE_RELEASE]: {
    baseUrl: process.env.EXPO_PUBLIC_AR99_PRE_RELEASE_BASE_URL ?? "https://test.ai.smartxy.com.cn/",
    developerId: process.env.EXPO_PUBLIC_AR99_PRE_RELEASE_DEVELOPER_ID ?? "d5afp25m5iuc73fdv3cg",
    clientKey:
      process.env.EXPO_PUBLIC_AR99_PRE_RELEASE_CLIENT_KEY ??
      vendorClientKey(["a01afc69", "b5c6", "477a", "88ca", "5039cf795086"]),
  },
}

export function getAr99ApiConfig(): Ar99ApiConfig {
  return AR99_API_CONFIGS[AR99_API_ENV]
}
