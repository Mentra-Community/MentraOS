// G2Manager — persistent Even G2 connection, the node port of the repo's
// SGCManager + G2.kt. Owns the BLE lifecycle and exposes a live command/event
// surface so callers connect ONCE and keep driving the glasses.
//
// Lifecycle: scan(serial) -> connect both arms -> bond -> discover -> subscribe
// notify(5402)+audio(6402) -> auth handshake -> heartbeats -> stay connected.
// Reconnect is best-effort on drop. All writes are serialized through one queue.
//
// Events (EventEmitter): "log", "state", "notify", "tap", "audio".
// Must run inside MentraBLE.app (CoreBluetooth permission) — see daemon.mjs.

import noble from "@abandonware/noble"
import { EventEmitter } from "node:events"
import * as g2 from "./g2.mjs"
import * as g1 from "./g1.mjs"
import * as live from "./live.mjs"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export class G2Manager extends EventEmitter {
  constructor() {
    super()
    this.arms = { L: null, R: null } // { peripheral, writeChar }
    this.send = new g2.SendManager()
    this.g1seq = new g1.G1Seq()
    this.device = null // "g1" | "g2", detected on connect
    this.connected = false
    this.match = null
    this.pageCreated = false
    this.lastText = null
    this.audioFrames = 0
    this.status_ = null // battery/charging/firmware from the glasses
    this.imuEnabled = false
    this.micEnabled = false
    this._q = Promise.resolve() // serialize BLE writes
    this._hb = []
    // Auto-reconnect is OFF by default: a device that drops repeatedly (e.g. a
    // Mentra Live still trying to rebond to its phone) would otherwise spin a
    // connect/announce/drop loop that makes the glasses misbehave. Opt in only
    // for a known-stable held link.
    this._autoReconnect = false
    this._reconnectTries = 0
    this._rx = Buffer.alloc(0) // Mentra Live K900 frame reassembly buffer
    this._fileRx = Buffer.alloc(0) // Mentra Live file-packet (72FF) reassembly buffer
    this._fileTransfers = new Map() // fileName -> { fileSize, packs: Map(index->Buffer) }
  }

  log(m) {
    this.emit("log", `[g2] ${m}`)
  }

  status() {
    return {
      connected: this.connected,
      device: this.device, // "g1" | "g2"
      match: this.match,
      arms: { L: !!this.arms.L, R: !!this.arms.R },
      lastText: this.lastText,
      audioFrames: this.audioFrames,
      micEnabled: this.micEnabled,
      imuEnabled: this.imuEnabled,
      info: this.status_, // battery/charging/firmware (null until requestInfo)
    }
  }

  // ---- connection ----
  async start(match, { waitMs = 30000 } = {}) {
    this.match = match
    // A fresh start may target a DIFFERENT device family than the last session
    // (e.g. G2 then a Live on the same daemon); never carry the old protocol over.
    this.device = null
    this.pageCreated = false
    this.status_ = null
    await this._ready()
    const found = await this._scan(match, waitMs)
    if (!found.L && !found.R) throw new Error(`no arms matched "${match}" (wake glasses, off phone)`)
    for (const side of ["L", "R"]) {
      if (found[side]) {
        try { await this._setupArm(side, found[side]) }
        catch (e) { this.log(`${side} setup failed: ${e.message || e}`) }
      }
    }
    if (!this.arms.L && !this.arms.R) throw new Error("no arm connected (all timed out)")
    await this._auth()
    this._startHeartbeats()
    this.connected = true
    this._reconnectTries = 0
    this.emit("state", this.status())
    this.log("connected + authed; link is live")
    return this.status()
  }

  _ready() {
    return new Promise((res) => {
      if (noble.state === "poweredOn") return res()
      noble.on("stateChange", (s) => s === "poweredOn" && res())
    })
  }

  _scan(match, waitMs) {
    return new Promise(async (resolve) => {
      const found = {}
      const m = match.toLowerCase()
      let timer = null
      const done = async () => {
        clearTimeout(timer)
        noble.removeListener("discover", onDisc)
        try { await noble.stopScanningAsync() } catch {}
        resolve(found)
      }
      const onDisc = (p) => {
        const name = p.advertisement?.localName || ""
        const serial = g2.decodeSerial(p.advertisement?.manufacturerData) || ""
        if (!(serial.toLowerCase().includes(m) || name.toLowerCase().includes(m))) return
        const side = /_L_|_L$/.test(name) ? "L" : /_R_|_R$/.test(name) ? "R" : null
        if (side) {
          if (!found[side]) {
            found[side] = p
            this.log(`found ${side}: ${name} (serial ${serial || "?"})`)
            if (found.L && found.R) done()
          }
        } else if (!found.L) {
          // Single-device family (Mentra Live / Nex / Mach1): no L/R arms.
          found.L = p
          this.log(`found single device: ${name}`)
          done()
        }
      }
      noble.on("discover", onDisc)
      await noble.startScanningAsync([], false)
      timer = setTimeout(done, waitMs)
    })
  }

  async _setupArm(side, p) {
    this.log(`connecting ${side} (${p.advertisement.localName})...`)
    await this._withTimeout(p.connectAsync(), 15000, `${side} connect`)
    const { characteristics } = await p.discoverAllServicesAndCharacteristicsAsync()
    // Detect protocol from the device name + which characteristics are present.
    // Mentra Live: 71ff write / 70ff notify / LC3 mic on 6e400002. G2: EvenHub
    // 5401/5402/6402. G1: Nordic UART 6e40000x.
    const nm = p.advertisement?.localName || ""
    let writeChar, notifyChar, audioChar, device
    if (/mentra[_ ]live/i.test(nm)) {
      device = "live"
      writeChar = characteristics.find((c) => c.uuid.endsWith("71ff"))
      notifyChar = characteristics.find((c) => c.uuid.endsWith("70ff"))
      audioChar = characteristics.find((c) => c.uuid.includes("6e400002")) // LC3 mic notify
      // File transfer (BLE photos): K900 file packets arrive on 72FF.
      const fileChar = characteristics.find((c) => c.uuid.endsWith("72ff"))
      if (fileChar) {
        await fileChar.subscribeAsync()
        fileChar.on("data", (d) => this._onFileData(d))
      }
    } else {
      writeChar = characteristics.find((c) => c.uuid.endsWith("5401"))
      notifyChar = characteristics.find((c) => c.uuid.endsWith("5402"))
      audioChar = characteristics.find((c) => c.uuid.endsWith("6402"))
      device = "g2"
      if (!writeChar) {
        writeChar = characteristics.find((c) => c.uuid.includes("6e400002"))
        notifyChar = characteristics.find((c) => c.uuid.includes("6e400003"))
        audioChar = null // G1 audio rides the notify char as 0xF1 packets
        if (writeChar) device = "g1"
      }
    }
    if (!writeChar) throw new Error(`${side}: no known write characteristic (not a Live/G1/G2?)`)
    this.device = this.device || device
    this.log(`${side} protocol: ${this.device.toUpperCase()}`)
    if (this.device === "live" && process.env.LIVE_DEBUG) {
      this._dbgRx = true
      this.log(`live chars: write=${writeChar?.uuid} notify=${notifyChar?.uuid} audio=${audioChar?.uuid}`)
    }
    if (notifyChar) {
      await notifyChar.subscribeAsync()
      notifyChar.on("data", (d) => this._onNotify(side, d))
    }
    if (audioChar) {
      await audioChar.subscribeAsync()
      audioChar.on("data", (d) => {
        let data = d
        if (this.device === "live") {
          const a = live.decodeAudio(d) // strip 0xF1 + seq -> raw LC3
          if (!a) return
          data = a.lc3
        }
        this.audioFrames++
        this.emit("audio", { side, data })
      })
    }
    p.once("disconnect", () => this._onDisconnect(side))
    this.arms[side] = { peripheral: p, writeChar, audioChar }
    this.log(`${side} mtu: ${p.mtu ?? "unknown"}`)
    this.log(`${side} ready`)
  }

  // Mentra Live BLE file transfer (photos): K900 file packets arrive on 72FF,
  // fragmented into MTU-sized notifications. Buffer, parse, reassemble by
  // fileName, then emit the whole file and confirm to the glasses.
  _onFileData(d) {
    this._fileRx = Buffer.concat([this._fileRx, d])
    for (;;) {
      // Resync to the next '##' start code.
      const start = this._fileRx.indexOf(0x23)
      if (start < 0) { this._fileRx = Buffer.alloc(0); return }
      if (start > 0) this._fileRx = this._fileRx.subarray(start)
      if (this._fileRx.length < 31) return // wait for a full header
      const pkt = live.parseFilePacket(this._fileRx)
      if (pkt === null) { this._fileRx = this._fileRx.subarray(2); continue } // bad frame; resync
      if (pkt.incomplete) return // wait for more bytes
      this._fileRx = this._fileRx.subarray(pkt.consumed)
      if (!pkt.valid) { this.log(`file pack ${pkt.packIndex} checksum FAIL (${pkt.fileName})`); continue }
      let t = this._fileTransfers.get(pkt.fileName)
      if (!t) {
        t = { fileSize: pkt.fileSize, packs: new Map(), packSize: pkt.packSize, startedAt: Date.now() }
        this._fileTransfers.set(pkt.fileName, t)
        this.log(`file transfer start: ${pkt.fileName} (${pkt.fileSize}B, packSize ${pkt.packSize})`)
      }
      t.packs.set(pkt.packIndex, pkt.data)
      // Match the phone's completion semantics: count PACKETS, not bytes — the
      // header's fileSize can overstate the actual payload (observed: last pack
      // 89B with fileSize 3200 for a 2889B file), so ceil(fileSize/packSize)
      // packets received = done. packSize comes from the first (full) pack.
      const expected = Math.ceil(t.fileSize / t.packSize)
      this.log(`file pack ${pkt.packIndex} ok (${t.packs.size}/${expected} packs)`)
      if (t.packs.size >= expected) {
        const ordered = [...t.packs.keys()].sort((a, b) => a - b).map((i) => t.packs.get(i))
        const file = Buffer.concat(ordered)
        this._fileTransfers.delete(pkt.fileName)
        this.log(`file transfer complete: ${pkt.fileName} (${file.length}B in ${Date.now() - t.startedAt}ms)`)
        this._live(live.cmd.transferComplete(pkt.fileName, true), true).catch(() => {})
        this.emit("photoFile", { fileName: pkt.fileName, data: file })
      }
    }
  }

  _onNotify(side, d) {
    if (this.device === "live") {
      if (this._dbgRx) this.log(`live rx ${d.length}B: ${d.toString("hex").slice(0, 60)}`)
      // Reassemble K900 frames (they can split across notifications), decode each.
      this._rx = Buffer.concat([this._rx, d])
      const { frames, rest } = live.extractFrames(this._rx)
      this._rx = rest.length < 4096 ? Buffer.from(rest) : Buffer.alloc(0) // guard runaway buffer
      for (const f of frames) {
        const ev = live.decodeFrame(f)
        if (!ev) continue
        if (ev.type === "status") {
          this.status_ = { ...this.status_, battery: ev.battery, charging: ev.charging }
          this.emit("status", this.status_)
        } else if (ev.type === "gesture") {
          this.emit("gesture", { side, gesture: ev.gesture, buttonId: ev.buttonId })
        } else if (ev.type === "imu") {
          this.emit("imu", { side, accel: ev.accel, gyro: ev.gyro, euler: ev.euler })
        } else if (ev.type === "photo") {
          this.emit("photo", ev)
        } else if (ev.type === "pong") {
          /* keepalive ack */
        } else {
          this.emit("liveEvent", ev)
        }
      }
      return
    }
    if (this.device === "g1") {
      const ev = g1.decodeG1(d)
      if (!ev) return
      if (ev.type === "audio") {
        this.audioFrames++
        this.emit("audio", { side, data: ev.lc3 }) // 20-byte LC3 frames
      } else if (ev.type === "status") {
        this.status_ = { ...this.status_, battery: ev.battery }
        this.emit("status", this.status_)
      } else if (ev.type === "gesture" || ev.type === "case") {
        this.emit("gesture", { side, gesture: ev.gesture })
      }
      return
    }
    const pkt = g2.parseNotify(d)
    if (!pkt) return
    this.emit("notify", { side, serviceId: pkt.serviceId, cmd: pkt.cmd, hex: d.toString("hex") })
    // Decode the payload into a semantic event (IMU / gesture / device status).
    const ev = g2.decodeG2Event(pkt.serviceId, pkt.payload)
    if (!ev) return
    if (ev.type === "imu") this.emit("imu", { side, x: ev.x, y: ev.y, z: ev.z })
    else if (ev.type === "gesture") this.emit("gesture", { side, gesture: ev.gesture, eventType: ev.eventType })
    else if (ev.type === "status") {
      this.status_ = { ...this.status_, ...ev }
      this.emit("status", this.status_)
    }
  }

  _onDisconnect(side) {
    this.log(`${side} disconnected`)
    this.arms[side] = null
    if (!this.arms.L && !this.arms.R) {
      this.connected = false
      this.pageCreated = false
      this._stopHeartbeats()
      this.emit("state", this.status())
      if (this._autoReconnect && this.match && this._reconnectTries < 3) {
        // Backoff so a flapping device can never spin a tight connect loop.
        const delay = 8000 * 2 ** this._reconnectTries
        this._reconnectTries++
        this.log(`auto-reconnect ${this._reconnectTries}/3 in ${delay / 1000}s...`)
        setTimeout(() => this.start(this.match, { waitMs: 30000 }).catch((e) => this.log(`reconnect failed: ${e.message}`)), delay)
      } else if (this._reconnectTries >= 3) {
        this.log("auto-reconnect gave up after 3 tries")
      }
    }
  }

  // ---- serialized writes ----
  _write(packets, { left, right }, gapMs = 30) {
    this._q = this._q
      .then(async () => {
        for (const pkt of packets) {
          if (left && this.arms.L) await this.arms.L.writeChar.writeAsync(pkt, true)
          if (right && this.arms.R) await this.arms.R.writeChar.writeAsync(pkt, true)
          if (packets.length > 1) await sleep(gapMs)
        }
      })
      .catch((e) => this.log(`write error: ${e.message || e}`))
    return this._q
  }
  _devSettings(payload, lr) {
    return this._write(this.send.packets(g2.ServiceID.DEVICE_SETTINGS, payload), lr)
  }
  _evenHub(payload) {
    return this._write(this.send.packets(g2.ServiceID.EVEN_HUB, payload, true), { left: true, right: true })
  }
  _g2setting(payload) {
    return this._write(this.send.packets(g2.ServiceID.G2_SETTING, payload, true), { left: true, right: true })
  }

  async _g1Init() {
    this.log("G1 init sequence...")
    if (this.arms.L) await this._write([g1.INIT.init], { left: true, right: false })
    await this._write([g1.INIT.firmware], { left: true, right: true })
    await sleep(50)
    await this._write([g1.INIT.wearOff], { left: true, right: true })
    await this._write([g1.INIT.silentOff], { left: true, right: true })
    await this._write([g1.batteryQuery()], { left: true, right: true })
    await this._write([g1.exitToHome()], { left: true, right: true })
    this.log("G1 init complete")
  }

  _live(obj, wakeup = true) {
    // packCommands chunks oversized commands (>200B C-wrapped); the glasses
    // need ~50ms between chunk frames, which _write's multi-packet gap covers.
    return this._write(live.packCommands(obj, wakeup), { left: true, right: true }, 50)
  }

  async _liveInit() {
    this.log("Mentra Live init: phone_ready...")
    await this._live(live.cmd.phoneReady(), true)
    await sleep(150)
    await this._live(live.cmd.requestBattery(), true)
    await this._live(live.cmd.requestVersion(), true)
    this.log("Mentra Live init sent")
  }

  async _auth() {
    if (this.device === "g1") return this._g1Init()
    if (this.device === "live") return this._liveInit()
    this.log("auth sequence...")
    if (this.arms.L) await this._devSettings(g2.authCmd(this.send.nextMagic()), { left: true, right: false })
    await sleep(200)
    if (this.arms.R) await this._devSettings(g2.authCmd(this.send.nextMagic()), { left: false, right: true })
    await sleep(200)
    if (this.arms.R) await this._devSettings(g2.pipeRoleChange(this.send.nextMagic()), { left: false, right: true })
    await sleep(200)
    const tz = -new Date().getTimezoneOffset() * 60
    await this._devSettings(g2.timeSync(this.send.nextMagic(), Date.now(), tz), { left: false, right: true })
    await sleep(200)
    this.log("auth complete")
  }

  _startHeartbeats() {
    this._stopHeartbeats()
    if (this.device === "live") {
      // Mentra Live: {"type":"ping"} every 30s.
      this._hb.push(setInterval(() => this._live(live.cmd.ping(), false).catch(() => {}), 30000))
      return
    }
    if (this.device === "g1") {
      // G1: 0x25 heartbeat every 15s keeps the link alive.
      this._hb.push(
        setInterval(() => this._write([g1.heartbeat(this.g1seq.nextHb())], { left: true, right: true }).catch(() => {}), 15000),
      )
      return
    }
    this._hb.push(setInterval(() => this._evenHub(g2.heartbeatMessage(this.send.nextMagic())).catch(() => {}), 10000))
    this._hb.push(
      setInterval(
        () => this._devSettings(g2.baseHeartbeat(this.send.nextMagic()), { left: false, right: true }).catch(() => {}),
        5000,
      ),
    )
  }
  _stopHeartbeats() {
    this._hb.forEach(clearInterval)
    this._hb = []
  }

  // ---- public commands ----
  async displayText(text) {
    if (!this.connected) throw new Error("not connected")
    if (this.device === "live") throw new Error("Mentra Live is a camera (no display) — use takePhoto/mic/info")
    this.lastText = text
    if (this.device === "g1") {
      await this._write(g1.textPackets(text, this.g1seq.nextText()), { left: true, right: true })
      return { ok: true, text }
    }
    if (!this.pageCreated) {
      await this._evenHub(g2.defaultTextPage(text, this.send.nextMagic()))
      this.pageCreated = true
    } else {
      // live update of container 1 — no page flicker
      await this._evenHub(g2.updateTextMessage(1, text.length === 0 ? " " : text, this.send.nextMagic()))
    }
    return { ok: true, text }
  }

  async clear() {
    return this.displayText(" ")
  }

  async setBrightness(level, auto = false) {
    if (!this.connected) throw new Error("not connected")
    if (this.device === "live") throw new Error("Mentra Live has no display")
    if (this.device === "g1") {
      await this._write([g1.brightness(Math.max(0, Math.min(255, level)), auto)], { left: true, right: true })
      return { ok: true, level, auto }
    }
    await this._g2setting(g2.setBrightnessMessage(Math.max(0, Math.min(255, level)), auto, this.send.nextMagic()))
    return { ok: true, level, auto }
  }

  async setHeadUpAngle(angle) {
    if (!this.connected) throw new Error("not connected")
    if (this.device === "g1") {
      await this._write([g1.headUpAngle(angle)], { left: true, right: true })
      return { ok: true, angle }
    }
    await this._g2setting(g2.setHeadUpAngleMessage(angle, this.send.nextMagic()))
    return { ok: true, angle }
  }

  // Display a 4-bit BMP (Buffer) on the lens, in a container of the given
  // geometry. Creates an image page, then streams the bitmap in 4096-byte
  // fragments (200ms apart, per G2.kt sendImageData).
  async displayImage(bmp, { x = 188, y = 44, width = 200, height = 100, label = " ", imageOnly = false, settleMs = 300 } = {}) {
    if (!this.connected) throw new Error("not connected")
    if (this.device !== "g2") throw new Error("image display is wired for G2 (G1 bitmap is in g1.mjs; Live has no display)")
    // Firmware limits (community RE): container width 20-288, height 20-144,
    // name <= 14 chars, fragments <= 4096B, BMP dims must equal container dims.
    if (width < 20 || width > 288 || height < 20 || height > 144)
      throw new Error(`G2 image container must be 20-288 x 20-144 (got ${width}x${height})`)
    const id = 10
    const name = `img-${id}`
    const prop = g2.imageContainerProperty({ x, y, width, height, containerID: id, containerName: name })
    const textProps = imageOnly ? [] : [g2.defaultTextProp(label)]
    // The image container must be declared via REBUILD_PAGE on a live page —
    // a repeat CREATE does not rebuild firmware state and image data then
    // fails with errorCode 5. So: ensure a page exists, then REBUILD with
    // text + image containers, settle, then stream fragments.
    if (!this.pageCreated) {
      await this._evenHub(g2.defaultTextPage(label, this.send.nextMagic()))
      this.pageCreated = true
      await sleep(300)
    }
    await this._evenHub(g2.rebuildPageMessage(textProps, [prop], this.send.nextMagic()))
    await sleep(settleMs)
    // Sessions wedge after any failed stream; advance by 2 to skip inherited state.
    const session = (this._imgSession = (this._imgSession || 40) + 2)
    const FRAG = 4096
    let frag = 0
    for (let off = 0; off < bmp.length; off += FRAG) {
      const chunk = bmp.subarray(off, Math.min(off + FRAG, bmp.length))
      // unique magic per fragment: it is the firmware's ack-correlation key
      await this._evenHub(g2.updateImageMessage(id, name, session, bmp.length, frag, chunk, this.send.nextMagic()))
      frag++
      await sleep(200)
    }
    return { ok: true, bytes: bmp.length, fragments: frag, session, geometry: { x, y, width, height } }
  }

  async setImu(enable, freq = 100) {
    if (!this.connected) throw new Error("not connected")
    if (this.device === "live") {
      await this._live({ type: enable ? "imu_stream_start" : "imu_stream_stop" }, true)
      this.imuEnabled = enable
      return { ok: true, imu: enable }
    }
    if (this.device !== "g2") throw new Error("IMU not supported on this device")
    await this._evenHub(g2.imuControlMessage(enable, freq, this.send.nextMagic()))
    this.imuEnabled = enable
    return { ok: true, imu: enable }
  }

  // Ask the glasses for battery + firmware; resolves with the status the decoder
  // collects from the notify response (or the last known status on timeout).
  async requestInfo(timeoutMs = 2500) {
    if (!this.connected) throw new Error("not connected")
    const got = new Promise((resolve) => {
      const onStatus = (s) => { this.off("status", onStatus); resolve(s) }
      this.on("status", onStatus)
      setTimeout(() => { this.off("status", onStatus); resolve(this.status_ || null) }, timeoutMs)
    })
    if (this.device === "live") await this._live(live.cmd.requestBattery(), true)
    else if (this.device === "g1") await this._write([g1.batteryQuery()], { left: true, right: true })
    else await this._g2setting(g2.requestInfoMessage(this.send.nextMagic()))
    return got
  }

  // Mentra Live: send any control command (e.g. {type:"request_wifi_status"}).
  async sendLive(obj, wakeup = true) {
    if (!this.connected) throw new Error("not connected")
    if (this.device !== "live") throw new Error("sendLive is Mentra Live only")
    await this._live(obj, wakeup)
    return { ok: true, sent: obj }
  }

  // Mentra Live: capture a photo. For the BLE path we generate a bleImgId and
  // resolve when the assembled file arrives on 72FF; for the WiFi path the
  // glasses POST to opts.webhookUrl and we resolve on the photo_response (the
  // daemon's media receiver reports the actual upload separately).
  async takePhoto(opts = {}, timeoutMs = 90000) {
    if (!this.connected) throw new Error("not connected")
    if (this.device !== "live") throw new Error("takePhoto is Mentra Live only")
    const reqId = opts.requestId || `harness${Date.now() % 100000}`
    if ((opts.transferMethod || "ble") === "ble" && !opts.bleImgId) {
      opts = { ...opts, bleImgId: `I${(Date.now() % 1000000).toString(36)}` }
    }
    const got = new Promise((resolve) => {
      let done = false
      const finish = (r) => {
        if (done) return
        done = true
        this.off("photo", onPhoto)
        this.off("photoFile", onFile)
        resolve(r)
      }
      const onPhoto = (p) => {
        // An explicit failure ends the wait; a success ack on the BLE path just
        // means "capture started" — keep waiting for the file itself.
        if (p.success === false) finish(p)
        else if ((opts.transferMethod || "ble") !== "ble") finish(p)
      }
      const onFile = (f) => finish({ type: "photo", success: true, fileName: f.fileName, bytes: f.data.length, requestId: reqId })
      this.on("photo", onPhoto)
      this.on("photoFile", onFile)
      setTimeout(() => finish({ timeout: true, requestId: reqId }), timeoutMs)
    })
    await this._live(live.cmd.takePhoto(reqId, opts), true)
    return got
  }

  // Mentra Live: start/stop an RTMP/SRT stream to the given URL.
  async startStream(streamUrl) {
    if (!this.connected) throw new Error("not connected")
    if (this.device !== "live") throw new Error("streaming is Mentra Live only")
    await this._live(live.cmd.startStream(streamUrl), true)
    return { ok: true, streamUrl }
  }

  async stopStream() {
    if (!this.connected) throw new Error("not connected")
    await this._live(live.cmd.stopStream(), true)
    return { ok: true }
  }

  async setMic(enable) {
    if (!this.connected) throw new Error("not connected")
    if (this.device === "live") {
      // Mentra Live streams LC3 mic on the subscribed audio char; keep the device
      // awake so it keeps sending. (No separate JSON mic-enable in this firmware.)
      if (enable) await this._live(live.cmd.keepAwake(), true)
      this.micEnabled = enable
      return { ok: true, mic: enable, note: "Live mic streams via the LC3 characteristic" }
    }
    return this._setMicInner(enable)
  }

  async _setMicInner(enable) {
    if (this.device === "g1") {
      await this._write([g1.micControl(enable)], { left: true, right: true })
      this.micEnabled = enable
      return { ok: true, mic: enable }
    }
    if (enable) {
      // The mic only streams when a display page exists (G2.kt re-creates the
      // page before enabling). Ensure one, then enable after a short settle.
      if (!this.pageCreated) await this.displayText("Listening…")
      await sleep(300)
      await this._evenHub(g2.audioControlMessage(true, this.send.nextMagic()))
    } else {
      await this._evenHub(g2.audioControlMessage(false, this.send.nextMagic()))
    }
    this.micEnabled = enable
    return { ok: true, mic: enable }
  }

  async stop() {
    this._autoReconnect = false
    this._stopHeartbeats()
    for (const side of ["L", "R"]) {
      if (this.arms[side]) { try { await this.arms[side].peripheral.disconnectAsync() } catch {} }
      this.arms[side] = null
    }
    this.connected = false
    this.emit("state", this.status())
    return { ok: true }
  }

  _withTimeout(p, ms, label) {
    return Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
    ])
  }
}
