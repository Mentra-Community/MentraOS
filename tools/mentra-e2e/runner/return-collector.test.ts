import {afterEach, expect, test} from "bun:test"
import {mkdtemp, readFile, rm} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {
  collectReturnObservation,
  exactJsonResponse,
  exactBleOutputResponse,
  freshBes,
  logRows,
  PROBE_SHA,
  PROBE_BYTES,
  validateFixture,
  validateProbePath,
  type AppObserver,
  type ReturnCollectorConfig,
} from "./return-collector"
import {TestReturnRecorder, simulatedReturnCollection} from "./return-collector.test-support"
import {day1ReturnSources} from "./day1-local-runtime"

const owned: string[] = []
afterEach(async () => {
  await Promise.all(owned.splice(0).map((path) => rm(path, {recursive: true, force: true})))
})

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

test("requires one explicit transport and full fixture identity", () => {
  expect(validateFixture(fixture)).toEqual(fixture)
  const {usb, ...wireless} = fixture
  expect(validateFixture({...wireless, wifiEndpoint: "192.168.1.22:5555"}).wifiEndpoint).toBe("192.168.1.22:5555")
  expect(() => validateFixture(wireless)).toThrow()
  expect(() => validateFixture({...fixture, wifiEndpoint: "192.168.1.22:5555"})).toThrow()
  expect(() => validateFixture({...fixture, cid: "33793"})).toThrow()
  expect(() => validateFixture({...fixture, bluetooth: "03BE"})).toThrow()
  expect(() => validateFixture({...fixture, serial: "device; reboot"})).toThrow()
})

test("probe path only permits the exact pinned name and optional owned directory", () => {
  const name = `mentra-update-engine-status-${PROBE_SHA}.jar`
  expect(validateProbePath(`/data/local/tmp/${name}`)).toBe(`/data/local/tmp/${name}`)
  expect(validateProbePath(`/data/local/tmp/mentra-return-probe-${"a".repeat(32)}/${name}`)).toContain(name)
  for (const path of [
    "/data/local/tmp/UpdateEngineStatus.jar",
    `/data/local/tmp/../tmp/${name}`,
    `/data/local/tmp/other-owner/${name}`,
    `/data/local/tmp/${name};reboot`,
    `/data/local/tmp/${name.replace(PROBE_SHA, "b".repeat(64))}`,
  ])
    expect(() => validateProbePath(path)).toThrow()
})

test("fresh BES proof uses actual hardware response, current process and boot", () => {
  const rows = logRows(
    [
      "--------- beginning of main",
      line(proof()),
      line('{"bes_firmware":"26.9.21.3"}', "100.600000", 1335, "AsgClientService"),
    ].join("\n"),
  )
  expect(freshBes(rows, processRead, "26.9.21.3", 15)?.version).toBe("26.9.21.3")
  expect(freshBes(logRows(line(proof(), "20.000000")), processRead, "26.9.21.3", 15)).toBeUndefined()
  expect(freshBes(logRows(line(proof(), "50.000000")), processRead, "26.9.21.3", 15)).toBeUndefined()
  expect(freshBes(logRows(line(proof(), "101.500000")), processRead, "26.9.21.3", 15)).toBeUndefined()
  expect(freshBes(logRows(line(proof(), "100.000000", 1336)), processRead, "26.9.21.3", 15)).toBeUndefined()
  expect(
    freshBes(logRows(line(proof("26.9.21.3", "91462ecc-a06f-4bf8-9e1a-aa7bf1f0b2ff"))), processRead, "26.9.21.3", 15),
  ).toBeUndefined()
  expect(
    freshBes(
      rows.filter((row) => row.tag !== "K900BluetoothManager"),
      processRead,
      "26.9.21.3",
      15,
    ),
  ).toBeUndefined()
})

test("does not cherry-pick an older expected BES version past a fresh mismatch", () => {
  const rows = logRows([line(proof()), line(proof("17.26.1.13"), "100.800000")].join("\n"))
  expect(() => freshBes(rows, processRead, "26.9.21.3", 15)).toThrow("Fresh BES target mismatch")
})

test("query replies require one exact nonce, PID and capture interval", () => {
  const text = line('OTA activity snapshot: {"request_id":"fresh","schema":1}', "100.250000", 1335, "OtaCommandHandler")
  const rows = logRows(text)
  const read = (candidate = rows, pid = 1335, begin = 100, end = 101) =>
    exactJsonResponse(
      candidate,
      pid,
      "OtaCommandHandler",
      "OTA activity snapshot: ",
      begin,
      end,
      (value) => value.request_id === "fresh",
    )
  expect(read().value.schema).toBe(1)
  expect(() => read(rows, 1336)).toThrow("observed 0")
  expect(() => read(rows, 1335, 100.5)).toThrow("observed 0")
  expect(() => read(rows, 1335, 99, 100)).toThrow("observed 0")
  expect(() => read(logRows(text.replace("fresh", "old")))).toThrow("observed 0")
  expect(() => read([...rows, ...rows])).toThrow("observed 2")
  expect(() => read(logRows(text.replace('{"request_id":"fresh","schema":1}', "null")))).toThrow("Expected JSON object")
})

