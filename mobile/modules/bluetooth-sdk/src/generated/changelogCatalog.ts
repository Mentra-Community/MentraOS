/** Generated from /changelogs. Do not edit directly. */
export const GENERATED_RELEASE_CHANGELOGS = Object.freeze(
[
  {
    "version": "3.2.0",
    "markdown": "This release is under active development. User-facing changes will be documented as they land.\n\n- Breaking Bluetooth SDK change: `forgetWifiNetwork(ssid)` now returns `WifiForgetResult` instead of `WifiStatusChangeEvent`. Migrate status-only consumers to the semantic `outcome`; the requested network remains `ssid`, while optional post-command connectivity is reported by `connected`, `currentSsid`, and `localIp`."
  },
  {
    "version": "3.1.0",
    "markdown": "Software updates are more reliable, with clearer progress and recovery when the glasses restart.\n\n- MentraOS, Mentra Engine, the Bluetooth SDK, and the glasses client now share one coordinated release version.\n- Mentra Live updates can continue across APK, system, and firmware restarts without asking the user to start the same update again.\n- Bluetooth photo capture and transfer diagnostics are more precise and less disruptive to normal glasses traffic."
  }
] as const,
)
