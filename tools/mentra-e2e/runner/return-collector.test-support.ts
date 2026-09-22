import {appendFile, writeFile} from "node:fs/promises"
import {join} from "node:path"
import {
  PROBE_SHA,
  PROBE_BYTES,
  type AppObserver,
  type ReturnCollectorConfig,
  type ReturnCommandCapture,
  type ReturnEvidenceRecorder,
} from "./return-collector"

/** Offline test adapter only. No subprocess or device command is executed. */
export class TestReturnRecorder implements ReturnEvidenceRecorder {
  readonly commands: string[][] = []
  constructor(
    readonly output: string,
    readonly respond: (argv: string[]) => Promise<string> | string = () => {
      throw new Error("Unexpected command")
    },
  ) {}
  async file(name: string, value: string | Uint8Array) {
    const path = join(this.output, name)
    await writeFile(path, value, {flag: "wx", mode: 0o600})
    return path
  }
  async json(name: string, value: unknown) {
    return this.file(name, JSON.stringify(value) + "\n")
  }
  async append(value: unknown) {
    await appendFile(join(this.output, "commands.jsonl"), JSON.stringify(value) + "\n", {mode: 0o600})
  }
  async capture(argv: string[]): Promise<ReturnCommandCapture> {
    const startedAt = new Date().toISOString()
    this.commands.push(argv)
    const stdout = await this.respond(argv)
    const finishedAt = new Date().toISOString()
    const evidence = await this.json(`command-${this.commands.length}.json`, {
      simulated: true,
      argv,
      startedAt,
      finishedAt,
      stdout,
      exitCode: 0,
    })
    return {startedAt, finishedAt, argv, exitCode: 0, stdout, evidence}
  }
  async run(argv: string[]) {
    return (await this.capture(argv)).stdout.trim()
  }
}