test("actual release output replies use the exact BLE trace envelope and monotonic capture interval", () => {
  // Response shape from return-observation-01 / 0065.stdout. Payload wall time is
  // intentionally unrelated to logcat's explicitly requested monotonic seconds.
  const version =
    '8995.257905  2166  2225 I MentraBleTrace: BLE_TRACE direction=glasses_to_phone layer=asg_ble_output source=asg_client type=version_info_1 bytes=411 payload={"type":"version_info_1","chunkIndex":1,"chunkCount":2,"final":false,"package_name":"com.mentra.asg_client","request_id":"return-version-b6bfbd29cc3f4458a1623246a15d205b","app_version":"303006291","build_number":"303006291","device_model":"Mentra Live","android_version":"11","system_time_ms":1790073488360,"sid":"4954f060","hotspot_ota_version":1,"wifi_forget_result_version":1,"saved_wifi_networks_version":0}'
  const stream =
    '8996.130353  2166  2225 I MentraBleTrace: BLE_TRACE direction=glasses_to_phone layer=asg_ble_output source=asg_client type=stream_status bytes=172 payload={"status":"stopped","type":"stream_status","kind":"snapshot","sid":"4954f060","revision":0,"terminal":true,"streaming":false,"reconnecting":false,"timestamp":1790073488586}'
  const read = (text = version, pid = 2166, earliest = 8988.58, latest = 8999) =>
    exactBleOutputResponse(
      logRows(text),
      pid,
      "version_info_1",
      earliest,
      latest,
      (value) => value.request_id === "return-version-b6bfbd29cc3f4458a1623246a15d205b",
    )
  expect(read().row.seconds).toBe(8995.257905)
  expect(read().value.system_time_ms).toBe(1790073488360)
  expect(read().value.sid).toBe("4954f060")
  expect(
    exactBleOutputResponse(logRows(stream), 2166, "stream_status", 8995.3, 8999, (value) => value.kind === "snapshot")
      .value.status,
  ).toBe("stopped")
  for (const text of [
    version.replace("layer=asg_ble_output", "layer=asg_ble_outbound_queue"),
    version.replace("layer=asg_ble_output", "layer=sdk_ble_chunk"),
    version.replace("direction=glasses_to_phone", "direction=phone_to_glasses"),
    version.replace("source=asg_client", "source=other"),
    version.replace("MentraBleTrace:", "AsgClientServiceV2:"),
    version.replace('"type":"version_info_1"', '"type":"version_info_3"'),
    version.replace("return-version-b6bfbd29cc3f4458a1623246a15d205b", "old-request"),
    version.slice(0, -10) + "...",
  ])
    expect(() => read(text)).toThrow("observed 0")
  expect(() => read(version, 2167)).toThrow("observed 0")
  expect(() => read(version, 2166, 8995.3)).toThrow("observed 0")
  expect(() => read(version, 2166, 8988.58, 8995.2)).toThrow("observed 0")
  expect(() => read(version + "\n" + version)).toThrow("observed 2")
})

async function simulatedCollection() {
  const output = await mkdtemp(join(tmpdir(), "mentra-return-collector-"))
  owned.push(output)
  return simulatedReturnCollection(output)
}

test("the extracted collector evaluates all 14 assertions using one read-only batch and never reuses its evidence", async () => {
  const s = await simulatedCollection()
  const result = await collectReturnObservation(s.config, s.app)
  expect(result.returnObservationPassed).toBe(true)
  expect(result.fixtureStateChanged).toBe(false)
  expect(result.firmwareAssertions).toHaveLength(14)
  expect(result.firmwareAssertions.every((entry) => entry.status === "passed")).toBe(true)
  expect(s.queries.map((query) => query.type)).toEqual(["request_version", "get_stream_status", "ota_query_status"])
  const count = (s.config.recorder as TestReturnRecorder).commands.length
  await expect(collectReturnObservation(s.config, s.app)).rejects.toThrow()
  expect((s.config.recorder as TestReturnRecorder).commands).toHaveLength(count)
})

test("ADB-only and each independent failed target or idle check cannot pass full return", async () => {
  const noApp = await simulatedCollection()
  expect(await collectReturnObservation(noApp.config)).toMatchObject({
    adbQualified: true,
    returnObservationPassed: false,
    fullFixtureReturnQualified: false,
    appConnection: "not-observed",
  })
  for (const flag of ["busy", "staged", "wrongSid", "wrongApk"] as const) {
    const s = await simulatedCollection()
    s.flags[flag] = true
    const result = await collectReturnObservation(s.config, s.app)
    expect(result.returnObservationPassed).toBe(false)
    expect(result.adbQualified).toBe(false)
    expect(result.fixtureStateChanged).toBe(false)
  }
})

