#!/usr/bin/env bun
// glasses — thin client for the glasses daemon (daemon.mjs). No Bluetooth here,
// so it runs under plain bun/node; the daemon does the BLE. Keeps the glasses
// connected across commands.
//
//   bun glasses.mjs connect 3248      # connect to YOUR glasses (serial suffix)
//   bun glasses.mjs text "hello"      # draw text on the live link
//   bun glasses.mjs clear
//   bun glasses.mjs mic on|off
//   bun glasses.mjs status
//   bun glasses.mjs logs
//   bun glasses.mjs disconnect        # drop the BLE link (daemon stays up)
//   bun glasses.mjs shutdown          # stop the daemon
//
// PORT override: GLASSES_PORT env (default 8799).

const PORT = process.env.GLASSES_PORT || "8799"
const BASE = `http://127.0.0.1:${PORT}`
const [, , cmd, ...rest] = process.argv

async function call(method, path, bodyObj) {
  const res = await fetch(BASE + path, {
    method,
    headers: bodyObj ? { "Content-Type": "application/json" } : undefined,
    body: bodyObj ? JSON.stringify(bodyObj) : undefined,
  }).catch((e) => {
    console.error(`cannot reach daemon on ${BASE} — start it with ./gd.sh start`)
    process.exit(1)
  })
  const j = await res.json().catch(() => ({}))
  return j
}

const pretty = (o) => console.log(JSON.stringify(o, null, 2))

switch (cmd) {
  case "connect":
    // second arg is SECONDS (human-friendly); daemon wants ms
    pretty(await call("POST", "/connect", { serial: rest[0] || "G2_", waitMs: Number(rest[1] || 30) * 1000 }))
    break
  case "text":
    pretty(await call("POST", "/text", { text: rest.join(" ") }))
    break
  case "clear":
    pretty(await call("POST", "/clear"))
    break
  case "mic":
    pretty(await call("POST", "/mic", { enable: rest[0] === "on" || rest[0] === "true" }))
    break
  case "brightness":
    pretty(await call("POST", "/brightness", { level: Number(rest[0]), auto: rest[1] === "auto" }))
    break
  case "headup":
    pretty(await call("POST", "/headup", { angle: Number(rest[0]) }))
    break
  case "image":
    // image [width] [height] — draws a demo test pattern on the lens
    pretty(await call("POST", "/image", { width: Number(rest[0] || 200), height: Number(rest[1] || 100) }))
    break
  case "imu":
    pretty(await call("POST", "/imu", { enable: rest[0] === "on" || rest[0] === "true", freq: Number(rest[1] || 100) }))
    break
  case "info":
    pretty(await call("GET", "/info"))
    break
  case "photo": // photo [wifi|ble] [size] — captures and delivers the image back to the harness
    pretty(await call("POST", "/photo", { transferMethod: rest[0] || "ble", size: rest[1] || "medium" }))
    break
  case "photos": // list images received by the media server
    pretty(await call("GET", "/photos"))
    break
  case "stream": // stream start [rtmpUrl] | stream stop
    if (rest[0] === "stop") pretty(await call("POST", "/stream/stop"))
    else pretty(await call("POST", "/stream/start", rest[1] ? { streamUrl: rest[1] } : {}))
    break
  case "live": // send an arbitrary Mentra Live JSON command, e.g. live '{"type":"request_wifi_status"}'
    pretty(await call("POST", "/live", { cmd: JSON.parse(rest.join(" ")) }))
    break
  case "events": // recent decoded events (battery/gesture/photo/wifi/version/...)
    (await call("GET", "/liveEvents")).events?.forEach((e) => console.log(JSON.stringify(e)))
    break
  case "status":
    pretty(await call("GET", "/status"))
    break
  case "logs":
    (await call("GET", "/logs")).logs?.forEach((l) => console.log(l))
    break
  case "disconnect":
    pretty(await call("POST", "/disconnect"))
    break
  case "shutdown":
    pretty(await call("POST", "/shutdown"))
    break
  default:
    console.log(
      "usage: glasses.mjs {connect <serial>|text <...>|clear|image [w] [h]|mic on|off|imu on|off|brightness <0-255> [auto]|headup <angle>|info|status|logs|disconnect|shutdown}",
    )
}
