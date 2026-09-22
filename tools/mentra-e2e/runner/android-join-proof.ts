import {isIPv4} from "node:net"

export type AndroidJoinTrace = {
  logPath: string
  pid: number
  traceId: string
  ssid: string
  startedAtMs: number
}

/** Read only complete native logcat lines from this attempt, never a UI hint. */
export function androidJoinProof(log: string, trace: AndroidJoinTrace, nowMs: number) {
  let began = false,
    ready = false,
    ended = false
  let localIpv4: string | undefined
  let connected: {callId: string; connectedAtMs: number} | undefined
  let previousMs = trace.startedAtMs
  for (const line of log.slice(0, log.lastIndexOf("\n") + 1).split("\n")) {
    const match = /^\s*(\d+\.\d+)\s+(\d+)\s+\d+\s+[IDEW]\s+SOFTAP-TRACE:\s+\[SOFTAP_TRACE\] (.*)$/.exec(line)
    if (!match || Number(match[2]) !== trace.pid) continue
    const at = Number(match[1]) * 1000
    if (at < trace.startedAtMs || at > nowMs) continue
    const fields = Object.fromEntries([...match[3].matchAll(/(?:^|\s)(\w+)=([^\s]+)/g)].map((m) => [m[1], m[2]]))
    if (fields.traceId !== trace.traceId) {
      // A new join in the same process supersedes this attempt's evidence.
      if (fields.stage === "native_join_scoped_network_begin") return null
      continue
    }
    if (at < previousMs) return null
    previousMs = at
    const stage = fields.stage
    if (!stage) return null
    if (
      stage === "scoped_network_released" ||
      stage.startsWith("scoped_network_lost") ||
      stage === "scoped_network_not_ready" ||
      stage.startsWith("session_hangup") ||
      (stage === "acs_call_state" && ["disconnecting", "disconnected"].includes(fields.state))
    )
      return null
    if (stage === "native_join_scoped_network_begin") {
      if (began || fields.ssid !== trace.ssid) return null
      began = true
    } else if (stage === "scoped_network_available") {
      if (!began || fields.ssid !== trace.ssid || !isIPv4(fields.localIpv4 || "")) return null
      localIpv4 = fields.localIpv4
      ready = ended = false
      connected = undefined
    } else if (stage === "scoped_network_ready") {
      if (
        !localIpv4 ||
        fields.localIpv4 !== localIpv4 ||
        fields.agrees !== "true" ||
        fields.capabilitiesSeen !== "true" ||
        !/^wlan\d+$/.test(fields.owner || "") ||
        fields.claimed !== fields.owner
      )
        return null
      ready = true
    } else if (stage === "native_join_scoped_network_end") {
      if (!ready) return null
      ended = true
    } else if (stage === "acs_call_state") {
      if (fields.state === "connected" && fields.callPhase === "connected") {
        if (!ended || !/^[a-f0-9-]{36}$/.test(fields.callId || "")) return null
        if (connected && connected.callId !== fields.callId) return null
        connected = {callId: fields.callId, connectedAtMs: at}
      } else connected = undefined
    }
  }
  return connected && localIpv4
    ? {pid: trace.pid, traceId: trace.traceId, ssid: trace.ssid, localIpv4, ...connected}
    : null
}
