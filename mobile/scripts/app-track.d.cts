export function resolveAppTrack(options?: {
  env?: Record<string, string | undefined>
  run?: (args: string[]) => string
}): "dev" | "staging"
