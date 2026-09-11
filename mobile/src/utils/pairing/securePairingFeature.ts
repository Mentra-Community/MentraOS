/**
 * Secure Mentra Live ownership is coordinated with BES firmware and remains
 * disabled unless a release explicitly opts in on both sides.
 */
export const isMentraLiveSecurePairingEnabled = (): boolean =>
  process.env.EXPO_PUBLIC_ENABLE_MENTRA_LIVE_SECURE_PAIRING === "true"