/** Complete offline command fixture shared by collector and lifecycle/export tests. */
export function simulatedReturnCollection(output: string) {
  const fixture = {
    serial: "TEST012345",
    cid: "0123456789abcdef0123456789abcdef",
    bluetooth: "AA:BB:CC:DD:EE:01",
    usb: "1048576X",
  }
  const processRead = {
    bootId: "da1ae189-2166-4d4b-8069-806e570bb530",
    pid: 1335,
    startTicks: "2485",
    clockTicksPerSecond: 100,
    uptimeSeconds: 101,
  }
  const line = (message: string, time = "100.250000", pid = 1335, tag = "K900BluetoothManager") =>
    `${time}  ${pid}  1500 D ${tag}: ${message}`
  const proof = (version = "26.9.21.3", boot = processRead.bootId) =>
    `BES_OTA_DIAG version_proof actual=${version} current_boot=${boot} owner=diagnostic`
  let uptime = 100
  const sid = "0123abcd"
  const digest = "d".repeat(64)
  const remote = `/data/local/tmp/mentra-update-engine-status-${PROBE_SHA}.jar`
  const apk = "/data/app/owned/base.apk"
  const logs: string[] = []
  const queries: Record<string, unknown>[] = []
  const flags = {
    busy: false,
    staged: false,
    wrongSid: false,
    wrongApk: false,
    duplicateReply: false,
    wrongCid: false,
    wrongBluetooth: false,
    firmware: "MentraLive_20260921.0",
    asgVersion: 303006291,
    besVersion: "26.9.21.3",
  }
  const record = (value: unknown, tag: string, prefix = "") => {
    logs.push(line(prefix + JSON.stringify(value), uptime.toFixed(6), processRead.pid, tag))
  }
  const ble = (value: Record<string, unknown>) =>
    record(
      value,
      "MentraBleTrace",
      `BLE_TRACE direction=glasses_to_phone layer=asg_ble_output source=asg_client type=${value.type} bytes=500 payload=`,
    )
  const recorder = new TestReturnRecorder(output, (argv) => {
    uptime = Math.round((uptime + 0.005) * 1000) / 1000
    if (JSON.stringify(argv) === JSON.stringify(["adb", "devices", "-l"]))
      return `List of devices attached\n${fixture.serial} device usb:${fixture.usb} transport_id:1\n`
    if (argv.slice(0, 4).join(" ") !== "adb -t 1 shell") throw new Error("Unapproved simulated command")
    const cmd = argv.slice(4).join(" ")
    const values: Record<string, string> = {
      "cat /sys/block/mmcblk0/device/cid": flags.wrongCid ? "f".repeat(32) : fixture.cid,
      "getprop ro.serialno": fixture.serial,
      "getprop persist.mentra.live.mac": flags.wrongBluetooth ? "00:11:22:33:44:55" : fixture.bluetooth,
      "getprop ro.custom.ota.version": flags.firmware,
      "getprop sys.boot_completed": "1",
      "cat /proc/sys/kernel/random/boot_id": processRead.bootId,
      "getprop ro.boot.slot_suffix": "_a",
      "dumpsys package com.mentra.asg_client": `versionCode=${flags.asgVersion}`,
      "pidof com.mentra.asg_client": String(processRead.pid),
      [`cat /proc/${processRead.pid}/stat`]: `${processRead.pid} (asg) S ${Array(18).fill("0").join(" ")} ${processRead.startTicks} 0`,
      "getconf CLK_TCK": "100",
      "cat /proc/uptime": `${uptime} 0`,
      [`test ! -L ${remote}`]: "",
      [`sha256sum ${remote}`]: PROBE_SHA + " " + remote,
      [`stat -c %s ${remote}`]: String(PROBE_BYTES),
      "pm path com.mentra.asg_client": "package:" + apk,
      [`sha256sum ${apk}`]: (flags.wrongApk ? "e".repeat(64) : digest) + " " + apk,
      [`CLASSPATH='${remote}' app_process /system/bin UpdateEngineStatus`]: flags.staged
        ? "CURRENT_OP=UPDATE_STATUS_UPDATED_NEED_REBOOT\nSTATUS_CODE=6\n"
        : "CURRENT_OP=UPDATE_STATUS_IDLE\nSTATUS_CODE=0\n",
    }
    if (cmd in values) return values[cmd]
    if (cmd === "logcat -b main -d -v threadtime -v monotonic -v usec")
      return [line(proof(flags.besVersion), "99.500000"), ...logs].join("\n")
    const query = /--es json '(.*)'$/.exec(cmd)
    if (query && cmd.startsWith("am broadcast -n com.mentra.asg_client/.receiver.IntentCommandReceiver ")) {
      const value = JSON.parse(query[1])
      queries.push(value)
      if (value.type === "request_version") {
        ble({
          type: "version_info_1",
          package_name: "com.mentra.asg_client",
          build_number: String(flags.asgVersion),
          sid,
          request_id: value.request_id,
        })
        if (flags.duplicateReply) logs.push(logs.at(-1)!)
      } else if (value.type === "get_stream_status") {
        ble({
          type: "stream_status",
          kind: "snapshot",
          sid,
          revision: 0,
          status: "stopped",
          terminal: true,
          streaming: false,
          reconnecting: false,
        })
      } else if (value.type === "ota_query_status" && value.include_activity === true) {
        record(
          {
            schema: 1,
            request_id: value.request_id,
            process_sid: flags.wrongSid ? "deadbeef" : sid,
            elapsed_realtime_ms: Math.round(uptime * 1000),
            admission_generation: 0,
            admission_held: false,
            updating: false,
            mtk_in_progress: false,
            bes_in_progress: flags.busy,
            consistent: true,
            session: {session_id: "", status: "idle", restart_pending: false},
          },
          "OtaCommandHandler",
          "OTA activity snapshot: ",
        )
      } else throw new Error("Unapproved query type")
      return "Broadcast completed: result=0"
    }
    throw new Error("Unexpected simulated command: " + cmd)
  })
  const artifact = {url: "https://example.com/frozen", sha256: digest, size: 10}
  const config: ReturnCollectorConfig = {
    fixture,
    recorder,
    probe: {path: remote, sha256: PROBE_SHA, size: PROBE_BYTES},
    profile: {
      manifest: artifact,
      asg: {versionCode: 303006291, artifact},
      bes: {version: "26.9.21.3", artifact},
      mtk: {version: "MentraLive_20260921.0", artifact},
    },
  }
  const app: AppObserver = {
    prepare: async () => {},
    capture: async () => ({
      connected: true,
      evidence: "offline-app-proof",
      capturedAt: Array(3).fill(new Date().toISOString()),
    }),
    finish: async (_context, value) => value,
  }
  return {config, app, flags, queries}
}
