export function installedReleaseIdentity(): string {
  return process.env.EXPO_PUBLIC_MENTRAOS_VERSION?.trim() || "unknown"
}