test("an explicit source observation can prove idle without declaring off-target firmware restored", async () => {
  const s = await simulatedCollection()
  s.flags.firmware = "MentraLive_20260113"
  s.flags.asgVersion = 303006000
  s.flags.besVersion = "17.26.1.13"
  const source = structuredClone(s.config.profile)
  source.mtk.version = s.flags.firmware
  source.asg.versionCode = s.flags.asgVersion
  source.bes.version = s.flags.besVersion
  s.config.allowedSource = day1ReturnSources(s.config.profile, {sourceProfiles: [source]})
  const result = await collectReturnObservation(s.config, s.app)
  expect(result.returnObservationPassed).toBe(false)
  expect(result.adbQualified).toBe(false)
  expect(result.idleChecks.every((check) => check.passed)).toBe(true)
  expect(result.streamStopped).toBe(true)
  const failed = result.firmwareAssertions.filter((check) => check.status === "failed").map((check) => check.id)
  expect(failed).toEqual(["firmware.mtk", "firmware.asg.version", "firmware.bes.version"])
  const saved = JSON.parse(await readFile(join(s.config.recorder.output, "inputs.json"), "utf8"))
  expect(saved.profile).toEqual(s.config.profile)
  expect(saved.allowedSource).toEqual(s.config.allowedSource)
})

test("known source observation does not permit unknown versions, wrong identity or busy writers", async () => {
  for (const [flag, value, error] of [
    ["firmware", "MentraLive_20200101", "UNEXPECTED_FIRMWARE"],
    ["asgVersion", 37, "UNEXPECTED_ASG_VERSION"],
    ["besVersion", "99.1.1.1", "Fresh BES target mismatch"],
    ["wrongCid", true, "HARDWARE_IDENTITY_MISMATCH"],
    ["wrongBluetooth", true, "HARDWARE_BLUETOOTH_MISMATCH"],
  ] as const) {
    const s = await simulatedCollection()
    s.config.allowedSource = day1ReturnSources(s.config.profile, {
      sourceProfiles: [s.config.profile],
      setupBaseline: {mtkVersion: "MentraLive_20260113", besVersion: "17.26.1.13"},
    })
    Object.assign(s.flags, {[flag]: value})
    await expect(collectReturnObservation(s.config, s.app)).rejects.toThrow(error)
    expect(s.queries).toHaveLength(0)
  }
  const busy = await simulatedCollection()
  busy.config.allowedSource = day1ReturnSources(busy.config.profile, {sourceProfiles: []})
  busy.flags.busy = true
  const result = await collectReturnObservation(busy.config, busy.app)
  expect(result.returnObservationPassed).toBe(false)
  expect(result.adbQualified).toBe(false)
  expect(result.firmwareAssertions.find((c) => c.id === "update.idle")?.status).toBe("failed")
})

test("unknown source versions still fail and cannot cherry-pick an older BES match", async () => {
  const s = await simulatedCollection()
  s.flags.besVersion = "17.26.1.13"
  await expect(collectReturnObservation(s.config)).rejects.toThrow("Fresh BES target mismatch")
  const rows = logRows([line(proof()), line(proof("99.1.1.1"), "100.800000")].join("\n"))
  expect(() => freshBes(rows, processRead, ["26.9.21.3", "17.26.1.13"], 15)).toThrow("Fresh BES target mismatch")
})

test("repair observation validates its allowlist before any device command", async () => {
  const s = await simulatedCollection()
  s.config.allowedSource = {mtkVersions: [], asgVersions: [303006291], besVersions: ["17.26.1.13"]}
  await expect(collectReturnObservation(s.config)).rejects.toThrow("bounded source versions")
  expect((s.config.recorder as TestReturnRecorder).commands).toHaveLength(0)
})

test("ambiguous responses retain failure evidence and never resend queries", async () => {
  const s = await simulatedCollection()
  s.flags.duplicateReply = true
  await expect(collectReturnObservation(s.config, s.app)).rejects.toThrow("observed 2")
  expect(s.queries).toHaveLength(3)
  expect(JSON.parse(await readFile(join(s.config.recorder.output, "failure.json"), "utf8"))).toMatchObject({
    fullFixtureReturnQualified: false,
  })
})

test("an unreviewed probe is rejected before any device or app command", async () => {
  const s = await simulatedCollection()
  s.config.probe.sha256 = "e".repeat(64)
  let appPrepared = false
  s.app.prepare = async () => {
    appPrepared = true
  }
  await expect(collectReturnObservation(s.config, s.app)).rejects.toThrow("reviewed status probe")
  expect((s.config.recorder as TestReturnRecorder).commands).toHaveLength(0)
  expect(appPrepared).toBe(false)
})
