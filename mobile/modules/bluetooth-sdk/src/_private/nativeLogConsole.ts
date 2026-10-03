type LogSource = {
  addListener(event: "log", listener: (event: {message: string}) => void): {remove(): void}
}

// The native module survives Fast Refresh. Replace its previous subscription
// when JS reloads this module, rather than printing each event more than once.
const subscriptionKey = Symbol.for("mentra.bluetooth-sdk.native-log-console")
type SubscribedLogSource = LogSource & {[subscriptionKey]?: {remove(): void}}

const credentialPattern =
  /(?<![A-Za-z0-9])(?:access[_-]?token|refresh[_-]?token|auth[_-]?token|id[_-]?token|client[_-]?secret|api[_-]?key)(?![A-Za-z0-9])|(?<![A-Za-z0-9])(?:token|password|secret|authorization|auth|key)(?![A-Za-z0-9])\s*["']?\s*(?:is\s*)?[:=]\s*["']?\S+|(?<![A-Za-z0-9])bearer(?![A-Za-z0-9])\s+\S+/i

export function nativeLogMessage(message: string): string {
  return credentialPattern.test(message) ? "[REDACTED]" : message.slice(0, 16_384)
}

export function installNativeLogConsole(source: SubscribedLogSource, platform: string): void {
  source[subscriptionKey]?.remove()
  source[subscriptionKey] = source.addListener("log", ({message}) => {
    // Resolve console at delivery time so host console interception receives
    // native diagnostics in the same stream as ordinary JS logs.
    console.log(`[native:${platform}]`, nativeLogMessage(message))
  })
}
