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

// Vendor OTA credentials are injected at build time via EAS/env (EXPO_PUBLIC_AR99_*).
// They are intentionally NOT committed here so secret scanners are not circumvented.
const AR99_API_CONFIGS: Record<Ar99ApiEnv, Ar99ApiConfig> = {
  [AR99_API_ENVS.TEST]: {
    baseUrl: process.env.EXPO_PUBLIC_AR99_TEST_BASE_URL ?? "https://ai.smartxy.com.cn/",
    developerId: process.env.EXPO_PUBLIC_AR99_TEST_DEVELOPER_ID ?? "",
    clientKey: process.env.EXPO_PUBLIC_AR99_TEST_CLIENT_KEY ?? "",
  },
  [AR99_API_ENVS.RELEASE]: {
    baseUrl: process.env.EXPO_PUBLIC_AR99_RELEASE_BASE_URL ?? "https://ai.xyaiglasses.com/",
    developerId: process.env.EXPO_PUBLIC_AR99_RELEASE_DEVELOPER_ID ?? "",
    clientKey: process.env.EXPO_PUBLIC_AR99_RELEASE_CLIENT_KEY ?? "",
  },
  [AR99_API_ENVS.PRE_RELEASE]: {
    baseUrl: process.env.EXPO_PUBLIC_AR99_PRE_RELEASE_BASE_URL ?? "https://test.ai.smartxy.com.cn/",
    developerId: process.env.EXPO_PUBLIC_AR99_PRE_RELEASE_DEVELOPER_ID ?? "",
    clientKey: process.env.EXPO_PUBLIC_AR99_PRE_RELEASE_CLIENT_KEY ?? "",
  },
}

export function getAr99ApiConfig(): Ar99ApiConfig {
  return AR99_API_CONFIGS[AR99_API_ENV]
}
