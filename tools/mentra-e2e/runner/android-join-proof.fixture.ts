export const traceFixture = {
  pid: 20979,
  traceId: "99bf48e5",
  ssid: "MentraLive_b9a02c",
  startedAtMs: 100000,
  logPath: "unused",
}
export const connected =
  "acs_call_state callId=4295c0cc-9fd8-4551-b6ff-4351d2d72a0b state=connected callPhase=connected"
export const stages = [
  "native_join_scoped_network_begin ssid=MentraLive_b9a02c",
  "scoped_network_available ssid=MentraLive_b9a02c localIpv4=192.168.43.206",
  "scoped_network_ready localIpv4=192.168.43.206 claimed=wlan0 owner=wlan0 agrees=true capabilitiesSeen=true",
  "native_join_scoped_network_end",
  connected,
]
export const line = (stage: string, at: number) =>
  `${(at / 1000).toFixed(3)} 20979 21186 I SOFTAP-TRACE: [SOFTAP_TRACE] traceId=99bf48e5 stage=${stage}\n`
export const nativeJoinLog = (start = traceFixture.startedAtMs) =>
  stages.map((s, i) => line(s, start + i * 1000)).join("")
